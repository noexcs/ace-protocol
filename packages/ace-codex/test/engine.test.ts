/**
 * `CodexEngine` behavior over the `app-server` turn methods, driven by the
 * scripted {@link FakeAppServer} (no live Codex needed).
 *
 * This pins the ACE contract against the real routing the adapter performs:
 *
 * - **mode mapping** — idle `next_turn`/`immediate` → `turn/start`;
 *   `next_turn` while running is held and drained one turn at a time on idle;
 *   `immediate` while running folds into the active turn via `turn/steer`.
 * - **the steer `expectedTurnId` mismatch** — a genuine mismatch while the turn
 *   is still active propagates; a turn that ended mid-operation falls back to a
 *   fresh `turn/start`.
 * - **the ack point** — `inject` resolves only once the server echoes the exact
 *   rendered `<ace_event>` text back as a `userMessage` item; `turn/completed`
 *   alone does **not** ack; a delivery never observed within
 *   `deliveryTimeoutMs` rejects (the broker keeps the event pending).
 * - **manual** — never reaches the engine: the ACE runtime holds it in its own
 *   pending store (no turn, no Codex-side queue), and explicit activation
 *   re-dispatches it as `next_turn` → `turn/start`.
 */

import {
	AceDeliveryObserver,
	type AceMessage,
	AceRuntime,
	type EndpointConfig,
	InMemoryTransport,
	renderAceEvent,
} from "ace-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { AppServerClient } from "../src/client.ts";
import { CodexEngine } from "../src/engine.ts";
import { createMemoryConnections } from "../src/memory-connection.ts";
import { AppServerError } from "../src/protocol.ts";
import { FakeAppServer } from "./support/fake-app-server.ts";

const CONTEXT = { subscription: "build-events", address: "ace:ci" };

/** Flush pending microtasks (the in-memory connection delivers via `queueMicrotask`). */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Poll `predicate` (on real microtask ticks) until true, or fail after ~2s. */
async function until(predicate: () => boolean, what: string): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > 2000) throw new Error(`timed out waiting for ${what}`);
		await tick();
	}
}

function makeMessage(id: string, body: string, activation: AceMessage["activation"] = "next_turn"): AceMessage {
	return { aceVersion: "0.1", id, sender: "ci-bot", activation, body };
}

/** The text input units of a `turn/start` request. */
function turnStartInput(request: { params?: unknown } | undefined): Array<{ type: string; text: string }> {
	const params = request?.params as { input?: Array<{ type: string; text: string }> } | undefined;
	return params?.input ?? [];
}

/** Wait until the engine is running with an active turn (the first turn is confirmed). */
async function waitRunning(engine: CodexEngine): Promise<void> {
	await until(() => engine.isRunning() && engine.activeTurnId !== undefined, "the first turn to be running");
}

interface Harness {
	engine: CodexEngine;
	server: FakeAppServer;
	observer: AceDeliveryObserver;
	client: AppServerClient;
	runtime?: AceRuntime;
}

let current: Harness | undefined;
afterEach(async () => {
	const harness = current;
	current = undefined;
	if (!harness) return;
	// Settle everything the test started: stop the runtime (waits for idle), then
	// dispose the engine (clears pending delivery timers) and drop the connection.
	await harness.runtime?.stop().catch(() => {});
	harness.engine.dispose();
	harness.client.close();
});

/** Client + engine + observer over an in-memory connection; the handshake and thread start are awaited. */
async function setup(config: { deliveryTimeoutMs?: number; threadId?: string } = {}): Promise<Harness> {
	const { a, b } = createMemoryConnections();
	const server = new FakeAppServer(b);
	const { client, ready } = AppServerClient.begin(a, { clientInfo: { name: "t", version: "0" } });
	await ready;
	const engine = new CodexEngine(client, {
		listener: "stdio",
		...(config.deliveryTimeoutMs !== undefined ? { deliveryTimeoutMs: config.deliveryTimeoutMs } : {}),
		...(config.threadId !== undefined ? { threadId: config.threadId } : {}),
	});
	const observer = new AceDeliveryObserver();
	engine.setObserver(observer);
	await engine.start();
	current = { engine, server, observer, client };
	return current;
}

describe("CodexEngine mode mapping", () => {
	it("starts a turn for an idle next_turn event and sends the rendered event text", async () => {
		const { engine, server, observer } = await setup();
		const message = makeMessage("evt_1", "Build failed for project foo.");

		await engine.inject(message, "next_turn", CONTEXT);

		expect(server.count("turn/start")).toBe(1);
		expect(server.count("turn/steer")).toBe(0);
		const request = server.last("turn/start");
		expect(request?.params).toMatchObject({ threadId: server.threadId });
		// The engine sends the exact rendered `<ace_event>` text, which is what the
		// server later echoes back as the ack.
		expect(turnStartInput(request)).toEqual([{ type: "text", text: renderAceEvent(message, CONTEXT) }]);
		// The ack: the echo was observed, so no observation is still pending.
		expect(observer.pendingCount).toBe(0);
	});

	it("starts a turn for an idle immediate event (no active turn to steer)", async () => {
		const { engine, server } = await setup();

		await engine.inject(makeMessage("evt_2", "urgent fix"), "immediate", CONTEXT);

		expect(server.count("turn/start")).toBe(1);
		expect(server.count("turn/steer")).toBe(0);
	});

	it("folds an immediate event into the active turn via turn/steer", async () => {
		const { engine, server, observer } = await setup();
		server.autoComplete = false; // keep turn 1 running so the thread is busy

		await engine.inject(makeMessage("evt_a", "first"), "next_turn", CONTEXT);
		await waitRunning(engine);

		const steerMessage = makeMessage("evt_b", "steer me");
		const ack = engine.inject(steerMessage, "immediate", CONTEXT);
		await server.waitForRequest("turn/steer");

		const steer = server.last("turn/steer");
		expect(steer?.params).toMatchObject({ threadId: server.threadId, expectedTurnId: engine.activeTurnId });
		expect(turnStartInput(steer)).toEqual([{ type: "text", text: renderAceEvent(steerMessage, CONTEXT) }]);

		// The steer echo (steerEcho) is the ack for the folded-in event.
		await ack;
		expect(observer.pendingCount).toBe(0);
		expect(engine.isRunning()).toBe(true); // still in turn 1; the steer did not end it

		server.completeActiveTurn("completed");
		await engine.waitForIdle();
	});

	it("holds a next_turn event while running, then drains it as a fresh turn on idle", async () => {
		const { engine, server } = await setup();
		server.autoComplete = false;

		const held = makeMessage("evt_2", "held one");
		await engine.inject(makeMessage("evt_1", "first"), "next_turn", CONTEXT);
		await waitRunning(engine);

		const heldAck = engine.inject(held, "next_turn", CONTEXT);
		await tick();
		// Held locally, not started: still one turn, nothing steered.
		expect(engine.heldEvents).toHaveLength(1);
		expect(server.count("turn/start")).toBe(1);
		expect(server.count("turn/steer")).toBe(0);

		// The first turn ends → the held event starts its own turn, one turn at a time.
		server.completeActiveTurn("completed");
		await until(() => server.count("turn/start") === 2, "the second turn to start");
		const secondInput = turnStartInput(server.requests.filter((r) => r.method === "turn/start")[1]);
		expect(secondInput).toEqual([{ type: "text", text: renderAceEvent(held, CONTEXT) }]);

		await heldAck; // acks on the second turn's echo
		server.completeActiveTurn("completed");
		await engine.waitForIdle();
		expect(engine.heldEvents).toHaveLength(0);
	});
});

describe("CodexEngine steer expectedTurnId mismatch", () => {
	it("propagates a steer failure when the turn is still active (genuine mismatch)", async () => {
		const { engine, server } = await setup();
		server.autoComplete = false;

		await engine.inject(makeMessage("evt_1", "first"), "next_turn", CONTEXT);
		await waitRunning(engine);
		const stale = engine.activeTurnId;
		expect(stale).toBeDefined();

		// The server's active turn no longer matches the engine's, but a turn is still
		// running: the engine must treat this as a real failure, not recover silently.
		server.activeTurnId = "not-the-engine-turn";
		const error = await engine.inject(makeMessage("evt_2", "steer"), "immediate", CONTEXT).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(AppServerError);
		expect((error as AppServerError).message).toContain("does not match");
		expect(engine.activeTurnId).toBe(stale); // the engine still thinks the turn is active
	});

	it("falls back to a fresh turn/start when the turn ended between the check and the steer", async () => {
		const { engine, server } = await setup();
		server.autoComplete = false;

		await engine.inject(makeMessage("evt_1", "first"), "next_turn", CONTEXT);
		await waitRunning(engine);
		const firstTurnId = engine.activeTurnId;

		// Hold the next request (the steer) so it sits in flight unanswered, then kick
		// off the immediate inject: the engine checks the active turn (still set) and
		// sends turn/steer, which the fake holds rather than answering.
		server.holdNext = true;
		const fallbackAck = engine.inject(makeMessage("evt_2", "recovered"), "immediate", CONTEXT);
		const steerRequest = await server.waitForRequest("turn/steer");
		expect(steerRequest.params).toMatchObject({ expectedTurnId: firstTurnId });

		// The turn completes exactly as the steer is in flight: the engine's
		// activeTurnId is cleared by turn/completed *before* the steer is rejected, so
		// the engine sees the turn as already ended and falls back to a fresh turn.
		server.notify("turn/completed", {
			threadId: server.threadId,
			turn: { id: firstTurnId, status: "completed", error: null },
		});
		await until(() => engine.activeTurnId === undefined, "the turn completion to land");

		// Now reject the held steer with the stale expectedTurnId (the server's view).
		server.activeTurnId = undefined;
		expect(steerRequest.id).toBeDefined();
		server.respondError(steerRequest.id as string | number, -32602, "expectedTurnId does not match the active turn");

		await until(() => server.count("turn/start") === 2, "the fallback turn to start");
		const fallbackInput = turnStartInput(server.requests.filter((r) => r.method === "turn/start")[1]);
		expect(fallbackInput).toEqual([
			{ type: "text", text: renderAceEvent(makeMessage("evt_2", "recovered"), CONTEXT) },
		]);
		await fallbackAck;
		server.completeActiveTurn("completed");
		await engine.waitForIdle();
	});
});

describe("CodexEngine ack point", () => {
	it("resolves once the injected text is echoed back as a userMessage item", async () => {
		const { engine, server, observer } = await setup();
		server.autoComplete = false; // keep the turn open so the ack is what we observe
		server.echo = false; // drive the echo manually, so the ack is provably the echo
		const message = makeMessage("evt_3", "watch me echo");

		const pending = engine.inject(message, "next_turn", CONTEXT);
		await waitRunning(engine);
		expect(server.count("turn/start")).toBe(1);
		// The ack is still pending until the server echoes the text back.
		expect(observer.pendingCount).toBe(1);

		// Echo the exact rendered text back as a userMessage item -> the ack fires.
		const text = renderAceEvent(message, CONTEXT);
		server.notify("item/started", {
			item: { type: "userMessage", id: "u", content: [{ type: "text", text }] },
			threadId: server.threadId,
		});
		await pending;
		expect(observer.pendingCount).toBe(0);
		server.completeActiveTurn("completed");
		await engine.waitForIdle();
	});

	it("does not ack on turn/completed alone; the echo is the ack point", async () => {
		const { engine, server, observer } = await setup();
		server.echo = false; // suppress the automatic userMessage echo for this turn
		server.autoComplete = false; // keep the turn open
		const message = makeMessage("evt_4", "no echo yet");

		const pending = engine.inject(message, "next_turn", CONTEXT);
		await waitRunning(engine);
		expect(observer.pendingCount).toBe(1); // turn is running, no echo observed

		// The turn completes, but without the echo the ack must NOT resolve.
		const turnId = engine.activeTurnId;
		expect(turnId).toBeDefined();
		server.notify("turn/completed", {
			threadId: server.threadId,
			turn: { id: turnId, status: "completed", error: null },
		});
		await until(() => !engine.isRunning(), "the turn to be marked ended");
		expect(observer.pendingCount).toBe(1); // still pending: turn/completed is not the ack

		// The ack fires only when the exact rendered text is surfaced as a userMessage item.
		const text = renderAceEvent(message, CONTEXT);
		server.notify("item/started", {
			item: { type: "userMessage", id: "u", content: [{ type: "text", text }] },
			threadId: server.threadId,
		});
		await pending;
		expect(observer.pendingCount).toBe(0);
	});

	it("rejects a delivery that is never observed within the timeout", async () => {
		const { engine, server, observer } = await setup({ deliveryTimeoutMs: 40 });
		server.echo = false; // no userMessage echo ever arrives
		server.autoComplete = false; // the turn stays open, so nothing else resolves the ack

		const error = await engine
			.inject(makeMessage("evt_t", "never seen"), "immediate", CONTEXT)
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("not observed in the conversation within 40ms");
		// The unsatisfied observation is released, so nothing leaks.
		expect(observer.pendingCount).toBe(0);
	});
});

describe("CodexEngine thread lifecycle", () => {
	it("starts a new thread by default", async () => {
		const { engine, server } = await setup();
		expect(server.count("thread/start")).toBe(1);
		expect(server.count("thread/resume")).toBe(0);
		expect(engine.threadId).toBe(server.threadId);
	});

	it("resumes a durable thread when a threadId is configured (rejoin)", async () => {
		const durableId = "0190faketestresume00000000000000";
		const { engine, server } = await setup({ threadId: durableId });
		expect(server.last("thread/resume")?.params).toMatchObject({ threadId: durableId });
		expect(server.count("thread/start")).toBe(0);
		expect(engine.threadId).toBe(durableId);
	});

	it("interrupt aborts the active turn and surfaces it as interrupted", async () => {
		const { engine, server } = await setup();
		server.autoComplete = false;

		await engine.inject(makeMessage("evt_i", "long task"), "next_turn", CONTEXT);
		await waitRunning(engine);
		const turnId = engine.activeTurnId;

		await engine.interrupt();

		expect(server.last("turn/interrupt")?.params).toMatchObject({ threadId: server.threadId, turnId });
		await until(() => !engine.isRunning(), "the interrupted turn to end");
	});
});

describe("manual events are held by the ACE runtime, not the Codex engine", () => {
	it("stores a manual event without any turn, and activation re-dispatches it as next_turn", async () => {
		const harness = await setup();
		const transport = new InMemoryTransport();
		const input: EndpointConfig = {
			name: "build-events",
			transport: "memory",
			activation: "default",
			config: {},
			options: {},
		};
		const runtime = new AceRuntime({
			engine: harness.engine,
			subscribe: [input],
			transports: { [input.name]: transport },
		});
		harness.runtime = runtime;

		await runtime.start();
		const manual = makeMessage("evt_m", "retain me for later", "manual");
		const result = await runtime.handleRawMessage(manual, input);

		expect(result).toMatchObject({ activation: "manual", disposition: "stored" });
		expect(runtime.pendingEvents).toHaveLength(1);
		// Nothing was injected, and no Codex-side queue was touched at all.
		await tick();
		expect(harness.server.count("turn/start")).toBe(0);
		expect(harness.server.count("thread/queue/add")).toBe(0);
		expect(harness.engine.isRunning()).toBe(false);
		expect(harness.engine.activeTurnId).toBeUndefined();

		// Explicit activation re-dispatches the retained event as next_turn -> turn/start.
		await runtime.activatePendingEvent("ci-bot", "evt_m");
		expect(runtime.pendingEvents).toHaveLength(0);
		expect(harness.server.count("turn/start")).toBe(1);
		const startRequest = harness.server.last("turn/start");
		expect(turnStartInput(startRequest)[0]?.text).toContain("retain me for later");
		// The activated event is observed (acked) like any next_turn delivery.
		await until(() => harness.observer.pendingCount === 0, "the activated event to be observed");
		await harness.engine.waitForIdle();
	});
});
