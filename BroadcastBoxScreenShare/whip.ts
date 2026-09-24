/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { WhipSession } from "./types";

const logger = new Logger("WhipRelay:WebRTC", "#e5a00d");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** STUN servers used by both WHIP and WHEP peer connections for NAT traversal.
 * Includes Cloudflare STUN (ports 3478 and 53, Anycast in Brazil & worldwide)
 * alongside Google STUN for fast candidate gathering without ISP UDP throttling.
 */
const ICE_SERVERS: RTCIceServer[] = [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    { urls: ["stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] }
];

async function postSdp(
    endpoint: string,
    sdp: string,
    token: string,
    protocol: "WHIP" | "WHEP" = "WHIP",
    signal?: AbortSignal
): Promise<{ sdp: string; location: string | null; }> {
    logger.debug(`[${protocol}] Dispatching POST ${endpoint} (Token: ${token}, Offer SDP size: ${sdp.length} bytes)`);
    let res: Response;
    try {
        res = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/sdp",
                Accept: "application/sdp",
                Authorization: `Bearer ${token}`
            },
            body: sdp,
            signal
        });
    } catch (netErr) {
        if (signal?.aborted) throw netErr;
        logger.error(`[${protocol}] Network request to ${endpoint} failed:`, netErr);
        throw netErr;
    }

    logger.debug(`[${protocol}] Server response: HTTP ${res.status} ${res.statusText}`);

    if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        logger.error(`[${protocol}] Server error body (HTTP ${res.status}):`, errorText);
        throw new Error(`[WhipRelay] POST ${endpoint} → ${res.status}: ${errorText}`);
    }

    const answerSdp = await res.text();
    const location = res.headers.get("location");
    logger.debug(`[${protocol}] SDP answer received (${answerSdp.length} bytes), Location header: ${location ?? "(none)"}`);
    return { sdp: answerSdp, location };
}

function resolveUrl(base: string, path: string | null): string | null {
    if (!path) return null;
    try { return new URL(path, base).toString(); } catch { return null; }
}

async function waitForIceGathering(
    pc: RTCPeerConnection,
    token: string,
    protocol: "WHIP" | "WHEP",
    timeoutMs = 1500,
    signal?: AbortSignal
): Promise<void> {
    if (pc.iceGatheringState === "complete" || pc.signalingState === "closed" || signal?.aborted) {
        logger.debug(`[${protocol}] [${token}] ICE gathering already complete, closed, or aborted.`);
        return;
    }
    const start = Date.now();
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            pc.removeEventListener("icegatheringstatechange", onStateChange);
            signal?.removeEventListener("abort", onAbort);
        };

        const onAbort = () => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new DOMException("Aborted", "AbortError"));
        };

        const onStateChange = () => {
            if (pc.iceGatheringState === "complete" || pc.signalingState === "closed") {
                if (settled) return;
                settled = true;
                cleanup();
                logger.debug(`[${protocol}] [${token}] ICE gathering finished in ${Date.now() - start}ms.`);
                resolve();
            }
        };

        if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
        }

        timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            logger.warn(`[${protocol}] [${token}] ICE gathering timed out after ${Date.now() - start}ms (state: ${pc.iceGatheringState}). Proceeding.`);
            resolve();
        }, timeoutMs);

        pc.addEventListener("icegatheringstatechange", onStateChange);
    });
}

// ---------------------------------------------------------------------------
// WHIP — Publisher only
// ---------------------------------------------------------------------------

/**
 * DELETE the WHIP session resource to end ingest on broadcast-box.
 *
 * This is ONLY ever called by the publisher when the user stops sharing.
 * Calling DELETE on a WHIP resource terminates the broadcast entirely and
 * disconnects all WHEP subscribers. WHEP viewers must never call this.
 */
async function deleteWhipSession(url: string | null, token: string): Promise<void> {
    if (!url) return;
    try {
        logger.log(`[WHIP] Sending DELETE to ${url} (Token: ${token})`);
        const res = await fetch(url, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
            keepalive: true
        });
        if (!res.ok && res.status !== 404 && res.status !== 410) {
            logger.warn(`[WHIP] WHIP DELETE returned ${res.status}`);
        } else {
            logger.log(`[WHIP] WHIP session at ${url} deleted successfully (HTTP ${res.status}).`);
        }
    } catch (e) {
        logger.warn("[WHIP] WHIP teardown DELETE failed:", e);
    }
}

/**
 * Publish a local video track to Broadcast Box via WHIP.
 *
 * - Video-only, sendonly transceiver: no audio track is added, so Discord's
 *   native audio routing (mute, volume, etc.) is completely untouched.
 * - The WHIP peer connection is independent of Discord's own WebRTC stack.
 * - close() issues DELETE to end the ingest session on the server, which
 *   also disconnects all current WHEP subscribers.
 */
const sessionStore = new Map<string, string>();

function getSavedSessionUrl(token: string): string | null {
    if (sessionStore.has(token)) return sessionStore.get(token)!;
    try {
        if (typeof window !== "undefined" && window.sessionStorage) {
            return window.sessionStorage.getItem(`whip_res_${token}`);
        }
    } catch {}
    return null;
}

function setSavedSessionUrl(token: string, url: string): void {
    sessionStore.set(token, url);
    try {
        if (typeof window !== "undefined" && window.sessionStorage) {
            window.sessionStorage.setItem(`whip_res_${token}`, url);
        }
    } catch {}
}

function removeSavedSessionUrl(token: string): void {
    sessionStore.delete(token);
    try {
        if (typeof window !== "undefined" && window.sessionStorage) {
            window.sessionStorage.removeItem(`whip_res_${token}`);
        }
    } catch {}
}

export async function publish(
    whipUrl: string,
    token: string,
    track: MediaStreamTrack,
    onCreated?: (pc: RTCPeerConnection) => void,
    signal?: AbortSignal
): Promise<WhipSession> {
    if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
    }

    logger.log(`[WHIP] Initializing publish session for token "${token}"`);
    logger.log(`[WHIP] Track: kind=${track.kind}, id=${track.id}, label="${track.label}", readyState=${track.readyState}, muted=${track.muted}`);
    try {
        const settings = track.getSettings();
        logger.log(`[WHIP] Track settings: ${settings.width ?? "?"}x${settings.height ?? "?"} @ ${settings.frameRate ?? "?"}fps`);
    } catch {}

    // Preemptively clean up any lingering session on Broadcast Box from a previous reload/crash
    const savedUrl = getSavedSessionUrl(token);
    if (savedUrl) {
        logger.log(`[WHIP] Found prior session resource URL for token "${token}". Preemptively sending DELETE to clear host slot: ${savedUrl}`);
        await deleteWhipSession(savedUrl, token);
        removeSavedSessionUrl(token);
    }

    if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
    }

    const pc = new RTCPeerConnection({
        iceServers: ICE_SERVERS,
        bundlePolicy: "max-bundle"
    });
    onCreated?.(pc);

    if (signal?.aborted) {
        try { pc.close(); } catch {}
        throw new DOMException("Aborted", "AbortError");
    }

    let statsTimer: ReturnType<typeof setInterval> | null = null;
    const startStatsMonitoring = () => {
        if (statsTimer) return;
        let count = 0;
        statsTimer = setInterval(async () => {
            count++;
            if (pc.connectionState === "closed" || pc.connectionState === "failed" || count > 20) {
                if (statsTimer) {
                    clearInterval(statsTimer);
                    statsTimer = null;
                }
                return;
            }
            try {
                const stats = await pc.getStats();
                let videoStats: any = null;
                stats.forEach(report => {
                    if (report.type === "outbound-rtp" && (report.kind === "video" || report.mediaType === "video")) {
                        videoStats = report;
                    }
                });
                if (videoStats) {
                    logger.debug(`[WHIP] [${token}] Ingest Stats #${count}: ` +
                        `framesSent=${videoStats.framesSent ?? 0}, ` +
                        `framesEncoded=${videoStats.framesEncoded ?? 0}, ` +
                        `bytesSent=${videoStats.bytesSent ?? 0}, ` +
                        `fps=${videoStats.framesPerSecond ?? "?"}, ` +
                        `keyFrames=${videoStats.keyFramesEncoded ?? 0}`);
                }
            } catch {}
        }, 5000);
    };

    pc.addEventListener("connectionstatechange", () => {
        logger.log(`[WHIP] [${token}] PeerConnection connectionState: ${pc.connectionState}`);
        if (pc.connectionState === "connected") {
            logger.log(`[WHIP] [${token}] WebRTC connection fully established! Live video ingest active.`);
            startStatsMonitoring();
        } else if (pc.connectionState === "failed") {
            logger.error(`[WHIP] [${token}] PeerConnection FAILED. Check network/NAT/firewall.`);
        }
    });
    pc.addEventListener("iceconnectionstatechange", () => {
        logger.debug(`[WHIP] [${token}] ICE connectionState: ${pc.iceConnectionState}`);
    });
    pc.addEventListener("signalingstatechange", () => {
        logger.debug(`[WHIP] [${token}] Signaling state: ${pc.signalingState}`);
    });
    pc.addEventListener("icecandidateerror", (err: any) => {
        logger.warn(`[WHIP] [${token}] ICE candidate error:`, err?.errorCode, err?.errorText, err?.url);
    });

    // Explicit sendonly video-only transceiver — correct WHIP semantics.
    const transceiver = pc.addTransceiver(track, { direction: "sendonly" });
    applyCodecPreferences(transceiver, "WHIP");

    logger.debug(`[WHIP] [${token}] Creating SDP offer...`);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc, token, "WHIP", 1500, signal);

    const { sdp, location } = await postSdp(whipUrl, pc.localDescription!.sdp, token, "WHIP", signal);
    logger.debug(`[WHIP] [${token}] Applying remote SDP answer...`);
    await pc.setRemoteDescription({ type: "answer", sdp });

    const resourceUrl = resolveUrl(whipUrl, location);
    if (resourceUrl) {
        setSavedSessionUrl(token, resourceUrl);
    }
    logger.log(`[WHIP] [${token}] Session established successfully! Resource URL: ${resourceUrl ?? "(none)"}`);

    return {
        id: token,
        pc,
        resourceUrl,
        async close() {
            logger.log(`[WHIP] [${token}] Closing WHIP session...`);
            if (statsTimer) {
                clearInterval(statsTimer);
                statsTimer = null;
            }
            await deleteWhipSession(resourceUrl, token);
            removeSavedSessionUrl(token);
            try { pc.close(); } catch {}
            logger.log(`[WHIP] [${token}] WHIP session closed.`);
        }
    };
}

/**
 * Prioritizes codecs according to: AV1 -> HEVC -> VP9 -> VP8 -> H264 -> RTX -> others.
 */
function applyCodecPreferences(transceiver: RTCRtpTransceiver, protocol: "WHIP" | "WHEP"): void {
    if (typeof transceiver.setCodecPreferences !== "function") return;
    if (typeof RTCRtpReceiver.getCapabilities !== "function") return;

    try {
        const caps = RTCRtpReceiver.getCapabilities("video");
        if (!caps?.codecs?.length) return;

        const priority = [
            "video/av1",
            "video/av01",
            "video/h265",
            "video/hevc",
            "video/vp9",
            "video/vp8",
            "video/h264",
            "video/rtx"
        ];

        const sorted = [...caps.codecs].sort((a, b) => {
            const mimeA = a.mimeType.toLowerCase();
            const mimeB = b.mimeType.toLowerCase();
            const indexA = priority.indexOf(mimeA);
            const indexB = priority.indexOf(mimeB);
            const rankA = indexA === -1 ? priority.length : indexA;
            const rankB = indexB === -1 ? priority.length : indexB;
            return rankA - rankB;
        });

        transceiver.setCodecPreferences(sorted);
        logger.debug(`[${protocol}] Configured codec preferences (AV1 -> HEVC -> VP9 -> VP8 -> H264 -> RTX -> others): ${sorted.map(c => c.mimeType).join(", ")}`);
    } catch (err) {
        logger.warn(`[${protocol}] Failed to set codec preferences:`, err);
    }
}

// ---------------------------------------------------------------------------
// WHEP — Viewer only
// ---------------------------------------------------------------------------

/**
 * Subscribe to a Broadcast Box stream via WHEP (receive-only).
 *
 * - Only a recvonly video transceiver is added. Audio is intentionally
 *   omitted so Discord's native per-user audio controls are never touched.
 * - close() does NOT issue DELETE. WHEP viewers do not own the ingest session
 *   and must not attempt to terminate it. The server handles session cleanup.
 */
export async function subscribe(
    whepUrl: string,
    token: string,
    onTrack: (stream: MediaStream, track: MediaStreamTrack) => void,
    signal?: AbortSignal
): Promise<WhipSession> {
    if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
    }

    logger.log(`[WHEP] Initializing WHEP subscriber for token "${token}"`);
    const pc = new RTCPeerConnection({
        iceServers: ICE_SERVERS,
        bundlePolicy: "max-bundle"
    });

    if (signal?.aborted) {
        try { pc.close(); } catch {}
        throw new DOMException("Aborted", "AbortError");
    }

    pc.addEventListener("connectionstatechange", () => {
        logger.log(`[WHEP] [${token}] PeerConnection connectionState: ${pc.connectionState}`);
    });
    pc.addEventListener("iceconnectionstatechange", () => {
        logger.debug(`[WHEP] [${token}] ICE connectionState: ${pc.iceConnectionState}`);
    });

    // Recvonly video transceiver — we only want to receive, not send.
    const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
    applyCodecPreferences(transceiver, "WHEP");

    pc.ontrack = e => {
        logger.log(`[WHEP] [${token}] Remote track received: kind=${e.track.kind}, id=${e.track.id}`);
        e.track.enabled = true;
        const stream = e.streams[0] || new MediaStream([e.track]);
        onTrack(stream, e.track);
    };

    logger.debug(`[WHEP] [${token}] Creating SDP offer...`);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc, token, "WHEP", 1500, signal);

    const { sdp, location } = await postSdp(whepUrl, pc.localDescription!.sdp, token, "WHEP", signal);
    logger.debug(`[WHEP] [${token}] Applying remote SDP answer...`);
    await pc.setRemoteDescription({ type: "answer", sdp });

    const resourceUrl = resolveUrl(whepUrl, location);
    logger.log(`[WHEP] [${token}] WHEP subscription established.`);

    return {
        id: token,
        pc,
        resourceUrl,
        async close() {
            logger.log(`[WHEP] [${token}] Closing WHEP subscription.`);
            try { pc.close(); } catch {}
        }
    };
}
