/**
 * The ACE `AgentEngine` for DeepSeek Harness.
 *
 * The core hands this engine one validated event and a delivery mode; the engine's whole job is to make
 * the rendered event visible to the agent's later reasoning, on the right schedule:
 *
 * | ACE activation | DSH delivery |
 * |---|---|
 * | `immediate` | `steer()` into the running turn — `followup()` when the agent is idle, which starts one |
 * | `next_turn` | `followup()` — queued, wakes the driver when idle |
 * | `manual` | never reaches an engine: the runtime retains it until someone activates it |
 *
 * Unlike the Pi adapter, no delivery observer is needed here. On DSH `followup()`/`steer()` admit the
 * message to the *durable* inbox and return, and that admission is the commit point; the transport may
 * therefore acknowledge once `inject` resolves. (The Pi host had to wait for the event to appear in the
 * conversation, because a queued `followUp` on an idle session could sit there forever while the broker
 * had already acknowledged it.)
 */

import {
	type AceLogger,
	type AceMessage,
	type AgentEngine,
	type InjectionContext,
	type InjectionMode,
	renderAceEvent,
} from "../vendor/ace-runtime/dist/index.js";
import type { DshAgentPort, DshMessageFactory } from "./dsh.ts";

export interface DshAgentEngineOptions {
	/** The live agent this session drives. */
	agent: DshAgentPort;
	/** Host-owned message minting; the only host-specific step in this file. */
	buildMessage: DshMessageFactory;
	/** Renders one event into context text; defaults to the core's renderer. */
	renderEvent?: (message: AceMessage, context?: InjectionContext) => string;
	logger?: AceLogger;
}

/** Where an event came from, as the one-line journal entry names it. */
function originOf(message: AceMessage, context: InjectionContext | undefined): string {
	const channel = context?.channel ?? context?.subscription ?? "inbox";
	return `${message.sender}/${message.id} on ${channel}`;
}

export class DshAgentEngine implements AgentEngine {
	private readonly agent: DshAgentPort;
	private readonly buildMessage: DshMessageFactory;
	private readonly renderEvent: (message: AceMessage, context?: InjectionContext) => string;
	private readonly logger: AceLogger | undefined;

	constructor(options: DshAgentEngineOptions) {
		this.agent = options.agent;
		this.buildMessage = options.buildMessage;
		this.renderEvent = options.renderEvent ?? renderAceEvent;
		this.logger = options.logger;
	}

	/**
	 * Hand one event to the agent. Resolves once the message is admitted — not once a turn finishes, so an
	 * event that arrives during a run can still cut in.
	 */
	async inject(message: AceMessage, mode: InjectionMode, context?: InjectionContext): Promise<void> {
		const text = this.renderEvent(message, context);
		const userMessage = this.buildMessage({
			text,
			summary: `ACE event from ${message.sender}`,
			sender: message.sender,
			eventId: message.id,
			...(context?.channel === undefined ? {} : { channel: context.channel }),
			activation: mode,
		});
		const running = this.isRunning();
		if (mode === "immediate" && running) {
			this.agent.steer(userMessage);
			this.logger?.info?.(`[ace] steered ${originOf(message, context)} into the running turn`);
			return;
		}
		this.agent.followup(userMessage);
		this.logger?.info?.(
			running
				? `[ace] queued ${originOf(message, context)} for the next step`
				: `[ace] queued ${originOf(message, context)} and woke the session`,
		);
	}

	/** Whether a turn is currently being processed. */
	isRunning(): boolean {
		return this.agent.status === "running";
	}

	/** Resolve when the agent has no active or queued work left. */
	waitForIdle(): Promise<void> {
		return this.agent.whenIdle();
	}

	/** Register a listener for turns that ended in failure. */
	onRunError(listener: (error: unknown) => void): void {
		this.agent.onRunError(listener);
	}
}
