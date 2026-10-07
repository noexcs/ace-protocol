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
export class PendingEventStore {
	private readonly events: PendingAceEvent[] = [];
	private readonly max: number;
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly persist: ((event: PendingAceEvent) => void) | undefined;
	private readonly onEvict: ((event: PendingAceEvent, reason: PendingEvictionReason) => void) | undefined;

	constructor(options: PendingEventStoreOptions = {}) {
		// Defensive: the config layer rejects a negative capacity, but this store is also constructed by
		// hosts directly, and `evictOverCapacity` loops while `size > max` — a negative bound would spin
		// forever. Anything unusable falls back to "keep nothing" (0) rather than an unbounded loop.
		const max = options.max ?? 100;
		this.max = Number.isFinite(max) && max >= 0 ? Math.floor(max) : 0;
		const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
		this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 24 * 60 * 60 * 1000;
		this.now = options.now ?? (() => Date.now());
		this.persist = options.persist;
		this.onEvict = options.onEvict;
	}

	get size(): number {
		return this.list().length;
	}

	/** Retained events, oldest first. */
	list(): readonly PendingAceEvent[] {
		this.evictExpired();
		return [...this.events];
	}

	store(message: AceMessage, subscriptionName: string): PendingAceEvent {
		this.evictExpired();
		const event: PendingAceEvent = { message, subscriptionName, storedAt: this.now() };
		this.events.push(event);
		this.evictOverCapacity();
		this.persist?.(event);
		return event;
	}

	/** Remove and return the first event matching `(sender, id)`. */
	take(sender: string, id: string): PendingAceEvent | undefined {
		this.evictExpired();
		const index = this.events.findIndex((event) => event.message.sender === sender && event.message.id === id);
		if (index === -1) return undefined;
		return this.events.splice(index, 1)[0];
	}

	/** Adopt events persisted by an earlier session, honouring the current caps. */
	restore(subscriptionName: string, messages: readonly AceMessage[]): number {
		let restored = 0;
		for (const message of messages) {
			const event: PendingAceEvent = { message, subscriptionName, storedAt: this.now() };
			this.events.push(event);
			restored += 1;
		}
		this.evictOverCapacity();
		return restored;
	}

	private evictExpired(): void {
		const cutoff = this.now() - this.ttlMs;
		for (let index = this.events.length - 1; index >= 0; index -= 1) {
			const event = this.events[index] as PendingAceEvent;
			if (event.storedAt >= cutoff) continue;
			this.events.splice(index, 1);
			this.onEvict?.(event, "expired");
		}
	}

	private evictOverCapacity(): void {
		while (this.events.length > this.max) {
			const event = this.events.shift();
			if (event) this.onEvict?.(event, "capacity");
		}
	}
}
