import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AceRuntime } from "../../src/runtime/ace-runtime.ts";
import type { EndpointConfig } from "../../src/runtime/endpoint-config.ts";
import { AceMetrics } from "../../src/runtime/metrics.ts";
import { InMemoryTransport } from "../../src/transport/in-memory-transport.ts";
import { FakeAgentEngine } from "../support/fake-agent-engine.ts";

const directories: string[] = [];

function temporaryDirectory(): string {
	const dir = mkdtempSync(join(tmpdir(), "ace-policy-"));
	directories.push(dir);
	return dir;
}

afterEach(() => {
	while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true });
});

const validRaw = {
	aceVersion: "0.1",
	id: "evt_001",
	sender: "ci",
	activation: "next_turn",
	body: "Build failed.",
};

function subscription(overrides: Partial<EndpointConfig> = {}): EndpointConfig {
	return {
		name: "inbox",
		transport: "memory",
		activation: "next_turn",
		config: {},
		options: {},
		...overrides,
	};
}

function setup(
	options: {
		subscription?: Partial<EndpointConfig>;
		dedupCapacity?: number;
		manual?: { max?: number; ttlMs?: number };
		spool?: { dir: string };
		now?: () => number;
		setTimer?: (callback: () => void, ms: number) => { cancel: () => void };
	} = {},
) {
	const transport = new InMemoryTransport();
	const engine = new FakeAgentEngine();
	const metrics = new AceMetrics();
	const endpoint = subscription(options.subscription);
	const runtime = new AceRuntime({
		engine,
		metrics,
		subscribe: [endpoint],
		transports: { [endpoint.name]: transport },
		...(options.dedupCapacity === undefined ? {} : { dedupCapacity: options.dedupCapacity }),
		...(options.manual === undefined ? {} : { manual: options.manual }),
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.spool === undefined
			? {}
			: {
					spool: {
						dir: options.spool.dir,
						...(options.now === undefined ? {} : { now: options.now }),
						...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
					},
				}),
	});
	return { transport, engine, metrics, runtime, endpoint };
}

describe("delivery policy: deduplication", () => {
	it("injects a redelivered event only once and still reports it as handled", async () => {
		const { engine, runtime, endpoint } = setup();

		const first = await runtime.handleRawMessage(validRaw, endpoint);
		const second = await runtime.handleRawMessage(validRaw, endpoint);

		expect(first.disposition).toBe("injected");
		expect(second).toMatchObject({ disposition: "deduped", activation: "next_turn" });
		expect(engine.injections).toHaveLength(1);
	});

	it("keeps a failed delivery eligible for redelivery (a retry is not a duplicate)", async () => {
		const { engine, runtime, endpoint } = setup();
		engine.failures = 1;

		await expect(runtime.handleRawMessage(validRaw, endpoint)).rejects.toThrow("fake engine unavailable");
		const retry = await runtime.handleRawMessage(validRaw, endpoint);

		expect(retry.disposition).toBe("injected");
		expect(engine.injections.map((injection) => injection.message.id)).toEqual(["evt_001"]);
	});

	it("forgets the oldest identity once the window is full", async () => {
		const { engine, runtime, endpoint } = setup({ dedupCapacity: 1 });

		await runtime.handleRawMessage({ ...validRaw, id: "evt_1" }, endpoint);
		await runtime.handleRawMessage({ ...validRaw, id: "evt_2" }, endpoint);
		await runtime.handleRawMessage({ ...validRaw, id: "evt_1" }, endpoint);

		expect(engine.injections.map((injection) => injection.message.id)).toEqual(["evt_1", "evt_2", "evt_1"]);
	});
});

describe("delivery policy: sender allowlist", () => {
	it("drops events from senders outside the allowlist and counts them", async () => {
		const { engine, metrics, runtime, endpoint } = setup({ subscription: { allowedSenders: ["ci.*", "agent-?"] } });

		const refused = await runtime.handleRawMessage({ ...validRaw, sender: "stranger" }, endpoint);
		const accepted = await runtime.handleRawMessage({ ...validRaw, sender: "ci.runner-7" }, endpoint);

		expect(refused).toMatchObject({ disposition: "dropped" });
		expect(accepted).toMatchObject({ disposition: "injected" });
		expect(engine.injections).toHaveLength(1);
		expect(metrics.snapshot().inbox?.senderRejected).toBe(1);
	});

	it("accepts every sender when no allowlist is configured", async () => {
		const { engine, runtime, endpoint } = setup();

		await runtime.handleRawMessage({ ...validRaw, sender: "stranger" }, endpoint);

		expect(engine.injections).toHaveLength(1);
	});
});

describe("delivery policy: metrics", () => {
	it("counts received, rejected, injected and deduped per channel", async () => {
		const { metrics, runtime, endpoint } = setup();

		await runtime.handleRawMessage(validRaw, endpoint);
		await runtime.handleRawMessage(validRaw, endpoint);
		await runtime.handleRawMessage({ ...validRaw, id: "bad", activation: "whenever" }, endpoint).catch(() => {});

		expect(metrics.snapshot().inbox).toMatchObject({ received: 3, injected: 1, deduped: 1, rejected: 1 });
		expect(metrics.render()[0]).toMatch(/^inbox: /);
	});
});

describe("delivery policy: manual retention", () => {
	it("caps retained manual events", async () => {
		const { runtime, endpoint } = setup({ manual: { max: 1 }, subscription: { activation: "default" } });

		await runtime.handleRawMessage({ ...validRaw, id: "m1", activation: "manual" }, endpoint);
		await runtime.handleRawMessage({ ...validRaw, id: "m2", activation: "manual" }, endpoint);

		expect(runtime.pendingEvents.map((event) => event.message.id)).toEqual(["m2"]);
	});

	it("drops manual events that outlive the retention window", async () => {
		let now = 1_000;
		const { runtime, endpoint } = setup({
			manual: { ttlMs: 50 },
			now: () => now,
			subscription: { activation: "default" },
		});

		await runtime.handleRawMessage({ ...validRaw, id: "m1", activation: "manual" }, endpoint);
		now += 51;

		expect(runtime.pendingEvents).toEqual([]);
	});
});

describe("delivery policy: burst spilling", () => {
	/** Timer that fires only when the test advances it. */
	function manualTimer() {
		const callbacks: Array<() => void> = [];
		return {
			setTimer: (callback: () => void) => {
				callbacks.push(callback);
				return { cancel: () => {} };
			},
			async fire() {
				for (const callback of callbacks.splice(0)) callback();
				for (let i = 0; i < 20; i += 1) await Promise.resolve();
			},
		};
	}

	it("spills the overflow and injects one summary event instead", async () => {
		const timer = manualTimer();
		const { engine, runtime, endpoint } = setup({
			subscription: { spool: { afterEvents: 1, windowMs: 100 } },
			spool: { dir: temporaryDirectory() },
			setTimer: timer.setTimer,
		});

		await runtime.handleRawMessage({ ...validRaw, id: "e1" }, endpoint);
		const spilled = runtime.handleRawMessage({ ...validRaw, id: "e2" }, endpoint);
		const alsoSpilled = runtime.handleRawMessage({ ...validRaw, id: "e3" }, endpoint);
		await timer.fire();

		expect(await spilled).toMatchObject({ disposition: "spooled" });
		expect(await alsoSpilled).toMatchObject({ disposition: "spooled" });
		// e1 was injected normally; e2/e3 collapsed into one summary.
		expect(engine.injections.map((injection) => injection.message.id)).toHaveLength(2);
		const summary = engine.injections[1]?.message;
		expect(summary?.sender).toBe("ace-runtime");
		expect(summary?.body).toContain("2 events were spooled");
	});
});
