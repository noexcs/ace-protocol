import { createClient } from "redis";
import { REGISTRY_DEFAULTS, } from "../runtime/agent-registry.js";
/** Give up after this many failed attempts instead of retrying a dead broker forever. */
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 150;
function isBusyGroup(error) {
    return error instanceof Error && error.message.includes("BUSYGROUP");
}
/** The session stream recorded in a stored entry, when the payload still parses. */
function streamOf(raw) {
    if (raw === null)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || !("config" in parsed))
        return undefined;
    const config = parsed.config;
    if (typeof config !== "object" || config === null || !("stream" in config))
        return undefined;
    return typeof config.stream === "string" ? config.stream : undefined;
}
/**
 * The agent directory on Redis (RFC §22 item 1).
 *
 * ```text
 * <prefix>                  ZSet   score = expiresAt, member = "<coding-agent>:<sessionId>"
 * <prefix>:entry            Hash   field = member,     value = the channel entry
 * <prefix>:events:<member>  Stream one per session, holding the events peers send it
 * ```
 *
 * Presence is the ZSet score, so a session that dies without unregistering stops being discoverable
 * when its score falls behind the clock — no sweeper process, no ghost entries. Discovery reads
 * prune expired members on the way, which is the only cleanup this needs.
 */
export function createRedisAgentRegistry(options) {
    const onError = options.onError ?? (() => { });
    const prefix = options.prefix ?? REGISTRY_DEFAULTS.prefix;
    const operatorOptions = options.clientOptions;
    const operatorSocket = typeof operatorOptions?.socket === "object" ? operatorOptions.socket : {};
    const client = createClient({
        ...operatorOptions,
        url: options.url,
        socket: {
            ...operatorSocket,
            reconnectStrategy: (retries) => retries > MAX_RECONNECT_ATTEMPTS
                ? new Error(`${options.url} is unreachable`)
                : retries * RECONNECT_DELAY_MS,
        },
    });
    const entriesKey = `${prefix}:entry`;
    let connected = false;
    let outageReported = false;
    client.on("error", (error) => {
        if (!connected || outageReported)
            return;
        outageReported = true;
        onError(new Error(`${options.url}: ${error instanceof Error ? error.message : String(error)}`));
    });
    /** Connect on demand, run one operation, and clear the outage latch on success. */
    async function use(operation) {
        if (!client.isOpen) {
            await client.connect();
            connected = true;
        }
        const result = await operation();
        outageReported = false;
        return result;
    }
    return {
        async ensureStream(stream, group) {
            await use(async () => {
                try {
                    // Start at the tail: this session publishes its address for *future* events.
                    await client.xGroupCreate(stream, group, "$", { MKSTREAM: true });
                }
                catch (error) {
                    if (!isBusyGroup(error))
                        throw error;
                }
            });
        },
        async put(member, channel, expiresAt) {
            await use(async () => {
                await client
                    .multi()
                    .zAdd(prefix, { score: expiresAt, value: member })
                    .hSet(entriesKey, member, JSON.stringify(channel))
                    .exec();
            });
        },
        async refresh(member, expiresAt) {
            await use(() => client.zAdd(prefix, { score: expiresAt, value: member }, { XX: true }));
        },
        async remove(member) {
            await use(async () => {
                await client.multi().zRem(prefix, member).hDel(entriesKey, member).exec();
            });
        },
        async dropStream(stream) {
            await use(() => client.del(stream));
        },
        async list(now) {
            // Housekeeping happens on the read path. A session killed without a clean shutdown never
            // runs its own cleanup, so whoever reads next removes the expired entry *and* its leftovers
            // (hash field, session stream) — otherwise every crash would leak a stream forever.
            const live = await use(async () => {
                const expired = await client.zRangeByScore(prefix, "-inf", `(${now}`);
                if (expired.length > 0) {
                    const stale = await client.hmGet(entriesKey, expired);
                    await client.multi().zRemRangeByScore(prefix, "-inf", `(${now}`).hDel(entriesKey, expired).exec();
                    const payloads = Array.isArray(stale)
                        ? stale.map((value) => (typeof value === "string" ? value : null))
                        : [];
                    for (const raw of payloads) {
                        const stream = streamOf(raw);
                        if (stream !== undefined)
                            await client.del(stream);
                    }
                }
                return client.zRangeByScoreWithScores(prefix, `(${now}`, "+inf");
            });
            if (live.length === 0)
                return [];
            const members = live.map((entry) => entry.value);
            const values = await use(() => client.hmGet(entriesKey, members));
            // `redis` types the reply as a broad union; narrow it once instead of trusting it.
            const payloads = Array.isArray(values)
                ? values.map((value) => (typeof value === "string" ? value : null))
                : [];
            const entries = [];
            live.forEach((scored, index) => {
                const raw = payloads[index];
                if (typeof raw !== "string")
                    return;
                entries.push({
                    member: scored.value,
                    channel: JSON.parse(raw),
                    expiresAt: scored.score,
                });
            });
            return entries;
        },
        async close() {
            if (client.isOpen)
                await client.quit();
        },
    };
}
//# sourceMappingURL=redis-agent-registry.js.map