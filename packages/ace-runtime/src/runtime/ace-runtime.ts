import type { AgentEngine } from "../agent/agent-engine.ts";
import type { AceLogger } from "../logger.ts";
import type { ConcreteActivation } from "../protocol/ace-message.ts";
import { AceValidationError, decodeAceMessage } from "../protocol/validator.ts";
import type { Transport } from "../transport/transport.ts";
import { DEFAULT_RUNTIME_ACTIVATION, resolveActivation } from "./activation-resolver.ts";
import { AceConfigError, type EndpointConfig, validateEndpointConfig } from "./endpoint-config.ts";
import { type DispatchResult, EventDispatcher } from "./event-dispatcher.ts";
import { type PendingAceEvent, PendingEventStore } from "./pending-event-store.ts";

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
 * is the boundary between a transport and an agent engine.
 */
export class AceRuntime {
	private readonly engine: AgentEngine;
	private readonly subscribe: readonly EndpointConfig[];
	private readonly transportByName: ReadonlyMap<string, Transport>;
	private readonly defaultActivation: ConcreteActivation;
	private readonly logger: AceLogger;
	private readonly pendingEventStore = new PendingEventStore();
	private readonly dispatcher: EventDispatcher;
	private started = false;

	constructor(options: AceRuntimeOptions) {
		this.subscribe = options.subscribe.map((endpoint) => validateEndpointConfig(endpoint, "subscribe"));

		const transportByName = new Map<string, Transport>();
		const usedTransports = new Set<Transport>();
		for (const subscription of this.subscribe) {
			if (transportByName.has(subscription.name)) {
				throw new AceConfigError(`subscribe name "${subscription.name}" is configured twice`);
			}
			const transport = options.transports[subscription.name];
			if (!transport) {
				throw new AceConfigError(
					`subscribe "${subscription.name}" has no transport registered under its name (registered: ${
						Object.keys(options.transports).join(", ") || "none"
					})`,
				);
			}
			if (usedTransports.has(transport)) {
				throw new AceConfigError(
					`transport of subscribe "${subscription.name}" is already used by another subscription; its messages would be delivered twice`,
				);
			}
			usedTransports.add(transport);
			transportByName.set(subscription.name, transport);
		}

		this.engine = options.engine;
		this.transportByName = transportByName;
		this.defaultActivation = options.defaultActivation ?? DEFAULT_RUNTIME_ACTIVATION;
		this.logger = options.logger ?? {};
		this.dispatcher = new EventDispatcher(this.engine, this.pendingEventStore, this.logger);
	}

	/** Connect every subscription's transport (RFC §33). */
	async start(): Promise<void> {
		if (this.started) throw new AceConfigError("ACE runtime is already started");
		this.started = true;
		try {
			for (const subscription of this.subscribe) {
				await this.transportFor(subscription).start((raw) => this.deliver(raw, subscription));
			}
		} catch (error) {
			// Do not claim to be started when a transport refused to connect.
			this.started = false;
			throw error;
		}
		this.logger.info?.(
			`[ACE] runtime started subscribe=${this.subscribe.map((endpoint) => endpoint.name).join(",")} defaultActivation=${this.defaultActivation}`,
		);
	}

	/** Disconnect transports and wait for the agent engine to settle (RFC §33). */
	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		for (const subscription of this.subscribe) {
			await this.transportFor(subscription).stop();
		}
		await this.engine.waitForIdle();
		this.logger.info?.("[ACE] runtime stopped");
	}

	/**
	 * Full ACE path for one raw message.
	 *
	 * Throws {@link AceValidationError} for non-conforming messages. The
	 * transport-facing path ({@link start}) logs and drops those instead, and
	 * lets other errors propagate so the transport can retry or dead-letter
	 * (design doc §30).
	 */
	async handleRawMessage(raw: unknown, subscription: EndpointConfig): Promise<AceHandleResult> {
		const message = decodeAceMessage(raw);
		const activation = resolveActivation(message, subscription, this.defaultActivation);
		this.logger.info?.(`[ACE] received id=${message.id} sender=${message.sender} subscribe=${subscription.name}`);
		const result = await this.dispatcher.dispatch(message, subscription.name, activation);
		return { ...result, subscriptionName: subscription.name };
	}

	/** Handle a raw message addressed to a configured subscription by name. */
	async handleMessage(raw: unknown, subscriptionName: string): Promise<AceHandleResult> {
		const subscription = this.subscribe.find((candidate) => candidate.name === subscriptionName);
		if (!subscription) throw new AceConfigError(`unknown subscription "${subscriptionName}"`);
		return this.handleRawMessage(raw, subscription);
	}

	/** Events retained for `manual` activation (RFC §7.3, §12). */
	get pendingEvents(): readonly PendingAceEvent[] {
		return this.pendingEventStore.list();
	}

	/**
	 * Explicitly activate a retained `manual` event.
	 *
	 * ACE 0.1 leaves the trigger to the runtime or user (§7.3); this is that
	 * runtime control hook. Identity is `(sender, id)` (RFC §5.2).
	 */
	async activatePendingEvent(sender: string, id: string): Promise<void> {
		const event = this.pendingEventStore.take(sender, id);
		if (!event) {
			throw new Error(`No pending ACE event for sender="${sender}" id="${id}"`);
		}
		this.logger.info?.(`[ACE] activating id=${id} sender=${sender} subscribe=${event.subscriptionName}`);
		await this.engine.inject(event.message, "next_turn");
	}

	private transportFor(subscription: EndpointConfig): Transport {
		const transport = this.transportByName.get(subscription.name);
		if (!transport) throw new AceConfigError(`subscribe "${subscription.name}" has no transport`);
		return transport;
	}

	private async deliver(raw: unknown, subscription: EndpointConfig): Promise<void> {
		try {
			await this.handleRawMessage(raw, subscription);
		} catch (error) {
			if (error instanceof AceValidationError) {
				const fields = error.issues.map((issue) => issue.path || "<message>").join(",");
				this.logger.warn?.(`[ACE] rejected subscribe=${subscription.name} fields=${fields}`);
				return;
			}
			throw error;
		}
	}
}
