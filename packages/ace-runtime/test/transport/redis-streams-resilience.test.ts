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
				streamEntryId: "9-0",
				stream: "ace:in",
				field: "message",
				payload: validEntry,
				// The first delivery, then the reclaim that gave up: two deliveries in total.
				attempts: 2,
				reason: "after 2 delivery attempts",
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
		let deliveries = 0;
		await transport.start(async () => {
			deliveries += 1;
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
		// The record is retried; the delivery is not. Re-running the handler is the unbounded loop this
		// guards against (the budget used to be cleared before the write, so it restarted at zero).
		expect(recorded.length).toBeGreaterThanOrEqual(2);
		expect(deliveries).toBe(1);
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

describe("RedisStreamsTransport recovery from a swept-away group (audit A)", () => {
	it("rebuilds the consumer group and keeps reading instead of retrying NOGROUP forever", async () => {
		const { client, transport, errors } = setup();
		const handled: unknown[] = [];
		await transport.start(async (raw) => {
			handled.push(raw);
		});
		// start() creates the group once; that is the only time it used to be created.
		expect(client.ensuredGroups).toHaveLength(1);

		// What the directory sweep leaves behind: the stream is deleted, and its group with it.
		client.readError = new Error(
			"NOGROUP No such key 'ace:in' or consumer group 'g' in XREADGROUP with GROUP option",
		);
		// The read issued before the sweep is still blocked; let it settle so the loop tries again
		// and meets the NOGROUP (a real broker would answer it with the block timeout or the error).
		client.releaseRead();
		await settle(() => client.ensuredGroups.length > 1);
		// Stop before asserting: without the rebuild the loop retries NOGROUP forever (which is the
		// defect), and a spinning loop would hang the test instead of failing it.
		await stop(transport, client);
		expect(client.ensuredGroups.length).toBeGreaterThan(1);
		expect(errors.some((error) => String(error).includes("NOGROUP"))).toBe(true);
	});
});

describe("RedisStreamsTransport start failures (audit C5)", () => {
	it("releases the client it connected when the group cannot be created", async () => {
		const { client, transport } = setup();
		client.ensureGroupError = new Error("NOAUTH group creation denied");

		await expect(transport.start(async () => {})).rejects.toThrow(/NOAUTH/);

		// The read loop was never started, so `stop()` returns early; the transport must not leave a
		// connected client behind (a connection nobody owns, for the life of the process).
		expect(client.closes).toBe(1);
		expect(client.connections).toBe(1);
	});
});

describe("RedisStreamsTransport notice routing (audit C2)", () => {
	it("sends notices to onNotice instead of the error sink", async () => {
		let now = 0;
		const notices: string[] = [];
		const { client, errors, transport } = setup({ reclaimAttempts: 1 }, () => now, {
			onNotice: (message) => notices.push(message),
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
		await stop(transport, client);

		// The drop is a notice, not a failure: a host that derives health from onError would latch
		// "down" on it and then swallow the real errors that follow.
		expect(notices.some((message) => message.includes("dropping entry 9-0"))).toBe(true);
		expect(errors.some((error) => String(error).includes("dropping entry"))).toBe(false);
	});
});
