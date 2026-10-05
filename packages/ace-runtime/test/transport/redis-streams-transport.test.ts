import { describe, expect, it } from "vitest";
import { renderAceEvent } from "../../src/agent/event-rendering.ts";
import { AceRuntime } from "../../src/runtime/ace-runtime.ts";
import { AceConfigError, type EndpointConfig } from "../../src/runtime/endpoint-config.ts";
import {
	REDIS_STREAMS_DELIVERY_QUEUE_LIMIT,
	RedisStreamsTransport,
	type RedisStreamsTransportOptions,
	redisStreamEntryTimestamp,
	redisStreamsConfigFrom,
} from "../../src/transport/redis-streams-transport.ts";
import { FakeAgentEngine } from "../support/fake-agent-engine.ts";
import { FakeRedisStreamsClient } from "../support/fake-redis-client.ts";

const redisInput: EndpointConfig = {
	name: "build-events",
	transport: "redis-streams",
	config: { stream: "ace:build-events", group: "coding-agent" },
	options: {},
};

const validEntry = JSON.stringify({
	aceVersion: "0.1",
	id: "evt_001",
	sender: "build-service",
	activation: "next_turn",
	body: "Build failed for project foo.",
});

function setup(configOverrides: Record<string, unknown> = {}, options: Partial<RedisStreamsTransportOptions> = {}) {
	const input: EndpointConfig = { ...redisInput, config: { ...redisInput.config, ...configOverrides } };
	const client = new FakeRedisStreamsClient();
	const errors: unknown[] = [];
	const transport = new RedisStreamsTransport(input, { client, onError: (error) => errors.push(error), ...options });
	return { input, client, errors, transport };
}

/** Stop a transport whose read is blocked, standing in for the `BLOCK` timeout elapsing. */
async function stop(stopFn: () => Promise<void>, client: FakeRedisStreamsClient): Promise<void> {
	const stopped = stopFn();
	client.releaseRead();
	await stopped;
}

/** Wait for a condition driven by the transport's background loop (microtasks only). */
async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await Promise.resolve();
}

/**
 * Run microtasks without waiting for anything: the only way to assert a *negative* — that the loop
 * did not read again — is to give it every chance to and then look.
 */
async function microrounds(ticks = 200): Promise<void> {
	for (let tick = 0; tick < ticks; tick++) await Promise.resolve();
}

describe("redisStreamEntryTimestamp", () => {
	it("reads the broker arrival millis from the entry id's first segment", () => {
		expect(redisStreamEntryTimestamp("1791053000001-0")).toBe(1791053000001);
		expect(redisStreamEntryTimestamp("1-0")).toBe(1);
	});

	it("returns undefined for an id that is not in the Redis Streams shape", () => {
		// The renderer must omit `received at:` rather than fabricate a time from an unparseable id.
		expect(redisStreamEntryTimestamp("not-an-id")).toBeUndefined();
		expect(redisStreamEntryTimestamp("")).toBeUndefined();
		expect(redisStreamEntryTimestamp("-0")).toBeUndefined();
	});
});

describe("redisStreamsConfigFrom", () => {
	it("keeps explicit settings", () => {
		expect(
			redisStreamsConfigFrom({
				name: "builds",
				transport: "redis-streams",
				config: {
					stream: "ace:builds",
					group: "agents",
					url: "redis://broker:6380",
					consumer: "worker-1",
					field: "ace",
					count: 4,
					blockMs: 250,
				},
				options: {},
			}),
		).toMatchObject({
			url: "redis://broker:6380",
			stream: "ace:builds",
			group: "agents",
			consumer: "worker-1",
			field: "ace",
			count: 4,
			blockMs: 250,
			reclaimIdleMs: 60_000,
			reclaimAttempts: 3,
			retryDelayMs: 200,
			maxRetryDelayMs: 5_000,
		});
	});

	it("defaults url, field, count, blockMs and the consumer name", () => {
		const config = redisStreamsConfigFrom({ ...redisInput });

		expect(config.url).toBe("redis://127.0.0.1:6379");
		expect(config.field).toBe("message");
		expect(config.count).toBe(16);
		expect(config.blockMs).toBe(1000);
		expect(config.consumer).toMatch(/^ace-\d+$/);
	});

	const invalidConfigs: Array<[string, Record<string, unknown>]> = [
		["missing stream", { group: "agents" }],
		["empty group", { stream: "s", group: "" }],
		["zero count", { stream: "s", group: "g", count: 0 }],
		["fractional count", { stream: "s", group: "g", count: 1.5 }],
		["string count", { stream: "s", group: "g", count: "8" }],
		["zero blockMs", { stream: "s", group: "g", blockMs: 0 }],
		["empty field", { stream: "s", group: "g", field: "" }],
		["an unknown setting", { stream: "s", group: "g", strem: "typo" }],
	];

	it.each(invalidConfigs)("rejects a config with %s", (_name, config) => {
		const endpoint: EndpointConfig = { name: "builds", transport: "redis-streams", config, options: {} };
		expect(() => redisStreamsConfigFrom(endpoint)).toThrow(AceConfigError);
	});
});

describe("RedisStreamsTransport consumption", () => {
	it("connects, creates the group, delivers entries and acknowledges them", async () => {
		const { client, transport } = setup({ count: 4, blockMs: 250 });
		const handled: unknown[] = [];
		await transport.start(async (raw) => {
			handled.push(raw);
		});

		client.push({ id: "1-0", payload: validEntry });
		await client.waitForAcks(1);

		expect(client.connections).toBe(1);
		expect(client.ensuredGroups).toEqual([["ace:build-events", "coding-agent"]]);
		expect(handled).toEqual([validEntry]);
		expect(client.acked).toEqual(["1-0"]);
		expect(client.reads[0]).toMatchObject({
			stream: "ace:build-events",
			group: "coding-agent",
			count: 4,
			blockMs: 250,
		});
		await stop(() => transport.stop(), client);
	});

	it("handles a whole batch in order", async () => {
		const { client, transport } = setup();
		const handled: unknown[] = [];
		await transport.start(async (raw) => {
			handled.push(raw);
		});

		client.push({ id: "1-0", payload: "first" }, { id: "2-0", payload: "second" }, { id: "3-0", payload: "third" });
		await client.waitForAcks(3);

		expect(handled).toEqual(["first", "second", "third"]);
		expect(client.acked).toEqual(["1-0", "2-0", "3-0"]);
		await stop(() => transport.stop(), client);
	});

	it("leaves an entry pending when the handler fails, and keeps consuming", async () => {
		const { client, transport, errors } = setup();
		const handled: unknown[] = [];
		const failure = new Error("agent unavailable");
		await transport.start(async (raw) => {
			handled.push(raw);
			if (raw === "poison") throw failure;
		});

		client.push({ id: "1-0", payload: "poison" }, { id: "2-0", payload: "after" });
		await client.waitForAcks(1);

		expect(handled).toEqual(["poison", "after"]);
		expect(client.acked).toEqual(["2-0"]);
		expect(errors).toEqual([failure]);
		await stop(() => transport.stop(), client);
	});

	it("reports and acknowledges an entry without the payload field", async () => {
		const { client, transport, errors } = setup();
		const handled: unknown[] = [];
		await transport.start(async (raw) => {
			handled.push(raw);
		});

		client.push({ id: "1-0" });
		await client.waitForAcks(1);

		expect(handled).toEqual([]);
		expect(client.acked).toEqual(["1-0"]);
		expect(String(errors[0])).toContain('no "message" field');
		await stop(() => transport.stop(), client);
	});

	it("stops consuming and disconnects", async () => {
		const { client, transport } = setup();
		const handled: unknown[] = [];
		await transport.start(async (raw) => {
			handled.push(raw);
		});

		await stop(() => transport.stop(), client);

		expect(client.closes).toBe(1);
		client.push({ id: "9-0", payload: "too late" });
		await Promise.resolve();
		expect(handled).toEqual([]);
		expect(client.acked).toEqual([]);
	});

	it("refuses a second start", async () => {
		const { client, transport } = setup();
		await transport.start(async () => {});
		await expect(transport.start(async () => {})).rejects.toThrow(/already started/);
		await stop(() => transport.stop(), client);
	});

	it("does nothing when stopped before it was started", async () => {
		const { client, transport } = setup();
		await transport.stop();
		expect(client.closes).toBe(0);
	});

	it("reports a read failure and ends consumption", async () => {
		const { client, transport, errors } = setup();
		const failure = new Error("connection lost");
		await transport.start(async () => {});
		client.readError = failure;

		client.releaseRead();
		await waitFor(() => errors.length > 0);

		expect(errors).toEqual([failure]);
	});

	it("propagates a connection failure out of start", async () => {
		const { client, transport } = setup();
		const failure = new Error("ECONNREFUSED");
		client.connectError = failure;
		await expect(transport.start(async () => {})).rejects.toThrow(failure);
	});
});

describe("RedisStreamsTransport delivery queue", () => {
	it("keeps reading and reclaiming while a delivery waits", async () => {
		let now = 0;
		const { client, transport } = setup({ count: 2, reclaimIdleMs: 50 }, { now: () => now });
		const gate = Promise.withResolvers<void>();
		const handled: string[] = [];
		await transport.start(async (raw) => {
			handled.push(String(raw));
			// Stands in for a queued `aside` delivery, which surfaces at the next step boundary: no
			// wall clock, so the loop cannot wait for it.
			if (handled.length === 1) await gate.promise;
		});

		client.push({ id: "1-0", payload: "blocking" });
		await waitFor(() => handled.length === 1);

		// Delivery one is still running, yet the loop read the next batch: reads, not the wall clock.
		client.push({ id: "2-0", payload: "second" });
		await waitFor(() => client.reads.length >= 3);
		expect(client.reads.length).toBeGreaterThanOrEqual(3);

		// And the idle read reclaims a peer's stranded entry, throttled only by `reclaimIdleMs`.
		now = 100;
		client.pushReclaimable({ id: "9-0", payload: "reclaimed" });
		client.releaseRead();
		await waitFor(() => client.reclaimed.length >= 1);

		expect(client.reclaimed).toHaveLength(1);
		// Everything read queues behind the stuck delivery: one at a time, in read order, nothing acked.
		expect(handled).toEqual(["blocking"]);
		expect(client.acked).toEqual([]);

		gate.resolve();
		await client.waitForAcks(3);
		expect(handled).toEqual(["blocking", "second", "reclaimed"]);
		await stop(() => transport.stop(), client);
	});

	it("delivers entries one at a time in read order", async () => {
		const { client, transport } = setup({ count: 8 });
		const events: string[] = [];
		let running = 0;
		let peakRunning = 0;
		const releases: Array<() => void> = [];
		await transport.start(async (raw) => {
			running += 1;
			peakRunning = Math.max(peakRunning, running);
			events.push(`start:${String(raw)}`);
			const { promise, resolve } = Promise.withResolvers<void>();
			releases.push(resolve);
			await promise;
			running -= 1;
			events.push(`end:${String(raw)}`);
		});

		client.push({ id: "1-0", payload: "a" }, { id: "2-0", payload: "b" }, { id: "3-0", payload: "c" });
		await waitFor(() => events.length >= 1);
		await microrounds();
		expect(events).toEqual(["start:a"]);

		for (const payload of ["a", "b", "c"]) {
			await waitFor(() => events.includes(`start:${payload}`));
			releases.shift()?.();
			await waitFor(() => events.includes(`end:${payload}`));
		}

		expect(events).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
		expect(peakRunning).toBe(1);
		await client.waitForAcks(3);
		expect(client.acked).toEqual(["1-0", "2-0", "3-0"]);
		await stop(() => transport.stop(), client);
	});

	it("acknowledges only after the handler resolves, and reports a rejected entry pending", async () => {
		const { client, transport, errors } = setup();
		const failure = new Error("agent unavailable");
		const gate = Promise.withResolvers<void>();
		const handled: string[] = [];
		await transport.start(async (raw) => {
			handled.push(String(raw));
			if (raw === "first") await gate.promise;
			if (raw === "poison") throw failure;
		});

		client.push({ id: "1-0", payload: "first" }, { id: "2-0", payload: "poison" }, { id: "3-0", payload: "after" });
		await waitFor(() => handled.length === 1);
		await microrounds();
		expect(client.acked).toEqual([]);

		gate.resolve();
		await client.waitForAcks(2);

		// 1-0 acked once its handler resolved; 2-0 stays in the PEL for reclaim; 3-0 still delivered.
		expect(handled).toEqual(["first", "poison", "after"]);
		expect(client.acked).toEqual(["1-0", "3-0"]);
		expect(errors).toEqual([failure]);
		await stop(() => transport.stop(), client);
	});

	it("stops reading when the queue is full and resumes once it drains", async () => {
		const { client, transport } = setup({ count: 2 }, { deliveryQueueLimit: 2 });
		const gate = Promise.withResolvers<void>();
		const handled: string[] = [];
		await transport.start(async (raw) => {
			handled.push(String(raw));
			if (handled.length === 1) await gate.promise;
		});

		client.push({ id: "1-0", payload: "one" }, { id: "2-0", payload: "two" });
		await waitFor(() => handled.length === 1);
		// The batch filled the queue (limit 2) and the loop is back on a read that has nothing to return.
		await waitFor(() => client.reads.length >= 2);
		const readsAtTheBound = client.reads.length;

		client.push({ id: "3-0", payload: "three" });
		await microrounds();

		// Fourth entry read into a full queue: no further read, and nothing dropped.
		expect(client.reads).toHaveLength(readsAtTheBound);
		expect(handled).toEqual(["one"]);
		expect(client.acked).toEqual([]);

		gate.resolve();
		await client.waitForAcks(3);

		expect(client.reads.length).toBeGreaterThan(readsAtTheBound);
		expect(handled).toEqual(["one", "two", "three"]);
		expect(client.acked).toEqual(["1-0", "2-0", "3-0"]);
		await stop(() => transport.stop(), client);
	});

	it("waits for an in-flight delivery on stop and leaves no read entry unacknowledged", async () => {
		const { client, transport } = setup();
		const gate = Promise.withResolvers<void>();
		const handled: string[] = [];
		await transport.start(async (raw) => {
			handled.push(String(raw));
			if (handled.length === 1) await gate.promise;
		});

		client.push({ id: "1-0", payload: "first" }, { id: "2-0", payload: "second" });
		await waitFor(() => handled.length === 1);
		await waitFor(() => client.reads.length >= 2);

		const stopped = transport.stop();
		client.releaseRead();
		await microrounds();

		// The client stays open and nothing is acked while the delivery is still running.
		expect(client.closes).toBe(0);
		expect(client.acked).toEqual([]);

		gate.resolve();
		await stopped;

		// Both entries of the batch were delivered and acked before the client closed.
		expect(handled).toEqual(["first", "second"]);
		expect(client.acked).toEqual(["1-0", "2-0"]);
		expect(client.closes).toBe(1);
	});

	it("defaults the queue bound far above a realistic burst", () => {
		// Above the default `count` of 16 batches in flight; a bound that cannot hold one batch would
		// throttle the loop to one batch at a time for no reason.
		expect(REDIS_STREAMS_DELIVERY_QUEUE_LIMIT).toBeGreaterThan(16 * 10);
	});
	it("does not reclaim an entry it has accepted and is still delivering", async () => {
		let now = 0;
		const { client, transport, errors } = setup({ reclaimIdleMs: 50, reclaimAttempts: 1 }, { now: () => now });
		const gate = Promise.withResolvers<void>();
		const handled: string[] = [];
		await transport.start(async (raw) => {
			handled.push(String(raw));
			if (handled.length === 1) await gate.promise;
		});

		// The broker reports this consumer's own entry as idle, and it is: its delivery is still
		// waiting behind itself in the queue. It is not a peer's stranded entry, so it is skipped.
		client.pushReclaimable({ id: "1-0", payload: "first" });
		client.push({ id: "1-0", payload: "first" });
		await waitFor(() => handled.length === 1);

		now = 100;
		await waitFor(() => client.reads.length >= 2);
		client.releaseRead();
		await waitFor(() => client.reclaimed.length >= 1);

		now = 200;
		await waitFor(() => client.reads.length >= 3);
		client.pushReclaimable({ id: "1-0", payload: "first" });
		client.releaseRead();
		await waitFor(() => client.reclaimed.length >= 2);
		await microrounds();

		// Two reclaim passes saw the entry and both skipped it: it was neither delivered a second
		// time nor dead-lettered, and the `reclaimAttempts` budget was not spent on a delivery that
		// has not failed.
		expect(handled).toEqual(["first"]);
		expect(client.acked).toEqual([]);
		expect(errors.filter((error) => String(error).includes("dropping entry"))).toEqual([]);

		gate.resolve();
		await client.waitForAcks(1);

		// The skipped delivery completes on its own merits: delivered once, acked once.
		expect(handled).toEqual(["first"]);
		expect(client.acked).toEqual(["1-0"]);
		await stop(() => transport.stop(), client);
	});
});

describe("RedisStreamsTransport with the ACE runtime", () => {
	it("passes the stream entry id's broker timestamp to the handler", async () => {
		// The header's `received at:` line is the broker's append time, not the consumer's read time, so
		// the transport hands the handler the id's first segment.
		const { client, transport } = setup();
		const received: Array<number | undefined> = [];
		await transport.start(async (_raw, receivedAt) => {
			received.push(receivedAt);
		});

		client.push({ id: "1791053000001-0", payload: validEntry });
		await client.waitForAcks(1);

		expect(received).toEqual([1791053000001]);
		await stop(() => transport.stop(), client);
	});

	it("turns a stream entry into an injected ACE event and acknowledges it", async () => {
		const { client, transport } = setup();
		const engine = new FakeAgentEngine();
		const runtime = new AceRuntime({
			engine,
			subscribe: [redisInput],
			transports: { [redisInput.name]: transport },
		});

		await runtime.start();
		client.push({ id: "1791053000001-0", payload: validEntry });
		await client.waitForAcks(1);

		expect(engine.injections).toHaveLength(1);
		expect(engine.injections[0]?.message.id).toBe("evt_001");
		// The whole chain: the entry id's broker time and the channel name reach the renderer's context.
		expect(engine.injections[0]?.context).toMatchObject({
			subscription: "build-events",
			activation: "next_turn",
			receivedAt: 1791053000001,
		});
		// `channel` is unset here, so `arrived via:` falls back to the subscription label.
		const injected = engine.injections[0];
		expect(injected).toBeDefined();
		if (!injected?.context) throw new Error("expected an injection context");
		expect(renderAceEvent(injected.message, injected.context)).toContain("arrived via: build-events");
		await stop(() => runtime.stop(), client);
	});

	it("acknowledges an invalid ACE message after the runtime rejects it (RFC §13)", async () => {
		const { client, transport } = setup();
		const engine = new FakeAgentEngine();
		const logged: string[] = [];
		const runtime = new AceRuntime({
			engine,
			subscribe: [redisInput],
			transports: { [redisInput.name]: transport },
			logger: { warn: (message) => logged.push(message) },
		});

		await runtime.start();
		client.push({ id: "1-0", payload: "not json" });
		await client.waitForAcks(1);

		expect(engine.injections).toHaveLength(0);
		expect(client.acked).toEqual(["1-0"]);
		expect(logged.some((line) => line.includes("rejected"))).toBe(true);
		await stop(() => runtime.stop(), client);
	});
});
