import { type EndpointConfig } from "../runtime/endpoint-config.ts";
import type { AceMetrics } from "../runtime/metrics.ts";
import type { RedisStreamsClient } from "./redis-streams-client.ts";
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
/** Defaults shared by the Redis Streams consumer and publisher. */
export declare const REDIS_STREAMS_DEFAULTS: {
    readonly url: "redis://127.0.0.1:6379";
    readonly field: "message";
    readonly count: 16;
    readonly blockMs: 1000;
    readonly reclaimIdleMs: 60000;
    readonly reclaimAttempts: 3;
    readonly retryDelayMs: 200;
    readonly maxRetryDelayMs: 5000;
};
/** Settings a Redis Streams subscription understands inside its `config` object. */
export declare const REDIS_STREAMS_SUBSCRIPTION_KEYS: readonly ["stream", "group", "url", "consumer", "field", "count", "blockMs", "reclaimIdleMs", "reclaimAttempts", "retryDelayMs", "maxRetryDelayMs"];
/** Extract and validate the Redis Streams settings of one subscription. */
export declare function redisStreamsConfigFrom(subscription: EndpointConfig): RedisStreamsConfig;
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
export declare class RedisStreamsTransport implements Transport {
    private readonly config;
    private readonly name;
    private readonly client;
    private readonly onError;
    private readonly onDropped;
    private readonly metrics;
    private readonly delay;
    private readonly now;
    /** Delivery attempts per reclaimed entry id; the transport's own idempotency guard. */
    private readonly reclaimAttempts;
    /** Entries whose dead-letter write already failed: report once, not once per reclaim pass. */
    private readonly reportedDrops;
    private loop?;
    private stopped;
    private lastReclaimAt;
    constructor(subscription: EndpointConfig, options?: RedisStreamsTransportOptions);
    /** Connect, create the consumer group if needed, then consume in the background. */
    start(handler: RawAceMessageHandler): Promise<void>;
    /** Stop after the current batch and disconnect. */
    stop(): Promise<void>;
    /** Read loop with capped-backoff reconnection: a broker blip must not make the agent deaf. */
    private consume;
    /** Reclaim entries another consumer left pending, so a crashed peer does not strand events. */
    private reclaimStale;
    private deliver;
    private acknowledge;
    private report;
    private reportNotice;
}
//# sourceMappingURL=redis-streams-transport.d.ts.map