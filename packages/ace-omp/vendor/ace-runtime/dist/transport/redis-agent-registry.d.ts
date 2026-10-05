import { type AgentRegistryStore } from "../runtime/agent-registry.ts";
export interface RedisAgentRegistryOptions {
    url: string;
    /** Key namespace; defaults to `ace:agents`. */
    prefix?: string;
    /** Raw client options passed through to the `redis` package; never validated. */
    clientOptions?: Record<string, unknown>;
    /** Called when the broker connection fails, at most once per outage. */
    onError?: (error: unknown) => void;
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
export declare function createRedisAgentRegistry(options: RedisAgentRegistryOptions): AgentRegistryStore;
//# sourceMappingURL=redis-agent-registry.d.ts.map