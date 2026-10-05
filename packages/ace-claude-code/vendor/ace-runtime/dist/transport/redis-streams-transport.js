import { AceConfigError, optionalStringField, positiveIntegerField, rejectUnknownKeys, requiredStringField, } from "../runtime/endpoint-config.js";
import { createRedisStreamsClient } from "./redis-streams-node-client.js";
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
export const REDIS_STREAMS_DELIVERY_QUEUE_LIMIT = 256;
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
];
/** Read an optional non-negative integer setting, falling back to a default. */
function nonNegativeIntegerField(config, key, fallback, subject) {
    const value = config[key];
    if (value === undefined)
        return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new AceConfigError(`${subject} has invalid "${key}": needs an integer >= 0`);
    }
    return value;
}
/** Extract and validate the Redis Streams settings of one subscription. */
export function redisStreamsConfigFrom(subscription) {
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
/**
 * The broker arrival instant a Redis stream entry id encodes, epoch milliseconds UTC.
 *
 * A Redis Streams entry id is `<millisecondsTime>-<sequenceNumber>`; the first segment is when the
 * server appended the entry — the broker's arrival time, not when this consumer read it and not when
 * the event is rendered. `undefined` when the id is not in that shape, so the renderer omits its
 * `received at:` line instead of showing a fabricated time.
 */
export function redisStreamEntryTimestamp(id) {
    const match = /^(\d+)-/.exec(id);
    if (!match)
        return undefined;
    const millis = Number(match[1]);
    return Number.isSafeInteger(millis) ? millis : undefined;
}
/**
 * Per-subscription serial delivery queue.
 *
 * One delivery runs at a time, in the order the read loop accepted it: this is a single-consumer
 * loop, so entries must reach the handler in read order and never overlap. The loop does not wait
 * for a delivery to finish — it hands the entry over and keeps reading — so a delivery that waits
 * (a queued `aside` event surfaces at the next step boundary, unbounded) no longer stops this
 * subscription from reading or from reclaiming.
 *
 * `deliver` reports its own failures and does not throw; a rejection that still reaches this queue
 * (a failing `XACK`, say) escaped that path and has no loop `catch` to land in any more, so it is
 * reported through `onFailure`.
 */
class DeliveryQueue {
    limit;
    onFailure;
    depth = 0;
    tail = Promise.resolve();
    /** Resolvers waiting for the queue to fall back below the high-water mark. */
    onProgress = [];
    /** `limit` is the most deliveries the queue may hold; the read loop waits above it. */
    constructor(limit, onFailure) {
        this.limit = limit;
        this.onFailure = onFailure;
    }
    /** Accept one delivery; it runs after every earlier one, never concurrently with it. */
    push(job) {
        this.depth += 1;
        this.tail = this.tail.then(async () => {
            try {
                await job();
            }
            catch (error) {
                this.onFailure(error);
            }
            finally {
                this.depth -= 1;
                for (const wake of this.onProgress.splice(0))
                    wake();
            }
        });
    }
    /**
     * Resolve once one more delivery fits. Called per entry, never per batch: a batch larger than the
     * limit then waits for one slot at a time instead of for room it could never get, so a `count`
     * above the limit slows the loop down but cannot deadlock it.
     */
    async waitForRoom() {
        while (this.depth >= this.limit) {
            const { promise, resolve } = Promise.withResolvers();
            this.onProgress.push(resolve);
            await promise;
        }
    }
    /** Resolve once every accepted delivery has finished, successfully or not. */
    async drain() {
        while (this.depth > 0)
            await this.tail;
    }
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
export class RedisStreamsTransport {
    config;
    name;
    client;
    onError;
    onDropped;
    metrics;
    deliveryQueueLimit;
    delay;
    now;
    /** Delivery attempts per reclaimed entry id; the transport's own idempotency guard. */
    reclaimAttempts = new Map();
    /** Entries whose dead-letter write already failed: report once, not once per reclaim pass. */
    reportedDrops = new Set();
    /** Entry ids handed to the delivery queue and not yet settled. */
    inFlight = new Set();
    loop;
    stopped = true;
    lastReclaimAt = 0;
    constructor(subscription, options = {}) {
        this.config = redisStreamsConfigFrom(subscription);
        this.name = subscription.name;
        this.onError = options.onError ?? (() => { });
        this.onDropped = options.onDropped;
        this.metrics = options.metrics;
        this.deliveryQueueLimit = options.deliveryQueueLimit ?? REDIS_STREAMS_DELIVERY_QUEUE_LIMIT;
        this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.now = options.now ?? (() => Date.now());
        this.client =
            options.client ??
                createRedisStreamsClient(this.config.url, this.config.field, (error) => this.report(error), subscription.options);
    }
    /** Connect, create the consumer group if needed, then consume in the background. */
    async start(handler) {
        if (this.loop)
            throw new AceConfigError("Redis Streams transport is already started");
        await this.client.connect();
        await this.client.ensureGroup(this.config.stream, this.config.group);
        this.stopped = false;
        this.lastReclaimAt = this.now();
        this.loop = this.consume(handler, new DeliveryQueue(this.deliveryQueueLimit, (error) => this.report(error)));
    }
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
    async stop() {
        if (!this.loop)
            return;
        this.stopped = true;
        await this.loop;
        this.loop = undefined;
        await this.client.close();
    }
    /**
     * Read loop with capped-backoff reconnection: a broker blip must not make the agent deaf.
     *
     * Entries are handed to `queue`, never awaited here: a delivery that waits on the host must not
     * stop this subscription from reading the next batch or from reclaiming a peer's stranded
     * entries — that backstop is exactly what a stalled handler needs. The queue preserves read
     * order, and backpressure is one `waitForRoom` before each entry is accepted, so the queue stays
     * bounded without ever dropping an entry the broker already gave us.
     */
    async consume(handler, queue) {
        let delay = this.config.retryDelayMs;
        let outage = false;
        while (!this.stopped) {
            try {
                const entries = await this.client.read(this.config.stream, this.config.group, this.config.consumer, this.config.count, this.config.blockMs);
                if (outage) {
                    outage = false;
                    delay = this.config.retryDelayMs;
                    this.metrics?.increment(this.name, "reconnected");
                    this.reportNotice(`redis stream ${this.config.stream}: reconnected`);
                }
                // Queue the whole batch: a `stop()` that arrives mid-batch must not leave a read entry
                // undelivered — "entries must not stay unacknowledged just because we are shutting
                // down" still holds, and `stop()` drains this queue. The queue's own bound is the only
                // thing that can pause this loop here, and it does so one entry at a time.
                for (const entry of entries) {
                    await queue.waitForRoom();
                    this.enqueue(queue, handler, entry);
                }
                if (entries.length === 0)
                    await this.reclaimStale(handler, queue);
            }
            catch (error) {
                if (this.stopped)
                    break;
                if (!outage) {
                    outage = true;
                    this.report(error);
                }
                await this.delay(delay);
                delay = Math.min(delay * 2, this.config.maxRetryDelayMs);
            }
        }
        // The loop ended because we are stopping: an entry already read is delivered and acked (or
        // left pending) before `stop()` returns, and never after the client is closed.
        await queue.drain();
    }
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
    enqueue(queue, handler, entry) {
        this.inFlight.add(entry.id);
        queue.push(async () => {
            try {
                await this.deliver(handler, entry);
            }
            finally {
                this.inFlight.delete(entry.id);
            }
        });
    }
    /**
     * Reclaim entries another consumer left pending, so a crashed peer does not strand events.
     *
     * Runs on its own guard (`entries.length === 0` plus the `reclaimIdleMs` throttle) whether or not
     * deliveries are still in flight — that is the point: a peer's stranded entries must not wait
     * behind this consumer's own slow delivery. Reclaimed entries go through the same serial queue
     * as freshly read ones, so their handler calls stay ordered and never overlap.
     */
    async reclaimStale(handler, queue) {
        const { reclaimIdleMs, reclaimAttempts } = this.config;
        if (reclaimIdleMs <= 0)
            return;
        if (this.now() - this.lastReclaimAt < reclaimIdleMs)
            return;
        this.lastReclaimAt = this.now();
        const entries = await this.client.reclaim(this.config.stream, this.config.group, this.config.consumer, reclaimIdleMs, this.config.count);
        for (const entry of entries) {
            // This consumer is already delivering it: it is not stranded, and re-queuing it would
            // deliver it twice and spend an attempt on a delivery that has not even failed yet.
            if (this.inFlight.has(entry.id))
                continue;
            const attempts = this.reclaimAttempts.get(entry.id) ?? 0;
            if (attempts >= reclaimAttempts) {
                // Give up. The last copy is recorded first: an entry that no handler could deliver is
                // exactly the one worth keeping, and it may leave the PEL only once it is written down.
                this.reclaimAttempts.delete(entry.id);
                this.metrics?.increment(this.name, "dropped");
                try {
                    await this.onDropped?.({
                        streamEntryId: entry.id,
                        stream: this.config.stream,
                        field: this.config.field,
                        payload: entry.payload,
                        attempts,
                        reason: `after ${attempts} delivery attempts`,
                    });
                    this.reportedDrops.delete(entry.id);
                    this.reportNotice(`redis stream ${this.config.stream}: dropping entry ${entry.id} after ${attempts} delivery attempts`);
                    await this.acknowledge(entry);
                }
                catch (error) {
                    // Stay pending: the loss remains visible in the PEL, and the write failure is
                    // reported once per entry instead of once per reclaim pass.
                    if (!this.reportedDrops.has(entry.id)) {
                        this.reportedDrops.add(entry.id);
                        this.report(new Error(`redis stream ${this.config.stream}: cannot record dead letter for entry ${entry.id}: ${error instanceof Error ? error.message : String(error)}`));
                    }
                }
                continue;
            }
            this.reclaimAttempts.set(entry.id, attempts + 1);
            this.metrics?.increment(this.name, "reclaimed");
            this.reportNotice(`redis stream ${this.config.stream}: reclaimed entry ${entry.id} (attempt ${attempts + 1})`);
            // Same bound as a freshly read batch: a reclaim pass may not push the queue past its
            // high-water mark just because the entries arrived from the PEL instead of a read.
            await queue.waitForRoom();
            this.enqueue(queue, handler, entry);
        }
    }
    async deliver(handler, entry) {
        if (entry.payload === undefined) {
            this.reportNotice(`redis stream entry ${entry.id} has no "${this.config.field}" field`);
            await this.acknowledge(entry);
            return;
        }
        try {
            await handler(entry.payload, redisStreamEntryTimestamp(entry.id));
            this.reclaimAttempts.delete(entry.id);
            await this.acknowledge(entry);
        }
        catch (error) {
            // Injection or transport failure: leave the entry pending (RFC §17) so reclaim can retry it.
            this.report(error);
        }
    }
    async acknowledge(entry) {
        await this.client.ack(this.config.stream, this.config.group, entry.id);
    }
    report(error) {
        try {
            this.onError(error);
        }
        catch {
            // A failing error hook must not stop consumption.
        }
    }
    reportNotice(message) {
        this.report(new Error(message));
    }
}
//# sourceMappingURL=redis-streams-transport.js.map