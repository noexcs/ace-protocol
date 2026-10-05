import type { RawAceMessageHandler, Transport } from "./transport.ts";
/**
 * In-process transport for tests and examples (RFC §22).
 *
 * Stands in for Kafka/NATS until a real adapter exists; publishing delivers the
 * raw message to every started handler.
 */
export declare class InMemoryTransport implements Transport {
    private handlers;
    get started(): boolean;
    start(handler: RawAceMessageHandler): Promise<void>;
    stop(): Promise<void>;
    /** Deliver one raw message to all handlers and await their handling. */
    publish(raw: unknown): Promise<void>;
}
//# sourceMappingURL=in-memory-transport.d.ts.map