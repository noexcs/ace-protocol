import { createClient } from "redis";
import { validateAceMessage } from "../protocol/validator.js";
/** Give up after this many failed attempts instead of retrying a dead broker forever. */
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 150;
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Adapt the `redis` package to {@link RedisStreamsAddClient}.
 *
 * Connects on the first publish so a session can start while a publish target is down; failures
 * are reported through `onError` at most once per outage, and reconnection is bounded.
 */
export function createRedisStreamsAddClient(url, onError, clientOptions = {}) {
    // Operator-supplied passthrough (`.ace.json` `options`); see the consumer client for the rationale.
    const operatorOptions = clientOptions;
    const operatorSocket = typeof operatorOptions.socket === "object" ? operatorOptions.socket : {};
    const client = createClient({
        ...operatorOptions,
        url,
        socket: {
            ...operatorSocket,
            reconnectStrategy: (retries) => retries > MAX_RECONNECT_ATTEMPTS ? new Error(`${url} is unreachable`) : retries * RECONNECT_DELAY_MS,
        },
    });
    let connected = false;
    let outageReported = false;
    client.on("error", (error) => {
        if (!connected || outageReported)
            return;
        outageReported = true;
        onError(new Error(`${url}: ${describeError(error)}`));
    });
    return {
        async add(stream, field, value) {
            if (!client.isOpen) {
                await client.connect();
                connected = true;
            }
            const entryId = await client.xAdd(stream, "*", { [field]: value });
            outageReported = false;
            return entryId;
        },
        async close() {
            if (client.isOpen)
                await client.quit();
        },
    };
}
/** Publishes ACE messages as Redis Stream entries. */
export class RedisStreamsPublisher {
    stream;
    field;
    client;
    onError;
    constructor(options) {
        this.stream = options.stream;
        this.field = options.field;
        this.onError = options.onError ?? (() => { });
        this.client =
            options.client ??
                createRedisStreamsAddClient(options.url, (error) => {
                    try {
                        this.onError(error);
                    }
                    catch {
                        // A failing error hook must not break publishing.
                    }
                }, options.clientOptions);
    }
    /** Validate before emitting: this runtime never publishes a non-conforming message (RFC §13). */
    async publish(message) {
        const validated = validateAceMessage(message);
        await this.client.add(this.stream, this.field, JSON.stringify(validated));
    }
    async close() {
        await this.client.close();
    }
}
//# sourceMappingURL=redis-streams-publisher.js.map