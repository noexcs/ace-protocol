import type { RawAceMessageHandler, Transport } from "./transport.ts";

/**
 * In-process transport for tests and examples (RFC §22).
 *
 * Stands in for Kafka/NATS until a real adapter exists; publishing delivers the
 * raw message to every started handler.
 */
export class InMemoryTransport implements Transport {
	private handlers: RawAceMessageHandler[] = [];

	get started(): boolean {
		return this.handlers.length > 0;
	}

	async start(handler: RawAceMessageHandler): Promise<void> {
		this.handlers.push(handler);
	}

	async stop(): Promise<void> {
		this.handlers = [];
	}

	/** Deliver one raw message to all handlers and await their handling. */
	async publish(raw: unknown): Promise<void> {
		if (this.handlers.length === 0) {
			throw new Error("InMemoryTransport has no started handler");
		}
		for (const handler of [...this.handlers]) {
			await handler(raw);
		}
	}
}
