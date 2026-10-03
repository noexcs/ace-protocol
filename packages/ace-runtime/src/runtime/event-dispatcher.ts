import type { AgentEngine } from "../agent/agent-engine.ts";
import type { AceLogger } from "../logger.ts";
import type { AceMessage, ConcreteActivation } from "../protocol/ace-message.ts";
import type { PendingEventStore } from "./pending-event-store.ts";

/** Where an ACE message ended up after activation resolution. */
export type DispatchDisposition = "injected" | "queued" | "stored";

export interface DispatchResult {
	readonly activation: ConcreteActivation;
	/**
	 * - `injected`: the agent was idle; the event was placed in its context and a
	 *   turn was started.
	 * - `queued`: the agent was running; the event waits for the engine's next
	 *   processing point.
	 * - `stored`: a `manual` event retained by the runtime, no turn started.
	 */
	readonly disposition: DispatchDisposition;
}

/** Routes an ACE message according to its effective activation (RFC §7, §19). */
export class EventDispatcher {
	private readonly engine: AgentEngine;
	private readonly pendingEvents: PendingEventStore;
	private readonly logger: AceLogger;

	constructor(engine: AgentEngine, pendingEvents: PendingEventStore, logger: AceLogger = {}) {
		this.engine = engine;
		this.pendingEvents = pendingEvents;
		this.logger = logger;
	}

	async dispatch(
		message: AceMessage,
		subscriptionName: string,
		activation: ConcreteActivation,
	): Promise<DispatchResult> {
		if (activation === "manual") {
			this.pendingEvents.store(message, subscriptionName);
			this.logger.info?.(
				`[ACE] stored id=${message.id} sender=${message.sender} input=${subscriptionName} activation=manual`,
			);
			return { activation, disposition: "stored" };
		}

		const running = this.engine.isRunning();
		this.logger.info?.(
			`[ACE] injecting id=${message.id} sender=${message.sender} input=${subscriptionName} activation=${activation} agent=${
				running ? "running" : "idle"
			}`,
		);
		await this.engine.inject(message, activation);
		return { activation, disposition: running ? "queued" : "injected" };
	}
}
