/**
 * The slice of DeepSeek Harness this plugin drives, expressed as **structure** rather than an import.
 *
 * The core keeps the same discipline for its own host seam (`AgentEngine`): the engine can be exercised
 * against a fake agent, with no host package installed, and a host can change internally without this
 * plugin's logic following it. The one method that is not structure — the identified user message — is
 * injected as a factory, because only the host may mint one.
 */

import type {} from "@deepseek-ai/dsh-llm";

/** An agent's lifecycle state, as the host reports it. */
export type DshAgentStatus = "idle" | "running";

/** The activation an engine executes; `manual` never reaches one. */
export type DeliveryActivation = "immediate" | "next_turn";

/** One event on its way into the agent's conversation. */
export interface AceDelivery {
	/** The rendered `<ace_event>` block — what the model reads. */
	readonly text: string;
	/** Host-facing metadata, for a session list or a log line. */
	readonly summary: string;
	/** The channel the sender claims as its own ({@link AceMessage.sender}). A claim, never an authorization. */
	readonly sender: string;
	/** The event id, as `/ace pending` and a reply will name it. */
	readonly eventId: string;
	/** The channel this session received the event on, when the binding named one. */
	readonly channel?: string;
	/** The activation that was actually executed, not the one the sender asked for. */
	readonly activation: DeliveryActivation;
}

/** The live agent one ACE session is bound to. */
export interface DshAgentPort {
	/** The session identity that becomes the last name segment of this session's channel. */
	readonly sessionId: string;
	/** The session's working directory: the configuration domain (`.ace.json`) and the file-transfer root. */
	readonly cwd: string;
	/** Whether a turn is currently running. */
	readonly status: DshAgentStatus;
	/** Queue an ordinary next-turn prompt and wake the driver. */
	followup(message: unknown): void;
	/** Submit next-step input to a running turn and wake the driver. */
	steer(message: unknown): void;
	/** Resolve when the agent has no active or queued work left. */
	whenIdle(): Promise<void>;
	/** Observe one failed turn; returns the unsubscriber. */
	onRunError(listener: (error: unknown) => void): () => void;
}

/**
 * Mint one identified user-role message for the host.
 *
 * The one method that is not structure: only the host may mint a message, so it is injected.
 */
export type DshMessageFactory = (delivery: AceDelivery) => unknown;

/**
 * The provenance one ACE event carries into the session record.
 *
 * `MessageSourceMap` is the documented merge point for exactly this — a package that admits programmatic
 * input declares its own source variant — so an event in the conversation is labelled as an ACE event
 * from a named channel, not as anonymous plugin input.
 */
declare module "@deepseek-ai/dsh-llm" {
	interface MessageSourceMap {
		/** External input admitted from one ACE event delivered to this session. */
		"ace-event": {
			readonly kind: "ace-event";
			/** The channel the sender claims; a name, never an authorization. */
			readonly sender: string;
			/** The event id, unique per sender. */
			readonly eventId: string;
			/** The channel this session received it on, when the binding named one. */
			readonly channel?: string;
			/** What was executed: `immediate` cut in, `next_turn` queued. */
			readonly activation: DeliveryActivation;
			readonly form: "notice";
			readonly summary: string;
		};
	}
}

/** Where this plugin reports; a missing method is not an error. */
export interface DshLogger {
	info?(message: string): void;
	warn?(message: string): void;
	error?(message: string): void;
}
