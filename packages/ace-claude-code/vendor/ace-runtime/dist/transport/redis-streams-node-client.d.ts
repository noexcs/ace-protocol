import type { RedisStreamsClient } from "./redis-streams-client.ts";
/**
 * Adapt the `redis` package to {@link RedisStreamsClient}.
 *
 * Connection failures are reported through `onError` at most once per outage — the client would
 * otherwise emit one error per reconnect attempt — and reconnection is bounded so an unreachable
 * broker fails the start instead of retrying forever.
 */
export declare function createRedisStreamsClient(url: string, field: string, onError: (error: unknown) => void, clientOptions?: Record<string, unknown>): RedisStreamsClient;
//# sourceMappingURL=redis-streams-node-client.d.ts.map