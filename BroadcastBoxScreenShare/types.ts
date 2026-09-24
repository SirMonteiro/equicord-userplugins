/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type StreamKind = "scrn" | "cam";

export interface WhipSession {
    readonly id: string;
    readonly pc: RTCPeerConnection;
    /** The WHIP/WHEP session resource URL returned in the Location header. */
    readonly resourceUrl: string | null;
    close(): Promise<void>;
}

export type SubscriptionState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";
