import type { AceMessage } from "../protocol/ace-message.ts";

/** How need-to-process-now an ACE event is (RFC §7.1, §7.2). */
export type InjectionMode = "immediate" | "next_turn";

/**
 * Where an injected event came from, so the header can say which of this session's channels received
 * it. Not part of the ACE message: the sender names a target in *its* configuration, the receiver sees
 * a subscription in *its own*.
 */
export interface InjectionContext {
	/** Subscription name in this session's `.ace.json` (e.g. `from-wsl`). */
	subscription: string;
	/** Address it arrived on (e.g. `ace:lan:in.mac`), when the transport kind exposes one. */
	address?: string;
}

/**
 * The agent engine ACE drives.
 *
 * ACE core depends only on this interface; `PiAdapter` is one implementation
 * (RFC-facing §15). `startTurn()` from the design doc is folded into
 * {@link inject}: both Pi and pi-agent-core start a turn atomically with the
 * injected message when the agent is idle, so splitting them would only invite
 * races.
 */
export interface AgentEngine {
	/**
	 * Make `message.body` visible to later agent reasoning (RFC §9).
	 *
	 * Resolves once the event has been handed to the engine — not once the turn
	 * finished, so events arriving during a run can still preempt.
	 */
	inject(message: AceMessage, mode: InjectionMode, context?: InjectionContext): Promise<void>;

	/** Whether a turn is currently being processed. */
	isRunning(): boolean;

	/** Resolve when the engine has no active or queued work left. */
	waitForIdle(): Promise<void>;

	/**
	 * Register a listener for runs that ended in failure (optional capability).
	 *
	 * Turn failures surface after {@link inject} resolved — as an assistant message with a failure
	 * stop reason, not as a rejected promise — so the runtime subscribes here to count them
	 * (design doc §30: a turn error must stay visible).
	 */
	onRunError?(listener: (error: unknown) => void): void;
}
