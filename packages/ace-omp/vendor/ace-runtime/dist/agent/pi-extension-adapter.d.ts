import type { AceMessage } from "../protocol/ace-message.ts";
import type { AgentEngine, InjectionContext, InjectionMode } from "./agent-engine.ts";
import type { DeliveryObserver } from "./event-delivery-observer.ts";
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
    sendUserMessage(content: string, options?: {
        deliverAs?: DeliverAs;
    }): void;
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
    /** Renders an ACE event into context text. Defaults to {@link renderAceEvent}. */
    renderEvent?: (message: AceMessage, context?: InjectionContext) => string;
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
    setTimer?: (callback: () => void, ms: number) => {
        cancel: () => void;
    };
}
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
export declare class PiExtensionAdapter implements AgentEngine {
    private readonly pi;
    private readonly isIdle;
    private readonly renderEvent;
    private readonly host;
    private readonly observeDelivery?;
    private readonly deliveryTimeoutMs;
    private readonly setTimer;
    private readonly runErrorListeners;
    constructor(options: PiExtensionAdapterOptions);
    inject(message: AceMessage, mode: InjectionMode, context?: InjectionContext): Promise<void>;
    /** The delivery this host understands for the event's urgency and the agent's state. */
    private deliveryFor;
    /** Fail loudly when the host never surfaced the event, so the broker keeps it pending. */
    private awaitDelivery;
    /** Listeners the runtime registers to count failed runs. */
    onRunError(listener: (error: unknown) => void): void;
    /**
     * Report a failed turn the host surfaced as an event (`turn_end` with a failure stop reason).
     *
     * The extension adapter cannot see turn outcomes on its own — it only hands messages over — so the
     * extension watches the host's events and calls this.
     */
    reportRunFailure(error: unknown): void;
    isRunning(): boolean;
    waitForIdle(): Promise<void>;
}
/**
 * Detect the host's delivery behavior.
 *
 * `pi.pi` is oh-my-pi's self-reference to its SDK namespace (`extensions/types.ts:1375`); upstream
 * Pi's `ExtensionAPI` has no such field. Probes are how capability gaps get found in practice, so
 * `ACE_DELIVERY=aside|portable` overrides the guess when a host changes its surface.
 */
export declare function detectHostDelivery(pi: unknown): HostDelivery;
//# sourceMappingURL=pi-extension-adapter.d.ts.map