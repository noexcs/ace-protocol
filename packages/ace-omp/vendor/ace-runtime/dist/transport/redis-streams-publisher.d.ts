import type { AceMessage } from "../protocol/ace-message.ts";
/**
 * Publishes ACE messages to a configured target (RFC §19: Agent → Agent, Agent → Service).
 *
 * The target address lives in runtime configuration, never in the message (RFC §4.1), so a
 * publisher is bound to one destination.
 */
export interface AcePublisher {
    publish(message: AceMessage): Promise<void>;
    close(): Promise<void>;
}
/** The narrow Redis surface the publisher needs; keeps tests broker-free. */
export interface RedisStreamsAddClient {
    /** Append one entry and return its id. */
    add(stream: string, field: string, value: string): Promise<string>;
    close(): Promise<void>;
}
/**
 * Adapt the `redis` package to {@link RedisStreamsAddClient}.
 *
 * Connects on the first publish so a session can start while a publish target is down; failures
 * are reported through `onError` at most once per outage, and reconnection is bounded.
 */
export declare function createRedisStreamsAddClient(url: string, onError: (error: unknown) => void, clientOptions?: Record<string, unknown>): RedisStreamsAddClient;
export interface RedisStreamsPublisherOptions {
    url: string;
    stream: string;
    /** Stream entry field carrying the ACE message JSON; mirrors the consumer side. */
    field: string;
    /** Injected client; defaults to a `redis` client for `url`. */
    client?: RedisStreamsAddClient;
    /** Raw client options passed through to the `redis` package. */
    clientOptions?: Record<string, unknown>;
    /** Called when the broker connection fails. */
    onError?: (error: unknown) => void;
}
/** Publishes ACE messages as Redis Stream entries. */
export declare class RedisStreamsPublisher implements AcePublisher {
    readonly stream: string;
    private readonly field;
    private readonly client;
    private readonly onError;
    constructor(options: RedisStreamsPublisherOptions);
    /** Validate before emitting: this runtime never publishes a non-conforming message (RFC §13). */
    publish(message: AceMessage): Promise<void>;
    close(): Promise<void>;
}
//# sourceMappingURL=redis-streams-publisher.d.ts.map