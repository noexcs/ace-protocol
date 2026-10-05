import { renderAceEvent } from "./pi-adapter.js";
const DEFAULT_DELIVERY_TIMEOUT_MS = 30_000;
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
    runErrorListeners = [];
    constructor(options) {
        this.pi = options.pi;
        this.isIdle = options.isIdle ?? (() => true);
        this.renderEvent = options.renderEvent ?? renderAceEvent;
        this.host = { supportsAside: options.host?.supportsAside ?? false };
        this.observeDelivery = options.observeDelivery;
        this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
        this.setTimer =
            options.setTimer ?? ((callback, ms) => ({ cancel: clearTimeout.bind(undefined, setTimeout(callback, ms)) }));
    }
    async inject(message, mode, context) {
        const deliverAs = this.deliveryFor(mode);
        // Render first, then observe with the very text we send: the header can depend on the directory,
        // so re-rendering later would not necessarily produce the same string.
        const text = this.renderEvent(message, context);
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
        if (observed)
            await this.awaitDelivery(message, observed);
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
    /** Fail loudly when the host never surfaced the event, so the broker keeps it pending. */
    async awaitDelivery(message, observed) {
        let timer;
        const timeout = new Promise((resolve) => {
            timer = this.setTimer(() => resolve("timeout"), this.deliveryTimeoutMs);
        });
        const outcome = await Promise.race([observed.then(() => "observed"), timeout]);
        timer?.cancel();
        if (outcome === "timeout") {
            this.observeDelivery?.release?.(message);
            throw new Error(`injected event id=${message.id} sender=${message.sender} was not observed in the conversation within ${this.deliveryTimeoutMs}ms`);
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