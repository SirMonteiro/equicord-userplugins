/*
 * Vencord, a Discord client mod
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import { StreamKind } from "./types";
import { WhepSubscription } from "./WhepSubscription";

const logger = new Logger("WhipRelay:WhepMgr", "#e5a00d");

function makeKey(userId: string, kind: StreamKind): string {
    return `${userId}-${kind}`;
}

/**
 * Manages all active WHEP subscriptions across users and stream kinds.
 *
 * Implements Single Responsibility Principle (managing subscription collection),
 * keeping active WebRTC connections persistent and independent of DOM lifecycles.
 */
export class WhepSubscriptionManager {
    private readonly subscriptions = new Map<string, WhepSubscription>();

    /**
     * Retrieves an existing active subscription or creates and starts a new one.
     */
    public getOrCreate(userId: string, kind: StreamKind, baseUrl: string): WhepSubscription {
        const key = makeKey(userId, kind);
        const existing = this.subscriptions.get(key);

        if (existing && existing.isAlive()) {
            return existing;
        }

        if (existing) {
            existing.close().catch(() => {});
            this.subscriptions.delete(key);
        }

        logger.log(`Creating new persistent WHEP subscription for ${key}`);
        const sub = new WhepSubscription(baseUrl, userId, kind);
        this.subscriptions.set(key, sub);
        sub.start();
        return sub;
    }

    /**
     * Get an active subscription if one exists.
     */
    public get(userId: string, kind: StreamKind): WhepSubscription | undefined {
        const sub = this.subscriptions.get(makeKey(userId, kind));
        return sub && sub.isAlive() ? sub : undefined;
    }

    /**
     * Check if an active subscription exists.
     */
    public has(userId: string, kind: StreamKind): boolean {
        return this.get(userId, kind) !== undefined;
    }

    /**
     * Close a specific stream subscription (e.g. when broadcaster stops screenshare or camera).
     */
    public async close(userId: string, kind: StreamKind): Promise<void> {
        const key = makeKey(userId, kind);
        const sub = this.subscriptions.get(key);
        if (sub) {
            logger.log(`Closing subscription for ${key}`);
            this.subscriptions.delete(key);
            await sub.close();
        }
    }

    /**
     * Close all subscriptions for a specific user (e.g. when user leaves voice channel).
     */
    public async closeForUser(userId: string): Promise<void> {
        await Promise.all([
            this.close(userId, "scrn"),
            this.close(userId, "cam")
        ]);
    }

    /**
     * Close all active subscriptions across all users (e.g. local user leaves voice channel).
     */
    public async closeAll(): Promise<void> {
        const subs = Array.from(this.subscriptions.values());
        this.subscriptions.clear();
        await Promise.all(subs.map(s => s.close()));
    }
}

export const whepSubscriptionManager = new WhepSubscriptionManager();
