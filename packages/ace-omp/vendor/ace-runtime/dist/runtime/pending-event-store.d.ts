import type { AceMessage } from "../protocol/ace-message.ts";
/** A `manual` ACE event retained by the runtime until it is activated (RFC §7.3). */
export interface PendingAceEvent {
    readonly message: AceMessage;
    readonly subscriptionName: string;
    /** Runtime-side bookkeeping for the retention window; not part of the protocol. */
    readonly storedAt: number;
}
export type PendingEvictionReason = "expired" | "capacity";
export interface PendingEventStoreOptions {
    /** Retain at most this many events; the oldest is evicted first (default 100). */
    max?: number;
    /** Drop events older than this (default 24h). */
    ttlMs?: number;
    now?: () => number;
    /** Called for every stored event so a host can persist it. */
    persist?: (event: PendingAceEvent) => void;
    onEvict?: (event: PendingAceEvent, reason: PendingEvictionReason) => void;
}
/**
 * In-memory holding area for `manual` events (RFC §7.3, §12).
 *
 * Bounded on purpose: without a cap, an event storm that ask for `manual` activation would grow
 * until the process dies. Expired entries are dropped on every access, so `/ace pending` never
 * shows stale events.
 */
export declare class PendingEventStore {
    private readonly events;
    private readonly max;
    private readonly ttlMs;
    private readonly now;
    private readonly persist;
    private readonly onEvict;
    constructor(options?: PendingEventStoreOptions);
    get size(): number;
    /** Retained events, oldest first. */
    list(): readonly PendingAceEvent[];
    store(message: AceMessage, subscriptionName: string): PendingAceEvent;
    /** Remove and return the first event matching `(sender, id)`. */
    take(sender: string, id: string): PendingAceEvent | undefined;
    /** Adopt events persisted by an earlier session, honouring the current caps. */
    restore(subscriptionName: string, messages: readonly AceMessage[]): number;
    private evictExpired;
    private evictOverCapacity;
}
//# sourceMappingURL=pending-event-store.d.ts.map