import type { AceMessage } from "../protocol/ace-message.ts";
import type { AgentEngine, InjectionMode } from "./agent-engine.ts";
import type { DeliveryObserver } from "./event-delivery-observer.ts";
import { renderAceEvent } from "./pi-adapter.ts";

/**
 * How the host queues an injected message.
 *
 * Upstream Pi takes `steer | followUp`; oh-my-pi (omp) adds `aside` (`nextTurn` exists only on its
 * custom-message API). The two hosts also disagree about what happens while the agent is idle —
 * see {@link HostDelivery}.
 */
export type DeliverAs = "steer" | "followUp" | "aside";

/** The slice of Pi's `ExtensionAPI` this adapter needs. */
export interface ExtensionMessageApi {
	sendUserMessage(content: string, options?: { deliverAs?: DeliverAs }): void;
}

/**
 * What this host does with `deliverAs` while the agent is idle. The difference is real and is not
 * visible in either type signature:
 *
 * - **Upstream Pi**: `sendUserMessage` always triggers a turn, so a `deliverAs` sent while idle
 *   still starts one.
 * - **oh-my-pi**: `sendUserMessage` queues and returns for `steer`/`followUp` — the message waits
 *   for a turn that may never come — and only `aside` falls through to the prompt path when idle.
 *   Measured on omp 18.5.0: a `followUp` injected into an idle headless session sat in the queue
 *   forever while its broker entry had already been acknowledged. That is silent event loss, which
 *   is why the adapter picks the delivery itself instead of trusting the host to sort it out.
 */
export interface HostDelivery {
	/** Whether `deliverAs: "aside"` is understood (oh-my-pi). Defaults to `false` (upstream Pi). */
	supportsAside?: boolean;
}

export interface PiExtensionAdapterOptions {
	pi: ExtensionMessageApi;
	/**
	 * Reports whether the agent is idle, e.g. `() => ctx.isIdle()`. Defaults to "idle" for the
	 * window before a session context exists.
	 */
	isIdle?: () => boolean;
	/** Renders an ACE event into context text. Defaults to {@link renderAceEvent}. */
	renderEvent?: (message: AceMessage) => string;
	/** Host delivery behavior; defaults to the upstream-Pi shape. */
	host?: HostDelivery;
	/**
	 * Decides when an injected event reached the conversation (`AceDeliveryObserver`). When given,
	 * `inject` waits for it: an event the agent never saw must not be acknowledged, so the broker
	 * keeps it pending for redelivery.
	 */
	observeDelivery?: DeliveryObserver;
	/**
	 * How long to wait for {@link PiExtensionAdapterOptions.observeDelivery} before failing the
	 * injection. Keep it below the transport's `reclaimIdleMs`: the transport must be able to
	 * redeliver an event whose wait timed out. Default 30s.
	 */
	deliveryTimeoutMs?: number;
	/** Timer for the delivery wait; tests inject a controllable one. */
	setTimer?: (callback: () => void, ms: number) => { cancel: () => void };
}

const DEFAULT_DELIVERY_TIMEOUT_MS = 30_000;

/**
 * Drives the Pi session this extension is loaded into (design doc §16).
 *
 * The adapter owns the `activation → deliverAs` decision because it depends on the host, not on the
 * protocol:
 *
 * | activation | agent running | upstream Pi | oh-my-pi |
 * |---|---|---|---|
 * | `next_turn` | any | `followUp` (idle: no `deliverAs`) | `aside` — queues at the next step boundary, starts a turn when idle |
 * | `immediate` | running | `steer` | `steer` |
 * | `immediate` | idle | no `deliverAs` (the prompt path starts the turn) | same |
 *
 * Passing no `deliverAs` means "start a turn now": both hosts route it through their prompt path.
 * It is the only delivery both hosts agree on for an idle agent, so the adapter uses it there
 * instead of relying on `followUp`, which omp never drains on an idle session.
 *
 * Deviations from {@link AgentEngine}: `waitForIdle` resolves immediately, because a session
 * shutdown must never block the interactive UI on a live turn.
 */
export class PiExtensionAdapter implements AgentEngine {
	private readonly pi: ExtensionMessageApi;
	private readonly isIdle: () => boolean;
	private readonly renderEvent: (message: AceMessage) => string;
	private readonly host: Required<HostDelivery>;
	private readonly observeDelivery?: DeliveryObserver;
	private readonly deliveryTimeoutMs: number;
	private readonly setTimer: (callback: () => void, ms: number) => { cancel: () => void };
	private readonly runErrorListeners: Array<(error: unknown) => void> = [];

	constructor(options: PiExtensionAdapterOptions) {
		this.pi = options.pi;
		this.isIdle = options.isIdle ?? (() => true);
		this.renderEvent = options.renderEvent ?? renderAceEvent;
		this.host = { supportsAside: options.host?.supportsAside ?? false };
		this.observeDelivery = options.observeDelivery;
		this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
		this.setTimer =
			options.setTimer ?? ((callback, ms) => ({ cancel: clearTimeout.bind(undefined, setTimeout(callback, ms)) }));
	}

	async inject(message: AceMessage, mode: InjectionMode): Promise<void> {
		const deliverAs = this.deliveryFor(mode);
		// Start observing before sending: a host may deliver synchronously.
		const observed = this.observeDelivery?.observe(message);
		try {
			this.pi.sendUserMessage(this.renderEvent(message), deliverAs === undefined ? undefined : { deliverAs });
		} catch (error) {
			// Drop the observation we will never satisfy; its promise must not stay unhandled.
			void observed?.catch(() => {});
			this.observeDelivery?.release?.(message);
			throw error;
		}
		if (observed) await this.awaitDelivery(message, observed);
	}

	/** The delivery this host understands for the event's urgency and the agent's state. */
	private deliveryFor(mode: InjectionMode): DeliverAs | undefined {
		const running = this.isRunning();
		if (mode === "next_turn") {
			// `aside` carries both states on its own: queued at the next step boundary while running,
			// a turn of its own while idle. Upstream Pi has no `aside`; there an idle agent needs the
			// prompt path, and only a running one may be queued.
			return this.host.supportsAside ? "aside" : running ? "followUp" : undefined;
		}
		return running ? "steer" : undefined;
	}

	/** Fail loudly when the host never surfaced the event, so the broker keeps it pending. */
	private async awaitDelivery(message: AceMessage, observed: Promise<void>): Promise<void> {
		let timer: { cancel: () => void } | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = this.setTimer(() => resolve("timeout"), this.deliveryTimeoutMs);
		});
		const outcome = await Promise.race([observed.then(() => "observed" as const), timeout]);
		timer?.cancel();
		if (outcome === "timeout") {
			this.observeDelivery?.release?.(message);
			throw new Error(
				`injected event id=${message.id} sender=${message.sender} was not observed in the conversation within ${this.deliveryTimeoutMs}ms`,
			);
		}
	}

	/** Listeners the runtime registers to count failed runs. */
	onRunError(listener: (error: unknown) => void): void {
		this.runErrorListeners.push(listener);
	}

	/**
	 * Report a failed turn the host surfaced as an event (`turn_end` with a failure stop reason).
	 *
	 * The extension adapter cannot see turn outcomes on its own — it only hands messages over — so the
	 * extension watches the host's events and calls this.
	 */
	reportRunFailure(error: unknown): void {
		for (const listener of this.runErrorListeners) {
			try {
				listener(error);
			} catch {
				// A failing listener must not take down the session.
			}
		}
	}

	isRunning(): boolean {
		return !this.isIdle();
	}

	async waitForIdle(): Promise<void> {}
}

/**
 * Detect the host's delivery behavior.
 *
 * `pi.pi` is oh-my-pi's self-reference to its SDK namespace (`extensions/types.ts:1375`); upstream
 * Pi's `ExtensionAPI` has no such field. Probes are how capability gaps get found in practice, so
 * `ACE_DELIVERY=aside|portable` overrides the guess when a host changes its surface.
 */
export function detectHostDelivery(pi: unknown): HostDelivery {
	const override = process.env.ACE_DELIVERY;
	if (override === "aside") return { supportsAside: true };
	if (override === "portable") return { supportsAside: false };
	const marker = pi !== null && typeof pi === "object" && "pi" in pi ? pi.pi : undefined;
	return { supportsAside: marker !== undefined };
}
