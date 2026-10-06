import type { AceMessage } from "../protocol/ace-message.ts";
/** Why a pending observation was failed: the host's run settled without surfacing the text. */
export declare const UNSURFACED_RELEASE_REASON = "the run settled without surfacing this text";
/**
 * The failure {@link AceDeliveryObserver.failPending} rejects with: the run this text was queued for
 * settled and the text never appeared in the conversation.
 *
 * A rejection — never a resolve. A resolve means "delivered" to whoever awaits the observation, and
 * treating "the host never surfaced it" as delivered would acknowledge an event the agent never saw,
 * losing it. The rejection makes `inject` fail instead, so the broker entry stays pending and
 * reclaim can retry it (and, once `reclaimAttempts` is spent, dead-letter it).
 */
export declare class DeliveryNotSurfacedError extends Error {
    /** The rendered text that never surfaced, for diagnostics. */
    readonly rendered: string;
    constructor(rendered: string);
}
/** Something that can decide when an injected event has reached the conversation. */
export interface DeliveryObserver {
    /** Resolves once the host surfaced `message` in the conversation, i.e. this rendered text. */
    observe(message: AceMessage, rendered?: string): Promise<void>;
    /** Drop a pending observation that will never be satisfied (injection gave up). */
    release?(message: AceMessage, rendered?: string): void;
    /**
     * Fail every pending observation: their run settled without surfacing them. The waiters reject
     * with {@link DeliveryNotSurfacedError}, which is a delivery failure, not a surface.
     */
    failPending?(): void;
}
/**
 * Resolves an injection once it shows up in the conversation.
 *
 * The host echoes the injected text back in a message event — oh-my-pi emits the very string we
 * handed it — so the observer matches on that string. Matching the whole rendered event means no
 * id parsing and no false positives from an event body that happens to mention an id.
 *
 * Why this exists: "handed to the host" is not "the agent can see it". An idle oh-my-pi session
 * queues a `followUp` without starting a turn, so an injection that resolved on hand-off let the
 * transport acknowledge events the agent never received. Until the message event arrives, the
 * broker entry stays pending.
 *
 * The other end of the same problem: a queued delivery has no wall clock, so waiting for the
 * message event can outlast the run it was queued for. When the host says the run has settled and
 * nothing more from its queue will surface, {@link failPending} ends those waits as *not delivered*
 * — the rejection makes `inject` fail, the entry leaves the transport's delivery queue, and
 * reclaim/`reclaimAttempts`/the dead-letter file take over instead of a queue slot being held
 * forever.
 */
export declare class AceDeliveryObserver implements DeliveryObserver {
    private readonly renderEvent;
    private readonly waiters;
    constructor(options?: {
        renderEvent?: (message: AceMessage) => string;
    });
    observe(message: AceMessage, rendered?: string): Promise<void>;
    release(message: AceMessage, rendered?: string): void;
    /**
     * Fail every pending observation: the host's run settled and none of their texts surfaced in it.
     *
     * Each waiter rejects with {@link DeliveryNotSurfacedError} — never resolves. A resolve means
     * "delivered", and acknowledging an event the agent never saw is the loss this whole observer
     * exists to prevent; the rejection is what makes `inject` fail so the broker entry stays pending
     * for reclaim.
     *
     * Distinct from {@link release}, which only drops waiters: that path says "stop waiting, the
     * caller has its own failure to report" (the bounded delivery timeout), while this one says
     * "this run did not deliver it". Idempotent by construction: {@link accept} removes a waiter the
     * moment its text surfaces, so a surfaced delivery is never failed by a later settle, and a
     * second call finds nothing left to fail.
     */
    failPending(): void;
    /** Feed every host message event here. */
    accept(event: unknown): void;
    /** How many injections are still waiting, for diagnostics. */
    get pendingCount(): number;
}
//# sourceMappingURL=event-delivery-observer.d.ts.map