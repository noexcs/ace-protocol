import { describe, expect, it, vi } from "vitest";
import type { AceLogger } from "../../src/logger.ts";
import type { AceMessage } from "../../src/protocol/ace-message.ts";
import { AceValidationError } from "../../src/protocol/validator.ts";
import { AceRuntime } from "../../src/runtime/ace-runtime.ts";
import { AceConfigError, type EndpointConfig } from "../../src/runtime/endpoint-config.ts";
import { InMemoryTransport } from "../../src/transport/in-memory-transport.ts";
import type { Transport } from "../../src/transport/transport.ts";
import { FakeAgentEngine } from "../support/fake-agent-engine.ts";

const validRaw = {
	aceVersion: "0.1",
	id: "evt_001",
	sender: "build-service",
	activation: "next_turn",
	body: "Build failed for project foo.",
};

function collectLogs(): AceLogger & { lines: string[] } {
	const lines: string[] = [];
	return {
		lines,
		info: (message) => lines.push(message),
		warn: (message) => lines.push(message),
		error: (message) => lines.push(message),
	};
}

function setup(inputOverrides: Partial<EndpointConfig> = {}, defaultActivation?: "immediate" | "next_turn" | "manual") {
	const transport = new InMemoryTransport();
	const engine = new FakeAgentEngine();
	const input: EndpointConfig = {
		name: "build-events",
		transport: "memory",
		config: {},
		options: {},
		...inputOverrides,
	};
	const logger = collectLogs();
	const runtime = new AceRuntime({
		engine,
		subscribe: [input],
		transports: { [input.name]: transport },
		logger,
		defaultActivation,
	});
	return { transport, engine, input, logger, runtime };
}

describe("AceRuntime dispatch (RFC §7, §9, §19)", () => {
	it("injects a next_turn event and starts a turn when the agent is idle", async () => {
		const { transport, engine, runtime } = setup();
		await runtime.start();

		await transport.publish(validRaw);

		expect(engine.injections).toEqual([
			{ message: validRaw, mode: "next_turn", context: { subscription: "build-events", activation: "next_turn" } },
		]);
		await runtime.stop();
	});

	it("queues a next_turn event without interrupting a running agent", async () => {
		const { engine, runtime } = setup();
		await runtime.start();
		engine.running = true;

		const result = await runtime.handleRawMessage(validRaw, {
			name: "build-events",
			transport: "memory",
			config: {},
			options: {},
		});

		expect(result).toMatchObject({
			activation: "next_turn",
			disposition: "queued",
			subscriptionName: "build-events",
		});
		expect(engine.injections[0]?.mode).toBe("next_turn");
	});

	it("hands an immediate event to the engine as immediate while running", async () => {
		const { engine, runtime, input } = setup();
		await runtime.start();
		engine.running = true;

		const result = await runtime.handleRawMessage({ ...validRaw, activation: "immediate" }, input);

		expect(result).toMatchObject({ activation: "immediate", disposition: "queued" });
		expect(engine.injections[0]?.mode).toBe("immediate");
	});

	it("starts a turn for an immediate event when idle (MVP scope)", async () => {
		const { engine, runtime, input } = setup();
		await runtime.start();

		const result = await runtime.handleRawMessage({ ...validRaw, activation: "immediate" }, input);

		expect(result).toMatchObject({ activation: "immediate", disposition: "injected" });
		expect(engine.injections[0]?.mode).toBe("immediate");
	});

	it("retains a manual event without starting the agent (RFC §7.3)", async () => {
		const { engine, runtime, input } = setup();
		await runtime.start();

		const result = await runtime.handleRawMessage({ ...validRaw, activation: "manual" }, input);

		expect(result).toMatchObject({ activation: "manual", disposition: "stored" });
		expect(engine.injections).toHaveLength(0);
		expect(runtime.pendingEvents).toHaveLength(1);
		expect(runtime.pendingEvents[0]?.message.id).toBe("evt_001");
	});

	it("activates a retained manual event on demand", async () => {
		const { engine, runtime, input } = setup();
		await runtime.start();
		await runtime.handleRawMessage({ ...validRaw, activation: "manual" }, input);

		await runtime.activatePendingEvent("build-service", "evt_001");

		expect(engine.injections).toEqual([
			{
				message: { ...validRaw, activation: "manual" },
				mode: "next_turn",
				context: { subscription: "build-events", activation: "manual" },
			},
		]);
		expect(runtime.pendingEvents).toHaveLength(0);
		await expect(runtime.activatePendingEvent("build-service", "evt_001")).rejects.toThrow(/no pending ACE event/i);
	});

	it("treats default as next_turn when nothing overrides it (RFC §7.4)", async () => {
		const { engine, runtime, input } = setup();
		await runtime.start();

		const result = await runtime.handleRawMessage({ ...validRaw, activation: "default" }, input);

		expect(result.activation).toBe("next_turn");
		expect(engine.injections[0]?.mode).toBe("next_turn");
	});

	it("lets input configuration override the sender (RFC §8)", async () => {
		const { runtime, input } = setup({ activation: "immediate" });
		await runtime.start();

		const result = await runtime.handleRawMessage(validRaw, input);

		expect(result.activation).toBe("immediate");
	});

	it("uses the configured runtime default only as the last fallback (RFC §8)", async () => {
		const { runtime, input } = setup({ activation: "default" }, "immediate");

		const result = await runtime.handleRawMessage({ ...validRaw, activation: "default" }, input);

		expect(result.activation).toBe("immediate");
	});
});

describe("AceRuntime message ingestion", () => {
	it("accepts JSON text and raw bytes from a transport", async () => {
		const { transport, engine, runtime } = setup();
		await runtime.start();

		await transport.publish(JSON.stringify(validRaw));
		await transport.publish(new TextEncoder().encode(JSON.stringify({ ...validRaw, id: "evt_002" })));

		expect(engine.injections.map((injection) => injection.message.id)).toEqual(["evt_001", "evt_002"]);
	});

	it("rejects an invalid message through the transport path and keeps running", async () => {
		const { transport, engine, runtime, logger } = setup();
		await runtime.start();

		await transport.publish({ ...validRaw, activation: "whenever" });
		await transport.publish(validRaw);

		expect(engine.injections).toHaveLength(1);
		expect(logger.lines.some((line) => line.includes("rejected"))).toBe(true);
	});

	it("throws AceValidationError when called directly", async () => {
		const { runtime, input } = setup();
		await expect(runtime.handleRawMessage({ ...validRaw, id: "" }, input)).rejects.toThrow(AceValidationError);
	});

	it("propagates engine errors so the transport can retry", async () => {
		const { engine, runtime, input } = setup();
		const failure = new Error("agent unavailable");
		engine.inject = vi.fn(async () => {
			throw failure;
		});

		await expect(runtime.handleRawMessage(validRaw, input)).rejects.toThrow(failure);
	});

	it("logs ids and senders but never the body", async () => {
		const { transport, runtime, logger } = setup();
		await runtime.start();

		await transport.publish(validRaw);

		expect(logger.lines.join("\n")).toContain("id=evt_001");
		expect(logger.lines.join("\n")).toContain("sender=build-service");
		expect(logger.lines.join("\n")).not.toContain(validRaw.body);
	});
});

describe("AceRuntime lifecycle and configuration", () => {
	it("only delivers after start and stops delivering after stop", async () => {
		const { transport, engine, runtime } = setup();

		await expect(transport.publish(validRaw)).rejects.toThrow(/no started handler/);

		await runtime.start();
		expect(transport.started).toBe(true);
		await transport.publish(validRaw);

		await runtime.stop();
		expect(transport.started).toBe(false);
		expect(engine.injections).toHaveLength(1);
		await expect(runtime.start()).resolves.toBeUndefined();
	});

	it("waits for the agent engine when stopping", async () => {
		const { runtime, engine } = setup();
		const waitForIdle = vi.spyOn(engine, "waitForIdle");

		await runtime.start();
		await runtime.stop();

		expect(waitForIdle).toHaveBeenCalled();
	});

	it("rejects an input without a registered transport", () => {
		expect(
			() =>
				new AceRuntime({
					engine: new FakeAgentEngine(),
					subscribe: [{ name: "alerts", transport: "redis-streams", config: {}, options: {} }],
					transports: {},
				}),
		).toThrow(/no transport registered under its name/);
	});

	it("rejects the same transport instance used by two inputs", () => {
		const shared = new InMemoryTransport();
		expect(
			() =>
				new AceRuntime({
					engine: new FakeAgentEngine(),
					subscribe: [
						{ name: "builds", transport: "memory", config: {}, options: {} },
						{ name: "alerts", transport: "memory", config: {}, options: {} },
					],
					transports: { builds: shared, alerts: shared },
				}),
		).toThrow(/delivered twice/);
	});

	it("rejects a duplicated input name", () => {
		expect(
			() =>
				new AceRuntime({
					engine: new FakeAgentEngine(),
					subscribe: [
						{ name: "builds", transport: "memory", config: {}, options: {} },
						{ name: "builds", transport: "memory", config: {}, options: {} },
					],
					transports: { builds: new InMemoryTransport() },
				}),
		).toThrow(/configured twice/);
	});

	it("reads two inputs of the same transport kind from separate transports", async () => {
		const engine = new FakeAgentEngine();
		const builds = new InMemoryTransport();
		const alerts = new InMemoryTransport();
		const runtime = new AceRuntime({
			engine,
			subscribe: [
				{ name: "builds", transport: "redis-streams", config: { stream: "ace:builds" }, options: {} },
				{ name: "alerts", transport: "redis-streams", config: { stream: "ace:alerts" }, options: {} },
			],
			transports: { builds, alerts },
		});

		await runtime.start();
		await builds.publish({ ...validRaw, id: "evt_build" });
		await alerts.publish({ ...validRaw, id: "evt_alert" });

		expect(engine.injections.map((injection) => injection.message.id)).toEqual(["evt_build", "evt_alert"]);
		expect(engine.injections.map((injection) => injection.message.sender)).toEqual([
			"build-service",
			"build-service",
		]);
	});

	// Deliberately malformed configurations: the runtime rejects them at construction.
	const invalidInputs: Array<[string, EndpointConfig]> = [
		["a missing name", { transport: "memory" } as unknown as EndpointConfig],
		["an empty transport", { name: "builds", transport: "", config: {}, options: {} } as unknown as EndpointConfig],
		[
			"an invalid activation",
			{ name: "builds", transport: "memory", activation: "soon" } as unknown as EndpointConfig,
		],
	];

	it.each(invalidInputs)("rejects an input config with %s", (_name, config) => {
		expect(
			() =>
				new AceRuntime({
					engine: new FakeAgentEngine(),
					subscribe: [config],
					transports: { [String(config.name ?? "builds")]: new InMemoryTransport() },
				}),
		).toThrow(AceConfigError);
	});

	it("rejects an unknown input name when handling by name", async () => {
		const { runtime } = setup();
		await expect(runtime.handleMessage(validRaw, "nope")).rejects.toThrow(/unknown subscription "nope"/);
	});

	it("keeps unknown ACE fields on the injected message (RFC §15)", async () => {
		const { engine, runtime, input } = setup();

		await runtime.handleRawMessage({ ...validRaw, futureField: "value" }, input);

		expect((engine.injections[0]?.message as AceMessage).futureField).toBe("value");
	});

	it("marks an event from one of this session's own senders as self (defect: no self marker)", async () => {
		const transport = new InMemoryTransport();
		const engine = new FakeAgentEngine();
		const input: EndpointConfig = { name: "inbox", transport: "memory", config: {}, options: {} };
		const runtime = new AceRuntime({
			engine,
			subscribe: [input],
			transports: { [input.name]: transport },
			selfSenders: ["ace:ana:oh-my-pi:sess"],
		});
		await runtime.start();

		await runtime.handleRawMessage({ ...validRaw, sender: "ace:ana:oh-my-pi:sess", id: "evt_self" }, input);
		await runtime.handleRawMessage({ ...validRaw, id: "evt_peer" }, input);

		expect(engine.injections[0]?.context?.self).toBe(true);
		expect(engine.injections[1]?.context?.self).toBeUndefined();
	});

	it("echoes a self-published event back on every channel the session reads", async () => {
		// Bug 1 of the seventh open round: the report read "self-publishes to `ace:noexcs:inbox` produced
		// ZERO self-echoes while `ace:noexcs:team` echoed". No channel selects for a drop — the inbox event
		// simply arrived several turns later (the same evaluation's transcripts show it did arrive, and the
		// runtime does not filter by channel). This test pins the invariant that made it impossible: one
		// runtime, two subscriptions, the same self-sent event delivered on each, both injected and both
		// marked `self`, because de-duplication is per subscription and the marker is per message.
		const engine = new FakeAgentEngine();
		const inbox: EndpointConfig = { name: "session-inbox", transport: "memory", config: {}, options: {} };
		const team: EndpointConfig = { name: "ace:ana:team", transport: "memory", config: {}, options: {} };
		const transports = { [inbox.name]: new InMemoryTransport(), [team.name]: new InMemoryTransport() };
		const runtime = new AceRuntime({
			engine,
			subscribe: [inbox, team],
			transports,
			selfSenders: ["ace:ana:oh-my-pi:sess"],
		});
		await runtime.start();

		const selfPublished = { ...validRaw, sender: "ace:ana:oh-my-pi:sess", id: "evt_self" };
		const first = await runtime.handleRawMessage(selfPublished, inbox);
		const second = await runtime.handleRawMessage(selfPublished, team);

		expect(first.disposition).toBe("injected");
		expect(second.disposition).toBe("injected");
		expect(engine.injections.map((injection) => injection.message.id)).toEqual(["evt_self", "evt_self"]);
		expect(engine.injections.map((injection) => injection.context?.self)).toEqual([true, true]);
		expect(engine.injections.map((injection) => injection.context?.subscription)).toEqual([
			"session-inbox",
			"ace:ana:team",
		]);
	});
});

describe("AceRuntime start failure leaves nothing running (audit C)", () => {
	it("stops the transports it already started when a later one refuses to start", async () => {
		const events: string[] = [];
		const first: Transport = {
			async start() {
				events.push("first:start");
			},
			async stop() {
				events.push("first:stop");
			},
		};
		const second: Transport = {
			async start() {
				events.push("second:start");
				throw new Error("redis://127.0.0.1:1 is unreachable");
			},
			async stop() {
				events.push("second:stop");
			},
		};
		const a: EndpointConfig = { name: "a", transport: "memory", config: {}, options: {} };
		const b: EndpointConfig = { name: "b", transport: "memory", config: {}, options: {} };
		const runtime = new AceRuntime({
			engine: new FakeAgentEngine(),
			subscribe: [a, b],
			transports: { a: first, b: second },
		});

		await expect(runtime.start()).rejects.toThrow(/unreachable/);

		// The transport that connected is stopped; the one that failed never gets a stop it does not need.
		expect(events).toEqual(["first:start", "second:start", "first:stop"]);
	});

	it("still rejects when a started transport will not finish stopping", async () => {
		const events: string[] = [];
		const first: Transport = {
			async start() {
				events.push("first:start");
			},
			// A stalled host holds the drain open forever; the cleanup must not wait for it.
			stop() {
				events.push("first:stop");
				return new Promise<void>(() => {});
			},
		};
		const second: Transport = {
			async start() {
				throw new Error("redis://127.0.0.1:1 is unreachable");
			},
			async stop() {},
		};
		const a: EndpointConfig = { name: "a", transport: "memory", config: {}, options: {} };
		const b: EndpointConfig = { name: "b", transport: "memory", config: {}, options: {} };
		const logger = collectLogs();
		const runtime = new AceRuntime({
			engine: new FakeAgentEngine(),
			subscribe: [a, b],
			transports: { a: first, b: second },
			logger,
		});

		await expect(runtime.start()).rejects.toThrow(/unreachable/);
		expect(events).toEqual(["first:start", "first:stop"]);
		expect(logger.lines.some((line) => line.includes("still unwinding"))).toBe(true);
	}, 10_000);
});
