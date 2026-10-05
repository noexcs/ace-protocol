import type { AgentEngine } from "../agent/agent-engine.ts";
import type { AceLogger } from "../logger.ts";
import type { AceMessage, ConcreteActivation } from "../protocol/ace-message.ts";
import type { AceMetrics } from "./metrics.ts";
import type { PendingEventStore } from "./pending-event-store.ts";

/** Where an ACE message ended up after activation resolution. */
export type DispatchDisposition = "injected" | "queued" | "stored" | "deduped" | "spooled" | "dropped";

export interface DispatchResult {
	readonly activation: ConcreteActivation;
	/**
	 * - `injected`: the agent was idle; the event was placed in its context and a turn was started.
	 * - `queued`: the agent was running; the event waits for the engine's next processing point.
	 * - `stored`: a `manual` event retained by the runtime, no turn started.
	 * - `deduped`: already seen `(sender, id)`; dropped, but acknowledged.
	 * - `spooled`: written to a file with its burst; a summary event was injected instead.
	 * - `dropped`: refused by policy (for example a sender that is not allowed).
	 */
	readonly disposition: DispatchDisposition;
}

/** Routes an ACE message according to its effective activation (RFC §7, §19). */
export class EventDispatcher {
	private readonly engine: AgentEngine;
	private readonly pendingEvents: PendingEventStore;
	private readonly logger: AceLogger;
	private readonly metrics: AceMetrics | undefined;
	/** This session's own sender names: a message from one of them is its own event echoed back. */
	private readonly selfSenders: ReadonlySet<string>;

	constructor(
		engine: AgentEngine,
		pendingEvents: PendingEventStore,
		logger: AceLogger = {},
		metrics?: AceMetrics,
		selfSenders: ReadonlySet<string> = new Set(),
	) {
		this.engine = engine;
		this.pendingEvents = pendingEvents;
		this.logger = logger;
		this.metrics = metrics;
		this.selfSenders = selfSenders;
	}

	async dispatch(
		message: AceMessage,
		subscriptionName: string,
		activation: ConcreteActivation,
		/** Uploaded channel name the event arrived on, for the header; the subscription label when absent. */
		channel?: string,
		/** Broker arrival time (epoch ms UTC) when the transport exposes one; the header omits the line otherwise. */
		receivedAt?: number,
	): Promise<DispatchResult> {
		if (activation === "manual") {
			this.pendingEvents.store(message, subscriptionName);
			this.metrics?.increment(subscriptionName, "stored");
			this.logger.info?.(
				`[ACE] stored id=${message.id} sender=${message.sender} subscribe=${subscriptionName} activation=manual`,
			);
			return { activation, disposition: "stored" };
		}

		const running = this.engine.isRunning();
		this.logger.info?.(
			`[ACE] injecting id=${message.id} sender=${message.sender} subscribe=${subscriptionName} activation=${activation} agent=${
				running ? "running" : "idle"
			}`,
		);
		await this.engine.inject(message, activation, {
			subscription: subscriptionName,
			...(channel === undefined ? {} : { channel }),
			// The header's `activation:` line is the sender's *request*, not the effective activation
			// resolved below (RFC §7): the block must not read as a confirmation of the latter.
			activation: message.activation,
			...(receivedAt === undefined ? {} : { receivedAt }),
			...(this.selfSenders.has(message.sender) ? { self: true } : {}),
		});
		this.metrics?.increment(subscriptionName, running ? "queued" : "injected");
		return { activation, disposition: running ? "queued" : "injected" };
	}
}
