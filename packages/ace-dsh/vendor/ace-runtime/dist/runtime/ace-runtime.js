import { isActivation } from "../protocol/ace-message.js";
import { AceValidationError, decodeAceMessage } from "../protocol/validator.js";
import { DEFAULT_RUNTIME_ACTIVATION, resolveActivation } from "./activation-resolver.js";
import { AceConfigError } from "./endpoint-config.js";
import { EventDispatcher } from "./event-dispatcher.js";
import { DEFAULT_SPOOL_RULE, EventSpool, } from "./event-spool.js";
import { AceMetrics } from "./metrics.js";
import { PendingEventStore } from "./pending-event-store.js";
import { SeenMessageIds } from "./seen-message-ids.js";
/** How long a failed start waits for each transport it already started to unwind. */
const FAILED_START_STOP_TIMEOUT_MS = 1_000;
/**
 * Stop `transport`, giving up after `ms` so a stalled host cannot hang a failed start.
 *
 * Returns whether the stop finished inside the bound. The timer is unref'd, so a pending bound never
 * keeps a process alive on its own.
 */
async function stopWithin(transport, ms) {
    let timer;
    let finished = false;
    const stopped = transport.stop().then(() => {
        finished = true;
    });
    try {
        await Promise.race([
            stopped,
            new Promise((resolve) => {
                timer = setTimeout(resolve, ms);
                timer.unref?.();
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
    return finished;
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
export class AceRuntime {
    metrics;
    engine;
    subscribe;
    transportByName;
    defaultActivation;
    logger;
    pendingEventStore;
    dispatcher;
    seenBySubscription = new Map();
    dedupCapacity;
    /** This session's own sender names (see {@link AceRuntimeOptions.selfSenders}). */
    selfSenders;
    spool;
    now;
    started = false;
    constructor(options) {
        this.subscribe = options.subscribe.map((endpoint) => {
            if (typeof endpoint.name !== "string" || endpoint.name.length === 0) {
                throw new AceConfigError("subscribe entry requires a non-empty name");
            }
            if (typeof endpoint.transport !== "string" || endpoint.transport.length === 0) {
                throw new AceConfigError(`subscribe "${endpoint.name}" requires a transport`);
            }
            if (endpoint.activation !== undefined && !isActivation(endpoint.activation)) {
                throw new AceConfigError(`subscribe "${endpoint.name}" has an invalid activation: ${endpoint.activation}`);
            }
            return endpoint;
        });
        const transportByName = new Map();
        const usedTransports = new Set();
        for (const subscription of this.subscribe) {
            if (transportByName.has(subscription.name)) {
                throw new AceConfigError(`subscribe name "${subscription.name}" is configured twice`);
            }
            const transport = options.transports[subscription.name];
            if (!transport) {
                throw new AceConfigError(`subscribe "${subscription.name}" has no transport registered under its name (registered: ${Object.keys(options.transports).join(", ") || "none"})`);
            }
            if (usedTransports.has(transport)) {
                throw new AceConfigError(`transport of subscribe "${subscription.name}" is already used by another subscription; its messages would be delivered twice`);
            }
            usedTransports.add(transport);
            transportByName.set(subscription.name, transport);
        }
        this.engine = options.engine;
        this.transportByName = transportByName;
        this.defaultActivation = options.defaultActivation ?? DEFAULT_RUNTIME_ACTIVATION;
        this.logger = options.logger ?? {};
        this.metrics = options.metrics ?? new AceMetrics();
        this.dedupCapacity = options.dedupCapacity ?? 1024;
        this.selfSenders = new Set(options.selfSenders ?? []);
        this.now = options.now ?? (() => Date.now());
        if (options.spool) {
            const { rule, ...spoolOptions } = options.spool;
            this.spool = new EventSpool({
                ...spoolOptions,
                now: this.now,
                rules: () => rule ?? DEFAULT_SPOOL_RULE,
                onBatch: (batch) => this.summarizeBatch(batch),
                logger: this.logger,
                onError: (error) => this.logger.error?.(`[ACE] spool error: ${error instanceof Error ? error.message : String(error)}`),
            });
        }
        else {
            this.spool = undefined;
        }
        this.pendingEventStore = new PendingEventStore({
            now: this.now,
            ...(options.manual?.max === undefined ? {} : { max: options.manual.max }),
            ...(options.manual?.ttlMs === undefined ? {} : { ttlMs: options.manual.ttlMs }),
            ...(this.spool ? { persist: (event) => this.spool?.appendManual(event.subscriptionName, event.message) } : {}),
            onEvict: (event, reason) => this.logger.warn?.(`[ACE] dropped pending manual event id=${event.message.id} (${reason})`),
        });
        this.restorePendingEvents();
        this.dispatcher = new EventDispatcher(this.engine, this.pendingEventStore, this.logger, this.metrics, this.selfSenders);
        // Failures arrive after the fact and without saying which event was in flight, so they are
        // counted at runtime scope rather than charged to a subscription.
        this.engine.onRunError?.((error) => this.recordRunFailure(error));
    }
    /** Connect every subscription's transport (RFC §33). */
    async start() {
        if (this.started)
            throw new AceConfigError("ACE runtime is already started");
        this.started = true;
        const started = [];
        try {
            for (const subscription of this.subscribe) {
                const transport = this.transportFor(subscription);
                await transport.start((raw, receivedAt) => this.deliver(raw, subscription, receivedAt));
                started.push(transport);
            }
        }
        catch (error) {
            // Do not claim to be started when a transport refused to connect — and do not leave the
            // transports that *did* connect running: they would keep reading and injecting into an
            // engine the caller was just told is not there, invisible and unbounded.
            this.started = false;
            for (const transport of started) {
                try {
                    // Bounded on purpose: `stop()` waits for whatever the host still has in flight, and a
                    // stalled host is exactly what this path may be staring at — waiting forever would turn
                    // a failed start into a hung one. A stop that outlives the bound keeps unwinding in the
                    // background; the caller still gets its error.
                    if (!(await stopWithin(transport, FAILED_START_STOP_TIMEOUT_MS))) {
                        this.logger.warn?.(`[ACE] a transport from the failed start is still unwinding after ${FAILED_START_STOP_TIMEOUT_MS}ms`);
                    }
                }
                catch (stopError) {
                    this.logger.warn?.(`[ACE] stopping a half-started transport failed: ${stopError instanceof Error ? stopError.message : String(stopError)}`);
                }
            }
            throw error;
        }
        this.logger.info?.(`[ACE] runtime started subscribe=${this.subscribe.map((endpoint) => endpoint.name).join(",")} defaultActivation=${this.defaultActivation}`);
    }
    /** Disconnect transports, flush open spool windows, and wait for the engine to settle (RFC §33). */
    async stop() {
        if (!this.started)
            return;
        this.started = false;
        for (const subscription of this.subscribe) {
            await this.transportFor(subscription).stop();
        }
        if (this.spool)
            await this.spool.flush();
        await this.engine.waitForIdle();
    }
    /**
     * Full ACE path for one raw message: validate → dedup → activation → burst policy → dispatch.
     *
     * Throws {@link AceValidationError} for non-conforming messages. The transport-facing path
     * ({@link start}) logs and drops those instead, and lets other errors propagate so the transport
     * can retry or dead-letter (design doc §30).
     *
     * `receivedAt` is the broker arrival instant (epoch ms UTC) when the transport can tell it — the
     * rendered block's `received at:` line comes from here, not from render time. It is omitted when the
     * transport exposes no timestamp (design doc §18).
     */
    async handleRawMessage(raw, subscription, receivedAt) {
        this.metrics.increment(subscription.name, "received");
        let message;
        try {
            message = decodeAceMessage(raw);
        }
        catch (error) {
            if (error instanceof AceValidationError)
                this.metrics.increment(subscription.name, "rejected");
            throw error;
        }
        const activation = resolveActivation(message, subscription, this.defaultActivation);
        const seen = this.seenFor(subscription.name);
        if (seen.has(message.sender, message.id)) {
            this.metrics.increment(subscription.name, "deduped");
            this.logger.info?.(`[ACE] duplicate id=${message.id} sender=${message.sender} subscribe=${subscription.name}`);
            return { activation, disposition: "deduped", subscriptionName: subscription.name };
        }
        this.logger.info?.(`[ACE] received id=${message.id} sender=${message.sender} subscribe=${subscription.name}`);
        if (this.spool) {
            const outcome = await this.spool.offer(subscription.name, message);
            if (outcome.spooled) {
                this.metrics.increment(subscription.name, "spooled");
                seen.remember(message.sender, message.id);
                return { activation, disposition: "spooled", subscriptionName: subscription.name };
            }
        }
        const result = await this.dispatcher.dispatch(message, subscription.name, activation, subscription.channel, receivedAt);
        // Remember only now: a failed delivery must stay eligible for redelivery.
        seen.remember(message.sender, message.id);
        return { ...result, subscriptionName: subscription.name };
    }
    /** Handle a raw message addressed to a configured subscription by name. */
    async handleMessage(raw, subscriptionName) {
        const subscription = this.subscribe.find((candidate) => candidate.name === subscriptionName);
        if (!subscription)
            throw new AceConfigError(`unknown subscription "${subscriptionName}"`);
        return this.handleRawMessage(raw, subscription);
    }
    /** Events retained for `manual` activation (RFC §7.3, §12). */
    get pendingEvents() {
        return this.pendingEventStore.list();
    }
    /**
     * Explicitly activate a retained `manual` event.
     *
     * ACE 0.1 leaves the trigger to the runtime or user (§7.3); this is that runtime control hook.
     * Identity is `(sender, id)` (RFC §5.2).
     */
    async activatePendingEvent(sender, id) {
        const event = this.pendingEventStore.take(sender, id);
        if (!event) {
            throw new Error(`No pending ACE event for sender="${sender}" id="${id}"`);
        }
        this.logger.info?.(`[ACE] activating id=${id} sender=${sender} subscribe=${event.subscriptionName}`);
        const origin = this.subscribe.find((entry) => entry.name === event.subscriptionName);
        // Manual activation is a user action on this host, so there is no broker arrival time to show:
        // `receivedAt` stays undefined and the block omits its `received at:` line (design doc §18).
        await this.engine.inject(event.message, "next_turn", {
            subscription: event.subscriptionName,
            ...(origin?.channel === undefined ? {} : { channel: origin.channel }),
            activation: event.message.activation,
            ...(this.selfSenders.has(event.message.sender) ? { self: true } : {}),
        });
    }
    /** A turn this runtime started ended in failure; counted for `/ace stats` and logged. */
    recordRunFailure(error) {
        this.metrics.increment("runtime", "runFailed");
        this.logger.warn?.(`[ACE] agent run failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    /** Open spool windows, for `/ace stats`. */
    openSpoolWindows() {
        return this.spool?.openWindows() ?? [];
    }
    /** Restore `manual` events persisted by an earlier session. */
    restorePendingEvents() {
        const spool = this.spool;
        if (!spool)
            return;
        for (const subscription of this.subscribe) {
            const messages = spool.loadManual(subscription.name);
            if (messages.length === 0)
                continue;
            const restored = this.pendingEventStore.restore(subscription.name, messages);
            this.logger.info?.(`[ACE] restored ${restored} pending manual event(s) subscribe=${subscription.name}`);
        }
    }
    /** Inject one summary event for a spooled burst. */
    async summarizeBatch(batch) {
        const first = batch.events[0];
        const last = batch.events[batch.events.length - 1];
        const senders = [...new Set(batch.events.map((message) => message.sender))].join(", ");
        const preview = batch.events
            .slice(0, 3)
            .map((message) => `- ${message.id} from ${message.sender}: ${message.body.slice(0, 120).replace(/\s+/g, " ")}`)
            .join("\n");
        const summary = {
            aceVersion: "0.1",
            id: `evt_spool_${Date.now().toString(36)}_${batch.events.length}`,
            sender: "ace-runtime",
            activation: "next_turn",
            body: [
                `${batch.events.length} events were spooled to ${batch.path} because this channel received more than it should inject at once.`,
                `Senders: ${senders}.${first && last ? ` Window: ${first.id} … ${last.id}.` : ""}`,
                preview.length > 0 ? `\nFirst events:\n${preview}` : "",
                `\nRead the file if the details matter; every line is one ACE message.`,
            ]
                .filter((line) => line.length > 0)
                .join("\n"),
        };
        const origin = this.subscribe.find((entry) => entry.name === batch.subscription);
        await this.dispatcher.dispatch(summary, batch.subscription, "next_turn", origin?.channel);
    }
    seenFor(subscriptionName) {
        const existing = this.seenBySubscription.get(subscriptionName);
        if (existing)
            return existing;
        const created = new SeenMessageIds(this.dedupCapacity);
        this.seenBySubscription.set(subscriptionName, created);
        return created;
    }
    transportFor(subscription) {
        const transport = this.transportByName.get(subscription.name);
        if (!transport)
            throw new AceConfigError(`subscribe "${subscription.name}" has no transport`);
        return transport;
    }
    async deliver(raw, subscription, receivedAt) {
        try {
            await this.handleRawMessage(raw, subscription, receivedAt);
        }
        catch (error) {
            if (error instanceof AceValidationError) {
                const fields = error.issues.map((issue) => issue.path || "<message>").join(",");
                this.logger.warn?.(`[ACE] rejected subscribe=${subscription.name} fields=${fields}`);
                return;
            }
            throw error;
        }
    }
}
//# sourceMappingURL=ace-runtime.js.map