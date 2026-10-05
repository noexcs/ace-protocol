import type {
	AceMessage,
	AgentEngine,
	DeliveryObserver,
	InjectionContext,
	InjectionMode,
} from "../vendor/ace-runtime/dist/index.js";
import { renderAceEvent } from "../vendor/ace-runtime/dist/index.js";

/**
 * Push an event into the session over the host's channel: `notifications/claude/channel` with the
 * rendered `<ace_event>` block as `content`. Claude Code wraps it verbatim in its own
 * `<channel source="…">` tag and injects it — starting a turn when the session is idle, and
 * delivering batched events together on the next turn while it is busy. The host does not acknowledge
 * the notification, so the promise resolves when it is written to the transport, not when the model
 * has read it.
 */
export type ChannelPush = (content: string) => Promise<void>;

export interface ClaudeCodeEngineOptions {
	/** Push a rendered event into the session via the host's channel. */
	push: ChannelPush;
	/** Resolves an event once it is observed in the conversation (the `UserPromptSubmit` hook feeds it). */
	observer: DeliveryObserver;
	/**
	 * Wait for the observation before acknowledging. Must stay below the transport's `reclaimIdleMs`
	 * (default 60s) so a timed-out event is still redelivered rather than stranded in the pending
	 * list. Defaults to 30s, matching the Pi extension.
	 */
	ackTimeoutMs?: number;
	/** Injectable timer for tests. */
	setTimer?: (callback: () => void, ms: number) => { cancel: () => void };
}

const DEFAULT_ACK_TIMEOUT_MS = 30_000;

/**
 * The agent engine ACE drives in a Claude Code session.
 *
 * Deviations from {@link AgentEngine} that are host-specific:
 *
 * - {@link isRunning} is always `false`. The engine cannot tell whether the host session is mid-turn:
 *   the channel push is fire-and-forget and never blocks, so "a turn is in flight in this engine" is
 *   never true. The dispatcher uses this only for the `injected` vs `queued` metric.
 * - {@link waitForIdle} resolves immediately: shutting the runtime down must never wait on a live
 *   host turn, which lives in another process.
 *
 * `immediate` and `next_turn` are pushed identically: the channel has no mid-turn steering. An
 * `immediate` event reaches the model at the next step boundary (when the running tools finish) or on
 * the next turn — the host's own "delivered together on the next turn" behavior — which is the
 * closest the channel can get to immediate.
 */
export class ClaudeCodeEngine implements AgentEngine {
	private readonly push: ChannelPush;
	private readonly observer: DeliveryObserver;
	private readonly ackTimeoutMs: number;
	private readonly setTimer: (callback: () => void, ms: number) => { cancel: () => void };

	constructor(options: ClaudeCodeEngineOptions) {
		this.push = options.push;
		this.observer = options.observer;
		this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
		this.setTimer =
			options.setTimer ?? ((callback, ms) => ({ cancel: clearTimeout.bind(undefined, setTimeout(callback, ms)) }));
	}

	async inject(message: AceMessage, _mode: InjectionMode, context?: InjectionContext): Promise<void> {
		// Render first, then observe with the very text we send: the header names the channel, so
		// re-rendering later could produce a different string. Observe before pushing: the host may
		// deliver synchronously into a turn that is already starting.
		const text = renderAceEvent(message, context);
		const observed = this.observer.observe(message, text);
		try {
			await this.push(text);
		} catch (error) {
			// The push failed, so the observation can never be satisfied: release it (its promise must
			// not stay unhandled) and let the transport retry.
			void observed.catch(() => {});
			this.observer.release?.(message, text);
			throw error;
		}
		await this.awaitObservation(message, text, observed);
	}

	/** Fail loudly when the event is never observed, so the broker keeps it pending for redelivery. */
	private async awaitObservation(message: AceMessage, text: string, observed: Promise<void>): Promise<void> {
		let timer: { cancel: () => void } | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = this.setTimer(() => resolve("timeout"), this.ackTimeoutMs);
		});
		const outcome = await Promise.race([observed.then(() => "observed" as const), timeout]);
		timer?.cancel();
		if (outcome === "timeout") {
			// Release the exact text we observed by, not a re-render: the dispatcher passes a context
			// that adds a `stream:` line, so re-rendering without it would miss the stored key.
			this.observer.release?.(message, text);
			throw new Error(
				`injected event id=${message.id} sender=${message.sender} was not observed in the conversation within ${this.ackTimeoutMs}ms`,
			);
		}
	}

	isRunning(): boolean {
		return false;
	}

	async waitForIdle(): Promise<void> {}
}
