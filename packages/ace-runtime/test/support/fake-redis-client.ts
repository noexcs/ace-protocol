import type { RedisStreamEntry, RedisStreamsClient } from "../../src/transport/redis-streams-client.ts";

/**
 * In-memory {@link RedisStreamsClient} for tests: no broker, no timers.
 *
 * `read` resolves immediately with queued entries, or waits until the test pushes entries
 * or releases the pending read (which stands in for a real `BLOCK` timeout elapsing).
 */
export class FakeRedisStreamsClient implements RedisStreamsClient {
	readonly acked: string[] = [];
	readonly ensuredGroups: Array<[string, string]> = [];
	readonly reads: Array<{ stream: string; group: string; consumer: string; count: number; blockMs: number }> = [];
	connections = 0;
	closes = 0;
	connectError?: unknown;
	ensureGroupError?: unknown;
	readError?: unknown;
	reclaimError?: unknown;
	ackError?: unknown;

	readonly reclaimed: Array<{ consumer: string; minIdleMs: number; count: number }> = [];
	private queued: RedisStreamEntry[] = [];
	private reclaimable: RedisStreamEntry[] = [];
	private pendingRead?: (entries: RedisStreamEntry[]) => void;
	private readonly ackWaiters: Array<{ remaining: number; resolve: () => void }> = [];

	async connect(): Promise<void> {
		this.connections += 1;
		if (this.connectError) throw this.connectError;
	}

	async ensureGroup(stream: string, group: string): Promise<void> {
		if (this.ensureGroupError) throw this.ensureGroupError;
		this.ensuredGroups.push([stream, group]);
	}

	read(stream: string, group: string, consumer: string, count: number, blockMs: number): Promise<RedisStreamEntry[]> {
		this.reads.push({ stream, group, consumer, count, blockMs });
		if (this.readError) return Promise.reject(this.readError);
		const queued = this.queued.splice(0);
		if (queued.length > 0) return Promise.resolve(queued);
		const { promise, resolve } = Promise.withResolvers<RedisStreamEntry[]>();
		this.pendingRead = resolve;
		return promise;
	}

	reclaim(
		_stream: string,
		_group: string,
		consumer: string,
		minIdleMs: number,
		count: number,
	): Promise<RedisStreamEntry[]> {
		this.reclaimed.push({ consumer, minIdleMs, count });
		if (this.reclaimError) return Promise.reject(this.reclaimError);
		return Promise.resolve(this.reclaimable.splice(0, count));
	}

	async ack(_stream: string, _group: string, id: string): Promise<void> {
		if (this.ackError) throw this.ackError;
		this.acked.push(id);
		for (const waiter of [...this.ackWaiters]) {
			waiter.remaining -= 1;
			if (waiter.remaining > 0) continue;
			this.ackWaiters.splice(this.ackWaiters.indexOf(waiter), 1);
			waiter.resolve();
		}
	}

	/** Resolve once at least `count` entries have been acknowledged. */
	waitForAcks(count: number): Promise<void> {
		const missing = count - this.acked.length;
		if (missing <= 0) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.ackWaiters.push({ remaining: missing, resolve });
		return promise;
	}

	async close(): Promise<void> {
		this.closes += 1;
	}

	/** Queue entries for the next read; wakes a blocked read. */
	push(...entries: Array<{ id: string; payload?: string }>): void {
		const resolved: RedisStreamEntry[] = entries.map((entry) => ({ id: entry.id, payload: entry.payload }));
		const pending = this.pendingRead;
		if (pending) {
			this.pendingRead = undefined;
			pending(resolved);
			return;
		}
		this.queued.push(...resolved);
	}

	/** Queue entries for the next reclaim, as a peer's abandoned PEL entries would. */
	pushReclaimable(...entries: Array<{ id: string; payload?: string }>): void {
		this.reclaimable.push(...entries.map((entry) => ({ id: entry.id, payload: entry.payload })));
	}

	/** Complete a blocked read with no entries, as a real `BLOCK` timeout would. */
	releaseRead(): void {
		const pending = this.pendingRead;
		this.pendingRead = undefined;
		pending?.([]);
	}
}
