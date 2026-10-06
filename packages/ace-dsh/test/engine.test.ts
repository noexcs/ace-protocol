/**
 * The engine's delivery contract: which ACE activation becomes which host call, and what the agent sees.
 *
 * These are the assertions the whole plugin rests on. On Pi the equivalent mapping was measured against a
 * live session because the host's queue semantics were not visible in its types; on DeepSeek Harness
 * `followup`/`steer` are documented to admit a durable inbox message, so the mapping is asserted here.
 */

import { describe, expect, it } from "vitest";
import type { AceDelivery } from "../src/dsh.ts";
import { DshAgentEngine } from "../src/engine.ts";
import { aceEvent, FakeAgent } from "./support/harness.ts";

function engineFor(agent: FakeAgent): DshAgentEngine {
	return new DshAgentEngine({
		agent,
		buildMessage: (delivery: AceDelivery) => ({ text: delivery.text, summary: delivery.summary }),
	});
}

describe("DshAgentEngine", () => {
	it("queues a next_turn event for the next turn and wakes the session", async () => {
		const agent = new FakeAgent();
		await engineFor(agent).inject(aceEvent({ activation: "next_turn" }), "next_turn");

		expect(agent.received).toHaveLength(1);
		expect(agent.received[0]?.kind).toBe("followup");
		expect(agent.lastText).toContain("<ace_event>");
		expect(agent.lastText).toContain("build failed on main");
	});

	it("never steers a next_turn event, even while a turn is running", async () => {
		const agent = new FakeAgent();
		agent.status = "running";
		await engineFor(agent).inject(aceEvent({ activation: "next_turn" }), "next_turn");

		expect(agent.received.map((entry) => entry.kind)).toEqual(["followup"]);
	});

	it("steers an immediate event into the running turn", async () => {
		const agent = new FakeAgent();
		agent.status = "running";
		await engineFor(agent).inject(aceEvent({ activation: "immediate" }), "immediate");

		expect(agent.received.map((entry) => entry.kind)).toEqual(["steer"]);
	});

	it("starts a turn for an immediate event when the session is idle", async () => {
		const agent = new FakeAgent();
		await engineFor(agent).inject(aceEvent({ activation: "immediate" }), "immediate");

		// `followup` is the waking delivery on this host; `steer` on an idle agent would have nothing to steer.
		expect(agent.received.map((entry) => entry.kind)).toEqual(["followup"]);
	});

	it("renders the receiving channel and the sender's own claims into the block", async () => {
		const agent = new FakeAgent();
		await engineFor(agent).inject(aceEvent({ activation: "next_turn" }), "next_turn", {
			subscription: "session-inbox",
			channel: "ace:tester:dsh:s-1",
			activation: "next_turn",
			receivedAt: 1_700_000_000_000,
		});

		const text = agent.lastText;
		expect(text).toContain("sender: ace:peer:dsh:peer-1");
		expect(text).toContain("arrived via: ace:tester:dsh:s-1");
		expect(text).toContain("received at: 2023-11-14T22:13:20.000Z");
		expect(text).toContain("id: evt-1");
		// The body is opaque and passed through verbatim, after the header line that ends it.
		expect(text).toContain("<ace_body>\nbuild failed on main\n</ace_event>");
	});

	it("reports running state and idle waits from the agent itself", async () => {
		const agent = new FakeAgent();
		const engine = engineFor(agent);
		expect(engine.isRunning()).toBe(false);
		agent.status = "running";
		expect(engine.isRunning()).toBe(true);
		await engine.waitForIdle();
	});

	it("forwards failed turns to the runtime's failure counter", async () => {
		const agent = new FakeAgent();
		const seen: unknown[] = [];
		engineFor(agent).onRunError((error) => seen.push(error));
		agent.failRun(new Error("turn exploded"));

		expect(seen).toHaveLength(1);
		expect(String(seen[0])).toContain("turn exploded");
	});
});
