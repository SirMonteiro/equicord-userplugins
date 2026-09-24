/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationStreamingStore, PopoutWindowStore, UserStore, VoiceStateStore } from "@webpack/common";
import { Logger } from "@utils/Logger";

import { VideoHook } from "./VideoHook";
import { whepSubscriptionManager } from "./WhepSubscriptionManager";
import { StreamKind } from "./types";

const logger = new Logger("WhipRelay:Watcher", "#e5a00d");

export interface VideoInjectorOpts {
    baseUrl: string;
    userId: string;
    kind: StreamKind;
}

const SCAN_DEBOUNCE_MS = 250;

interface TargetInfo {
    userId: string;
    kind: StreamKind;
}

// ---------------------------------------------------------------------------
// Document Management (Main Window + Popouts)
// ---------------------------------------------------------------------------

function getAllDocuments(): Document[] {
    const docs: Document[] = [];
    if (typeof document !== "undefined" && document) {
        docs.push(document);
    }
    try {
        if (PopoutWindowStore?.getWindowKeys) {
            for (const key of PopoutWindowStore.getWindowKeys()) {
                const win = PopoutWindowStore.getWindow(key);
                if (win?.document && !docs.includes(win.document)) {
                    docs.push(win.document);
                }
            }
        }
    } catch {}
    return docs;
}

// ---------------------------------------------------------------------------
// Discord State Helpers
// ---------------------------------------------------------------------------

function isUserStreaming(userId: string): boolean {
    try {
        if (ApplicationStreamingStore?.getAnyStreamForUser) {
            return !!ApplicationStreamingStore.getAnyStreamForUser(userId);
        }
    } catch {}
    return false;
}

function isUserCameraActiveInVoiceState(userId: string): boolean {
    try {
        const channelId = (VoiceStateStore as any)?.getCurrentClientVoiceChannelId?.();
        if (channelId) {
            const voiceStates = (VoiceStateStore as any)?.getVoiceStatesForChannel?.(channelId);
            if (voiceStates?.[userId]) {
                return Boolean(voiceStates[userId].selfVideo);
            }
        }
        const state = (VoiceStateStore as any)?.getVoiceStateForUser?.(userId);
        if (state) {
            return Boolean(state.selfVideo);
        }
    } catch {}
    return false;
}

function hasCameraIconInUserList(userId: string, doc: Document): boolean {
    try {
        const selectors = [
            `[data-user-id="${userId}"]`,
            `[data-list-item-id*="${userId}"]`
        ];
        for (const sel of selectors) {
            for (const el of Array.from(doc.querySelectorAll<HTMLElement>(sel))) {
                if (el.closest("[data-selenium-video-tile]")) continue;
                const hasCam = !!el.querySelector(
                    "svg[class*='camera_'], [class*='cameraIcon_'], [aria-label*='Camera'], [aria-label*='Vídeo'], [aria-label*='Video']"
                );
                if (hasCam) return true;
            }
        }
    } catch {}
    return false;
}

function tileHasCameraError(tile: HTMLElement): boolean {
    const t = tile.textContent ?? "";
    return t.includes("Failed to start camera") || t.includes("Failed to start your camera");
}

function getFiber(node: any): any {
    if (!node) return null;
    const key = Object.keys(node).find(
        k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
    );
    return key ? node[key] : null;
}

function isCameraActiveForUser(userId: string, tile: HTMLElement): boolean {
    if (isUserCameraActiveInVoiceState(userId)) return true;
    if (hasCameraIconInUserList(userId, tile.ownerDocument)) return true;
    if (tileHasCameraError(tile)) return true;

    let fiber = getFiber(tile);
    let depth = 0;
    while (fiber && depth < 8) {
        const p = fiber.memoizedProps;
        if (p?.participant?.voiceState?.selfVideo || p?.participant?.user?.selfVideo || p?.video === true) {
            return true;
        }
        fiber = fiber.return;
        depth++;
    }

    return false;
}

function hasLiveBadgeInTile(tile: HTMLElement): boolean {
    if (tile.querySelector("[class*='liveIndicator_'], [class*='live_'], [class*='liveSmall_']")) {
        return true;
    }
    const indicators = tile.querySelector("[class*='indicators_']");
    if (indicators) {
        const text = (indicators.textContent ?? "").toLowerCase();
        if (text.includes("live") || text.includes("ao vivo")) return true;
    }
    const overlay = tile.querySelector("[class*='overlayContainer_'], [class*='overlayBottom_'], [class*='overlayTop_']");
    if (overlay) {
        const text = (overlay.textContent ?? "").toLowerCase();
        if (text.includes("live") || text.includes("ao vivo")) return true;
    }
    const focusTarget = tile.querySelector("[class*='focusTarget_']");
    const ariaLabel = (focusTarget?.getAttribute("aria-label") ?? "").toLowerCase();
    if (ariaLabel.includes(", stream,") || ariaLabel.includes(", transmissão,")) {
        return true;
    }
    const walker = tile.ownerDocument.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
        const val = (node.textContent ?? "").trim().toLowerCase();
        if (val === "live" || val === "ao vivo") return true;
    }
    return false;
}

function hasLiveBadgeInHeader(doc: Document): boolean {
    const header = doc.querySelector(
        "[class*='header_'] [class*='liveIndicator_'], " +
        "[class*='header_'] [class*='live_'], " +
        "[class*='topControls_'] [class*='liveIndicator_'], " +
        "[class*='videoControls_'] [class*='liveIndicator_'], " +
        "[class*='callContainer_'] [class*='liveIndicator_'], " +
        "[class*='stageSection_'] [class*='liveIndicator_']"
    );
    if (header) return true;

    const headers = doc.querySelectorAll<HTMLElement>("[class*='header_'], [class*='topControls_']");
    for (const h of Array.from(headers)) {
        const t = (h.textContent ?? "").toLowerCase();
        if (t.includes("live") || t.includes("ao vivo")) return true;
    }
    return false;
}

function tileHasWatchStreamButton(tile: HTMLElement): boolean {
    const text = tile.textContent ?? "";
    if (
        text.includes("Watch Stream") ||
        text.includes("Assistir à transmissão") ||
        text.includes("Assistir transmissão")
    ) {
        return true;
    }
    for (const btn of Array.from(tile.querySelectorAll("button, [role='button']"))) {
        const btnText = (btn.textContent ?? "").trim().toLowerCase();
        if (btnText.includes("watch stream") || btnText.includes("assistir")) {
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Candidate Video Search & Resolution
// ---------------------------------------------------------------------------

function findCandidateVideos(doc: Document): HTMLVideoElement[] {
    const results: HTMLVideoElement[] = [];
    const allVideos = doc.querySelectorAll<HTMLVideoElement>("video");

    for (const v of Array.from(allVideos)) {
        if (v.hasAttribute("data-whip-relay")) {
            continue;
        }

        // Skip previews, empty preview boxes, or chat media
        if (v.closest("[class*='previewWrapper_'], [class*='emptyPreviewWrapper_'], [class*='emptyPreview_']")) {
            continue;
        }

        // Must be a call video element:
        // - Direct class media-engine-video (Vesktop)
        // - Parent/ancestor class media-engine-video (Discord Desktop)
        // - Inside videoWrapper / wrapper__48b20
        // - Inside any tile container
        const isCallVideo = !!(
            v.classList.contains("media-engine-video") ||
            v.closest(".media-engine-video") ||
            v.closest("[class*='videoWrapper_'], [class*='wrapper__48b20'], [class*='videoContainer_']") ||
            v.closest("[data-selenium-video-tile], [data-call-tile]")
        );

        if (isCallVideo) {
            results.push(v);
        }
    }

    return results;
}

function resolveUserIdForVideo(video: HTMLVideoElement): string | null {
    // 1. Direct attribute on closest tile
    const tile = video.closest<HTMLElement>("[data-selenium-video-tile], [data-user-id]");
    const attrId = tile?.getAttribute("data-selenium-video-tile") ?? tile?.getAttribute("data-user-id");
    if (attrId && /^\d{17,20}$/.test(attrId)) {
        return attrId;
    }

    // 2. Walk upwards through React Fiber tree for user or participant ID
    let curr: HTMLElement | null = video;
    while (curr && curr !== curr.ownerDocument.body) {
        let fiber = getFiber(curr);
        let depth = 0;
        while (fiber && depth < 8) {
            const p = fiber.memoizedProps;
            const uid = p?.userId ?? p?.participant?.user?.id ?? p?.stream?.userId ?? p?.participant?.id;
            if (uid && /^\d{17,20}$/.test(String(uid))) {
                return String(uid);
            }
            fiber = fiber.return;
            depth++;
        }
        if (curr.hasAttribute("data-selenium-video-tile") || curr.hasAttribute("data-call-tile")) {
            break;
        }
        curr = curr.parentElement;
    }

    // 3. Fallback to ancestor elements
    const ancestor = video.closest<HTMLElement>("[data-user-id], [data-list-item-id]");
    const fallbackId = ancestor?.getAttribute("data-user-id")
        ?? ancestor?.getAttribute("data-list-item-id")?.match(/\d{17,20}/)?.[0];
    if (fallbackId && /^\d{17,20}$/.test(fallbackId)) {
        return fallbackId;
    }

    return null;
}

function resolveStreamKind(video: HTMLVideoElement, userId: string): StreamKind {
    const tile = video.closest<HTMLElement>("[data-selenium-video-tile], [data-call-tile], [class*='tile_']");

    // 1. Live overlay tag on THIS specific tile is the definitive indicator of screenshare
    if (tile && hasLiveBadgeInTile(tile)) {
        return "scrn";
    }

    // 2. Focused stream container in theater/expanded view
    const isFocused = !!video.closest(
        "[class*='focusedVideo_'], [class*='videoFrame_'], [class*='stageSection_']"
    );
    if (isFocused && isUserStreaming(userId)) {
        return "scrn";
    }

    // 3. React Fiber participant check on video and its ancestors
    let curr: HTMLElement | null = video;
    while (curr && curr !== curr.ownerDocument.body) {
        let fiber = getFiber(curr);
        let depth = 0;
        while (fiber && depth < 8) {
            const p = fiber.memoizedProps;
            if (p?.participant?.type === "STREAM" || p?.stream?.type === "STREAM" || p?.context === "stream") {
                return "scrn";
            }
            if (p?.participant?.type === "USER" && p?.participant?.voiceState?.selfVideo) {
                return "cam";
            }
            fiber = fiber.return;
            depth++;
        }
        if (curr.hasAttribute("data-selenium-video-tile") || curr.hasAttribute("data-call-tile")) {
            break;
        }
        curr = curr.parentElement;
    }

    // 4. Focus target aria-label check:
    if (tile) {
        const focusTarget = tile.querySelector("[class*='focusTarget_']");
        const ariaLabel = (focusTarget?.getAttribute("aria-label") ?? "").toLowerCase();
        if (ariaLabel.includes(", stream,") || ariaLabel.includes(", transmissão,")) {
            return "scrn";
        }
    }

    // 5. If this tile lacks the live overlay tag, check if user's webcam is active:
    // This reliably routes the other tile to webcam when both are active!
    if (tile && isCameraActiveForUser(userId, tile)) {
        return "cam";
    }
    if (isUserCameraActiveInVoiceState(userId)) {
        return "cam";
    }

    // 6. Fallback: if user is streaming, default to scrn; otherwise cam
    return isUserStreaming(userId) ? "scrn" : "cam";
}

function qualifyVideo(video: HTMLVideoElement): TargetInfo | null {
    const userId = resolveUserIdForVideo(video);
    if (!userId) return null;

    // Never hook our own broadcaster stream
    const myId = UserStore.getCurrentUser()?.id;
    if (userId === myId) return null;

    // If the tile still shows "Watch Stream" prompt (not yet watching), do not inject screenshare
    const tile = video.closest<HTMLElement>("[data-selenium-video-tile], [data-call-tile], [class*='tile_']");
    if (tile && tileHasWatchStreamButton(tile)) {
        if (isCameraActiveForUser(userId, tile)) {
            return { userId, kind: "cam" };
        }
        return null;
    }

    const kind = resolveStreamKind(video, userId);
    return { userId, kind };
}

// ---------------------------------------------------------------------------
// StreamWatcher
// ---------------------------------------------------------------------------

export class StreamWatcher {
    private observers = new Map<Document, MutationObserver>();
    private readonly baseUrlProvider: () => string;
    private readonly hooks = new Map<HTMLVideoElement, VideoHook>();
    private scanTimer: number | null = null;

    constructor(baseUrlProvider: () => string) {
        this.baseUrlProvider = baseUrlProvider;
    }

    public start(): void {
        this.ensureObservers();
        this.scheduleScan();
    }

    public stop(): void {
        for (const [, obs] of this.observers) {
            obs.disconnect();
        }
        this.observers.clear();

        if (this.scanTimer != null) {
            clearTimeout(this.scanTimer);
            this.scanTimer = null;
        }

        for (const [, hook] of this.hooks) {
            hook.destroy();
        }
        this.hooks.clear();
    }

    public forceInject(userId: string, _username: string): void {
        for (const doc of getAllDocuments()) {
            const videos = findCandidateVideos(doc);
            for (const video of videos) {
                const uid = resolveUserIdForVideo(video);
                if (uid === userId) {
                    const kind = resolveStreamKind(video, userId);
                    const existingHook = this.hooks.get(video);
                    if (existingHook) {
                        existingHook.destroy();
                        this.hooks.delete(video);
                    }
                    const sub = whepSubscriptionManager.getOrCreate(userId, kind, this.baseUrlProvider());
                    const hook = new VideoHook(video, sub);
                    this.hooks.set(video, hook);
                    return;
                }
            }
        }
    }

    private scheduleScan(): void {
        if (this.scanTimer != null) return;
        this.scanTimer = window.setTimeout(() => {
            this.scanTimer = null;
            this.scan();
        }, SCAN_DEBOUNCE_MS);
    }

    private ensureObservers(): void {
        const activeDocs = new Set(getAllDocuments());

        // Disconnect observers for closed documents (e.g. popout closed)
        for (const [doc, obs] of Array.from(this.observers)) {
            if (!activeDocs.has(doc)) {
                obs.disconnect();
                this.observers.delete(doc);
            }
        }

        // Add observer for any active document not yet observed
        for (const doc of activeDocs) {
            if (!this.observers.has(doc) && doc.body) {
                const obs = new MutationObserver(() => this.scheduleScan());
                obs.observe(doc.body, { childList: true, subtree: true });
                this.observers.set(doc, obs);
            }
        }
    }

    private scan(): void {
        this.ensureObservers();

        const docs = getAllDocuments();
        const seenVideos = new Set<HTMLVideoElement>();

        for (const doc of docs) {
            const candidates = findCandidateVideos(doc);
            for (const video of candidates) {
                const target = qualifyVideo(video);
                if (!target) continue;

                seenVideos.add(video);

                const existingHook = this.hooks.get(video);
                if (existingHook) {
                    if (existingHook.getUserId() === target.userId && existingHook.getKind() === target.kind) {
                        existingHook.reapply();
                        continue;
                    }
                    existingHook.destroy();
                    this.hooks.delete(video);
                }

                // Connect to persistent subscription (survives UI re-renders and element swaps!)
                const sub = whepSubscriptionManager.getOrCreate(
                    target.userId,
                    target.kind,
                    this.baseUrlProvider()
                );

                logger.log(`Binding ${target.userId}-${target.kind} video element to persistent WHEP subscription`);
                const hook = new VideoHook(video, sub);
                this.hooks.set(video, hook);
            }
        }

        // Reap hooks for elements that are no longer active or unmounted from DOM
        for (const [video, hook] of Array.from(this.hooks)) {
            if (!seenVideos.has(video) || !hook.isActive()) {
                hook.destroy();
                this.hooks.delete(video);
            } else {
                hook.reapply();
            }
        }
    }
}
