import { renderAceEvent } from "./event-rendering.js";
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
 */
export class AceDeliveryObserver {
    renderEvent;
    waiters = new Map();
    constructor(options = {}) {
        this.renderEvent = options.renderEvent ?? renderAceEvent;
    }
    observe(message, rendered) {
        const text = rendered ?? this.renderEvent(message);
        return new Promise((resolve) => {
            const waiters = this.waiters.get(text) ?? [];
            waiters.push(resolve);
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
    /** Feed every host message event here. */
    accept(event) {
        const text = messageText(event);
        if (text === undefined)
            return;
        const waiters = this.waiters.get(text);
        if (!waiters)
            return;
        this.waiters.delete(text);
        for (const resolve of waiters)
            resolve();
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