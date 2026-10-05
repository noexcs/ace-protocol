/** Routes an ACE message according to its effective activation (RFC §7, §19). */
export class EventDispatcher {
    engine;
    pendingEvents;
    logger;
    metrics;
    /** This session's own sender names: a message from one of them is its own event echoed back. */
    selfSenders;
    constructor(engine, pendingEvents, logger = {}, metrics, selfSenders = new Set()) {
        this.engine = engine;
        this.pendingEvents = pendingEvents;
        this.logger = logger;
        this.metrics = metrics;
        this.selfSenders = selfSenders;
    }
    async dispatch(message, subscriptionName, activation, 
    /** Uploaded channel name the event arrived on, for the header; the subscription label when absent. */
    channel, 
    /** Broker arrival time (epoch ms UTC) when the transport exposes one; the header omits the line otherwise. */
    receivedAt) {
        if (activation === "manual") {
            this.pendingEvents.store(message, subscriptionName);
            this.metrics?.increment(subscriptionName, "stored");
            this.logger.info?.(`[ACE] stored id=${message.id} sender=${message.sender} subscribe=${subscriptionName} activation=manual`);
            return { activation, disposition: "stored" };
        }
        const running = this.engine.isRunning();
        this.logger.info?.(`[ACE] injecting id=${message.id} sender=${message.sender} subscribe=${subscriptionName} activation=${activation} agent=${running ? "running" : "idle"}`);
        await this.engine.inject(message, activation, {
            subscription: subscriptionName,
            ...(channel === undefined ? {} : { channel }),
            // The header's `activation:` line is the sender's *request*, not the effective activation
            // resolved below (RFC §7): the block must not read as a confirmation of the latter.
            activation: message.activation,
            ...(receivedAt === undefined ? {} : { receivedAt }),
            ...(this.selfSenders.has(message.sender) ? { self: true } : {}),
        });
        this.metrics?.increment(subscriptionName, running ? "queued" : "injected");
        return { activation, disposition: running ? "queued" : "injected" };
    }
}
//# sourceMappingURL=event-dispatcher.js.map