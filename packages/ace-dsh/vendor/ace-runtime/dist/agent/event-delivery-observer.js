import { renderAceEvent } from "./event-rendering.js";
/** Why a pending observation was failed: the host's run settled without surfacing the text. */
export const UNSURFACED_RELEASE_REASON = "the run settled without surfacing this text";
/**
 * The failure {@link AceDeliveryObserver.failPending} rejects with: the run this text was queued for
 * settled and the text never appeared in the conversation.
 *
 * A rejection — never a resolve. A resolve means "delivered" to whoever awaits the observation, and
 * treating "the host never surfaced it" as delivered would acknowledge an event the agent never saw,
 * losing it. The rejection makes `inject` fail instead, so the broker entry stays pending and
 * reclaim can retry it (and, once `reclaimAttempts` is spent, dead-letter it).
 */
export class DeliveryNotSurfacedError extends Error {
    /** The rendered text that never surfaced, for diagnostics. */
    rendered;
    constructor(rendered) {
        super(UNSURFACED_RELEASE_REASON);
        this.name = "DeliveryNotSurfacedError";
        this.rendered = rendered;
    }
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
export class AceDeliveryObserver {
    renderEvent;
    waiters = new Map();
    constructor(options = {}) {
        this.renderEvent = options.renderEvent ?? renderAceEvent;
    }
    observe(message, rendered) {
        const text = rendered ?? this.renderEvent(message);
        return new Promise((resolve, reject) => {
            const waiters = this.waiters.get(text) ?? [];
            waiters.push({ resolve, reject });
            this.waiters.set(text, waiters);
        });
    }
    release(message, rendered) {
        const text = rendered ?? this.renderEvent(message);
        const waiters = this.waiters.get(text);
        if (!waiters)
            return;
        this.waiters.delete(text);
    }
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
    failPending() {
        const pending = [...this.waiters];
        this.waiters.clear();
        for (const [text, waiters] of pending) {
            const error = new DeliveryNotSurfacedError(text);
            for (const waiter of waiters)
                waiter.reject(error);
        }
    }
    /** Feed every host message event here. */
    accept(event) {
        const text = messageText(event);
        if (text === undefined)
            return;
        const waiters = this.waiters.get(text);
        if (!waiters)
            return;
        this.waiters.delete(text);
        for (const waiter of waiters)
            waiter.resolve();
    }
    /** How many injections are still waiting, for diagnostics. */
    get pendingCount() {
        let total = 0;
        for (const waiters of this.waiters.values())
            total += waiters.length;
        return total;
    }
}
/** The text of a host message event, or `undefined` when it is not a user message. */
function messageText(event) {
    if (typeof event !== "object" || event === null)
        return undefined;
    if (!("message" in event))
        return undefined;
    const message = event.message;
    if (typeof message !== "object" || message === null)
        return undefined;
    if ("role" in message && message.role !== undefined && message.role !== "user")
        return undefined;
    const content = "content" in message ? message.content : undefined;
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return undefined;
    const parts = [];
    for (const part of content) {
        if (typeof part !== "object" || part === null)
            continue;
        if (!("type" in part) || part.type !== "text")
            continue;
        if ("text" in part && typeof part.text === "string")
            parts.push(part.text);
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
}
//# sourceMappingURL=event-delivery-observer.js.map