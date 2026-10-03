import {
	AceConfigError,
	type EndpointConfig,
	optionalStringField,
	positiveIntegerField,
	rejectUnknownKeys,
	requiredStringField,
} from "../runtime/endpoint-config.ts";
import type { AceMetrics } from "../runtime/metrics.ts";
import type { RedisStreamEntry, RedisStreamsClient } from "./redis-streams-client.ts";
import { createRedisStreamsClient } from "./redis-streams-node-client.ts";
import type { RawAceMessageHandler, Transport } from "./transport.ts";

/**
 * Redis Streams settings, read from the subscription config (RFC §4.1, §9).
 *
 * These keys are transport configuration, not ACE protocol fields: they never travel
 * inside an ACE message and never map to ACE fields (RFC §4).
 */
export interface RedisStreamsConfig {
	url: string;
	stream: string;
	group: string;
	/** Consumer name inside the group; defaults to `ace-<pid>`. */
	consumer: string;
	/** Stream entry field carrying the ACE message JSON. */
	field: string;
	/** Entries fetched per read. */
	count: number;
	/** Milliseconds `XREADGROUP` blocks before the loop re-checks its stop flag. */
	blockMs: number;
	/** Reclaim entries another consumer left pending for at least this long (0 disables). */
	reclaimIdleMs: number;
	/** Give up on a reclaimed entry after this many delivery attempts. */
	reclaimAttempts: number;
	/** First reconnect delay after a read failure; doubles up to {@link maxRetryDelayMs}. */
	retryDelayMs: number;
	maxRetryDelayMs: number;
}

const DEFAULT_CONSUMER = `ace-${process.pid}`;

/** Defaults shared by the Redis Streams consumer and publisher. */
export const REDIS_STREAMS_DEFAULTS = {
	url: "redis://127.0.0.1:6379",
	field: "message",
	count: 16,
	blockMs: 1000,
	reclaimIdleMs: 60_000,
	reclaimAttempts: 3,
	retryDelayMs: 200,
	maxRetryDelayMs: 5_000,
} as const;

/** Settings a Redis Streams subscription understands inside its `config` object. */
export const REDIS_STREAMS_SUBSCRIPTION_KEYS = [
	"stream",
	"group",
	"url",
	"consumer",
	"field",
	"count",
	"blockMs",
	"reclaimIdleMs",
	"reclaimAttempts",
	"retryDelayMs",
	"maxRetryDelayMs",
] as const;

/** Read an optional non-negative integer setting, falling back to a default. */
function nonNegativeIntegerField(
	config: Record<string, unknown>,
	key: string,
	fallback: number,
	subject: string,
): number {
	const value = config[key];
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new AceConfigError(`${subject} has invalid "${key}": needs an integer >= 0`);
	}
	return value;
}

/** Extract and validate the Redis Streams settings of one subscription. */
export function redisStreamsConfigFrom(subscription: EndpointConfig): RedisStreamsConfig {
	const subject = `subscribe "${subscription.name}" config`;
	const config = subscription.config;
	rejectUnknownKeys(config, REDIS_STREAMS_SUBSCRIPTION_KEYS, subject);
	return {
		url: optionalStringField(config, "url", REDIS_STREAMS_DEFAULTS.url, subject),
		stream: requiredStringField(config, "stream", subject),
		group: requiredStringField(config, "group", subject),
		consumer: optionalStringField(config, "consumer", DEFAULT_CONSUMER, subject),
		field: optionalStringField(config, "field", REDIS_STREAMS_DEFAULTS.field, subject),
		count: positiveIntegerField(config, "count", REDIS_STREAMS_DEFAULTS.count, subject),
		blockMs: positiveIntegerField(config, "blockMs", REDIS_STREAMS_DEFAULTS.blockMs, subject),
		reclaimIdleMs: nonNegativeIntegerField(config, "reclaimIdleMs", REDIS_STREAMS_DEFAULTS.reclaimIdleMs, subject),
		reclaimAttempts: positiveIntegerField(config, "reclaimAttempts", REDIS_STREAMS_DEFAULTS.reclaimAttempts, subject),
		retryDelayMs: positiveIntegerField(config, "retryDelayMs", REDIS_STREAMS_DEFAULTS.retryDelayMs, subject),
		maxRetryDelayMs: positiveIntegerField(config, "maxRetryDelayMs", REDIS_STREAMS_DEFAULTS.maxRetryDelayMs, subject),
	};
}

/** An entry the transport gave up on after `reclaimAttempts` redeliveries. */
export interface DroppedEntry {
	/** Broker entry id, so the record can be traced back to the stream. */
	brokerId: string;
	/** Stream the entry came from; a replay publishes back to exactly this stream. */
	stream: string;
	/** Entry field carrying the AceMessage JSON, so a replay writes the same shape. */
	field: string;
	/** Raw payload exactly as stored, `undefined` when the entry lacked the field. */
	payload: string | undefined;
	/** Delivery attempts made before giving up. */
	attempts: number;
	/** Why it was dropped, for the record. */
	reason: string;
}

export interface RedisStreamsTransportOptions {
	/** Injected client; defaults to a `redis` client for the configured URL. */
	client?: RedisStreamsClient;
	/**
	 * Called with the last copy of an entry the transport gives up on. The entry leaves the PEL
	 * (and stops blocking the group) only once this resolves; a rejection leaves it pending, so a
	 * sink that cannot write makes the loss visible instead of silent.
	 */
	onDropped?: (entry: DroppedEntry) => void | Promise<void>;
	/** Called when the broker connection or the read loop fails. */
	onError?: (error: unknown) => void;
	/** Counter sink for reconnects, reclaimed entries and dropped events. */
	metrics?: AceMetrics;
	/** Injectable delay for tests; defaults to a real timer. */
	delay?: (ms: number) => Promise<void>;
	/** Injectable clock for tests. */
	now?: () => number;
}

/**
 * Consume ACE messages from a Redis Stream consumer group (RFC §4, §17).
 *
 * Delivery policy:
 *
 * - the handler resolving → the entry is acknowledged (`XACK`);
 * - the handler rejecting → the entry stays pending in the group's PEL;
 * - entries another consumer left pending are reclaimed after `reclaimIdleMs` and redelivered, and
 *   dropped after `reclaimAttempts` -- handed to `onDropped` first, then acknowledged;
 * - an entry without the configured payload field → reported and acknowledged;
 * - invalid ACE messages are acknowledged too, because the runtime logs and drops them
 *   instead of rejecting them (RFC §13, design doc §30) — a poison message never blocks
 *   the stream;
 * - a failed read does not end consumption: the loop reconnects with a capped backoff.
 */
export class RedisStreamsTransport implements Transport {
	private readonly config: RedisStreamsConfig;
	private readonly name: string;
	private readonly client: RedisStreamsClient;
	private readonly onError: (error: unknown) => void;
	private readonly onDropped: ((entry: DroppedEntry) => void | Promise<void>) | undefined;
	private readonly metrics: AceMetrics | undefined;
	private readonly delay: (ms: number) => Promise<void>;
	private readonly now: () => number;
	/** Delivery attempts per reclaimed entry id; the transport's own idempotency guard. */
	private readonly reclaimAttempts = new Map<string, number>();
	/** Entries whose dead-letter write already failed: report once, not once per reclaim pass. */
	private readonly reportedDrops = new Set<string>();
	private loop?: Promise<void>;
	private stopped = true;
	private lastReclaimAt = 0;

	constructor(subscription: EndpointConfig, options: RedisStreamsTransportOptions = {}) {
		this.config = redisStreamsConfigFrom(subscription);
		this.name = subscription.name;
		this.onError = options.onError ?? (() => {});
		this.onDropped = options.onDropped;
		this.metrics = options.metrics;
		this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.now = options.now ?? (() => Date.now());
		this.client =
			options.client ??
			createRedisStreamsClient(
				this.config.url,
				this.config.field,
				(error) => this.report(error),
				subscription.options,
			);
	}

	/** Connect, create the consumer group if needed, then consume in the background. */
	async start(handler: RawAceMessageHandler): Promise<void> {
		if (this.loop) throw new AceConfigError("Redis Streams transport is already started");
		await this.client.connect();
		await this.client.ensureGroup(this.config.stream, this.config.group);
		this.stopped = false;
		this.lastReclaimAt = this.now();
		this.loop = this.consume(handler);
	}

	/** Stop after the current batch and disconnect. */
	async stop(): Promise<void> {
		if (!this.loop) return;
		this.stopped = true;
		await this.loop;
		this.loop = undefined;
		await this.client.close();
	}

	/** Read loop with capped-backoff reconnection: a broker blip must not make the agent deaf. */
	private async consume(handler: RawAceMessageHandler): Promise<void> {
		let delay = this.config.retryDelayMs;
		let outage = false;
		while (!this.stopped) {
			try {
				const entries = await this.client.read(
					this.config.stream,
					this.config.group,
					this.config.consumer,
					this.config.count,
					this.config.blockMs,
				);
				if (outage) {
					outage = false;
					delay = this.config.retryDelayMs;
					this.metrics?.increment(this.name, "reconnected");
					this.reportNotice(`redis stream ${this.config.stream}: reconnected`);
				}

				// Finish the batch even if `stop()` arrived mid-batch: entries must not stay
				// unacknowledged just because we are shutting down.
				for (const entry of entries) await this.deliver(handler, entry);

				if (entries.length === 0) await this.reclaimStale(handler);
			} catch (error) {
				if (this.stopped) return;
				if (!outage) {
					outage = true;
					this.report(error);
				}
				await this.delay(delay);
				delay = Math.min(delay * 2, this.config.maxRetryDelayMs);
			}
		}
	}

	/** Reclaim entries another consumer left pending, so a crashed peer does not strand events. */
	private async reclaimStale(handler: RawAceMessageHandler): Promise<void> {
		const { reclaimIdleMs, reclaimAttempts } = this.config;
		if (reclaimIdleMs <= 0) return;
		if (this.now() - this.lastReclaimAt < reclaimIdleMs) return;
		this.lastReclaimAt = this.now();

		const entries = await this.client.reclaim(
			this.config.stream,
			this.config.group,
			this.config.consumer,
			reclaimIdleMs,
			this.config.count,
		);
		for (const entry of entries) {
			const attempts = this.reclaimAttempts.get(entry.id) ?? 0;
			if (attempts >= reclaimAttempts) {
				// Give up. The last copy is recorded first: an entry that no handler could deliver is
				// exactly the one worth keeping, and it may leave the PEL only once it is written down.
				this.reclaimAttempts.delete(entry.id);
				this.metrics?.increment(this.name, "dropped");
				try {
					await this.onDropped?.({
						brokerId: entry.id,
						stream: this.config.stream,
						field: this.config.field,
						payload: entry.payload,
						attempts,
						reason: `after ${attempts} delivery attempts`,
					});
					this.reportedDrops.delete(entry.id);
					this.reportNotice(
						`redis stream ${this.config.stream}: dropping entry ${entry.id} after ${attempts} delivery attempts`,
					);
					await this.acknowledge(entry);
				} catch (error) {
					// Stay pending: the loss remains visible in the PEL, and the write failure is
					// reported once per entry instead of once per reclaim pass.
					if (!this.reportedDrops.has(entry.id)) {
						this.reportedDrops.add(entry.id);
						this.report(
							new Error(
								`redis stream ${this.config.stream}: cannot record dead letter for entry ${entry.id}: ${
									error instanceof Error ? error.message : String(error)
								}`,
							),
						);
					}
				}
				continue;
			}

			this.reclaimAttempts.set(entry.id, attempts + 1);
			this.metrics?.increment(this.name, "reclaimed");
			this.reportNotice(`redis stream ${this.config.stream}: reclaimed entry ${entry.id} (attempt ${attempts + 1})`);
			await this.deliver(handler, entry);
		}
	}

	private async deliver(handler: RawAceMessageHandler, entry: RedisStreamEntry): Promise<void> {
		if (entry.payload === undefined) {
			this.reportNotice(`redis stream entry ${entry.id} has no "${this.config.field}" field`);
			await this.acknowledge(entry);
			return;
		}

		try {
			await handler(entry.payload);
			this.reclaimAttempts.delete(entry.id);
			await this.acknowledge(entry);
		} catch (error) {
			// Injection or transport failure: leave the entry pending (RFC §17) so reclaim can retry it.
			this.report(error);
		}
	}

	private async acknowledge(entry: RedisStreamEntry): Promise<void> {
		await this.client.ack(this.config.stream, this.config.group, entry.id);
	}

	private report(error: unknown): void {
		try {
			this.onError(error);
		} catch {
			// A failing error hook must not stop consumption.
		}
	}

	private reportNotice(message: string): void {
		this.report(new Error(message));
	}
}
