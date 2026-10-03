import {
	AceConfigError,
	type EndpointConfig,
	optionalStringField,
	positiveIntegerField,
	rejectUnknownKeys,
	requiredStringField,
} from "../runtime/endpoint-config.ts";
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
}

const DEFAULT_CONSUMER = `ace-${process.pid}`;

/** Defaults shared by the Redis Streams consumer and publisher. */
export const REDIS_STREAMS_DEFAULTS = {
	url: "redis://127.0.0.1:6379",
	field: "message",
	count: 16,
	blockMs: 1000,
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
] as const;

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
	};
}

export interface RedisStreamsTransportOptions {
	/** Injected client; defaults to a `redis` client for the configured URL. */
	client?: RedisStreamsClient;
	/** Called when the broker connection or the read loop fails. */
	onError?: (error: unknown) => void;
}

/**
 * Consume ACE messages from a Redis Stream consumer group (RFC §4, §17).
 *
 * Delivery policy:
 *
 * - the handler resolving → the entry is acknowledged (`XACK`);
 * - the handler rejecting → the entry stays pending in the group's PEL (no automatic
 *   reclaim yet; the host can `XAUTOCLAIM` it);
 * - an entry without the configured payload field → reported and acknowledged;
 * - invalid ACE messages are acknowledged too, because the runtime logs and drops them
 *   instead of rejecting them (RFC §13, design doc §30) — a poison message never blocks
 *   the stream.
 *
 * A failed read ends consumption; recreate the transport to reconnect.
 */
export class RedisStreamsTransport implements Transport {
	private readonly config: RedisStreamsConfig;
	private readonly client: RedisStreamsClient;
	private readonly onError: (error: unknown) => void;
	private loop?: Promise<void>;
	private stopped = true;

	constructor(subscription: EndpointConfig, options: RedisStreamsTransportOptions = {}) {
		this.config = redisStreamsConfigFrom(subscription);
		this.onError = options.onError ?? (() => {});
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

	private async consume(handler: RawAceMessageHandler): Promise<void> {
		const { stream, group, consumer, count, blockMs } = this.config;
		try {
			while (!this.stopped) {
				const entries = await this.client.read(stream, group, consumer, count, blockMs);
				// Finish the batch even if `stop()` arrived mid-batch: entries must not stay
				// unacknowledged just because we are shutting down.
				for (const entry of entries) await this.deliver(handler, entry);
			}
		} catch (error) {
			if (!this.stopped) this.report(error);
		}
	}

	private async deliver(handler: RawAceMessageHandler, entry: RedisStreamEntry): Promise<void> {
		if (entry.payload === undefined) {
			this.report(new Error(`redis stream entry ${entry.id} has no "${this.config.field}" field`));
			await this.acknowledge(entry);
			return;
		}

		try {
			await handler(entry.payload);
			await this.acknowledge(entry);
		} catch (error) {
			// Injection or transport failure: leave the entry pending (RFC §17).
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
}
