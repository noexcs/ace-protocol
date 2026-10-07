/**
 * One live agent's ACE session: the transport, the directory entry, and the runtime, as one lifecycle.
 *
 * Pi is one process per session, so its host can keep the runtime in a module global. DeepSeek Harness is
 * one process for many sessions, and a session's channel *is* its address — so the runtime is per agent
 * and lives exactly as long as the agent does. {@link AceSession.open} is the whole of "this session is
 * reachable now", {@link AceSession.stop} the whole of "it is not", and those are the host's only calls.
 *
 * Start-up order is the core's, not an accident: the directory entry is created **after** the consumer
 * group exists (the registry creates the group at the tail first), so an event published the instant a
 * peer sees the address is still pending for the consumer `runtime.start()` creates a moment later.
 * Shutdown order is the core's too — reader, then directory, then clients (`shutdownAce`).
 *
 * **Live channels only.** A session reads its own inbox — the channel named by its sender — and nothing
 * else. Topic and service channels (`.ace.json` `subscribe`) are not part of this host; they are reported
 * as a warning rather than dropped silently.
 */

import { join } from "node:path";
import {
	type AceLogger,
	type AceMessage,
	AceMetrics,
	AceRuntime,
	type AgentEngine,
	AgentRegistry,
	type AgentRegistryStore,
	channelStreamKey,
	createRedisAgentRegistry,
	createRedisStreamsAddClient,
	createRedisXferClient,
	createTransports,
	DeadLetterSink,
	type DroppedEntry,
	describeSender,
	type EndpointConfig,
	hostFacts,
	REDIS_STREAMS_DEFAULTS,
	type RedisStreamsAddClient,
	type RedisXferClient,
	type RegistryEntry,
	type ResolvedAceConfig,
	type ResolvedServer,
	SESSION_INBOX,
	senderName,
	serverAddress,
	shutdownAce,
	subscriptionEndpoint,
	type TargetServer,
	type Transport,
	type XferTarget,
} from "../vendor/ace-runtime/dist/index.js";

/** What one server this session is live on holds: the directory entry and the clients derived from it. */
interface AceServerLink {
	readonly server: ResolvedServer;
	/** This session's channel on that server — also the group its inbox is read in. */
	readonly sender: string;
	readonly registry: AgentRegistry;
	addClient?: RedisStreamsAddClient;
	xferClient?: RedisXferClient;
}

/** A configured server that did not come up. */
interface UnavailableServer {
	readonly name: string;
	readonly address: string;
}

/** The four host-side constructions one session needs; injectable so tests run without a broker. */
export interface AceFactories {
	registryStore(server: ResolvedServer, onError: (error: unknown) => void): AgentRegistryStore;
	transports(
		endpoints: readonly EndpointConfig[],
		onError: (error: unknown) => void,
		onNotice: (message: string) => void,
		onDropped: (subscription: string, entry: DroppedEntry) => void | Promise<void>,
	): Record<string, Transport>;
	addClient(url: string, onError: (error: unknown) => void): RedisStreamsAddClient;
	xferClient(server: ResolvedServer, onError: (error: unknown) => void): RedisXferClient;
}

/** The Redis implementations, used unless a caller injects its own. */
export const REDIS_FACTORIES: AceFactories = {
	registryStore: (server, onError) =>
		createRedisAgentRegistry({ url: server.url, namespace: server.namespace, onError }),
	transports: (endpoints, onError, onNotice, onDropped) =>
		createTransports(endpoints, { onError, onNotice, onDropped }),
	addClient: (url, onError) => createRedisStreamsAddClient(url, onError),
	xferClient: (server, onError) => createRedisXferClient({ url: server.url, name: `${server.name}:xfer`, onError }),
};

export interface AceSessionOptions {
	/** The engine that receives events: one per agent. */
	engine: AgentEngine;
	/** Configuration resolved from the agent's working directory. */
	config: ResolvedAceConfig;
	sessionId: string;
	/** What this session is, for the channel name's third segment (`dsh`) and its directory description. */
	codingAgent: string;
	/** Session working directory: the file-transfer root and what the directory entry reports. */
	cwd: string;
	logger?: AceLogger;
	/** Dead-letter sink shared with the transports; `open()` creates it, tests may inject one. */
	deadLetters?: DeadLetterSink;
	/** A problem that must not take the session down (an unreachable server, a failed heartbeat). */
	onProblem?: (message: string, error?: unknown) => void;
	factories?: Partial<AceFactories>;
}

/** One live ACE session: its runtime, its directory entries, and the clients they need. */
export class AceSession {
	readonly config: ResolvedAceConfig;
	readonly sessionId: string;
	readonly codingAgent: string;
	readonly cwd: string;
	readonly runtime: AceRuntime;
	private readonly metrics: AceMetrics;
	private readonly links: AceServerLink[];
	private readonly unavailable: UnavailableServer[];
	private readonly endpoints: EndpointConfig[];
	private readonly options: AceSessionOptions;
	private readonly factories: AceFactories;
	/** Directory, transport and client errors arrive here as a bare error, with their subject supplied. */
	private readonly onError: (error: unknown) => void;
	private closed = false;

	private constructor(
		config: ResolvedAceConfig,
		sessionId: string,
		codingAgent: string,
		cwd: string,
		runtime: AceRuntime,
		metrics: AceMetrics,
		links: AceServerLink[],
		unavailable: UnavailableServer[],
		endpoints: EndpointConfig[],
		options: AceSessionOptions,
	) {
		this.config = config;
		this.sessionId = sessionId;
		this.codingAgent = codingAgent;
		this.cwd = cwd;
		this.runtime = runtime;
		this.metrics = metrics;
		this.links = links;
		this.unavailable = unavailable;
		this.endpoints = endpoints;
		this.options = options;
		this.factories = { ...REDIS_FACTORIES, ...options.factories };
		this.onError = (error: unknown): void => this.problem("[ace] the broker reported a problem", error);
	}

	/**
	 * Bring one session up: register every configured server in the directory, then start reading.
	 *
	 * A server that cannot be reached is skipped and reported, and a session with no server at all still
	 * exists — its tools answer `noDirectory` — rather than taking the agent down with it. Nothing here
	 * throws.
	 */
	static async open(options: AceSessionOptions): Promise<AceSession> {
		const factories: AceFactories = { ...REDIS_FACTORIES, ...options.factories };
		const problem = options.onProblem ?? ((): void => {});
		/** The core's registry and transport hooks take a bare error; the subject is added here. */
		const onError = (error: unknown): void => problem("[ace] the broker reported a problem", error);
		// Entries the reader gives up on are written down before they leave the PEL, in the same `.ace/`
		// the Pi host uses. Nothing is written until an entry is actually given up on.
		const deadLetters = new DeadLetterSink({
			dir: join(options.cwd, ".ace"),
			...(options.logger === undefined ? {} : { logger: options.logger }),
			onError: (error) => problem("[ace] could not write a dead letter", error),
		});
		const links: AceServerLink[] = [];
		const unavailable: UnavailableServer[] = [];
		const metrics = new AceMetrics();

		for (const server of options.config.servers) {
			const sender = senderName({
				namespace: server.namespace,
				username: options.config.username,
				codingAgent: options.codingAgent,
				sessionId: options.sessionId,
			});
			const registry = new AgentRegistry({
				store: factories.registryStore(server, onError),
				namespace: server.namespace,
				...(options.logger === undefined ? {} : { logger: options.logger }),
				onError,
			});
			try {
				// The group is created here, before the entry that makes this session addressable exists.
				await registry.register({
					sender,
					codingAgent: options.codingAgent,
					sessionId: options.sessionId,
					cwd: options.cwd,
				});
			} catch (error) {
				await registry.close().catch(() => {});
				unavailable.push({ name: server.name, address: serverAddress(server.url) });
				problem(`[ace] server "${server.name}" is unreachable; this session is not live on it`, error);
				continue;
			}
			links.push({ server, sender, registry });
		}

		const multi = links.length > 1;
		const endpoints: EndpointConfig[] = links.map((link) =>
			subscriptionEndpoint({
				channel: link.sender,
				name: multi ? `${link.server.name}:${SESSION_INBOX}` : SESSION_INBOX,
				url: link.server.url,
				namespace: link.server.namespace,
				sender: link.sender,
				description: "this session's inbox — the channel named by its sender",
			}),
		);

		const runtime = new AceRuntime({
			engine: options.engine,
			metrics,
			subscribe: endpoints,
			manual: options.config.manual,
			selfSenders: links.map((link) => link.sender),
			transports: factories.transports(
				endpoints,
				onError,
				(message) => problem(message),
				(subscription, entry) => deadLetters.record(subscription, entry),
			),
			...(options.config.defaultActivation === undefined
				? {}
				: { defaultActivation: options.config.defaultActivation }),
			...(options.logger === undefined ? {} : { logger: options.logger }),
		});

		const session = new AceSession(
			options.config,
			options.sessionId,
			options.codingAgent,
			options.cwd,
			runtime,
			metrics,
			links,
			unavailable,
			endpoints,
			{ ...options, deadLetters },
		);

		if (endpoints.length > 0) {
			try {
				await runtime.start();
			} catch (error) {
				// We could not read, so we must not stay addressable: withdraw every entry and report the session
				// as not live, rather than leaving an address that silently swallows events.
				problem("[ace] could not start reading this session's channels", error);
				for (const link of links) {
					await link.registry.unregister().catch(() => {});
					await link.registry.close().catch(() => {});
					unavailable.push({ name: link.server.name, address: serverAddress(link.server.url) });
				}
				links.length = 0;
			}
		}

		for (const warning of options.config.warnings) problem(`[ace] config warning: ${warning}`);
		if (options.config.subscriptions.length > 0) {
			// Live channels only: a configured subscription names a persistent (topic/service) channel, which this
			// host does not read. Saying so is the point — a silently dropped subscription loses events.
			problem(
				`[ace] .ace.json lists ${options.config.subscriptions.length} subscription(s) (${options.config.subscriptions
					.map((subscription) => `"${subscription.channel}"`)
					.join(
						", ",
					)}); this host reads live channels only, so they are ignored — direct messages to this session still arrive`,
			);
		}
		return session;
	}

	private problem(message: string, error?: unknown): void {
		(this.options.onProblem ?? ((): void => {}))(message, error);
	}

	/** This session's channel on each server it is live on; empty when no server came up. */
	get senders(): readonly string[] {
		return this.links.map((link) => link.sender);
	}

	/** The servers this session is actually live on. */
	get servers(): readonly ResolvedServer[] {
		return this.links.map((link) => link.server);
	}

	/**
	 * Every server the session was configured with, live or not.
	 *
	 * This is what target resolution needs for the `<server>:` prefix: a name that matches a configured
	 * but unreachable server must fail loudly ("did not come up") instead of being mistaken for a plain
	 * channel name and stored on whichever server happens to be live.
	 */
	get configuredServers(): readonly ResolvedServer[] {
		return this.options.config.servers;
	}

	/** What the dead-letter sink holds, for the human report. */
	get deadLetterSummary(): { count: number; directory?: string } {
		const sink = this.options.deadLetters;
		return sink === undefined ? { count: 0 } : { count: sink.count, directory: sink.directory };
	}

	/** Configured servers that did not come up, for the human report. */
	get unavailableServers(): readonly UnavailableServer[] {
		return this.unavailable;
	}

	/** Whether this session is reachable on at least one server. */
	get live(): boolean {
		return this.links.length > 0;
	}

	/** Counter snapshot for the human report. */
	metricsSnapshot(): ReturnType<AceMetrics["snapshot"]> {
		return this.metrics.snapshot();
	}

	/** What this session says about itself in every event it publishes. */
	senderDescription(): string {
		return describeSender(hostFacts({ codingAgent: this.codingAgent, sessionId: this.sessionId, cwd: this.cwd }));
	}

	/** The channels this session reads: its own inboxes, used by `ace_publish`'s reader checks. */
	readChannels(): string[] {
		return [...this.senders];
	}

	/** The bindings behind those channels, for the human report's channel rows. */
	readEndpoints(): readonly EndpointConfig[] {
		return this.endpoints;
	}

	/** The registry view `resolveChannelTarget` resolves a target against, one entry per live server. */
	targetServers(): TargetServer[] {
		return this.links.map((link) => ({
			server: link.server,
			sender: link.sender,
			list: () => link.registry.list(),
		}));
	}

	/** Live directory entries across every server, for `ace_agents` and `/ace`. */
	async listPeers(): Promise<Array<{ server: string; entry: RegistryEntry }>> {
		const rows: Array<{ server: string; entry: RegistryEntry }> = [];
		for (const link of this.links) {
			try {
				for (const entry of await link.registry.list()) rows.push({ server: link.server.name, entry });
			} catch (error) {
				this.problem(`[ace] could not read the directory on "${link.server.name}"`, error);
			}
		}
		return rows;
	}

	/** Write one event to a channel stream: the storage half of `ace_publish`. */
	async store(serverName: string, channel: string, message: AceMessage): Promise<void> {
		const link = this.links.find((candidate) => candidate.server.name === serverName);
		if (link === undefined) throw new Error(`server "${serverName}" is not live in this session`);
		link.addClient ??= this.factories.addClient(link.server.url, this.onError);
		await link.addClient.add(
			channelStreamKey(link.server.namespace, channel),
			REDIS_STREAMS_DEFAULTS.field,
			JSON.stringify(message),
		);
	}

	/** The file-transfer targets `ace_store_file`/`ace_get_file` work against: one per live server. */
	xferTargets(): XferTarget[] {
		return this.links.map((link) => {
			link.xferClient ??= this.factories.xferClient(link.server, this.onError);
			return { name: link.server.name, namespace: link.server.namespace, client: link.xferClient };
		});
	}

	/**
	 * Leave: the reader stops first, then each directory entry and its stream go away, then the clients.
	 * Idempotent — a session that lost the race with its own start still gets here.
	 */
	async stop(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await shutdownAce({
			runtime: this.runtime,
			onError: (step, error) => this.problem(`[ace] ${step} failed while closing`, error),
		});
		for (const link of this.links) {
			await shutdownAce({
				registry: link.registry,
				onError: (step, error) => this.problem(`[ace] ${step} failed on "${link.server.name}"`, error),
			});
			await link.addClient?.close().catch((error) => this.problem("[ace] publisher close failed", error));
			await link.xferClient?.close().catch((error) => this.problem("[ace] transfer client close failed", error));
		}
	}
}
