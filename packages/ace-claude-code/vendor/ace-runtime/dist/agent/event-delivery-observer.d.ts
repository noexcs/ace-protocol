import type { AceMessage } from "../protocol/ace-message.ts";
/** Something that can decide when an injected event has reached the conversation. */
export interface DeliveryObserver {
    /** Resolves once the host surfaced `message` in the conversation, i.e. this rendered text. */
    observe(message: AceMessage, rendered?: string): Promise<void>;
    /** Drop a pending observation that will never be satisfied (injection gave up). */
    release?(message: AceMessage, rendered?: string): void;
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
 */
export declare class AceDeliveryObserver implements DeliveryObserver {
    private readonly renderEvent;
    private readonly waiters;
    constructor(options?: {
        renderEvent?: (message: AceMessage) => string;
    });
    observe(message: AceMessage, rendered?: string): Promise<void>;
    release(message: AceMessage, rendered?: string): void;
    /** Feed every host message event here. */
    accept(event: unknown): void;
    /** How many injections are still waiting, for diagnostics. */
    get pendingCount(): number;
}
//# sourceMappingURL=event-delivery-observer.d.ts.map