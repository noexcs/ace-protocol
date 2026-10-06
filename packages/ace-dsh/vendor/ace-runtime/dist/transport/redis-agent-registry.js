import { createClient } from "redis";
import { channelStreamKey, directoryEntryKey, directoryKey, NAMESPACE_DEFAULT } from "../runtime/naming.js";
/** Give up after this many failed attempts instead of retrying a dead broker forever. */
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 150;
function isBusyGroup(error) {
    return error instanceof Error && error.message.includes("BUSYGROUP");
}
/**
 * The directory on Redis (RFC §22 item 1).
 *
 * ```text
 * <ns>                 ZSet   score = expiresAt, member = the channel name (= a session's sender)
 * <ns>:entry           Hash   field = channel,     value = what it says about itself
 * <ns>:ch:<channel>    Stream the channel's events — the same key path as any other channel
 * ```
 *
 * There is one kind of thing here — a channel — so a live session needs no second record: it registers
 * the channel named by its own sender, and everything else (stream key, group) is derived from that
 * name. Presence is the ZSet score, so a session that dies without unregistering stops being
 * discoverable when its score falls behind the clock — no sweeper, no ghost entries. Discovery prunes
 * expired channels on the way, deleting the leftovers (hash field, stream) it can derive.
 */
export function createRedisAgentRegistry(options) {
    const onError = options.onError ?? (() => { });
    const namespace = options.namespace ?? NAMESPACE_DEFAULT;
    // Library boundary: `clientOptions` is operator-supplied and never validated on our side — the cast
    // is only to reach `createClient`, which is typed with the `redis` package's own options type.
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
    const membersKey = directoryKey(namespace);
    const entriesKey = directoryEntryKey(namespace);
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
        async put(channel, description, expiresAt) {
            await use(async () => {
                await client
                    .multi()
                    .zAdd(membersKey, { score: expiresAt, value: channel })
                    .hSet(entriesKey, channel, description)
                    .exec();
            });
        },
        async refresh(channel, expiresAt) {
            await use(() => client.zAdd(membersKey, { score: expiresAt, value: channel }, { XX: true }));
        },
        async remove(channel) {
            await use(async () => {
                await client.multi().zRem(membersKey, channel).hDel(entriesKey, channel).exec();
            });
        },
        async dropStream(stream) {
            await use(() => client.del(stream));
        },
        async list(now) {
            // Housekeeping happens on the read path. A session killed without a clean shutdown never runs
            // its own cleanup, so whoever reads next removes the expired channel *and* its leftovers
            // (hash field, stream) — all of them derivable from the channel name.
            const live = await use(async () => {
                const expired = await client.zRangeByScore(membersKey, "-inf", `(${now}`);
                if (expired.length > 0) {
                    await client.multi().zRemRangeByScore(membersKey, "-inf", `(${now}`).hDel(entriesKey, expired).exec();
                    for (const channel of expired)
                        await client.del(channelStreamKey(namespace, channel));
                }
                return client.zRangeByScoreWithScores(membersKey, `(${now}`, "+inf");
            });
            if (live.length === 0)
                return [];
            const channels = live.map((entry) => entry.value);
            const values = await use(() => client.hmGet(entriesKey, channels));
            // `redis` types the reply as a broad union; narrow it once instead of trusting it.
            const descriptions = Array.isArray(values)
                ? values.map((value) => (typeof value === "string" ? value : null))
                : [];
            const entries = [];
            live.forEach((scored, index) => {
                const description = descriptions[index];
                if (typeof description !== "string")
                    return;
                entries.push({ channel: scored.value, description, expiresAt: scored.score });
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