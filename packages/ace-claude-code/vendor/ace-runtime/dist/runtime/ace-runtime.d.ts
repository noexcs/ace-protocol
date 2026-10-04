import type { AgentEngine } from "../agent/agent-engine.ts";
import type { AceLogger } from "../logger.ts";
import type { ConcreteActivation } from "../protocol/ace-message.ts";
import type { Transport } from "../transport/transport.ts";
import { type EndpointConfig } from "./endpoint-config.ts";
import { type DispatchResult } from "./event-dispatcher.ts";
import { EventSpool, type EventSpoolOptions, type SpoolRule } from "./event-spool.ts";
import { AceMetrics } from "./metrics.ts";
import { PendingEventStore } from "./pending-event-store.ts";
export interface AceRuntimeOptions {
    /** Agent engine that receives ACE events (RFC-facing §15). */
    engine: AgentEngine;
    /** Channels this runtime receives events from, and the activation it forces per channel (RFC §4.1, §8). */
    subscribe: readonly EndpointConfig[];
    /**
     * Transport instances keyed by **subscription name**: each configured subscription reads from
     * its own transport, so two subscriptions may use the same transport kind (RFC §4.1) with
     * different settings — two Redis streams, for example.
     */
    transports: Readonly<Record<string, Transport>>;
    /** Fallback activation; ACE 0.1 requires `next_turn` when unset (RFC §8). */
    defaultActivation?: ConcreteActivation;
    logger?: AceLogger;
    metrics?: AceMetrics;
    /** `(sender, id)` pairs remembered per subscription for deduplication (default 1024). */
    dedupCapacity?: number;
    /** Retention limits for `manual` events. */
    manual?: {
        max?: number;
        ttlMs?: number;
    };
    /** Burst handling: where spool files go. Thresholds are built in (`DEFAULT_SPOOL_RULE`) unless overridden here. */
    spool?: Omit<EventSpoolOptions, "onBatch" | "onError" | "logger" | "rules"> & {
        rule?: SpoolRule;
    };
    /** Injectable clock for retention windows and spool windows; defaults to `Date.now`. */
    now?: () => number;
}
/** Result of handling one raw inbound message. */
export interface AceHandleResult extends DispatchResult {
    readonly subscriptionName: string;
}
/**
 * ACE 0.1 runtime: receive → validate → resolve activation → dispatch (RFC §9,
 * design doc §20).
 *
 * The runtime owns no MQ metadata, no agent loop, and no transport internals; it
 * is the boundary between a transport and an agent engine. It does own the delivery policy the
 * transport cannot provide: deduplication of redelivered events, sender allowlists, burst spilling,
 * and the retention window for `manual` events.
 */
export declare class AceRuntime {
    readonly metrics: AceMetrics;
    private readonly engine;
    private readonly subscribe;
    private readonly transportByName;
    private readonly defaultActivation;
    private readonly logger;
    private readonly pendingEventStore;
    private readonly dispatcher;
    private readonly seenBySubscription;
    private readonly dedupCapacity;
    private readonly spool;
    private readonly now;
    private started;
    constructor(options: AceRuntimeOptions);
    /** Connect every subscription's transport (RFC §33). */
    start(): Promise<void>;
    /** Disconnect transports, flush open spool windows, and wait for the engine to settle (RFC §33). */
    stop(): Promise<void>;
    /**
     * Full ACE path for one raw message: validate → dedup → activation → burst policy → dispatch.
     *
     * Throws {@link AceValidationError} for non-conforming messages. The transport-facing path
     * ({@link start}) logs and drops those instead, and lets other errors propagate so the transport
     * can retry or dead-letter (design doc §30).
     */
    handleRawMessage(raw: unknown, subscription: EndpointConfig): Promise<AceHandleResult>;
    /** Handle a raw message addressed to a configured subscription by name. */
    handleMessage(raw: unknown, subscriptionName: string): Promise<AceHandleResult>;
    /** Events retained for `manual` activation (RFC §7.3, §12). */
    get pendingEvents(): ReturnType<PendingEventStore["list"]>;
    /**
     * Explicitly activate a retained `manual` event.
     *
     * ACE 0.1 leaves the trigger to the runtime or user (§7.3); this is that runtime control hook.
     * Identity is `(sender, id)` (RFC §5.2).
     */
    activatePendingEvent(sender: string, id: string): Promise<void>;
    /** A turn this runtime started ended in failure; counted for `/ace stats` and logged. */
    recordRunFailure(error: unknown): void;
    /** Open spool windows, for `/ace stats`. */
    openSpoolWindows(): ReturnType<EventSpool["openWindows"]>;
    /** Restore `manual` events persisted by an earlier session. */
    private restorePendingEvents;
    /** Inject one summary event for a spooled burst. */
    private summarizeBatch;
    private seenFor;
    private transportFor;
    private deliver;
}
//# sourceMappingURL=ace-runtime.d.ts.map