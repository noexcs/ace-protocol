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
export class SeenMessageIds {
    seen = new Map();
    capacity;
    constructor(capacity) {
        if (!Number.isInteger(capacity) || capacity < 1)
            throw new Error("dedup capacity must be a positive integer");
        this.capacity = capacity;
    }
    /** Whether this identity was handled before. */
    has(sender, id) {
        return this.seen.has(`${sender}\u0000${id}`);
    }
    /**
     * Record an identity as handled.
     *
     * Only call this once the event was actually dealt with: recording it up front would make a
     * redelivery after a failed attempt look like a duplicate and silently drop it.
     */
    remember(sender, id) {
        const key = `${sender}\u0000${id}`;
        this.seen.set(key, true);
        if (this.seen.size > this.capacity) {
            const oldest = this.seen.keys().next();
            if (!oldest.done)
                this.seen.delete(oldest.value);
        }
    }
    get size() {
        return this.seen.size;
    }
}
//# sourceMappingURL=seen-message-ids.js.map