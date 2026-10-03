import { describe, expect, it } from "vitest";
import { AceRuntime } from "../../src/runtime/ace-runtime.ts";
import { AceConfigError, type EndpointConfig } from "../../src/runtime/endpoint-config.ts";
import { RedisStreamsTransport, redisStreamsConfigFrom } from "../../src/transport/redis-streams-transport.ts";
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

function setup(configOverrides: Record<string, unknown> = {}) {
	const input: EndpointConfig = { ...redisInput, config: { ...redisInput.config, ...configOverrides } };
	const client = new FakeRedisStreamsClient();
	const errors: unknown[] = [];
	const transport = new RedisStreamsTransport(input, { client, onError: (error) => errors.push(error) });
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
		).toEqual({
			url: "redis://broker:6380",
			stream: "ace:builds",
			group: "agents",
			consumer: "worker-1",
			field: "ace",
			count: 4,
			blockMs: 250,
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

describe("RedisStreamsTransport with the ACE runtime", () => {
	it("turns a stream entry into an injected ACE event and acknowledges it", async () => {
		const { client, transport } = setup();
		const engine = new FakeAgentEngine();
		const runtime = new AceRuntime({
			engine,
			subscribe: [redisInput],
			transports: { [redisInput.name]: transport },
		});

		await runtime.start();
		client.push({ id: "1-0", payload: validEntry });
		await client.waitForAcks(1);

		expect(engine.injections).toHaveLength(1);
		expect(engine.injections[0]?.message.id).toBe("evt_001");
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
