import { describe, expect, it } from "vitest";
import type { EndpointConfig } from "../../src/runtime/endpoint-config.ts";
import { AceMetrics } from "../../src/runtime/metrics.ts";
import {
	type DroppedEntry,
	RedisStreamsTransport,
	type RedisStreamsTransportOptions,
} from "../../src/transport/redis-streams-transport.ts";
import { FakeRedisStreamsClient } from "../support/fake-redis-client.ts";

const validEntry = JSON.stringify({
	aceVersion: "0.1",
	id: "evt_001",
	sender: "ci",
	activation: "next_turn",
	body: "Build failed.",
});

/** Drain microtasks so the transport's background loop can advance without real timers. */
async function settle(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) await Promise.resolve();
}

function setup(
	config: Record<string, unknown> = {},
	now: () => number = () => 0,
	options: Partial<RedisStreamsTransportOptions> = {},
) {
	const subscription: EndpointConfig = {
		name: "inbox",
		transport: "redis-streams",
		config: { stream: "ace:in", group: "g", reclaimIdleMs: 50, reclaimAttempts: 2, ...config },
		options: {},
	};
	const client = new FakeRedisStreamsClient();
	const metrics = new AceMetrics();
	const errors: unknown[] = [];
	const transport = new RedisStreamsTransport(subscription, {
		client,
		metrics,
		onError: (error) => errors.push(error),
		delay: async () => {},
		now,
		...options,
	});
	return { client, metrics, errors, transport };
}

async function stop(transport: RedisStreamsTransport, client: FakeRedisStreamsClient): Promise<void> {
	const stopped = transport.stop();
	client.releaseRead();
	await stopped;
}

describe("RedisStreamsTransport resilience", () => {
	it("reconnects after a read failure instead of going deaf", async () => {
		const { client, metrics, errors, transport } = setup();
		const handled: string[] = [];
		const failure = new Error("connection lost");

		client.readError = failure;
		await transport.start(async (raw) => {
			handled.push(String(raw));
		});
		await settle(() => errors.length > 0);
		expect(String(errors[0])).toContain("connection lost");

		// The broker comes back; the loop is still consuming.
		client.readError = undefined;
		client.push({ id: "1-0", payload: validEntry });
		await client.waitForAcks(1);

		expect(handled).toEqual([validEntry]);
		expect(metrics.snapshot().inbox?.reconnected).toBe(1);
		await stop(transport, client);
	});

	it("reclaims entries another consumer left pending and redelivers them", async () => {
		let now = 0;
		const { client, metrics, transport } = setup({}, () => now);
		const handled: string[] = [];
		await transport.start(async (raw) => {
			handled.push(String(raw));
		});

		// Idle read, but the reclaim interval has not elapsed yet.
		client.releaseRead();
		await settle(() => client.reads.length >= 2);
		expect(client.reclaimed).toEqual([]);

		now = 100;
		client.pushReclaimable({ id: "9-0", payload: validEntry });
		client.releaseRead();
		await client.waitForAcks(1);

		expect(client.reclaimed).toHaveLength(1);
		expect(client.reclaimed[0]).toMatchObject({ consumer: expect.stringMatching(/^ace-/), minIdleMs: 50 });
		expect(handled).toEqual([validEntry]);
		expect(metrics.snapshot().inbox?.reclaimed).toBe(1);
		await stop(transport, client);
	});

	it("drops an entry after too many delivery attempts, so it stops blocking the group", async () => {
		let now = 0;
		const { client, metrics, errors, transport } = setup({ reclaimAttempts: 1 }, () => now);
		await transport.start(async () => {
			throw new Error("agent unavailable");
		});

		// First reclaim: delivered, handler fails, entry stays in the PEL.
		now = 100;
		client.pushReclaimable({ id: "9-0", payload: validEntry });
		client.releaseRead();
		await settle(() => client.reclaimed.length >= 1 && client.reads.length >= 3);
		expect(client.acked).toEqual([]);

		// Second reclaim: the attempt cap is reached, so the entry is dropped and acknowledged.
		now = 200;
		client.pushReclaimable({ id: "9-0", payload: validEntry });
		client.releaseRead();
		await client.waitForAcks(1);

		expect(client.acked).toEqual(["9-0"]);
		expect(metrics.snapshot().inbox?.dropped).toBe(1);
		expect(errors.some((error) => String(error).includes("dropping entry 9-0"))).toBe(true);
		await stop(transport, client);
	});

	it("records a dead letter before it acknowledges a dropped entry", async () => {
		let now = 0;
		const recorded: DroppedEntry[] = [];
		const { client, transport } = setup({ reclaimAttempts: 1 }, () => now, {
			onDropped: async (entry) => {
				recorded.push(entry);
			},
		});
		await transport.start(async () => {
			throw new Error("agent unavailable");
		});

		now = 100;
		client.pushReclaimable({ id: "9-0", payload: validEntry });
		client.releaseRead();
		await settle(() => client.reclaimed.length >= 1 && client.reads.length >= 3);

		now = 200;
		client.pushReclaimable({ id: "9-0", payload: validEntry });
		client.releaseRead();
		await client.waitForAcks(1);

		expect(recorded).toEqual([
			{
				brokerId: "9-0",
				stream: "ace:in",
				field: "message",
				payload: validEntry,
				attempts: 1,
				reason: "after 1 delivery attempts",
			},
		]);
		expect(client.acked).toEqual(["9-0"]);
		await stop(transport, client);
	});

	it("keeps the entry pending and reports once when the dead-letter write fails", async () => {
		let now = 0;
		const recorded: DroppedEntry[] = [];
		const { client, errors, transport } = setup({ reclaimAttempts: 1 }, () => now, {
			onDropped: async (entry) => {
				recorded.push(entry);
				throw new Error("disk full");
			},
		});
		await transport.start(async () => {
			throw new Error("agent unavailable");
		});

		now = 100;
		client.pushReclaimable({ id: "9-0", payload: validEntry });
		client.releaseRead();
		await settle(() => client.reclaimed.length >= 1 && client.reads.length >= 3);

		now = 200;
		client.pushReclaimable({ id: "9-0", payload: validEntry });
		client.releaseRead();
		await settle(() => recorded.length >= 1 && client.reads.length >= 4);

		// No acknowledgement: the event stays visible in the PEL instead of vanishing.
		expect(client.acked).toEqual([]);

		now = 300;
		client.pushReclaimable({ id: "9-0", payload: validEntry });
		client.releaseRead();
		await settle(() => recorded.length >= 2 && client.reads.length >= 5);

		expect(errors.filter((error) => String(error).includes("cannot record dead letter"))).toHaveLength(1);
		expect(client.acked).toEqual([]);
		await stop(transport, client);
	});

	it("keeps a failed delivery pending when reclaim is disabled", async () => {
		const { client, transport } = setup({ reclaimIdleMs: 0 }, () => 0);
		await transport.start(async () => {
			throw new Error("agent unavailable");
		});

		client.push({ id: "1-0", payload: validEntry });
		await settle(() => client.reclaimed.length > 0 || client.reads.length >= 2);

		expect(client.acked).toEqual([]);
		expect(client.reclaimed).toEqual([]);
		await stop(transport, client);
	});
});
