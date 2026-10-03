import type { AgentEngine } from "../agent/agent-engine.ts";
import type { AceLogger } from "../logger.ts";
import type { AceMessage, ConcreteActivation } from "../protocol/ace-message.ts";
import { AceValidationError, decodeAceMessage } from "../protocol/validator.ts";
import type { Transport } from "../transport/transport.ts";
import { DEFAULT_RUNTIME_ACTIVATION, resolveActivation } from "./activation-resolver.ts";
import { AceConfigError, type EndpointConfig, endpointAddress, validateEndpointConfig } from "./endpoint-config.ts";
import { type DispatchResult, EventDispatcher } from "./event-dispatcher.ts";
import {
	DEFAULT_SPOOL_RULE,
	EventSpool,
	type EventSpoolOptions,
	type SpooledBatch,
	type SpoolRule,
} from "./event-spool.ts";
import { AceMetrics } from "./metrics.ts";
import { PendingEventStore } from "./pending-event-store.ts";
import { SeenMessageIds } from "./seen-message-ids.ts";

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
	manual?: { max?: number; ttlMs?: number };
	/** Burst handling: where spool files go. Thresholds are built in (`DEFAULT_SPOOL_RULE`) unless overridden here. */
	spool?: Omit<EventSpoolOptions, "onBatch" | "onError" | "logger" | "rules"> & { rule?: SpoolRule };
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
export class AceRuntime {
	readonly metrics: AceMetrics;

	private readonly engine: AgentEngine;
	private readonly subscribe: readonly EndpointConfig[];
	private readonly transportByName: ReadonlyMap<string, Transport>;
	private readonly defaultActivation: ConcreteActivation;
	private readonly logger: AceLogger;
	private readonly pendingEventStore: PendingEventStore;
	private readonly dispatcher: EventDispatcher;
	private readonly seenBySubscription = new Map<string, SeenMessageIds>();
	private readonly dedupCapacity: number;
	private readonly spool: EventSpool | undefined;
	private readonly now: () => number;
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
		this.metrics = options.metrics ?? new AceMetrics();
		this.dedupCapacity = options.dedupCapacity ?? 1024;
		this.now = options.now ?? (() => Date.now());
		if (options.spool) {
			const { rule, ...spoolOptions } = options.spool;
			this.spool = new EventSpool({
				...spoolOptions,
				now: this.now,
				rules: () => rule ?? DEFAULT_SPOOL_RULE,
				onBatch: (batch) => this.summarizeBatch(batch),
				logger: this.logger,
				onError: (error) =>
					this.logger.error?.(`[ACE] spool error: ${error instanceof Error ? error.message : String(error)}`),
			});
		} else {
			this.spool = undefined;
		}

		this.pendingEventStore = new PendingEventStore({
			now: this.now,
			...(options.manual?.max === undefined ? {} : { max: options.manual.max }),
			...(options.manual?.ttlMs === undefined ? {} : { ttlMs: options.manual.ttlMs }),
			...(this.spool ? { persist: (event) => this.spool?.appendManual(event.subscriptionName, event.message) } : {}),
			onEvict: (event, reason) =>
				this.logger.warn?.(`[ACE] dropped pending manual event id=${event.message.id} (${reason})`),
		});
		this.restorePendingEvents();

		this.dispatcher = new EventDispatcher(this.engine, this.pendingEventStore, this.logger, this.metrics);
		// Failures arrive after the fact and without saying which event was in flight, so they are
		// counted at runtime scope rather than charged to a subscription.
		this.engine.onRunError?.((error) => this.recordRunFailure(error));
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

	/** Disconnect transports, flush open spool windows, and wait for the engine to settle (RFC §33). */
	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		for (const subscription of this.subscribe) {
			await this.transportFor(subscription).stop();
		}
		if (this.spool) await this.spool.flush();
		await this.engine.waitForIdle();
	}

	/**
	 * Full ACE path for one raw message: validate → dedup → activation → burst policy → dispatch.
	 *
	 * Throws {@link AceValidationError} for non-conforming messages. The transport-facing path
	 * ({@link start}) logs and drops those instead, and lets other errors propagate so the transport
	 * can retry or dead-letter (design doc §30).
	 */
	async handleRawMessage(raw: unknown, subscription: EndpointConfig): Promise<AceHandleResult> {
		this.metrics.increment(subscription.name, "received");

		let message: AceMessage;
		try {
			message = decodeAceMessage(raw);
		} catch (error) {
			if (error instanceof AceValidationError) this.metrics.increment(subscription.name, "rejected");
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

		const result = await this.dispatcher.dispatch(
			message,
			subscription.name,
			activation,
			endpointAddress(subscription),
		);
		// Remember only now: a failed delivery must stay eligible for redelivery.
		seen.remember(message.sender, message.id);
		return { ...result, subscriptionName: subscription.name };
	}

	/** Handle a raw message addressed to a configured subscription by name. */
	async handleMessage(raw: unknown, subscriptionName: string): Promise<AceHandleResult> {
		const subscription = this.subscribe.find((candidate) => candidate.name === subscriptionName);
		if (!subscription) throw new AceConfigError(`unknown subscription "${subscriptionName}"`);
		return this.handleRawMessage(raw, subscription);
	}

	/** Events retained for `manual` activation (RFC §7.3, §12). */
	get pendingEvents(): ReturnType<PendingEventStore["list"]> {
		return this.pendingEventStore.list();
	}

	/**
	 * Explicitly activate a retained `manual` event.
	 *
	 * ACE 0.1 leaves the trigger to the runtime or user (§7.3); this is that runtime control hook.
	 * Identity is `(sender, id)` (RFC §5.2).
	 */
	async activatePendingEvent(sender: string, id: string): Promise<void> {
		const event = this.pendingEventStore.take(sender, id);
		if (!event) {
			throw new Error(`No pending ACE event for sender="${sender}" id="${id}"`);
		}
		this.logger.info?.(`[ACE] activating id=${id} sender=${sender} subscribe=${event.subscriptionName}`);
		const origin = this.subscribe.find((entry) => entry.name === event.subscriptionName);
		await this.engine.inject(event.message, "next_turn", {
			subscription: event.subscriptionName,
			...(origin === undefined ? {} : { address: endpointAddress(origin) }),
		});
	}

	/** A turn this runtime started ended in failure; counted for `/ace stats` and logged. */
	recordRunFailure(error: unknown): void {
		this.metrics.increment("runtime", "runFailed");
		this.logger.warn?.(`[ACE] agent run failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	/** Open spool windows, for `/ace stats`. */
	openSpoolWindows(): ReturnType<EventSpool["openWindows"]> {
		return this.spool?.openWindows() ?? [];
	}

	/** Restore `manual` events persisted by an earlier session. */
	private restorePendingEvents(): void {
		const spool = this.spool;
		if (!spool) return;
		for (const subscription of this.subscribe) {
			const messages = spool.loadManual(subscription.name);
			if (messages.length === 0) continue;
			const restored = this.pendingEventStore.restore(subscription.name, messages);
			this.logger.info?.(`[ACE] restored ${restored} pending manual event(s) subscribe=${subscription.name}`);
		}
	}

	/** Inject one summary event for a spooled burst. */
	private async summarizeBatch(batch: SpooledBatch): Promise<void> {
		const first = batch.events[0];
		const last = batch.events[batch.events.length - 1];
		const senders = [...new Set(batch.events.map((message) => message.sender))].join(", ");
		const preview = batch.events
			.slice(0, 3)
			.map((message) => `- ${message.id} from ${message.sender}: ${message.body.slice(0, 120).replace(/\s+/g, " ")}`)
			.join("\n");
		const summary: AceMessage = {
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
		await this.dispatcher.dispatch(
			summary,
			batch.subscription,
			"next_turn",
			origin === undefined ? undefined : endpointAddress(origin),
		);
	}

	private seenFor(subscriptionName: string): SeenMessageIds {
		const existing = this.seenBySubscription.get(subscriptionName);
		if (existing) return existing;
		const created = new SeenMessageIds(this.dedupCapacity);
		this.seenBySubscription.set(subscriptionName, created);
		return created;
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
