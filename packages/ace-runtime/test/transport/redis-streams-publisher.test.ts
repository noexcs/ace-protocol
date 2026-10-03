import { describe, expect, it } from "vitest";
import type { AceMessage } from "../../src/protocol/ace-message.ts";
import { AceValidationError } from "../../src/protocol/validator.ts";
import type { RedisStreamsAddClient } from "../../src/transport/redis-streams-publisher.ts";
import { RedisStreamsPublisher } from "../../src/transport/redis-streams-publisher.ts";

class FakeAddClient implements RedisStreamsAddClient {
	readonly added: Array<{ stream: string; field: string; value: string }> = [];
	closes = 0;
	failure?: unknown;

	async add(stream: string, field: string, value: string): Promise<string> {
		if (this.failure) throw this.failure;
		this.added.push({ stream, field, value });
		return `${this.added.length}-0`;
	}

	async close(): Promise<void> {
		this.closes += 1;
	}
}

const message: AceMessage = {
	aceVersion: "0.1",
	id: "evt_1",
	sender: "agent-a",
	activation: "next_turn",
	body: "Build failed.",
};

function setup() {
	const client = new FakeAddClient();
	const publisher = new RedisStreamsPublisher({
		url: "redis://broker:6379",
		stream: "ace:to-b",
		field: "message",
		client,
	});
	return { client, publisher };
}

describe("RedisStreamsPublisher", () => {
	it("appends the ACE message as JSON to the configured stream and field", async () => {
		const { client, publisher } = setup();

		await publisher.publish(message);

		expect(client.added).toHaveLength(1);
		expect(client.added[0]?.stream).toBe("ace:to-b");
		expect(client.added[0]?.field).toBe("message");
		expect(JSON.parse(client.added[0]?.value as string)).toEqual(message);
	});

	it("keeps unknown fields on the envelope (RFC §15)", async () => {
		const { client, publisher } = setup();

		await publisher.publish({ ...message, traceId: "abc" });

		expect(JSON.parse(client.added[0]?.value as string)).toMatchObject({ traceId: "abc" });
	});

	it("never publishes a non-conforming message (RFC §13)", async () => {
		const { client, publisher } = setup();

		await expect(publisher.publish({ ...message, activation: "whenever" } as never)).rejects.toThrow(
			AceValidationError,
		);
		expect(client.added).toEqual([]);
	});

	it("propagates a broker failure to the caller", async () => {
		const { client, publisher } = setup();
		const failure = new Error("ECONNREFUSED");
		client.failure = failure;

		await expect(publisher.publish(message)).rejects.toThrow(failure);
	});

	it("closes the client", async () => {
		const { client, publisher } = setup();

		await publisher.close();

		expect(client.closes).toBe(1);
	});
});
