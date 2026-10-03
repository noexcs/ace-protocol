import type { AceMessage } from "../protocol/ace-message.ts";
import type { AgentEngine, InjectionMode } from "./agent-engine.ts";
import { renderAceEvent } from "./pi-adapter.ts";

/** The slice of Pi's `ExtensionAPI` this adapter needs. */
export interface ExtensionMessageApi {
	sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
}

export interface PiExtensionAdapterOptions {
	pi: ExtensionMessageApi;
	/**
	 * Reports whether Pi is idle, e.g. `() => ctx.isIdle()`. Defaults to "idle" for the
	 * window before a session context exists.
	 */
	isIdle?: () => boolean;
	/** Renders an ACE event into context text. Defaults to {@link renderAceEvent}. */
	renderEvent?: (message: AceMessage) => string;
}

/**
 * Drives the Pi session this extension is loaded into (design doc §16).
 *
 * Pi resolves idle vs streaming internally for `sendUserMessage`: `deliverAs` is ignored
 * while the agent is idle — the message starts a turn — and queues the message while a turn
 * runs (`steer` at the next turn boundary, `followUp` after the current run's pending work).
 * The adapter therefore always passes it and needs no state of its own.
 *
 * Deviations from {@link AgentEngine}, both deliberate: `inject` resolves once the message is
 * handed to Pi (Pi owns the turn), and `waitForIdle` resolves immediately because a session
 * shutdown must never block the interactive UI on a live turn.
 */
export class PiExtensionAdapter implements AgentEngine {
	private readonly pi: ExtensionMessageApi;
	private readonly isIdle: () => boolean;
	private readonly renderEvent: (message: AceMessage) => string;

	constructor(options: PiExtensionAdapterOptions) {
		this.pi = options.pi;
		this.isIdle = options.isIdle ?? (() => true);
		this.renderEvent = options.renderEvent ?? renderAceEvent;
	}

	async inject(message: AceMessage, mode: InjectionMode): Promise<void> {
		this.pi.sendUserMessage(this.renderEvent(message), {
			deliverAs: mode === "immediate" ? "steer" : "followUp",
		});
	}

	isRunning(): boolean {
		return !this.isIdle();
	}

	async waitForIdle(): Promise<void> {}
}
