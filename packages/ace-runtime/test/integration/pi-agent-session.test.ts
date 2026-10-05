import { afterEach, describe, expect, it } from "vitest";
import { PiAdapter, renderAceEvent } from "../../src/agent/pi-adapter.ts";
import type { AceMessage } from "../../src/protocol/ace-message.ts";
import { AceRuntime } from "../../src/runtime/ace-runtime.ts";
import type { EndpointConfig } from "../../src/runtime/endpoint-config.ts";
import { InMemoryTransport } from "../../src/transport/in-memory-transport.ts";
import { createTestPiSession, type TestPiSession } from "../support/pi-session.ts";

const buildFailure: AceMessage = {
	aceVersion: "0.1",
	id: "evt_001",
	sender: "build-service",
	activation: "next_turn",
	body: "Build failed for project foo at commit abc123.",
};

interface Harness {
	pi: TestPiSession;
	adapter: PiAdapter;
	runtime: AceRuntime;
	transport: InMemoryTransport;
	input: EndpointConfig;
	runErrors: unknown[];
}

describe("ACE runtime with a real Pi agent session", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(input: Partial<EndpointConfig> = {}): Promise<Harness> {
		const pi = await createTestPiSession();
		const transport = new InMemoryTransport();
		const runErrors: unknown[] = [];
		const adapter = new PiAdapter({
			session: pi.session,
			onRunError: (error) => runErrors.push(error),
		});
		const inputConfig: EndpointConfig = {
			name: "build-events",
			transport: "memory",
			activation: "default",
			...input,
			config: input.config ?? {},
			options: input.options ?? {},
		};
		const runtime = new AceRuntime({
			engine: adapter,
			subscribe: [inputConfig],
			transports: { [inputConfig.name]: transport },
		});
		cleanups.push(async () => {
			await runtime.stop();
			await pi.dispose();
		});
		return { pi, adapter, runtime, transport, input: inputConfig, runErrors };
	}

	it("puts an external event into the Pi context and starts a turn (design doc §36)", async () => {
		const { pi, runtime, transport } = await setup();
		pi.reply("I see the build failure, inspecting the logs.");
		await runtime.start();

		await transport.publish(buildFailure);
		await pi.session.waitForIdle();

		expect(pi.requests).toHaveLength(1);
		expect(pi.requests[0]).toContain(buildFailure.body);
		expect(pi.requests[0]).toContain("sender: build-service");
		expect(pi.requests[0]).toContain("id: evt_001");
		expect(pi.session.getLastAssistantText()).toBe("I see the build failure, inspecting the logs.");
	});

	it("reports the disposition of each activation through the same path", async () => {
		const { pi, runtime } = await setup();
		pi.reply("acknowledged");
		await runtime.start();

		const injected = await runtime.handleMessage(buildFailure, "build-events");
		await pi.session.waitForIdle();

		expect(injected).toEqual({ activation: "next_turn", disposition: "injected", subscriptionName: "build-events" });
		expect(pi.requests).toHaveLength(1);
	});

	it("starts a turn for an immediate event while the agent is idle", async () => {
		const { pi, runtime } = await setup();
		pi.reply("handling immediately");
		await runtime.start();

		const result = await runtime.handleMessage({ ...buildFailure, activation: "immediate" }, "build-events");
		await pi.session.waitForIdle();

		expect(result).toMatchObject({ activation: "immediate", disposition: "injected" });
		expect(pi.requests[0]).toContain(buildFailure.body);
	});

	it("does not start a turn for a manual event, then injects it on activation (RFC §7.3)", async () => {
		const { pi, runtime } = await setup();
		await runtime.start();

		const result = await runtime.handleMessage({ ...buildFailure, activation: "manual" }, "build-events");

		expect(result).toMatchObject({ activation: "manual", disposition: "stored" });
		expect(pi.requests).toHaveLength(0);
		expect(runtime.pendingEvents).toHaveLength(1);

		pi.reply("handling the retained event");
		await runtime.activatePendingEvent("build-service", "evt_001");
		await pi.session.waitForIdle();

		// The first turn the model ever saw is the one carrying the retained event.
		expect(pi.requests).toHaveLength(1);
		expect(pi.requests[0]).toContain(buildFailure.body);
		expect(runtime.pendingEvents).toHaveLength(0);
	});

	it("queues a next_turn event while running and delivers it exactly once (RFC §7.2)", async () => {
		const { pi, adapter, runtime } = await setup();
		pi.reply("first turn");
		pi.reply("second turn");
		await runtime.start();

		await runtime.handleMessage(buildFailure, "build-events");
		expect(adapter.isRunning()).toBe(true);

		const queued = await runtime.handleMessage(
			{ ...buildFailure, id: "evt_002", body: "Second event while running." },
			"build-events",
		);
		expect(queued).toMatchObject({ activation: "next_turn", disposition: "queued" });

		await pi.session.waitForIdle();

		// RFC §7.2 leaves batching to the runtime, so the event may share the running
		// turn's next request; what matters is that the turn was not interrupted and the
		// event reached the model exactly once.
		expect(pi.requests.filter((request) => request.includes("Second event while running."))).toHaveLength(1);
		expect(pi.requests.some((request) => request.includes(buildFailure.body))).toBe(true);
	});

	it("delivers an immediate event while running exactly once", async () => {
		const { pi, adapter, runtime } = await setup();
		pi.reply("first turn");
		pi.reply("preempted turn");
		await runtime.start();

		await runtime.handleMessage(buildFailure, "build-events");
		expect(adapter.isRunning()).toBe(true);

		const result = await runtime.handleMessage(
			{ ...buildFailure, id: "evt_003", activation: "immediate", body: "Urgent alert." },
			"build-events",
		);
		expect(result).toMatchObject({ activation: "immediate", disposition: "queued" });

		await pi.session.waitForIdle();

		expect(pi.requests.filter((request) => request.includes("Urgent alert."))).toHaveLength(1);
	});

	it("lets input configuration force immediate over a next_turn sender (RFC §8)", async () => {
		const { pi, runtime } = await setup({ activation: "immediate" });
		pi.reply("forced immediate");
		await runtime.start();

		const result = await runtime.handleMessage(buildFailure, "build-events");
		await pi.session.waitForIdle();

		expect(result.activation).toBe("immediate");
		expect(pi.requests[0]).toContain(buildFailure.body);
	});

	it("rejects an invalid message without touching the agent (RFC §13)", async () => {
		const { pi, runtime, transport, runErrors } = await setup();
		await runtime.start();

		await transport.publish({ ...buildFailure, activation: "whenever" });
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(pi.requests).toHaveLength(0);
		expect(runErrors).toHaveLength(0);
		expect(pi.session.getLastAssistantText()).toBeUndefined();
	});

	it("renders the ACE event as context text with a stable header (design doc §18)", async () => {
		expect(renderAceEvent(buildFailure, { subscription: "inbox", address: "ace:in.a" })).toBe(
			"<ace_event>\nsender: build-service\nstream: ace:in.a\nid: evt_001\n\n" +
				"Build failed for project foo at commit abc123.\n</ace_event>",
		);
	});
});
