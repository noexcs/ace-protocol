/**
 * In-process transport for tests and examples (RFC §22).
 *
 * Stands in for Kafka/NATS until a real adapter exists; publishing delivers the
 * raw message to every started handler.
 */
export class InMemoryTransport {
    handlers = [];
    get started() {
        return this.handlers.length > 0;
    }
    async start(handler) {
        this.handlers.push(handler);
    }
    async stop() {
        this.handlers = [];
    }
    /** Deliver one raw message to all handlers and await their handling. */
    async publish(raw) {
        if (this.handlers.length === 0) {
            throw new Error("InMemoryTransport has no started handler");
        }
        for (const handler of [...this.handlers]) {
            await handler(raw);
        }
    }
}
//# sourceMappingURL=in-memory-transport.js.map