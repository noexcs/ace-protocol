import { describe, expect, it, vi } from "vitest";
import { PiAdapter, renderAceEvent } from "../../src/agent/pi-adapter.ts";
import type { AceMessage } from "../../src/protocol/ace-message.ts";
import { FakeAgentSession } from "../support/fake-pi-session.ts";

function message(id: string, activation: AceMessage["activation"] = "next_turn"): AceMessage {
	return { aceVersion: "0.1", id, sender: "build-service", activation, body: `body of ${id}` };
}

function setup() {
	const session = new FakeAgentSession();
	const errors: unknown[] = [];
	const adapter = new PiAdapter({ session: session.asAgentSession(), onRunError: (error) => errors.push(error) });
	return { session, adapter, errors };
}

describe("PiAdapter injection", () => {
	it("starts a run with the event when the agent is idle", async () => {
		const { session, adapter } = setup();

		await adapter.inject(message("evt_1"), "next_turn");

		expect(session.prompted).toEqual([renderAceEvent(message("evt_1"))]);
		expect(session.steered).toEqual([]);
		expect(session.followedUp).toEqual([]);
	});

	it("queues a next_turn event while the agent runs", async () => {
		const { session, adapter } = setup();
		session.streaming = true;

		await adapter.inject(message("evt_1"), "next_turn");

		expect(session.followedUp).toEqual([renderAceEvent(message("evt_1"))]);
		expect(session.prompted).toEqual([]);
	});

	it("steers an immediate event while the agent runs", async () => {
		const { session, adapter } = setup();
		session.streaming = true;

		await adapter.inject(message("evt_1", "immediate"), "immediate");

		expect(session.steered).toEqual([renderAceEvent(message("evt_1"))]);
		expect(session.prompted).toEqual([]);
	});

	it("starts a run for an immediate event when the agent is idle", async () => {
		const { session, adapter } = setup();

		await adapter.inject(message("evt_1", "immediate"), "immediate");

		expect(session.prompted).toHaveLength(1);
	});
});

describe("PiAdapter stranded-event recovery", () => {
	it("starts a new run for an event the finished loop never injected", async () => {
		const { session, adapter } = setup();
		session.streaming = true;
		const queued = message("evt_1", "immediate");
		await adapter.inject(queued, "immediate");

		session.streaming = false;
		session.emit({ type: "agent_settled" });

		expect(session.clears).toBe(1);
		expect(session.prompted).toEqual([renderAceEvent(queued)]);
	});

	it("does not re-inject an event Pi already put into the conversation", async () => {
		const { session, adapter } = setup();
		session.streaming = true;
		await adapter.inject(message("evt_1"), "next_turn");
		session.emitInjectedUserMessage(renderAceEvent(message("evt_1")));

		session.streaming = false;
		session.emit({ type: "agent_settled" });

		expect(session.clears).toBe(0);
		expect(session.prompted).toEqual([]);
	});

	it("re-injects only undelivered events, preserving order", async () => {
		const { session, adapter } = setup();
		session.streaming = true;
		await adapter.inject(message("evt_1"), "next_turn");
		await adapter.inject(message("evt_2"), "next_turn");
		await adapter.inject(message("evt_3"), "next_turn");
		session.emitInjectedUserMessage(renderAceEvent(message("evt_1")));
		session.emitInjectedUserMessage(renderAceEvent(message("evt_3")));

		session.streaming = false;
		session.emit({ type: "agent_settled" });

		expect(session.prompted).toEqual([renderAceEvent(message("evt_2"))]);
	});

	it("treats repeated identical bodies as separate events", async () => {
		const { session, adapter } = setup();
		const event = message("evt_1");
		session.streaming = true;
		await adapter.inject(event, "next_turn");
		await adapter.inject(event, "next_turn");
		session.emitInjectedUserMessage(renderAceEvent(event));

		session.streaming = false;
		session.emit({ type: "agent_settled" });

		expect(session.prompted).toEqual([renderAceEvent(event)]);
	});

	it("does nothing when no event was queued", async () => {
		const { session } = setup();

		session.emit({ type: "agent_settled" });

		expect(session.clears).toBe(0);
		expect(session.prompted).toEqual([]);
	});
});

describe("PiAdapter error reporting", () => {
	it("reports a run that failed to start", async () => {
		const { session, adapter, errors } = setup();
		const failure = new Error("no API key");
		session.promptError = failure;

		await adapter.inject(message("evt_1"), "next_turn");

		expect(errors).toEqual([failure]);
	});

	it("reports agent turn errors from agent_end", async () => {
		const { session, errors } = setup();

		session.emit({
			type: "agent_end",
			willRetry: false,
			messages: [{ role: "assistant", content: [], errorMessage: "provider exploded" }],
		});

		expect(errors).toEqual(["provider exploded"]);
	});

	it("ignores agent_end that will be retried", () => {
		const { session, errors } = setup();

		session.emit({
			type: "agent_end",
			willRetry: true,
			messages: [{ role: "assistant", content: [], errorMessage: "transient" }],
		});

		expect(errors).toEqual([]);
	});

	it("keeps running when the error hook throws", async () => {
		const session = new FakeAgentSession();
		const adapter = new PiAdapter({
			session: session.asAgentSession(),
			onRunError: () => {
				throw new Error("hook broken");
			},
		});
		session.promptError = new Error("boom");

		await expect(adapter.inject(message("evt_1"), "next_turn")).resolves.toBeUndefined();
	});

	it("lets queue failures surface to the caller", async () => {
		const { session, adapter, errors } = setup();
		const failure = new Error("queue rejected");
		session.streaming = true;
		session.followUp = vi.fn(async () => {
			throw failure;
		});

		await expect(adapter.inject(message("evt_1"), "next_turn")).rejects.toThrow(failure);
		expect(errors).toEqual([]);
	});
});
