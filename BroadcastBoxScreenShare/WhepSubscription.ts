/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { StreamKind, SubscriptionState, WhipSession } from "./types";
import { subscribe } from "./whip";

const logger = new Logger("WhipRelay:WhepSub", "#e5a00d");

const ORPHAN_GRACE_PERIOD_MS = 25_000;
const RETRY_DELAY_MS = 3_000;

export type StreamReadyCallback = (stream: MediaStream) => void;

/**
 * Manages the lifecycle of a single persistent WHEP WebRTC connection for a
 * specific remote stream (${userId}-${kind}).
 *
 * Decoupled from individual DOM elements:
 * - Remains active across UI re-renders, layout changes, and popouts.
 * - Broadcasts its live MediaStream to all currently attached DOM elements.
 * - Automatically reconnects if ICE or network fails while the stream is desired.
 * - Closes only when explicitly ended or when orphaned past the grace period.
 */
export class WhepSubscription {
    public readonly userId: string;
    public readonly kind: StreamKind;
    public readonly token: string;

    private readonly baseUrl: string;
    private state: SubscriptionState = "idle";
    private session: WhipSession | null = null;
    private mediaStream: MediaStream | null = null;
    private activeTrack: MediaStreamTrack | null = null;

    private readonly attachedElements = new Set<HTMLVideoElement>();
    private readonly streamListeners = new Set<StreamReadyCallback>();

    private abortController: AbortController | null = null;
    private retryTimer: number | null = null;
    private orphanTimer: number | null = null;
    private connectionGen = 0;

    constructor(baseUrl: string, userId: string, kind: StreamKind) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.userId = userId;
        this.kind = kind;
        this.token = `${userId}-${kind}`;
    }

    public getState(): SubscriptionState {
        return this.state;
    }

    public getStream(): MediaStream | null {
        return this.mediaStream;
    }

    public isAlive(): boolean {
        return this.state !== "closed";
    }

    public isConnected(): boolean {
        return this.state === "connected" && this.mediaStream != null;
    }

    public getAttachedCount(): number {
        return this.attachedElements.size;
    }

    /**
     * Start the WHEP connection if not already connecting or connected.
     */
    public start(): void {
        if (this.state === "closed") {
            logger.warn(`[${this.token}] Cannot start closed subscription.`);
            return;
        }
        if (this.state === "connected" || this.state === "connecting") {
            return;
        }
        this.connect();
    }

    /**
     * Attach a DOM video element to this subscription.
     * Returns a detachment function to clean up when the element unmounts.
     */
    public attach(videoEl: HTMLVideoElement, onStream: StreamReadyCallback): () => void {
        this.attachedElements.add(videoEl);
        this.streamListeners.add(onStream);

        // Cancel orphan timer if element attached during grace period
        if (this.orphanTimer != null) {
            clearTimeout(this.orphanTimer);
            this.orphanTimer = null;
            logger.debug(`[${this.token}] Element re-attached, orphan grace timer cancelled.`);
        }

        // If media stream is already live, deliver immediately
        if (this.mediaStream) {
            try {
                onStream(this.mediaStream);
            } catch (err) {
                logger.warn(`[${this.token}] Error delivering stream to attached element:`, err);
            }
        } else if (this.state === "idle") {
            this.start();
        }

        let detached = false;
        return () => {
            if (detached) return;
            detached = true;
            this.attachedElements.delete(videoEl);
            this.streamListeners.delete(onStream);

            // If no elements remain attached, start orphan grace timer
            if (this.attachedElements.size === 0 && this.state !== "closed") {
                this.scheduleOrphanGraceTimer();
            }
        };
    }

    /**
     * Closes the subscription, tears down WebRTC session, and releases resources.
     */
    public async close(): Promise<void> {
        if (this.state === "closed") return;
        this.state = "closed";
        this.connectionGen++;

        this.clearTimers();

        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }

        const sess = this.session;
        this.session = null;
        this.mediaStream = null;
        this.activeTrack = null;

        this.attachedElements.clear();
        this.streamListeners.clear();

        if (sess) {
            logger.log(`[${this.token}] Closing active WHEP session...`);
            await sess.close().catch(err => {
                logger.warn(`[${this.token}] Error closing session:`, err);
            });
        }
    }

    private clearTimers(): void {
        if (this.retryTimer != null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.orphanTimer != null) {
            clearTimeout(this.orphanTimer);
            this.orphanTimer = null;
        }
    }

    private scheduleOrphanGraceTimer(): void {
        if (this.orphanTimer != null || this.state === "closed") return;
        logger.debug(`[${this.token}] No elements attached. Starting ${ORPHAN_GRACE_PERIOD_MS}ms orphan grace timer.`);
        this.orphanTimer = window.setTimeout(() => {
            this.orphanTimer = null;
            if (this.attachedElements.size === 0 && this.state !== "closed") {
                logger.log(`[${this.token}] Orphan grace timer expired with 0 attached elements. Closing subscription.`);
                this.close();
            }
        }, ORPHAN_GRACE_PERIOD_MS);
    }

    private scheduleRetry(): void {
        if (this.retryTimer != null || this.state === "closed") return;
        this.state = "reconnecting";
        logger.debug(`[${this.token}] Scheduling reconnect in ${RETRY_DELAY_MS}ms...`);
        this.retryTimer = window.setTimeout(() => {
            this.retryTimer = null;
            if (this.state !== "closed") {
                this.connect();
            }
        }, RETRY_DELAY_MS);
    }

    private async connect(): Promise<void> {
        const gen = ++this.connectionGen;
        this.clearTimers();

        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();

        if (this.session) {
            await this.session.close().catch(() => {});
            this.session = null;
        }
        this.mediaStream = null;
        this.activeTrack = null;

        if (this.state === "closed" || gen !== this.connectionGen) return;

        this.state = "connecting";
        const whepUrl = `${this.baseUrl}/api/whep`;
        logger.log(`[WHEP] Subscribing to token "${this.token}" at ${whepUrl}`);

        try {
            const session = await subscribe(
                whepUrl,
                this.token,
                (stream, track) => {
                    if (this.state === "closed" || gen !== this.connectionGen) return;
                    if (track.kind !== "video") return;

                    logger.log(`[WHEP] [${this.token}] Video track ready (id: ${track.id}, state: ${track.readyState})`);
                    this.mediaStream = stream;
                    this.activeTrack = track;
                    this.state = "connected";

                    // Notify all current listeners
                    for (const listener of Array.from(this.streamListeners)) {
                        try {
                            listener(stream);
                        } catch (err) {
                            logger.warn(`[${this.token}] Listener callback error:`, err);
                        }
                    }

                    track.addEventListener("ended", () => {
                        if (this.state === "closed" || gen !== this.connectionGen) return;
                        logger.log(`[WHEP] [${this.token}] Track ended. Attempting reconnect...`);
                        this.mediaStream = null;
                        this.activeTrack = null;
                        this.scheduleRetry();
                    }, { once: true });
                },
                this.abortController.signal
            );

            if (this.state === "closed" || gen !== this.connectionGen) {
                session.close().catch(() => {});
                return;
            }

            this.session = session;

            session.pc.addEventListener("connectionstatechange", () => {
                if (this.state === "closed" || gen !== this.connectionGen) return;
                const cs = session.pc.connectionState;
                logger.debug(`[WHEP] [${this.token}] Connection state: ${cs}`);
                if (cs === "failed" || cs === "closed") {
                    this.mediaStream = null;
                    this.activeTrack = null;
                    this.scheduleRetry();
                }
            });

            // Guard against silent stream stalls (SDP answered but no track received within 6s)
            window.setTimeout(() => {
                if (this.state === "connecting" && !this.mediaStream && gen === this.connectionGen) {
                    logger.debug(`[WHEP] [${this.token}] Still waiting for video track after 6s. Retrying...`);
                    this.scheduleRetry();
                }
            }, 6_000);

        } catch (err: any) {
            if (err?.name === "AbortError" || this.abortController?.signal.aborted) {
                return;
            }
            logger.warn(`[WHEP] [${this.token}] Subscription failed:`, err);
            if (this.state !== "closed" && gen === this.connectionGen) {
                this.scheduleRetry();
            }
        }
    }
}
