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
/**
 * High-water mark of the per-subscription delivery queue.
 *
 * The read loop hands entries to the queue and keeps reading, so a delivery that waits — a queued
 * event surfaces at the next step boundary, unbounded — no longer stops this subscription from
 * reading or from reclaiming. The queue is bounded because it holds one entry per handler call the
 * transport has accepted: a `count` of 16 (the default) means the loop may run 16 read cycles ahead
 * of the handler, so 256 is far above any realistic burst while still keeping a stalled handler from
 * growing the queue without bound — at the bound the loop waits for the queue to drain.
 */
export declare const REDIS_STREAMS_DELIVERY_QUEUE_LIMIT = 256;
/** Settings a Redis Streams subscription understands inside its `config` object. */
export declare const REDIS_STREAMS_SUBSCRIPTION_KEYS: readonly ["stream", "group", "url", "consumer", "field", "count", "blockMs", "reclaimIdleMs", "reclaimAttempts", "retryDelayMs", "maxRetryDelayMs"];
/** Extract and validate the Redis Streams settings of one subscription. */
export declare function redisStreamsConfigFrom(subscription: EndpointConfig): RedisStreamsConfig;
/**
 * The broker arrival instant a Redis stream entry id encodes, epoch milliseconds UTC.
 *
 * A Redis Streams entry id is `<millisecondsTime>-<sequenceNumber>`; the first segment is when the
 * server appended the entry — the broker's arrival time, not when this consumer read it and not when
 * the event is rendered. `undefined` when the id is not in that shape, so the renderer omits its
 * `received at:` line instead of showing a fabricated time.
 */
export declare function redisStreamEntryTimestamp(id: string): number | undefined;
/** An entry the transport gave up on after `reclaimAttempts` redeliveries. */
export interface DroppedEntry {
    /** Stream entry id, so the record can be traced back to the stream. */
    streamEntryId: string;
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
    /**
     * Entries the delivery queue may hold before the read loop pauses until it drains; defaults to
     * {@link REDIS_STREAMS_DELIVERY_QUEUE_LIMIT}.
     */
    deliveryQueueLimit?: number;
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
 * - delivery runs behind a per-subscription serial queue, so the read loop keeps reading and
 *   reclaiming while a delivery waits; the queue is bounded ({@link REDIS_STREAMS_DELIVERY_QUEUE_LIMIT})
 *   and the loop pauses at the bound rather than dropping entries;
 * - a failed read does not end consumption: the loop reconnects with a capped backoff.
 */
export declare class RedisStreamsTransport implements Transport {
    private readonly config;
    private readonly name;
    private readonly client;
    private readonly onError;
    private readonly onDropped;
    private readonly metrics;
    private readonly deliveryQueueLimit;
    private readonly delay;
    private readonly now;
    /** Delivery attempts per reclaimed entry id; the transport's own idempotency guard. */
    private readonly reclaimAttempts;
    /** Entries whose dead-letter write already failed: report once, not once per reclaim pass. */
    private readonly reportedDrops;
    /** Entry ids handed to the delivery queue and not yet settled. */
    private readonly inFlight;
    private loop?;
    private stopped;
    private lastReclaimAt;
    constructor(subscription: EndpointConfig, options?: RedisStreamsTransportOptions);
    /** Connect, create the consumer group if needed, then consume in the background. */
    start(handler: RawAceMessageHandler): Promise<void>;
    /**
     * Stop reading, let the deliveries already handed over settle, then disconnect.
     *
     * The order is the point: (a) `stopped` ends the read loop, so no further entry is read;
     * (b) the loop drains the delivery queue before it resolves, so an entry already read is still
     * delivered and either acked or — on failure — left pending for reclaim; it must not stay
     * unacknowledged just because we are shutting down; (c) only then is the client closed, so the
     * `XACK`s written by those last deliveries go out over a live connection. An entry the broker
     * still holds was never read, so it stays in the group's PEL for the next consumer to reclaim.
     */
    stop(): Promise<void>;
    /**
     * Read loop with capped-backoff reconnection: a broker blip must not make the agent deaf.
     *
     * Entries are handed to `queue`, never awaited here: a delivery that waits on the host must not
     * stop this subscription from reading the next batch or from reclaiming a peer's stranded
     * entries — that backstop is exactly what a stalled handler needs. The queue preserves read
     * order, and backpressure is one `waitForRoom` before each entry is accepted, so the queue stays
     * bounded without ever dropping an entry the broker already gave us.
     */
    private consume;
    /**
     * Hand one entry to the delivery queue, marking it in flight for as long as it is queued or
     * delivering.
     *
     * The mark is what keeps the decoupled reclaim pass honest: an entry this consumer has accepted
     * is not *stranded*, so a reclaim must skip it. It is set here, at accept time, not when the job
     * starts — an entry can wait behind a slow delivery for longer than `reclaimIdleMs`, and marking
     * it late would let the next pass reclaim it while it is still queued. Without the mark an entry
     * waiting in the queue would be delivered twice and its attempts counter would spend the
     * `reclaimAttempts` budget (possibly dead-lettering it) while the original delivery is still
     * about to succeed. The mark is cleared the moment the delivery settles, so a *failed* delivery
     * is still retried by the next reclaim pass, exactly as before.
     */
    private enqueue;
    /**
     * Reclaim entries another consumer left pending, so a crashed peer does not strand events.
     *
     * Runs on its own guard (`entries.length === 0` plus the `reclaimIdleMs` throttle) whether or not
     * deliveries are still in flight — that is the point: a peer's stranded entries must not wait
     * behind this consumer's own slow delivery. Reclaimed entries go through the same serial queue
     * as freshly read ones, so their handler calls stay ordered and never overlap.
     */
    private reclaimStale;
    private deliver;
    private acknowledge;
    private report;
    private reportNotice;
}
//# sourceMappingURL=redis-streams-transport.d.ts.map