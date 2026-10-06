/**
 * Remembers handled `(sender, id)` pairs so a redelivered event is not injected twice (RFC §5.2, §17).
 *
 * At-least-once delivery is the transport's guarantee, so duplicates are normal: a consumer that
 * crashes before acknowledging, a Redis PEL entry that is reclaimed, or a Kafka rebalance can all
 * deliver the same message again. The effect of an ACE event is an agent turn, which is not
 * idempotent, so the runtime has to deduplicate at this boundary.
 *
 * Bounded FIFO: the oldest entry is evicted once `capacity` is reached, so a very old duplicate can
 * still slip through. Capacity is a trade-off between memory and how long a sender's ids are trusted
 * to be unique.
 */
export declare class SeenMessageIds {
    private readonly seen;
    private readonly capacity;
    constructor(capacity: number);
    /** Whether this identity was handled before. */
    has(sender: string, id: string): boolean;
    /**
     * Record an identity as handled.
     *
     * Only call this once the event was actually dealt with: recording it up front would make a
     * redelivery after a failed attempt look like a duplicate and silently drop it.
     */
    remember(sender: string, id: string): void;
    get size(): number;
}
//# sourceMappingURL=seen-message-ids.d.ts.map