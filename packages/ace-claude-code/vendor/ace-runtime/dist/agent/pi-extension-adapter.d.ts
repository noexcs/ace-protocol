import type { AceLogger } from "../logger.ts";
import type { AceMessage } from "../protocol/ace-message.ts";
import type { AgentEngine, InjectionContext, InjectionMode } from "./agent-engine.ts";
import { type DeliveryObserver } from "./event-delivery-observer.ts";
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
     * How long a **bounded** delivery wait may take before failing the injection (`steer`, and the
     * prompt path where the host is expected to surface the event in the current turn). Leave it
     * below the transport's `reclaimIdleMs`: the transport must be able to redeliver an event whose
     * wait timed out. Default 30s. Queued deliveries ignore it — see {@link PiExtensionAdapter}.
     */
    deliveryTimeoutMs?: number;
    /** Timer for the bounded delivery wait; tests inject a controllable one. */
    setTimer?: (callback: () => void, ms: number) => {
        cancel: () => void;
    };
    /**
     * Where the adapter reports a suppressed duplicate injection, so a host can tell adapter-level
     * duplication from render-level duplication. Defaults to discarding the line.
     */
    logger?: AceLogger;
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
 * ## Idempotent injection
 *
 * `sendUserMessage` has no identity check of its own, and a redelivery from the transport is normal
 * at-least-once behavior. The adapter therefore records every event identity —
 * `(subscription, sender, id)` — as **handed to the host** the moment `sendUserMessage` returns
 * successfully, and never rolls that record back: it says the host received the message, not that
 * the agent saw it. Those are different facts, and the delivery observer keeps its own (separate)
 * concern. A redelivery whose identity is already recorded re-attaches to the observation and waits
 * again; it never calls `sendUserMessage` a second time. The set is a bounded FIFO of capacity
 * {@link DEFAULT_HANDED_CAPACITY} (the same trade-off `SeenMessageIds` makes: a duplicate older than
 * the window may still slip through, so memory stays bounded).
 *
 * Failure chain this closes: an agent turn can last minutes, so a `next_turn` event queued for the
 * next step boundary may not surface for a long time. A single wall clock failed that slow success,
 * the broker never got the acknowledgement, `reclaimStale` redelivered, and the host sent a second
 * copy — three successful sends for one stored entry (measured: `1 + reclaimAttempts(3) = 4`).
 *
 * ## Delivery wait
 *
 * What the wait does with the observation depends on the path, because the surface time does too:
 *
 * | delivery | paths | wait |
 * |---|---|---|
 * | queued | `deliverAs: "aside"` / `"followUp"` | no wall clock — wait for the observation; the host's settle signal (`agent_settled`) releases a wait whose text never surfaced, and the transport's `reclaimAttempts`/`reclaimIdleMs` bounds the retry |
 * | bounded | prompt path (no `deliverAs`), `steer` | fail after `deliveryTimeoutMs` (default 30s), so the entry stays pending and reclaim can redeliver it |
 *
 * A queued delivery surfaces at the next step boundary, and a model turn lasts as long as it lasts —
 * its surface time is not knowable, so a wall clock there would fail a delivery that already
 * succeeded (`sendUserMessage` returned; the message is queued and will surface). The paths where
 * the host is expected to surface the event in the current turn keep the timeout, which is the
 * only signal that the host dropped it.
 *
 * A queued wait ends instead on the host's lifecycle signal: when the run settles without surfacing
 * the text, the observation is released as *not delivered* (`DeliveryNotSurfacedError`), `inject`
 * logs the release and rejects, and the entry stays pending for reclaim. The identity record is not
 * rolled back — the release does not mean the host forgot the message, only that this run never
 * showed it — so a redelivery re-attaches to the observation and never calls `sendUserMessage`
 * again. Because of that, repeated releases end at the transport's `reclaimAttempts` cap and the
 * event lands in the dead-letter file (visible and replayable) instead of holding one of the 256
 * delivery-queue slots forever.
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
    private readonly logger;
    /** Identities already handed to the host, in insertion order (`Map` keeps it), FIFO-bounded. */
    private readonly handed;
    private readonly handedCapacity;
    private readonly runErrorListeners;
    constructor(options: PiExtensionAdapterOptions);
    inject(message: AceMessage, mode: InjectionMode, context?: InjectionContext): Promise<void>;
    /** The delivery this host understands for the event's urgency and the agent's state. */
    private deliveryFor;
    /**
     * Wait for the observation.
     *
     * A queued delivery waits without a wall clock (its surface time is the next step boundary and
     * not knowable); it ends when the text surfaces or when the host settles the run without
     * surfacing it, in which case the observation rejects and this rethrows — the entry stays
     * pending for reclaim. A bounded delivery fails after {@link deliveryTimeoutMs} for the same
     * reason, so the broker keeps the entry pending either way.
     */
    private awaitDelivery;
    /** Record an identity as handed to the host, evicting the oldest past the capacity. */
    private remember;
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