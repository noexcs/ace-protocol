import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AceMessage } from "../protocol/ace-message.ts";
import type { AgentEngine, InjectionContext, InjectionMode } from "./agent-engine.ts";
export interface PiAdapterOptions {
    /** Pi session that owns the agent context, turns, tools, and LLM calls. */
    session: AgentSession;
    /** Called when a run started by an injected ACE event fails. */
    onRunError?: (error: unknown) => void;
    /** Renders an ACE event into Pi context text. Defaults to {@link renderAceEvent}. */
    /** Renders an ACE event into context text. Defaults to {@link renderAceEvent}. */
    renderEvent?: (message: AceMessage, context?: InjectionContext) => string;
}
/**
 * Added to the host's system prompt by ACE-aware sessions (design doc §18).
 *
 * Soft constraint only: the runtime neither stores approvals nor blocks senders, and the user's answer
 * lives in the conversation. It is stated in the system prompt rather than in every event for two
 * reasons — a rule repeated per event costs context on each one, and a system message carries more
 * weight than text injected alongside the data it qualifies.
 */
export declare const ACE_TRUST_POLICY: string;
/** Append {@link ACE_TRUST_POLICY} to a system prompt. */
export declare function withTrustPolicy(systemPrompt: string): string;
/**
 * Render an ACE event for the agent context (design doc §18).
 *
 * The header is an adapter choice, not a protocol requirement: the protocol only requires `body` to be
 * visible to later reasoning (RFC §9). The whole event is wrapped in `<ace_event>` so a model can tell
 * an external event from anything a human typed — and because the rendered text starts with a fixed
 * prefix, an ACE body can never be mistaken for a Pi slash command or prompt template. The header names:
 *
 * - `sender`, as the sender wrote it (peers that construct theirs as a directory member of
 *   `<agent>:<sessionId>` can be matched against `ace_agents` by eye);
 * - `sender description`, when the sender supplied one;
 * - `channel`, from {@link InjectionContext}: the address it arrived on (a Redis stream name), or the
 *   subscription name when the transport exposes no address. A sender's target name lives in the sender's
 *   own configuration, so it is not what a receiver can name;
 * - `id`, the runtime-generated message id.
 *
 * Everything in the header is the sender's own account or our own bookkeeping; it is display-only and
 * never an authorization.
 */
export declare function renderAceEvent(message: AceMessage, context?: InjectionContext): string;
/**
 * Drives a Pi `AgentSession` from ACE events (design doc §16).
 *
 * Mapping onto public Pi session APIs:
 *
 * | Effective activation | Agent idle | Agent running |
 * |---|---|---|
 * | `next_turn` | prompt: event enters context, turn starts | `followUp()`: processed after the current run's pending work |
 * | `immediate` | prompt: event enters context, turn starts | `steer()`: processed at the current turn's next boundary |
 *
 * `immediate` therefore preempts at Pi's earliest public processing point
 * instead of force-aborting the running turn; mid-turn cancellation is design
 * doc §28/§29 work and is deliberately out of the MVP.
 *
 * Pi only drains its steering and follow-up queues from a live agent loop. An
 * event queued after the loop's last poll would sit there until some unrelated
 * run drains it, so the adapter records every queued event, watches for the
 * conversation message Pi emits when it injects it, and starts a new run for
 * whatever is left once the session settles.
 */
export declare class PiAdapter implements AgentEngine {
    readonly session: AgentSession;
    private readonly hostOnRunError;
    private readonly runErrorListeners;
    private readonly renderEvent;
    private readonly queuedEvents;
    constructor(options: PiAdapterOptions);
    inject(message: AceMessage, mode: InjectionMode, context?: InjectionContext): Promise<void>;
    isRunning(): boolean;
    waitForIdle(): Promise<void>;
    /**
     * Run `text` as a new turn and resolve once the run has started.
     *
     * The run itself is not awaited: a turn lasts as long as the model needs, and
     * events arriving meanwhile must still reach the session.
     */
    private startRun;
    private markDelivered;
    /** Start a run for every queued event the just-finished agent loop never injected. */
    private flushStrandedEvents;
    /** Listeners the runtime registers to count failed runs. */
    onRunError(listener: (error: unknown) => void): void;
    private reportRunError;
}
//# sourceMappingURL=pi-adapter.d.ts.map