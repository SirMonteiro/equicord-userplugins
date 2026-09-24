/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { StreamKind } from "./types";
import { WhepSubscription } from "./WhepSubscription";

const logger = new Logger("WhipRelay:VideoHook", "#e5a00d");

const NATIVE_SRC_OBJECT_DESC = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    "srcObject"
) ?? Object.getOwnPropertyDescriptor(
    HTMLVideoElement.prototype,
    "srcObject"
);

function nativeSet(el: HTMLVideoElement, value: MediaStream | null): void {
    if (NATIVE_SRC_OBJECT_DESC?.set) {
        try {
            NATIVE_SRC_OBJECT_DESC.set.call(el, value);
            return;
        } catch {}
    }
    try {
        (el as any).srcObject = value;
    } catch {}
}

/**
 * Single Responsibility: Hooks a DOM <video> element to an active WhepSubscription.
 *
 * - Locks `srcObject` so Discord's native media engine does not clear or overwrite it.
 * - Handles autoplay and playback lifecycle events.
 * - Hides Discord placeholder spinners and loading covers once live video frames render.
 * - Restores DOM state cleanly when unmounted without altering the DOM hierarchy.
 */
export class VideoHook {
    public readonly videoEl: HTMLVideoElement;
    public readonly subscription: WhepSubscription;

    private readonly detachSubscription: () => void;
    private readonly hiddenLoadingElements: HTMLElement[] = [];
    private currentStream: MediaStream | null = null;
    private destroyed = false;

    constructor(videoEl: HTMLVideoElement, subscription: WhepSubscription) {
        this.videoEl = videoEl;
        this.subscription = subscription;

        this.detachSubscription = this.subscription.attach(videoEl, stream => {
            if (this.destroyed) return;
            this.applyStream(stream);
        });
    }

    public getUserId(): string {
        return this.subscription.userId;
    }

    public getKind(): StreamKind {
        return this.subscription.kind;
    }

    public isActive(): boolean {
        if (this.destroyed) return false;
        const doc = this.videoEl.ownerDocument;
        return Boolean(doc?.body && doc.body.contains(this.videoEl));
    }

    /**
     * Reapplies playback and placeholder hiding if Discord re-rendered styles.
     */
    public reapply(): void {
        if (this.destroyed || !this.currentStream) return;

        const desc = Object.getOwnPropertyDescriptor(this.videoEl, "srcObject");
        if (!desc || typeof desc.get !== "function") {
            this.applyStream(this.currentStream);
            return;
        }

        if (this.videoEl.paused) {
            this.videoEl.play().catch(() => {});
        }

        if (this.hasRenderedFrames()) {
            this.hidePlaceholders();
        }
    }

    /**
     * Unhooks video element, cleans up locked properties, and restores placeholder visibility.
     * Does NOT close the persistent WhepSubscription!
     */
    public destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;

        this.detachSubscription();
        this.restoreNativeState();
    }

    private applyStream(stream: MediaStream): void {
        this.currentStream = stream;

        this.videoEl.setAttribute("autoplay", "");
        this.videoEl.setAttribute("playsinline", "");
        this.videoEl.setAttribute("muted", "");
        this.videoEl.autoplay = true;
        this.videoEl.playsInline = true;
        this.videoEl.muted = true;
        this.videoEl.style.objectFit = "contain";

        if (this.videoEl.style.display === "none") {
            this.videoEl.style.display = "";
        }
        if (this.videoEl.style.visibility === "hidden") {
            this.videoEl.style.visibility = "";
        }

        nativeSet(this.videoEl, stream);

        const self = this;
        Object.defineProperty(this.videoEl, "srcObject", {
            configurable: true,
            enumerable: true,
            get(): MediaStream | null { return self.currentStream; },
            set(_v: unknown): void { /* Block Discord media engine overwriting */ }
        });

        this.videoEl.play().catch(() => {});

        const onFrameReady = () => {
            if (this.destroyed) return;
            if (this.videoEl.paused) {
                this.videoEl.play().catch(() => {});
            }
            this.hidePlaceholders();
        };

        this.videoEl.addEventListener("loadeddata", onFrameReady, { once: true });
        this.videoEl.addEventListener("canplay", onFrameReady, { once: true });
        this.videoEl.addEventListener("playing", onFrameReady, { once: true });

        const [videoTrack] = stream.getVideoTracks();
        if (videoTrack) {
            videoTrack.addEventListener("unmute", onFrameReady, { once: true });
        }

        if (this.hasRenderedFrames()) {
            onFrameReady();
        }
    }

    private hasRenderedFrames(): boolean {
        return this.videoEl.readyState >= 2 || (this.videoEl.videoWidth > 0 && this.videoEl.videoHeight > 0);
    }

    private hidePlaceholders(): void {
        if (this.videoEl.style.display === "none") this.videoEl.style.display = "block";
        if (this.videoEl.style.visibility === "hidden") this.videoEl.style.visibility = "visible";

        const parent = this.videoEl.parentElement;
        if (parent && parent.classList?.contains("media-engine-video")) {
            if (parent.style.display === "none") parent.style.display = "";
            if (parent.style.visibility === "hidden") parent.style.visibility = "";
        }

        // 1. Hide loading preview/emptyPreview placeholder inside videoWrapper container
        const videoWrapper = this.videoEl.closest<HTMLElement>(
            "[class*='videoWrapper_'], [class*='wrapper__48b20']"
        );
        if (videoWrapper) {
            for (const el of Array.from(videoWrapper.querySelectorAll<HTMLElement>(
                "[class*='previewWrapper_'], [class*='emptyPreviewWrapper_'], [class*='emptyPreview_']"
            ))) {
                if (el.style.display !== "none") {
                    el.style.display = "none";
                    if (!this.hiddenLoadingElements.includes(el)) {
                        this.hiddenLoadingElements.push(el);
                    }
                }
            }
        }

        // 2. Direct parent siblings check (e.g. avatar background while video connects)
        if (parent) {
            for (const sibling of Array.from(parent.children)) {
                if (sibling === this.videoEl) continue;
                const el = sibling as HTMLElement;
                if (el.classList?.contains("media-engine-video")) continue;
                if (el.style && el.style.display !== "none") {
                    el.style.display = "none";
                    if (!this.hiddenLoadingElements.includes(el)) {
                        this.hiddenLoadingElements.push(el);
                    }
                }
            }
        }

        // 3. Hide standalone spinner or wandering cubes in the tile (never touching overlays)
        const tile = this.videoEl.closest("[data-selenium-video-tile], [data-call-tile]");
        if (tile) {
            for (const el of Array.from(tile.querySelectorAll<HTMLElement>("[class*='spinner_'], [class*='loadingCube_']"))) {
                if (el.closest("[class*='overlayContainer_']") || el.closest("[class*='indicators_']")) continue;
                if (el.style.display !== "none") {
                    el.style.display = "none";
                    if (!this.hiddenLoadingElements.includes(el)) {
                        this.hiddenLoadingElements.push(el);
                    }
                }
            }
        }
    }

    private restoreNativeState(): void {
        try { delete (this.videoEl as any).srcObject; } catch {}
        nativeSet(this.videoEl, null);

        for (const el of this.hiddenLoadingElements) {
            el.style.display = "";
        }
        this.hiddenLoadingElements.length = 0;
    }
}
