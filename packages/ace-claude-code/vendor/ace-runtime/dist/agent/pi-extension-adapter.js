import { eventIdentity, renderAceEvent } from "./event-rendering.js";
const DEFAULT_DELIVERY_TIMEOUT_MS = 30_000;
/** How many event identities this adapter trusts as already handed to the host (bounded FIFO). */
const DEFAULT_HANDED_CAPACITY = 1024;
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
 * | queued | `deliverAs: "aside"` / `"followUp"` | no wall clock — wait for the observation; the transport's `reclaimAttempts`/`reclaimIdleMs` bounds the retry |
 * | bounded | prompt path (no `deliverAs`), `steer` | fail after `deliveryTimeoutMs` (default 30s), so the entry stays pending and reclaim can redeliver it |
 *
 * A queued delivery surfaces at the next step boundary, and a model turn lasts as long as it lasts —
 * its surface time is not knowable, so a wall clock there would fail a delivery that already
 * succeeded (`sendUserMessage` returned; the message is queued and will surface). The paths where
 * the host is expected to surface the event in the current turn keep the timeout, which is the
 * only signal that the host dropped it.
 *
 * Deviations from {@link AgentEngine}: `waitForIdle` resolves immediately, because a session
 * shutdown must never block the interactive UI on a live turn.
 */
export class PiExtensionAdapter {
    pi;
    isIdle;
    renderEvent;
    host;
    observeDelivery;
    deliveryTimeoutMs;
    setTimer;
    logger;
    /** Identities already handed to the host, in insertion order (`Map` keeps it), FIFO-bounded. */
    handed = new Map();
    handedCapacity = DEFAULT_HANDED_CAPACITY;
    runErrorListeners = [];
    constructor(options) {
        this.pi = options.pi;
        this.isIdle = options.isIdle ?? (() => true);
        this.renderEvent = options.renderEvent ?? renderAceEvent;
        this.host = { supportsAside: options.host?.supportsAside ?? false };
        this.observeDelivery = options.observeDelivery;
        this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
        this.logger = options.logger ?? {};
        this.setTimer =
            options.setTimer ?? ((callback, ms) => ({ cancel: clearTimeout.bind(undefined, setTimeout(callback, ms)) }));
    }
    async inject(message, mode, context) {
        const deliverAs = this.deliveryFor(mode);
        // Render first, then observe with the very text we send: the header can depend on the directory,
        // so re-rendering later would not necessarily produce the same string.
        const text = this.renderEvent(message, context);
        const identity = eventIdentity(message, context);
        // A queued delivery surfaces at the next step boundary, so it has no knowable surface time and
        // carries no wall clock (`awaitDelivery`); the prompt path and `steer` surface in the current turn.
        const queued = deliverAs === "aside" || deliverAs === "followUp";
        // A redelivery of an event this host already received: re-attach to the observation only, never
        // call `sendUserMessage` again. The record is "handed to the host", which a redelivery cannot undo.
        const alreadyHanded = this.handed.get(identity);
        if (alreadyHanded !== undefined) {
            this.logger.info?.(`[ACE] suppressing duplicate injection id=${message.id} sender=${message.sender} subscribe=${context?.subscription ?? ""}`);
            // If the observation already landed there is nothing left to wait for.
            if (alreadyHanded.observed || this.observeDelivery === undefined)
                return;
            // Re-wait under the *recorded* delivery's rule, not a freshly computed one: the agent state may
            // have changed since the original send, and the pending entry was queued the way it was queued.
            await this.awaitDelivery(message, identity, this.observeDelivery.observe(message, text), text, alreadyHanded.queued);
            return;
        }
        // Start observing before sending: a host may deliver synchronously.
        const observed = this.observeDelivery?.observe(message, text);
        try {
            this.pi.sendUserMessage(text, deliverAs === undefined ? undefined : { deliverAs });
        }
        catch (error) {
            // Drop the observation we will never satisfy; its promise must not stay unhandled.
            void observed?.catch(() => { });
            this.observeDelivery?.release?.(message, text);
            throw error;
        }
        // Handed to the host, before the delivery wait and never rolled back — the send already happened.
        this.remember(identity, queued);
        if (observed)
            await this.awaitDelivery(message, identity, observed, text, queued);
    }
    /** The delivery this host understands for the event's urgency and the agent's state. */
    deliveryFor(mode) {
        const running = this.isRunning();
        if (mode === "next_turn") {
            // `aside` carries both states on its own: queued at the next step boundary while running,
            // a turn of its own while idle. Upstream Pi has no `aside`; there an idle agent needs the
            // prompt path, and only a running one may be queued.
            return this.host.supportsAside ? "aside" : running ? "followUp" : undefined;
        }
        return running ? "steer" : undefined;
    }
    /**
     * Wait for the observation. A queued delivery waits without a wall clock (its surface time is the
     * next step boundary and not knowable); a bounded one fails after {@link deliveryTimeoutMs} so the
     * broker keeps the entry pending for reclaim.
     */
    async awaitDelivery(message, identity, observed, text, queued) {
        const settled = observed.then(() => {
            // A record evicted meanwhile is simply gone; nothing to mark.
            const record = this.handed.get(identity);
            if (record !== undefined)
                record.observed = true;
        });
        if (queued) {
            await settled;
            return;
        }
        let timer;
        const timeout = new Promise((resolve) => {
            timer = this.setTimer(() => resolve("timeout"), this.deliveryTimeoutMs);
        });
        const outcome = await Promise.race([settled.then(() => "observed"), timeout]);
        timer?.cancel();
        if (outcome === "timeout") {
            this.observeDelivery?.release?.(message, text);
            throw new Error(`injected event id=${message.id} sender=${message.sender} was not observed in the conversation within ${this.deliveryTimeoutMs}ms`);
        }
    }
    /** Record an identity as handed to the host, evicting the oldest past the capacity. */
    remember(identity, queued) {
        this.handed.set(identity, { observed: false, queued });
        if (this.handed.size > this.handedCapacity) {
            const oldest = this.handed.keys().next();
            if (!oldest.done)
                this.handed.delete(oldest.value);
        }
    }
    /** Listeners the runtime registers to count failed runs. */
    onRunError(listener) {
        this.runErrorListeners.push(listener);
    }
    /**
     * Report a failed turn the host surfaced as an event (`turn_end` with a failure stop reason).
     *
     * The extension adapter cannot see turn outcomes on its own — it only hands messages over — so the
     * extension watches the host's events and calls this.
     */
    reportRunFailure(error) {
        for (const listener of this.runErrorListeners) {
            try {
                listener(error);
            }
            catch {
                // A failing listener must not take down the session.
            }
        }
    }
    isRunning() {
        return !this.isIdle();
    }
    async waitForIdle() { }
}
/**
 * Detect the host's delivery behavior.
 *
 * `pi.pi` is oh-my-pi's self-reference to its SDK namespace (`extensions/types.ts:1375`); upstream
 * Pi's `ExtensionAPI` has no such field. Probes are how capability gaps get found in practice, so
 * `ACE_DELIVERY=aside|portable` overrides the guess when a host changes its surface.
 */
export function detectHostDelivery(pi) {
    const override = process.env.ACE_DELIVERY;
    if (override === "aside")
        return { supportsAside: true };
    if (override === "portable")
        return { supportsAside: false };
    const marker = pi !== null && typeof pi === "object" && "pi" in pi ? pi.pi : undefined;
    return { supportsAside: marker !== undefined };
}
//# sourceMappingURL=pi-extension-adapter.js.map