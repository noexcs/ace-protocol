import type { AgentRegistryStore } from "../runtime/agent-registry.ts";
export interface RedisAgentRegistryOptions {
    url: string;
    /** Namespace this server owns; keys live under it. Defaults to `ace`. */
    namespace?: string;
    /** Raw client options passed through to the `redis` package; never validated. */
    clientOptions?: Record<string, unknown>;
    /** Called when the broker connection fails, at most once per outage. */
    onError?: (error: unknown) => void;
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
export declare function createRedisAgentRegistry(options: RedisAgentRegistryOptions): AgentRegistryStore;
//# sourceMappingURL=redis-agent-registry.d.ts.map