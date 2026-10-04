/**
 * A scripted in-memory `codex app-server` peer for tests.
 *
 * It speaks the same newline-delimited JSON envelope over an in-memory
 * {@link AppServerConnection} (see `src/memory-connection.ts`) and plays the
 * role the real server plays: answer `initialize`/`thread/*`/`turn/*` requests
 * and stream the turn-lifecycle notifications (`turn/started`, `item/*`,
 * `turn/completed`) the engine observes for its ack. The default behavior
 * mirrors what the live `codex 0.153.0` binary does (verified with
 * `scripts/verify-live.ts`): a `turn/start` with text echoes that exact text
 * back as a `userMessage` item before the turn completes, and a `turn/steer`
 * does the same for the folded-in text.
 *
 * Tests configure `echo`, `autoComplete`, and `steerEcho` to drive specific
 * lifecycle shapes (the hold-then-complete shape the steer tests need, the
 * no-echo shape the delivery-timeout test needs). Waiting helpers
 * ({@link waitForRequest}, {@link waitFor}) make tests await real signals
 * instead of sleeping.
 */

import type { AppServerConnection } from "../../src/connection.ts";
import { type AppServerFrame, createFrameDecoder, encodeFrame } from "../../src/protocol.ts";

export interface RecordedRequest {
	readonly id: string | number | undefined;
	readonly method: string;
	readonly params: unknown;
}

/** A client -> server response frame (a result or an error). */
export interface RecordedResponse {
	readonly id: string | number;
	readonly result?: unknown;
	readonly error?: { code: number; message: string };
}

/** One input unit the fake echoes back as a `userMessage` item. */
interface UserInputLike {
	readonly type: string;
	readonly text: string;
}

export interface RecordedNotification {
	readonly method: string;
	readonly params: unknown;
}

let threadCounter = 0;
let turnCounter = 0;

export class FakeAppServer {
	/** Every request the client sent, in order. */
	readonly requests: RecordedRequest[] = [];
	/** Every response the client sent back, in order (answers to server -> client requests). */
	readonly responses: RecordedResponse[] = [];
	/** Every notification the fake pushed to the client, in order. */
	readonly notifications: RecordedNotification[] = [];
	/** The thread id handed out for `thread/start`. */
	readonly threadId: string;
	/** The active turn id, or `undefined` while idle. */
	activeTurnId: string | undefined;

	/** Echo turn input back as a `userMessage` item (the ack point). Defaults to true. */
	echo = true;
	/** Echo `turn/steer` input back as a `userMessage` item. Defaults to true. */
	steerEcho = true;
	/** Emit `turn/completed` right after the agent message. Defaults to true. */
	autoComplete = true;
	/** When true, the next client request is answered with `error`, not `result`. */
	failNext = false;
	/** When true, the next client request is not answered (stays pending). */
	holdNext = false;

	private readonly connection: AppServerConnection;
	private readonly waiters: Array<() => void> = [];
	private nextServerRequestId = 1000;

	constructor(connection: AppServerConnection) {
		this.connection = connection;
		this.threadId = `0190fake${(++threadCounter).toString(16).padStart(4, "0")}00000000000000`;
		const decode = createFrameDecoder(
			(frame) => this.#onFrame(frame),
			() => {
				// Bad frames in tests are a test bug; ignore rather than crash the suite.
			},
		);
		connection.onChunk(decode);
	}

	/** Send a server -> client request; returns its id. The client's answer lands in {@link responses}. */
	serverRequest(method: string, params: unknown): number {
		const id = this.nextServerRequestId++;
		this.connection.write(encodeFrame({ id, method, params }));
		return id;
	}

	/** The client's answer to a server request, once it arrives. */
	async waitForResponse(id: number): Promise<RecordedResponse> {
		const existing = this.responses.find((r) => r.id === id);
		if (existing) return existing;
		await new Promise<void>((resolve) => this.waiters.push(() => resolve()));
		const found = this.responses.find((r) => r.id === id);
		if (found) return found;
		// The wake came for something else; wait again.
		return this.waitForResponse(id);
	}

	/** The number of requests of a given method so far. */
	count(method: string): number {
		return this.requests.filter((r) => r.method === method).length;
	}

	/** The most recent request of a given method. */
	last(method: string): RecordedRequest | undefined {
		for (let i = this.requests.length - 1; i >= 0; i--) {
			if (this.requests[i].method === method) return this.requests[i];
		}
		return undefined;
	}

	/** Resolve once the client has sent a request matching `method`. */
	async waitForRequest(method: string): Promise<RecordedRequest> {
		const existing = this.last(method);
		if (existing) return existing;
		await new Promise<void>((resolve) => this.waiters.push(() => resolve()));
		const found = this.last(method);
		if (found) return found;
		// The wake came for a different method; wait again.
		return this.waitForRequest(method);
	}

	/** Resolve once the fake has pushed a notification matching `method`. */
	async waitForNotification(method: string): Promise<RecordedNotification> {
		const existing = this.notifications.find((n) => n.method === method);
		if (existing) return existing;
		await new Promise<void>((resolve) => this.waiters.push(() => resolve()));
		const found = this.notifications.find((n) => n.method === method);
		if (found) return found;
		return this.waitForNotification(method);
	}

	/** Push a notification straight to the client and record it. */
	notify(method: string, params: unknown): void {
		this.notifications.push({ method, params });
		this.connection.write(encodeFrame({ method, ...(params === undefined ? {} : { params }) }));
		this.#wake();
	}

	/** Answer a pending client request with a result. */
	respond(id: string | number, result: unknown): void {
		this.connection.write(encodeFrame({ id, result }));
	}

	/** Answer a pending client request with an error. */
	respondError(id: string | number, code: number, message: string): void {
		this.connection.write(encodeFrame({ id, error: { code, message } }));
	}

	/** Finish the active turn with a status; clears `activeTurnId`. */
	completeActiveTurn(status: "completed" | "interrupted" | "failed"): void {
		const turnId = this.activeTurnId;
		if (turnId === undefined) return;
		this.activeTurnId = undefined;
		this.notify("turn/completed", {
			threadId: this.threadId,
			turn: {
				id: turnId,
				status,
				error: status === "failed" ? { message: "synthetic failure" } : null,
			},
		});
	}

	#wake(): void {
		for (const resolve of this.waiters.splice(0)) resolve();
	}

	#onFrame(frame: AppServerFrame): void {
		if (frame.method !== undefined) {
			// A client -> server frame: a request (carries an id) or a notification
			// (`initialized`, no id). Record both; only requests get a response.
			const id = frame.id as string | number | undefined;
			this.requests.push({ id, method: frame.method, params: frame.params });
			if (id === undefined || id === null) {
				this.#wake();
				return;
			}
			if (this.holdNext) {
				this.holdNext = false; // consume; leave the request unanswered
				this.#wake();
				return;
			}
			if (this.failNext) {
				this.failNext = false; // consume
				this.respondError(id, -32000, "simulated server failure");
				this.#wake();
				return;
			}
			this.#handle(frame.method, frame.params as Record<string, unknown> | undefined, id);
			this.#wake();
			return;
		}
		// A response to a server -> client request the client chose to answer.
		if (frame.id !== undefined && frame.id !== null) {
			this.responses.push({
				id: frame.id,
				...(frame.result !== undefined ? { result: frame.result } : {}),
				...(frame.error !== undefined ? { error: frame.error } : {}),
			});
			this.#wake();
		}
	}

	#handle(method: string, params: Record<string, unknown> | undefined, id: string | number): void {
		switch (method) {
			case "initialize":
				this.respond(id, {
					codexHome: "/tmp/fake-codex-home",
					platformFamily: "unix",
					platformOs: "macos",
					userAgent: "fake-app-server/0.0.1",
				});
				return;
			case "thread/start": {
				this.respond(id, { thread: { id: this.threadId, sessionId: `session-${this.threadId}` } });
				return;
			}
			case "thread/resume": {
				const threadId = String(params?.threadId);
				this.respond(id, { thread: { id: threadId, sessionId: `session-${threadId}` } });
				return;
			}
			case "turn/start": {
				const turnId = `turn-${(++turnCounter).toString(16)}`;
				this.activeTurnId = turnId;
				this.respond(id, { turn: { id: turnId, status: "inProgress" } });
				this.#runTurn(turnId, params);
				return;
			}
			case "turn/steer": {
				const expected = String(params?.expectedTurnId);
				if (this.activeTurnId !== undefined && expected === this.activeTurnId) {
					this.respond(id, { turnId: this.activeTurnId });
					if (this.steerEcho) this.#echoUserMessage(this.activeTurnId, params);
				} else {
					this.respondError(id, -32602, "expectedTurnId does not match the active turn");
				}
				return;
			}
			case "turn/interrupt": {
				this.respond(id, {});
				if (this.activeTurnId !== undefined) this.completeActiveTurn("interrupted");
				return;
			}
			default:
				this.respondError(id, -32601, `method not found: ${method}`);
		}
	}

	/** Stream the notifications a turn produces after `turn/start`. */
	#runTurn(turnId: string, params: Record<string, unknown> | undefined): void {
		// Defer past the response so the client has resolved the `turn/start`
		// request (and set its active turn) before the lifecycle arrives.
		queueMicrotask(() => {
			this.notify("turn/started", {
				threadId: this.threadId,
				turn: { id: turnId, status: "inProgress" },
			});
			if (this.echo) this.#echoUserMessage(turnId, params);
			this.notify("item/started", {
				item: { type: "agentMessage", id: `agent-${turnId}`, text: "" },
				threadId: this.threadId,
				turnId,
			});
			this.notify("item/completed", {
				item: { type: "agentMessage", id: `agent-${turnId}`, text: "ok" },
				threadId: this.threadId,
				turnId,
			});
			if (this.autoComplete) this.completeActiveTurn("completed");
		});
	}

	/** Echo the turn/steer input as a `userMessage` item, exactly as the real server does. */
	#echoUserMessage(turnId: string, params: Record<string, unknown> | undefined): void {
		const input = (params?.input ?? []) as UserInputLike[];
		const content = input.filter((part) => part.type === "text").map((part) => ({ type: "text", text: part.text }));
		this.notify("item/started", {
			item: { type: "userMessage", id: `user-${turnId}`, content },
			threadId: this.threadId,
			turnId,
		});
		this.notify("item/completed", {
			item: { type: "userMessage", id: `user-${turnId}`, content },
			threadId: this.threadId,
			turnId,
		});
	}
}
