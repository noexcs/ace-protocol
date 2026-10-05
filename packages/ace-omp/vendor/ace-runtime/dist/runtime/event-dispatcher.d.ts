import type { AgentEngine } from "../agent/agent-engine.ts";
import type { AceLogger } from "../logger.ts";
import type { AceMessage, ConcreteActivation } from "../protocol/ace-message.ts";
import type { AceMetrics } from "./metrics.ts";
import type { PendingEventStore } from "./pending-event-store.ts";
/** Where an ACE message ended up after activation resolution. */
export type DispatchDisposition = "injected" | "queued" | "stored" | "deduped" | "spooled" | "dropped";
export interface DispatchResult {
    readonly activation: ConcreteActivation;
    /**
     * - `injected`: the agent was idle; the event was placed in its context and a turn was started.
     * - `queued`: the agent was running; the event waits for the engine's next processing point.
     * - `stored`: a `manual` event retained by the runtime, no turn started.
     * - `deduped`: already seen `(sender, id)`; dropped, but acknowledged.
     * - `spooled`: written to a file with its burst; a summary event was injected instead.
     * - `dropped`: refused by policy (for example a sender that is not allowed).
     */
    readonly disposition: DispatchDisposition;
}
/** Routes an ACE message according to its effective activation (RFC §7, §19). */
export declare class EventDispatcher {
    private readonly engine;
    private readonly pendingEvents;
    private readonly logger;
    private readonly metrics;
    /** This session's own sender names: a message from one of them is its own event echoed back. */
    private readonly selfSenders;
    constructor(engine: AgentEngine, pendingEvents: PendingEventStore, logger?: AceLogger, metrics?: AceMetrics, selfSenders?: ReadonlySet<string>);
    dispatch(message: AceMessage, subscriptionName: string, activation: ConcreteActivation, 
    /** Uploaded channel name the event arrived on, for the header; the subscription label when absent. */
    channel?: string, 
    /** Broker arrival time (epoch ms UTC) when the transport exposes one; the header omits the line otherwise. */
    receivedAt?: number): Promise<DispatchResult>;
}
//# sourceMappingURL=event-dispatcher.d.ts.map