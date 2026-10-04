/**
 * {@link AgentEngine} over the Codex `app-server` turn methods.
 *
 * Routing (verified against the live `codex 0.153.0` protocol):
 *
 * | Effective activation | Agent idle                  | Agent running                                  |
 * |----------------------|-----------------------------|------------------------------------------------|
 * | `next_turn`          | `turn/start` (new turn)     | held locally; `turn/start` when it goes idle   |
 * | `immediate`          | `turn/start`                | `turn/steer` (folds into the active turn)      |
 *
 * `manual` events never reach the engine: the ACE runtime holds them in its own
 * pending store and re-dispatches one as `next_turn` only on explicit activation
 * (`/ace activate <sender> <id>`), exactly as the Pi/oh-my-pi host does. The
 * engine therefore never sees `manual` and never uses the experimental queue
 * methods.
 *
 * Codex threads are serial (one active turn at a time), so the engine tracks a single
 * `activeTurnId` plus a FIFO of held `next_turn` events.
 *
 * Ack policy: the engine observes the injected text **before** sending it, and `inject`
 * resolves only once the server echoes it back as a `userMessage` item (`item/started` or
 * `item/completed`) — the broker's ack point. A held `next_turn` event resolves once its
 * (later) turn surfaces the text. A delivery that is never observed within
 * `deliveryTimeoutMs` rejects, so the broker keeps the event pending for redelivery.
 */

import type { AceDeliveryObserver, AceMessage, AgentEngine, InjectionContext, InjectionMode } from "ace-runtime";
import { renderAceEvent } from "ace-runtime";
import type { AppServerClient, CodexTurn } from "./client.ts";
import type { CodexConnectionConfig } from "./config.ts";

/** A rendered event the engine is responsible for. */
export interface QueuedEvent {
	readonly message: AceMessage;
	readonly text: string;
	readonly context?: InjectionContext;
}

interface HeldEntry {
	readonly event: QueuedEvent;
	readonly resolveAck: () => void;
	readonly rejectAck: (error: Error) => void;
}

export class CodexEngine implements AgentEngine {
	/** Durable thread id (UUIDv7); undefined until {@link start}. */
	threadId: string | undefined;
	/** Active turn id (UUIDv7), or undefined while idle. */
	activeTurnId: string | undefined;

	private readonly client: AppServerClient;
	private observer: AceDeliveryObserver | undefined;
	private readonly deliveryTimeoutMs: number;
	private readonly cwd?: string;
	private readonly model?: string;
	private readonly resumeThreadId: string | undefined;
	private readonly held: HeldEntry[] = [];
	private readonly runErrorListeners: Array<(error: unknown) => void> = [];
	private idleWaiters: Array<() => void> = [];
	private readonly timers = new Set<NodeJS.Timeout>();
	/** True from the moment a turn is fired until its `turn/completed`; closes the gap before the server confirms the turn. */
	private running = false;
	private draining = false;

	constructor(client: AppServerClient, config: CodexConnectionConfig) {
		this.client = client;
		this.deliveryTimeoutMs = config.deliveryTimeoutMs ?? 30_000;
		this.cwd = config.cwd;
		this.model = config.model;
		this.resumeThreadId = config.threadId;
		client.onNotification = (event) => this.#onNotification(event.method, event.params);
	}

	/** Attach the delivery observer the engine acks against. */
	setObserver(observer: AceDeliveryObserver): void {
		this.observer = observer;
	}

	/** Held `next_turn` events waiting for the active turn to finish (diagnostics/tests). */
	get heldEvents(): readonly QueuedEvent[] {
		return this.held.map((entry) => entry.event);
	}

	/** Start (or resume, when a durable `threadId` is configured) the thread. Idempotent. */
	async start(): Promise<void> {
		if (this.threadId !== undefined) return;
		if (this.resumeThreadId !== undefined) {
			const { thread } = await this.client.threadResume({ threadId: this.resumeThreadId });
			this.threadId = thread.id;
			return;
		}
		const params: Record<string, unknown> = {};
		if (this.cwd !== undefined) params.cwd = this.cwd;
		if (this.model !== undefined) params.model = this.model;
		const { thread } = await this.client.threadStart(params);
		this.threadId = thread.id;
	}

	async inject(message: AceMessage, mode: InjectionMode, context?: InjectionContext): Promise<void> {
		// Render first, then observe with the very text that is sent: the header can depend on
		// the channel, so re-rendering later would not necessarily produce the same string.
		const text = renderAceEvent(message, context);
		const event: QueuedEvent = { message, text, context };
		const threadId = this.#requireThread();

		if (mode === "next_turn" && (this.running || this.held.length > 0)) {
			// Handoff is queueing; the ack happens when the held turn actually surfaces the text.
			// Hold while draining too: `running` is cleared before the drain's next `turnStart`
			// resolves, and starting a turn in that gap would run two turns at once.
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			this.held.push({ event, resolveAck: resolve, rejectAck: reject });
			return promise;
		}

		const observed = this.observer?.observe(event.message, event.text);
		try {
			let foldedIntoTurn = false;
			if (mode === "immediate" && this.activeTurnId !== undefined) {
				try {
					await this.client.turnSteer({
						threadId,
						input: [{ type: "text", text }],
						expectedTurnId: this.activeTurnId,
					});
					foldedIntoTurn = true;
				} catch (error) {
					// `expectedTurnId` no longer matches only if the turn just ended between the check and
					// the call; a genuine steer failure (turn still active) must propagate.
					if (this.activeTurnId !== undefined) throw error;
				}
			}
			if (!foldedIntoTurn) {
				this.running = true; // synchronous: keeps isRunning/waitForIdle correct before the server confirms
				const { turn } = await this.client.turnStart({ threadId, input: [{ type: "text", text }] });
				// A fast server can stream `turn/completed` in the same read as the response, so the
				// turn may already be ended before this continuation runs; `running` is false then.
				if (this.running) this.activeTurnId = turn.id;
			}
		} catch (error) {
			this.running = this.activeTurnId !== undefined;
			// Drop the observation that will never be satisfied; its promise must not stay unhandled.
			void observed?.catch(() => {});
			this.observer?.release?.(event.message, text);
			this.#settleIdleWaiters();
			throw error;
		}
		await this.#awaitDelivery(event, observed);
	}

	isRunning(): boolean {
		return this.running;
	}

	waitForIdle(): Promise<void> {
		if (!this.running && this.held.length === 0) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.idleWaiters.push(resolve);
		return promise;
	}

	onRunError(listener: (error: unknown) => void): void {
		this.runErrorListeners.push(listener);
	}

	/** Abort the active turn; the server reports it as `turn/completed` with `status: "interrupted"`. */
	async interrupt(): Promise<void> {
		const threadId = this.threadId;
		const turnId = this.activeTurnId;
		if (threadId === undefined || turnId === undefined) {
			throw new Error("no active turn to interrupt");
		}
		await this.client.turnInterrupt({ threadId, turnId });
	}

	#requireThread(): string {
		if (this.threadId === undefined) {
			throw new Error("CodexEngine is not started; call start() before injecting");
		}
		return this.threadId;
	}

	#onNotification(method: string, params: unknown): void {
		switch (method) {
			case "turn/started": {
				const turn = this.#turnOf(params);
				if (turn) this.activeTurnId = turn.id;
				return;
			}
			case "turn/completed": {
				const turn = this.#turnOf(params);
				if (turn) this.#onTurnEnded(turn);
				return;
			}
			case "item/started":
			case "item/completed":
				this.#feedItem(params);
				return;
			default:
				return;
		}
	}

	/** The `turn` of a `turn/started`/`turn/completed` notification, if well-shaped. */
	#turnOf(params: unknown): CodexTurn | undefined {
		if (typeof params !== "object" || params === null) return undefined;
		if (!("turn" in params)) return undefined;
		const turn = params.turn;
		if (typeof turn !== "object" || turn === null) return undefined;
		if (!("id" in turn) || typeof turn.id !== "string") return undefined;
		return turn as CodexTurn;
	}

	#onTurnEnded(turn: CodexTurn): void {
		if (this.activeTurnId !== undefined && this.activeTurnId !== turn.id) {
			return; // a different (older) turn completed; the active one is still running
		}
		if (turn.status === "failed" && turn.error) {
			this.#reportRunError(new Error(`turn ${turn.id} failed: ${turn.error.message}`));
		}
		this.activeTurnId = undefined;
		this.running = false;
		this.#drainHeld();
	}

	/**
	 * Start one turn for the next held `next_turn` event, FIFO. Each held event is started by
	 * exactly one drain invocation; a fresh drain runs when that turn completes, so held events
	 * serialize one turn at a time. The ack of the started turn is tracked in the background so
	 * the drain (and `waitForIdle`) never wedges on a slow or failing echo.
	 */
	#drainHeld(): void {
		if (this.draining) return;
		this.draining = true;
		try {
			while (!this.running && this.held.length > 0) {
				const entry = this.held.shift();
				if (entry === undefined) break;
				const observed = this.observer?.observe(entry.event.message, entry.event.text);
				const threadId = this.#requireThread();
				this.running = true; // synchronous: closes the gap until the server confirms the turn
				this.client
					.turnStart({ threadId, input: [{ type: "text", text: entry.event.text }] })
					.then(({ turn }) => {
						// Same race as in `inject`: `running` is false only if this turn already ended.
						if (this.running) this.activeTurnId = turn.id;
						if (observed) this.#ackHeld(entry, observed);
					})
					.catch((error: unknown) => {
						this.running = this.activeTurnId !== undefined;
						void observed?.catch(() => {});
						this.observer?.release?.(entry.event.message, entry.event.text);
						entry.rejectAck(error instanceof Error ? error : new Error(String(error)));
						this.#reportRunError(error);
						this.#drainHeld(); // the failed turn left the thread idle; start the next held one
					});
				return; // one held turn per drain; the next runs when this one completes
			}
		} finally {
			this.draining = false;
			this.#settleIdleWaiters();
		}
	}

	/** Ack a held event in the background: resolve on echo, reject on timeout. */
	#ackHeld(entry: HeldEntry, observed: Promise<void>): void {
		const { promise: timeout, resolve: resolveTimeout } = Promise.withResolvers<"timeout" | null>();
		const timer = setTimeout(() => resolveTimeout("timeout"), this.deliveryTimeoutMs);
		this.timers.add(timer);
		Promise.race([observed.then(() => "observed" as const), timeout]).then((outcome) => {
			this.timers.delete(timer);
			clearTimeout(timer);
			if (outcome === "timeout") {
				this.observer?.release?.(entry.event.message, entry.event.text);
				entry.rejectAck(
					new Error(
						`injected event id=${entry.event.message.id} sender=${entry.event.message.sender} was not observed in the conversation within ${this.deliveryTimeoutMs}ms`,
					),
				);
			} else {
				entry.resolveAck();
			}
		});
	}

	#settleIdleWaiters(): void {
		if (this.running || this.held.length > 0) return;
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) resolve();
	}

	/** Resolve once the injected text is echoed back, or fail on the delivery timeout. */
	async #awaitDelivery(event: QueuedEvent, observed: Promise<void> | undefined): Promise<void> {
		if (observed === undefined) return;
		const { promise: timeout, resolve: resolveTimeout } = Promise.withResolvers<"timeout" | null>();
		const timer = setTimeout(() => resolveTimeout("timeout"), this.deliveryTimeoutMs);
		this.timers.add(timer);
		const outcome = await Promise.race([observed.then(() => "observed" as const), timeout]);
		this.timers.delete(timer);
		clearTimeout(timer);
		if (outcome === "timeout") {
			this.observer?.release?.(event.message, event.text);
			throw new Error(
				`injected event id=${event.message.id} sender=${event.message.sender} was not observed in the conversation within ${this.deliveryTimeoutMs}ms`,
			);
		}
	}

	#reportRunError(error: unknown): void {
		const reported = error instanceof Error ? error : new Error(String(error));
		for (const listener of this.runErrorListeners) {
			try {
				listener(reported);
			} catch {
				// a broken listener must not break the turn lifecycle
			}
		}
	}

	/** Feed a `userMessage` item back through the observer so an ack can fire. */
	#feedItem(params: unknown): void {
		if (typeof params !== "object" || params === null) return;
		if (!("item" in params)) return;
		const item = params.item;
		if (typeof item !== "object" || item === null) return;
		if (!("type" in item) || item.type !== "userMessage") return;
		if (!("content" in item) || !Array.isArray(item.content)) return;
		const parts: string[] = [];
		for (const part of item.content) {
			if (typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part) {
				if (typeof part.text === "string") parts.push(part.text);
			}
		}
		if (parts.length === 0) return;
		this.observer?.accept({
			message: { role: "user", content: parts.map((text) => ({ type: "text", text })) },
		});
	}

	/** Cancel pending delivery timers and settle idle waiters (used on shutdown). */
	dispose(): void {
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters = [];
		for (const entry of this.held) entry.rejectAck(new Error("engine disposed"));
		this.held.length = 0;
		this.running = false;
	}
}
