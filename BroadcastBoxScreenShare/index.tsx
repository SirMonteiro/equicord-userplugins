/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FluxDispatcher, UserStore, MediaEngineStore, VoiceStateStore } from "@webpack/common";
import { findByProps, wreq } from "@webpack";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Logger } from "@utils/Logger";

import { StreamKind, WhipSession } from "./types";
import { publish } from "./whip";
import { StreamWatcher } from "./StreamWatcher";
import { whepSubscriptionManager } from "./WhepSubscriptionManager";

const logger = new Logger("WhipRelay", "#e5a00d");

const settings = definePluginSettings({
    baseUrl: {
        type: OptionType.STRING,
        description: "Broadcast Box base URL (no trailing slash)",
        default: "https://stream.gabrielsouza.top"
    }
});

// ---------------------------------------------------------------------------
// Publisher Manager (Single Responsibility: publishing lifecycle)
// ---------------------------------------------------------------------------

class PublisherManager {
    private readonly active = new Map<StreamKind, WhipSession>();
    private readonly pending = new Map<StreamKind, { abort: () => void; id: number }>();
    private readonly currentTrackId = new Map<StreamKind, string>();
    private readonly currentStreamId = new Map<StreamKind, string | number>();
    private sessionCounter = 0;

    public isCurrent(kind: StreamKind, streamId?: string | number, trackId?: string): boolean {
        const isBusy = this.active.has(kind) || this.pending.has(kind);
        if (!isBusy) return false;

        const curStreamId = this.currentStreamId.get(kind);
        const curTrackId = this.currentTrackId.get(kind);

        if (streamId != null && curStreamId != null && String(streamId) !== String(curStreamId)) {
            return false;
        }
        if (trackId != null && curTrackId != null && trackId !== curTrackId) {
            return false;
        }
        return true;
    }

    public isBusy(kind: StreamKind): boolean {
        return this.active.has(kind) || this.pending.has(kind);
    }

    public async start(kind: StreamKind, track: MediaStreamTrack, streamId?: string | number): Promise<void> {
        if (this.isCurrent(kind, streamId, track.id)) {
            logger.debug(`${kind} is already running track ${track.id} for streamId ${streamId}.`);
            return;
        }

        // Seamlessly update track on active WebRTC connection if already connected
        const activeSession = this.active.get(kind);
        if (activeSession && activeSession.pc.connectionState === "connected") {
            const sender = activeSession.pc.getSenders().find(s => s.track?.kind === "video");
            if (sender) {
                try {
                    logger.log(`Replacing track on active ${kind} WebRTC session with new track id=${track.id} (streamId: ${streamId})`);
                    await sender.replaceTrack(track);
                    this.currentTrackId.set(kind, track.id);
                    if (streamId != null) this.currentStreamId.set(kind, streamId);
                    return;
                } catch (err) {
                    logger.warn(`Failed to replaceTrack for ${kind}, falling back to restart:`, err);
                }
            }
        }

        // If a session is currently pending (e.g. gathering ICE / negotiating for a stale streamId), abort it
        const pendingSession = this.pending.get(kind);
        if (pendingSession) {
            logger.log(`Aborting pending ${kind} session #${pendingSession.id} to switch to streamId ${streamId}...`);
            pendingSession.abort();
            this.pending.delete(kind);
        }

        if (this.active.has(kind)) {
            await this.stop(kind);
        }

        const userId = UserStore.getCurrentUser()?.id;
        if (!userId) {
            logger.error(`Cannot publish ${kind}: current user ID is not available.`);
            return;
        }

        const token = `${userId}-${kind}`;
        const baseUrl = settings.store.baseUrl.replace(/\/+$/, "");
        const endpoint = `${baseUrl}/api/whip`;

        const sessionId = ++this.sessionCounter;
        const abortController = new AbortController();
        let pcToAbort: RTCPeerConnection | null = null;

        const abortFn = () => {
            abortController.abort();
            try { pcToAbort?.close(); } catch {}
        };

        this.pending.set(kind, { abort: abortFn, id: sessionId });
        this.currentTrackId.set(kind, track.id);
        if (streamId != null) this.currentStreamId.set(kind, streamId);

        logger.log(`Starting ${kind} publish session #${sessionId} to ${endpoint} with token: ${token} (streamId: ${streamId})`);

        try {
            const session = await publish(
                endpoint,
                token,
                track,
                (createdPc) => {
                    pcToAbort = createdPc;
                    if (abortController.signal.aborted) {
                        try { createdPc.close(); } catch {}
                    }
                },
                abortController.signal
            );

            if (abortController.signal.aborted) {
                logger.log(`Session #${sessionId} was aborted during connection, closing.`);
                session.close().catch(() => {});
                return;
            }

            this.active.set(kind, session);
            logger.log(`Successfully registered active publisher #${sessionId} for ${kind} (${token})`);
        } catch (err: any) {
            if (err?.name !== "AbortError" && !abortController.signal.aborted) {
                logger.error(`Failed to publish ${kind} session #${sessionId}:`, err);
            }
        } finally {
            const curPending = this.pending.get(kind);
            if (curPending && curPending.id === sessionId) {
                this.pending.delete(kind);
            }
        }
    }

    public async stop(kind: StreamKind): Promise<void> {
        const pendingSession = this.pending.get(kind);
        if (pendingSession) {
            pendingSession.abort();
            this.pending.delete(kind);
        }
        this.currentTrackId.delete(kind);
        this.currentStreamId.delete(kind);
        const session = this.active.get(kind);
        if (!session) return;
        this.active.delete(kind);
        logger.log(`Stopping active ${kind} publisher...`);
        await session.close().catch(e => logger.warn(`Close failed for ${kind}:`, e));
        logger.log(`Active ${kind} publisher stopped.`);
    }

    public async stopAll(): Promise<void> {
        await Promise.all([this.stop("scrn"), this.stop("cam")]);
    }
}

const publisherManager = new PublisherManager();

// ---------------------------------------------------------------------------
// Direct Video Manager (Single Responsibility: Discord Direct Video sink acquisition)
// ---------------------------------------------------------------------------

interface DirectVideoHandle {
    stream: MediaStream;
    release?: () => void;
}

interface DirectVideoModule {
    nz: (streamId: string | number) => DirectVideoHandle;
    au?: unknown;
    sj?: unknown;
}

class DirectVideoManager {
    private cachedModule: DirectVideoModule | null = null;
    private readonly directStreams = new Map<string | number, MediaStream>();
    private desktopReleaseFn: (() => void) | null = null;
    private camReleaseFn: (() => void) | null = null;

    public cacheStream(streamId: string | number, stream: MediaStream): void {
        (stream as any).__discordStreamId = streamId;
        this.directStreams.set(streamId, stream);
    }

    public getCachedStream(streamId: string | number): MediaStream | undefined {
        return this.directStreams.get(streamId);
    }

    public clearCache(): void {
        this.directStreams.clear();
    }

    public findModule(): DirectVideoModule | null {
        if (this.cachedModule) return this.cachedModule;

        try {
            if (typeof wreq === "function") {
                const direct = wreq(229209);
                if (direct && typeof direct.nz === "function") {
                    this.cachedModule = direct;
                    return direct;
                }
            }
        } catch {}

        try {
            if (typeof wreq === "function" && wreq.m) {
                for (const id of Object.keys(wreq.m)) {
                    const factory = wreq.m[id];
                    if (typeof factory === "function") {
                        const code = Function.prototype.toString.call(factory);
                        if (code.includes("Direct video streams are unavailable") || (code.includes("createDiscordStream") && code.includes("addDirectVideoOutputSink"))) {
                            const mod = wreq(id);
                            if (mod && typeof mod.nz === "function") {
                                this.cachedModule = mod;
                                return mod;
                            }
                        }
                    }
                }
            }
        } catch {}

        try {
            if (typeof wreq === "function" && wreq.c) {
                for (const id in wreq.c) {
                    const exp = wreq.c[id]?.exports;
                    if (exp && typeof exp.nz === "function" && typeof exp.au === "function") {
                        this.cachedModule = exp;
                        return exp;
                    }
                }
            }
        } catch {}

        try {
            const byProps = findByProps("nz", "au", "sj");
            if (byProps && typeof byProps.nz === "function") {
                this.cachedModule = byProps;
                return byProps;
            }
        } catch {}

        return null;
    }

    public acquire(streamId: string | number, kind: StreamKind): MediaStream | null {
        // 1. Try cached stream from createDiscordStream or srcObject hook
        const cached = this.directStreams.get(streamId);
        if (cached && hasVideoTracks(cached)) {
            logger.log(`Acquired stream from directStreams cache for ${kind} (${streamId})`);
            return cached;
        }

        // 2. Try DirectVideo module
        const mod = this.findModule();
        if (mod && typeof mod.nz === "function") {
            try {
                logger.log(`Calling DirectVideo.nz(${streamId}) for ${kind}...`);
                const handle = mod.nz(streamId);
                if (handle?.stream && hasVideoTracks(handle.stream)) {
                    const stream = handle.stream;
                    (stream as any).__discordStreamId = streamId;

                    const release = () => {
                        try { handle.release?.(); } catch {}
                    };

                    if (kind === "scrn") {
                        this.releaseDesktop();
                        this.desktopReleaseFn = release;
                    } else {
                        this.releaseCam();
                        this.camReleaseFn = release;
                    }

                    logger.log(`Successfully acquired ${kind} stream from DirectVideo.nz:`, stream);
                    return stream;
                } else {
                    logger.warn(`DirectVideo.nz(${streamId}) returned object without video tracks:`, handle);
                }
            } catch (err) {
                logger.error(`DirectVideo.nz(${streamId}) error:`, err);
            }
        } else {
            logger.warn("DirectVideo module not found.");
        }

        return null;
    }

    public releaseDesktop(): void {
        if (this.desktopReleaseFn) {
            try { this.desktopReleaseFn(); } catch {}
            this.desktopReleaseFn = null;
        }
    }

    public releaseCam(): void {
        if (this.camReleaseFn) {
            try { this.camReleaseFn(); } catch {}
            this.camReleaseFn = null;
        }
    }

    public releaseAll(): void {
        this.releaseDesktop();
        this.releaseCam();
        this.clearCache();
    }
}

const directVideoManager = new DirectVideoManager();

// ---------------------------------------------------------------------------
// Track acquisition and media helpers
// ---------------------------------------------------------------------------

let currentDesktopTrack: MediaStreamTrack | null = null;
let currentCamTrack: MediaStreamTrack | null = null;

let isScreenSharingActive = false;
let isCameraActive = false;
let ownScreenshareStreamId: string | number | null = null;
let ownCameraStreamId: string | number | null = null;

function hasVideoTracks(val: any): boolean {
    if (!val) return false;
    try {
        if (typeof val.getVideoTracks === "function") {
            return val.getVideoTracks().length > 0;
        }
    } catch {}
    return false;
}

function isDesktopCapture(constraints?: MediaStreamConstraints): boolean {
    const mandatory = (constraints?.video as any)?.mandatory;
    return mandatory?.chromeMediaSource === "desktop"
        || mandatory?.chromeMediaSource === "screen";
}

function extractDesktopSourceId(sourceConfig: any): string | null {
    if (!sourceConfig) return null;
    if (typeof sourceConfig === "string") return sourceConfig;
    return (
        sourceConfig.desktopDescription?.id ??
        sourceConfig.desktopSource?.id ??
        sourceConfig.id ??
        null
    );
}

async function onDesktopStreamAcquired(stream: MediaStream, sourceHint: string, streamId?: string | number): Promise<void> {
    const videoTracks = typeof stream?.getVideoTracks === "function" ? stream.getVideoTracks() : [];
    if (videoTracks.length === 0) {
        logger.warn(`Stream from ${sourceHint} has no video tracks for scrn.`);
        return;
    }

    const originalTrack = videoTracks[0];
    if (currentCamTrack && (originalTrack === currentCamTrack || originalTrack.id === currentCamTrack.id)) {
        logger.debug(`Track from ${sourceHint} matches current camera, skipping for scrn.`);
        return;
    }

    const actualStreamId = streamId ?? (stream as any).__discordStreamId ?? ownScreenshareStreamId;
    if (ownScreenshareStreamId != null && actualStreamId != null && String(actualStreamId) !== String(ownScreenshareStreamId)) {
        logger.debug(`Stream from ${sourceHint} has streamId ${actualStreamId} != own screenshare ${ownScreenshareStreamId}. Skipping.`);
        return;
    }

    if (publisherManager.isCurrent("scrn", actualStreamId, originalTrack.id)) {
        logger.debug(`scrn already running track ${originalTrack.id} for streamId ${actualStreamId}.`);
        return;
    }

    logger.log(`Acquired desktop track from ${sourceHint}: id=${originalTrack.id}, label="${originalTrack.label}" (streamId: ${actualStreamId})`);
    currentDesktopTrack = originalTrack;

    const cleanup = () => {
        logger.log(`Desktop track ended (${sourceHint}): id=${originalTrack.id}`);
        if (currentDesktopTrack === originalTrack) {
            currentDesktopTrack = null;
            directVideoManager.releaseDesktop();
            publisherManager.stop("scrn");
        }
    };

    originalTrack.addEventListener("ended", cleanup, { once: true });
    await publisherManager.start("scrn", originalTrack, actualStreamId);
}

async function onCameraStreamAcquired(stream: MediaStream, sourceHint: string, streamId?: string | number): Promise<void> {
    const videoTracks = typeof stream?.getVideoTracks === "function" ? stream.getVideoTracks() : [];
    if (videoTracks.length === 0) {
        logger.warn(`Stream from ${sourceHint} has no video tracks for cam.`);
        return;
    }

    const originalTrack = videoTracks[0];
    const actualStreamId = streamId ?? (stream as any).__discordStreamId ?? ownCameraStreamId;

    if (publisherManager.isCurrent("cam", actualStreamId, originalTrack.id)) {
        logger.debug(`cam already running track ${originalTrack.id} for streamId ${actualStreamId}.`);
        return;
    }

    logger.log(`Acquired camera track from ${sourceHint}: id=${originalTrack.id}, label="${originalTrack.label}" (streamId: ${actualStreamId})`);
    currentCamTrack = originalTrack;

    const cleanup = () => {
        logger.log(`Camera track ended (${sourceHint}): id=${originalTrack.id}`);
        if (currentCamTrack === originalTrack) {
            currentCamTrack = null;
            directVideoManager.releaseCam();
            publisherManager.stop("cam");
        }
    };

    originalTrack.addEventListener("ended", cleanup, { once: true });
    await publisherManager.start("cam", originalTrack, actualStreamId);
}

function acquireStreamForKind(streamId: string | number, kind: StreamKind, retryCount = 0): void {
    if (publisherManager.isCurrent(kind, streamId)) {
        logger.debug(`${kind} is already running or pending streamId ${streamId}.`);
        return;
    }

    const stream = directVideoManager.acquire(streamId, kind);
    if (stream && hasVideoTracks(stream)) {
        if (kind === "scrn") {
            onDesktopStreamAcquired(stream, `acquire(${streamId})`, streamId);
        } else {
            onCameraStreamAcquired(stream, `acquire(${streamId})`, streamId);
        }
        return;
    }

    if (retryCount < 3) {
        setTimeout(() => {
            const currentExpectedId = kind === "scrn" ? ownScreenshareStreamId : ownCameraStreamId;
            if (currentExpectedId != null && String(currentExpectedId) === String(streamId)) {
                logger.debug(`Retrying acquire(${streamId}) for ${kind} (attempt ${retryCount + 1})...`);
                acquireStreamForKind(streamId, kind, retryCount + 1);
            }
        }, 150 * (retryCount + 1));
    }
}

async function handleGoLiveSourceChange(sourceConfig: any): Promise<void> {
    if (!sourceConfig) {
        logger.log("Screen sharing stopping (sourceConfig is falsy).");
        isScreenSharingActive = false;
        ownScreenshareStreamId = null;
        currentDesktopTrack = null;
        directVideoManager.releaseDesktop();
        await publisherManager.stop("scrn");
        return;
    }

    isScreenSharingActive = true;
    logger.log("Screen sharing initiated with config:", sourceConfig);

    if (publisherManager.isCurrent("scrn", ownScreenshareStreamId ?? undefined)) return;

    // 1. If ownScreenshareStreamId is known, acquire via DirectVideo
    if (ownScreenshareStreamId != null) {
        acquireStreamForKind(ownScreenshareStreamId, "scrn");
        return;
    }

    // 2. Fallback for Vesktop/Web: getDisplayMedia or chromeMediaSource
    if (typeof navigator !== "undefined" && navigator.mediaDevices) {
        const sourceId = extractDesktopSourceId(sourceConfig);
        let stream: MediaStream | null = null;
        if (sourceId && typeof navigator.mediaDevices.getUserMedia === "function") {
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: {
                        mandatory: {
                            chromeMediaSource: "desktop",
                            chromeMediaSourceId: sourceId,
                            maxWidth: 3840,
                            maxHeight: 2160
                        }
                    } as any
                });
            } catch (err) {
                logger.debug("chromeMediaSource capture skipped/failed (normal on Discord Desktop):", err);
            }
        }

        if (!stream && typeof navigator.mediaDevices.getDisplayMedia === "function") {
            try {
                stream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        frameRate: sourceConfig?.qualityOptions?.fps || sourceConfig?.quality?.frameRate || 30,
                        height: sourceConfig?.qualityOptions?.resolution || sourceConfig?.quality?.resolution || 1080
                    },
                    audio: false
                });
            } catch {}
        }

        if (stream) {
            await onDesktopStreamAcquired(stream, "mediaDevices");
        }
    }
}

async function handleCameraToggle(enabled: boolean): Promise<void> {
    if (!enabled) {
        logger.log("Camera toggled off.");
        isCameraActive = false;
        ownCameraStreamId = null;
        currentCamTrack = null;
        directVideoManager.releaseCam();
        await publisherManager.stop("cam");
        return;
    }

    isCameraActive = true;
    logger.log("Camera toggled on.");

    if (publisherManager.isBusy("cam")) return;

    // 1. If ownCameraStreamId is known, acquire via DirectVideo
    if (ownCameraStreamId != null) {
        acquireStreamForKind(ownCameraStreamId, "cam");
        return;
    }

    // 2. Fallback for Vesktop/Web: navigator.mediaDevices.getUserMedia
    if (typeof navigator !== "undefined" && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function") {
        try {
            let deviceId: string | undefined;
            try {
                deviceId = MediaEngineStore?.getVideoDeviceId?.();
            } catch {}

            let stream: MediaStream | null = null;
            if (deviceId && deviceId !== "disabled" && deviceId !== "default") {
                try {
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: { deviceId: { exact: deviceId } },
                        audio: false
                    });
                } catch {}
            }
            if (!stream) {
                stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            }
            if (stream) {
                await onCameraStreamAcquired(stream, "getUserMedia");
            }
        } catch (err) {
            logger.debug("getUserMedia camera fallback failed/busy (normal on Discord Desktop):", err);
        }
    }
}

// ---------------------------------------------------------------------------
// Hooks (Single Responsibility: intercept native Discord streams cleanly)
// ---------------------------------------------------------------------------

let origCreateDiscordStream: any = null;
let origSrcObjectDescriptor: PropertyDescriptor | null = null;
let origSetGoLiveSource: any = null;
let origSetVideoEnabled: any = null;
let mediaEngineActionsModule: any = null;

function installDiscordStreamHook(): void {
    const wrap = (fn: any) => {
        return function (this: any, streamId: any, ...args: any[]) {
            logger.debug(`window.createDiscordStream called for streamId: ${streamId}`);
            const stream = fn.apply(this, [streamId, ...args]);
            if (hasVideoTracks(stream)) {
                directVideoManager.cacheStream(streamId, stream);
                if (isScreenSharingActive) {
                    if (ownScreenshareStreamId == null || String(streamId) === String(ownScreenshareStreamId)) {
                        onDesktopStreamAcquired(stream, `createDiscordStream(${streamId})`, streamId);
                    }
                }
                if (isCameraActive) {
                    if (ownCameraStreamId != null && String(streamId) === String(ownCameraStreamId)) {
                        onCameraStreamAcquired(stream, `createDiscordStream(${streamId})`, streamId);
                    }
                }
            }
            return stream;
        };
    };

    if (typeof (window as any).createDiscordStream === "function") {
        origCreateDiscordStream = (window as any).createDiscordStream;
        try {
            (window as any).createDiscordStream = wrap(origCreateDiscordStream);
            logger.log("window.createDiscordStream hook installed directly.");
        } catch (e) {
            logger.warn("Could not overwrite window.createDiscordStream directly:", e);
        }
    } else {
        let _streamFn: any = undefined;
        try {
            Object.defineProperty(window, "createDiscordStream", {
                configurable: true,
                enumerable: true,
                get() { return _streamFn; },
                set(fn) {
                    logger.debug("window.createDiscordStream assigned by Discord runtime.");
                    _streamFn = wrap(fn);
                }
            });
            logger.log("window.createDiscordStream property trap installed.");
        } catch (e) {
            logger.warn("Could not define property trap for createDiscordStream:", e);
        }
    }
}

function uninstallDiscordStreamHook(): void {
    if (origCreateDiscordStream) {
        try { (window as any).createDiscordStream = origCreateDiscordStream; } catch {}
        origCreateDiscordStream = null;
    }
}

function installSrcObjectHook(): void {
    const proto = HTMLMediaElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "srcObject")
        ?? Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, "srcObject");

    if (desc && desc.set && !origSrcObjectDescriptor) {
        origSrcObjectDescriptor = desc;
        Object.defineProperty(proto, "srcObject", {
            configurable: true,
            enumerable: desc.enumerable,
            get: desc.get,
            set(this: HTMLMediaElement, val: any) {
                desc.set!.call(this, val);
                if (hasVideoTracks(val)) {
                    logger.debug("srcObject assigned with video tracks:", val);
                    const streamId = (val as any).__discordStreamId;
                    if (streamId != null) {
                        directVideoManager.cacheStream(streamId, val);
                    }
                    if (isScreenSharingActive) {
                        if (ownScreenshareStreamId == null || (streamId != null && String(streamId) === String(ownScreenshareStreamId))) {
                            onDesktopStreamAcquired(val, `srcObject(${streamId ?? "unknown"})`, streamId);
                        }
                    }
                    if (isCameraActive) {
                        if (ownCameraStreamId != null && streamId != null && String(streamId) === String(ownCameraStreamId)) {
                            onCameraStreamAcquired(val, `srcObject(${streamId})`, streamId);
                        }
                    }
                }
            }
        });
        logger.log("HTMLMediaElement.prototype.srcObject hook installed.");
    }
}

function uninstallSrcObjectHook(): void {
    if (origSrcObjectDescriptor) {
        try { Object.defineProperty(HTMLMediaElement.prototype, "srcObject", origSrcObjectDescriptor); } catch {}
        origSrcObjectDescriptor = null;
    }
}

function installMediaEngineHooks(): void {
    try {
        mediaEngineActionsModule = findByProps("setGoLiveSource");
        if (mediaEngineActionsModule) {
            logger.debug("Hooking MediaEngineActions.setGoLiveSource");
            origSetGoLiveSource = mediaEngineActionsModule.setGoLiveSource;
            mediaEngineActionsModule.setGoLiveSource = function (sourceConfig: any, ...args: any[]) {
                logger.debug("MediaEngineActions.setGoLiveSource called with:", sourceConfig);
                const res = origSetGoLiveSource ? origSetGoLiveSource.apply(this, [sourceConfig, ...args]) : undefined;
                handleGoLiveSourceChange(sourceConfig).catch(e => logger.error("Error handling GoLiveSource change:", e));
                return res;
            };

            if (typeof mediaEngineActionsModule.setVideoEnabled === "function") {
                logger.debug("Hooking MediaEngineActions.setVideoEnabled");
                origSetVideoEnabled = mediaEngineActionsModule.setVideoEnabled;
                mediaEngineActionsModule.setVideoEnabled = function (enabled: boolean, ...args: any[]) {
                    logger.debug("MediaEngineActions.setVideoEnabled called with:", enabled);
                    const res = origSetVideoEnabled ? origSetVideoEnabled.apply(this, [enabled, ...args]) : undefined;
                    handleCameraToggle(Boolean(enabled)).catch(e => logger.error("Error handling video enabled change:", e));
                    return res;
                };
            }
        }
    } catch (e) {
        logger.error("Error installing MediaEngine hooks:", e);
    }
}

function uninstallMediaEngineHooks(): void {
    if (mediaEngineActionsModule) {
        if (origSetGoLiveSource) {
            mediaEngineActionsModule.setGoLiveSource = origSetGoLiveSource;
            origSetGoLiveSource = null;
        }
        if (origSetVideoEnabled) {
            mediaEngineActionsModule.setVideoEnabled = origSetVideoEnabled;
            origSetVideoEnabled = null;
        }
        mediaEngineActionsModule = null;
    }
}

function bindTrackTeardown(
    originalTrack: MediaStreamTrack,
    clonedTrack: MediaStreamTrack,
    kind: StreamKind
): void {
    let cleaned = false;
    const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        logger.log(`Native track ended, cleaning up ${kind} publisher.`);
        publisherManager.stop(kind);
    };

    const nativeStop = originalTrack.stop.bind(originalTrack);
    originalTrack.stop = () => { cleanup(); nativeStop(); };
    originalTrack.addEventListener("ended", cleanup, { once: true });
    clonedTrack.addEventListener("ended", cleanup, { once: true });
}

function installMediaDevicesHooks(): void {
    if (typeof navigator !== "undefined" && navigator.mediaDevices) {
        if (typeof navigator.mediaDevices.getUserMedia === "function") {
            const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getUserMedia = async (constraints): Promise<MediaStream> => {
                logger.debug("navigator.mediaDevices.getUserMedia invoked:", constraints);
                const stream = await origGUM(constraints);
                const [original] = stream.getVideoTracks();
                if (original && constraints?.video) {
                    const kind: StreamKind = isDesktopCapture(constraints) ? "scrn" : "cam";
                    logger.log(`getUserMedia video track acquired for ${kind}: id=${original.id}`);
                    const clone = original.clone();
                    bindTrackTeardown(original, clone, kind);
                    publisherManager.start(kind, clone);
                }
                return stream;
            };
        }

        if (typeof navigator.mediaDevices.getDisplayMedia === "function") {
            const origGDM = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getDisplayMedia = async (opts): Promise<MediaStream> => {
                logger.debug("navigator.mediaDevices.getDisplayMedia invoked:", opts);
                const stream = await origGDM(opts);
                const [original] = stream.getVideoTracks();
                if (original) {
                    logger.log(`getDisplayMedia video track acquired: id=${original.id}`);
                    const clone = original.clone();
                    bindTrackTeardown(original, clone, "scrn");
                    publisherManager.start("scrn", clone);
                }
                return stream;
            };
        }
    }
}

// ---------------------------------------------------------------------------
// Dispatcher Interceptor
// ---------------------------------------------------------------------------

let origDispatch: ((action: any) => Promise<void>) | null = null;

function shouldSuppressAction(action: any): boolean {
    if (!action) return false;
    const type = typeof action.type === "string" ? action.type : "";
    const errorStr = action.error ? String(action.error) : "";
    return (
        type.includes("VIDEO_STREAM_READY_TIMEOUT") ||
        type.includes("VIDEO_STREAM_TIMEOUT") ||
        errorStr.includes("video-stream-receiver-ready-timeout")
    );
}

function installDispatcherInterceptors(): void {
    if (typeof (FluxDispatcher as any)?.setInterceptor === "function") {
        (FluxDispatcher as any).setInterceptor((action: any) => {
            if (shouldSuppressAction(action)) {
                return true;
            }
            return false;
        });
    } else if (FluxDispatcher?.dispatch) {
        origDispatch = FluxDispatcher.dispatch.bind(FluxDispatcher);
        FluxDispatcher.dispatch = function (action: any): Promise<void> {
            if (shouldSuppressAction(action)) {
                return Promise.resolve();
            }
            return origDispatch!(action);
        };
    }
}

function uninstallDispatcherInterceptors(): void {
    if (typeof (FluxDispatcher as any)?.setInterceptor === "function") {
        (FluxDispatcher as any).setInterceptor(null);
    }
    if (origDispatch && FluxDispatcher) {
        FluxDispatcher.dispatch = origDispatch;
        origDispatch = null;
    }
}

// ---------------------------------------------------------------------------
// Plugin Definition
// ---------------------------------------------------------------------------

let watcher: StreamWatcher | null = null;
let beforeUnloadHandler: (() => void) | null = null;

export default definePlugin({
    name: "BroadcastBoxScreenShare",
    description: "Publishes your camera/screen to Broadcast Box via WHIP and replaces other users' stream videos with live WHEP playback. Audio always uses Discord's native route.",
    authors: [{ name: "SirMonteiro", id: 345954606544846852n }],
    settings,

    flux: {
        MEDIA_ENGINE_SET_GO_LIVE_SOURCE(action: any) {
            logger.debug("MEDIA_ENGINE_SET_GO_LIVE_SOURCE:", action);
            if (action?.settings?.desktopSource || action?.source) {
                const source = action.settings?.desktopSource ?? action.source;
                handleGoLiveSourceChange(source);
            } else if (action?.source === null || action?.settings === null) {
                handleGoLiveSourceChange(null);
            }
        },
        MEDIA_ENGINE_SET_VIDEO_ENABLED(action: any) {
            logger.debug("MEDIA_ENGINE_SET_VIDEO_ENABLED:", action);
            if (typeof action?.enabled === "boolean") {
                handleCameraToggle(action.enabled);
            }
        },
        RTC_CONNECTION_VIDEO(action: any) {
            logger.debug("RTC_CONNECTION_VIDEO:", action);
            const myId = UserStore.getCurrentUser()?.id;
            if (action?.userId && myId && action.userId === myId) {
                if (action.context === "stream") {
                    if (action.streamId == null) {
                        logger.log("Current user screenshare stream closed (streamId is null).");
                        handleGoLiveSourceChange(null);
                    } else {
                        const previousStreamId = ownScreenshareStreamId;
                        isScreenSharingActive = true;
                        ownScreenshareStreamId = action.streamId;
                        if (previousStreamId != null && String(previousStreamId) !== String(action.streamId)) {
                            logger.log(`Current user screenshare streamId changed: ${previousStreamId} -> ${action.streamId}. Switching stream...`);
                        } else {
                            logger.log(`Current user screenshare stream active: streamId=${action.streamId}`);
                        }
                        acquireStreamForKind(action.streamId, "scrn");
                    }
                } else {
                    if (action.streamId == null) {
                        logger.log("Current user camera stream closed (streamId is null).");
                        handleCameraToggle(false);
                    } else {
                        const previousStreamId = ownCameraStreamId;
                        isCameraActive = true;
                        ownCameraStreamId = action.streamId;
                        if (previousStreamId != null && String(previousStreamId) !== String(action.streamId)) {
                            logger.log(`Current user camera streamId changed: ${previousStreamId} -> ${action.streamId}. Switching stream...`);
                        } else {
                            logger.log(`Current user camera stream active: streamId=${action.streamId}`);
                        }
                        acquireStreamForKind(action.streamId, "cam");
                    }
                }
            }
        },
        STREAM_DELETE(action: any) {
            const myId = UserStore.getCurrentUser()?.id;
            if (action?.streamKey) {
                const streamUserId = action.streamKey.split(":").pop();
                if (streamUserId) {
                    whepSubscriptionManager.close(streamUserId, "scrn");
                }
                if (myId && action.streamKey.endsWith(myId)) {
                    logger.log("Current user STREAM_DELETE:", action.streamKey);
                    handleGoLiveSourceChange(null);
                }
            }
        },
        VOICE_STATE_UPDATES(action: any) {
            if (!Array.isArray(action?.voiceStates)) return;
            const currentVoiceChannelId = (VoiceStateStore as any)?.getCurrentClientVoiceChannelId?.();
            for (const vs of action.voiceStates) {
                if (!vs.userId) continue;
                if (currentVoiceChannelId && vs.channelId !== currentVoiceChannelId) {
                    whepSubscriptionManager.closeForUser(vs.userId);
                } else if (vs.selfVideo === false) {
                    whepSubscriptionManager.close(vs.userId, "cam");
                }
            }
        },
        VOICE_CHANNEL_SELECT(action: any) {
            if (!action?.channelId) {
                logger.log("Voice channel disconnected. Tearing down all publishers and subscriptions.");
                handleGoLiveSourceChange(null);
                handleCameraToggle(false);
                whepSubscriptionManager.closeAll();
            }
        }
    },

    start() {
        logger.log(`Plugin started. IS_DISCORD_DESKTOP: ${IS_DISCORD_DESKTOP}, Base URL: ${settings.store.baseUrl}`);

        installDiscordStreamHook();
        installSrcObjectHook();
        installMediaEngineHooks();
        installMediaDevicesHooks();
        installDispatcherInterceptors();

        watcher = new StreamWatcher(() => settings.store.baseUrl);
        watcher.start();

        beforeUnloadHandler = () => {
            logger.log("Window beforeunload fired, stopping all publishers, subscriptions, and watcher.");
            handleGoLiveSourceChange(null);
            handleCameraToggle(false);
            publisherManager.stopAll();
            whepSubscriptionManager.closeAll();
            watcher?.stop();
        };
        window.addEventListener("beforeunload", beforeUnloadHandler);
    },

    stop() {
        if (beforeUnloadHandler) {
            window.removeEventListener("beforeunload", beforeUnloadHandler);
            beforeUnloadHandler = null;
        }
        uninstallDiscordStreamHook();
        uninstallSrcObjectHook();
        uninstallMediaEngineHooks();
        uninstallDispatcherInterceptors();
        handleGoLiveSourceChange(null);
        handleCameraToggle(false);
        publisherManager.stopAll();
        directVideoManager.releaseAll();
        whepSubscriptionManager.closeAll();
        watcher?.stop();
        watcher = null;
        logger.log("Plugin stopped.");
    }
});
