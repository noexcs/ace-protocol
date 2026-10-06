/**
 * In-memory holding area for `manual` events (RFC §7.3, §12).
 *
 * Bounded on purpose: without a cap, an event storm that ask for `manual` activation would grow
 * until the process dies. Expired entries are dropped on every access, so `/ace pending` never
 * shows stale events.
 */
export class PendingEventStore {
    events = [];
    max;
    ttlMs;
    now;
    persist;
    onEvict;
    constructor(options = {}) {
        this.max = options.max ?? 100;
        this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
        this.now = options.now ?? (() => Date.now());
        this.persist = options.persist;
        this.onEvict = options.onEvict;
    }
    get size() {
        return this.list().length;
    }
    /** Retained events, oldest first. */
    list() {
        this.evictExpired();
        return [...this.events];
    }
    store(message, subscriptionName) {
        this.evictExpired();
        const event = { message, subscriptionName, storedAt: this.now() };
        this.events.push(event);
        this.evictOverCapacity();
        this.persist?.(event);
        return event;
    }
    /** Remove and return the first event matching `(sender, id)`. */
    take(sender, id) {
        this.evictExpired();
        const index = this.events.findIndex((event) => event.message.sender === sender && event.message.id === id);
        if (index === -1)
            return undefined;
        return this.events.splice(index, 1)[0];
    }
    /** Adopt events persisted by an earlier session, honouring the current caps. */
    restore(subscriptionName, messages) {
        let restored = 0;
        for (const message of messages) {
            const event = { message, subscriptionName, storedAt: this.now() };
            this.events.push(event);
            restored += 1;
        }
        this.evictOverCapacity();
        return restored;
    }
    evictExpired() {
        const cutoff = this.now() - this.ttlMs;
        for (let index = this.events.length - 1; index >= 0; index -= 1) {
            const event = this.events[index];
            if (event.storedAt >= cutoff)
                continue;
            this.events.splice(index, 1);
            this.onEvict?.(event, "expired");
        }
    }
    evictOverCapacity() {
        while (this.events.length > this.max) {
            const event = this.events.shift();
            if (event)
                this.onEvict?.(event, "capacity");
        }
    }
}
//# sourceMappingURL=pending-event-store.js.map