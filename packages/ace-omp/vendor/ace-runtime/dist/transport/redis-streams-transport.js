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
export class RedisStreamsTransport {
    config;
    name;
    client;
    onError;
    onDropped;
    metrics;
    delay;
    now;
    /** Delivery attempts per reclaimed entry id; the transport's own idempotency guard. */
    reclaimAttempts = new Map();
    /** Entries whose dead-letter write already failed: report once, not once per reclaim pass. */
    reportedDrops = new Set();
    loop;
    stopped = true;
    lastReclaimAt = 0;
    constructor(subscription, options = {}) {
        this.config = redisStreamsConfigFrom(subscription);
        this.name = subscription.name;
        this.onError = options.onError ?? (() => { });
        this.onDropped = options.onDropped;
        this.metrics = options.metrics;
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
        this.loop = this.consume(handler);
    }
    /** Stop after the current batch and disconnect. */
    async stop() {
        if (!this.loop)
            return;
        this.stopped = true;
        await this.loop;
        this.loop = undefined;
        await this.client.close();
    }
    /** Read loop with capped-backoff reconnection: a broker blip must not make the agent deaf. */
    async consume(handler) {
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
                // Finish the batch even if `stop()` arrived mid-batch: entries must not stay
                // unacknowledged just because we are shutting down.
                for (const entry of entries)
                    await this.deliver(handler, entry);
                if (entries.length === 0)
                    await this.reclaimStale(handler);
            }
            catch (error) {
                if (this.stopped)
                    return;
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
    async reclaimStale(handler) {
        const { reclaimIdleMs, reclaimAttempts } = this.config;
        if (reclaimIdleMs <= 0)
            return;
        if (this.now() - this.lastReclaimAt < reclaimIdleMs)
            return;
        this.lastReclaimAt = this.now();
        const entries = await this.client.reclaim(this.config.stream, this.config.group, this.config.consumer, reclaimIdleMs, this.config.count);
        for (const entry of entries) {
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
            await this.deliver(handler, entry);
        }
    }
    async deliver(handler, entry) {
        if (entry.payload === undefined) {
            this.reportNotice(`redis stream entry ${entry.id} has no "${this.config.field}" field`);
            await this.acknowledge(entry);
            return;
        }
        try {
            await handler(entry.payload);
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