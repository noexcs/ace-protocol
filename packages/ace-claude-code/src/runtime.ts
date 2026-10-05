import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	AceLogger,
	AceMessage,
	AgentRegistryStore,
	EndpointConfig,
	RedisStreamsAddClient,
	ResolvedAceConfig,
	ResolvedServer,
	Transport,
	TransportFactoryOptions,
} from "../vendor/ace-runtime/dist/index.js";
import {
	ACE_CONFIG_FILENAME,
	AceMetrics,
	AceRuntime,
	AgentRegistry,
	channelName,
	channelStreamKey,
	createRedisAgentRegistry,
	createRedisStreamsAddClient,
	createTransports,
	DeadLetterSink,
	describeEndpoint,
	NO_SESSION_LABEL,
	REDIS_STREAMS_DEFAULTS,
	resolveAceConfig,
	resolveTarget,
	SESSION_INBOX,
	senderName,
	serverForChannel,
	shutdownAce,
	subscriptionEndpoint,
	TOOL_ERROR_TEXT,
} from "../vendor/ace-runtime/dist/index.js";
import { readNewTrail } from "./ack.ts";
import type { ChannelPush } from "./engine.ts";
import { ClaudeCodeEngine } from "./engine.ts";
import { ChannelObserver } from "./observer.ts";
import type { PublishedTarget, PublishSurface, ToolContext } from "./tools.ts";

/** How often the acknowledgement poller re-reads the trail the hook appends to. */
const ACK_POLL_MS = 250;

export interface StartAceOptions {
	/** Directory `.ace.json` is read from and all ACE state (`.ace/`) lives in: the session working directory. */
	cwd: string;
	/** Push a rendered event into the session via the host's channel. */
	push: ChannelPush;
	/** The logger for ACE state; the server's stderr in practice. */
	logger: AceLogger;
	/** Wait for observation before acknowledging, in ms. */
	ackTimeoutMs?: number;
	/** Coding agent name shown in the sender description and carried in the sender name. */
	codingAgent?: string;
	env?: Readonly<Record<string, string | undefined>>;
	/** Injectable timers for tests. */
	setInterval?: (callback: () => void, ms: number) => { cancel: () => void };
	setTimeout?: (callback: () => void, ms: number) => { cancel: () => void };
	/**
	 * The host session id (`CLAUDE_CODE_SESSION_ID`), when the host injected it. The sender name — the
	 * channel this session registers and reads its inbox on — is built from it, so registration is
	 * skipped without one.
	 */
	sessionId?: string;
	/** Build the agent directory store per server; tests inject a recording stand-in. Production uses `createRedisAgentRegistry`. */
	registryStoreFactory?: (options: {
		url: string;
		namespace?: string;
		onError: (error: unknown) => void;
	}) => AgentRegistryStore;
	/** Build the transport per subscription; tests inject a no-op stand-in so the runtime starts without a broker. */
	transportsFactory?: (
		subscriptions: readonly EndpointConfig[],
		options: TransportFactoryOptions,
	) => Record<string, Transport>;
	/** Open the Redis writer for a server URL; tests inject a recording stand-in so publish stays broker-free. */
	addClientFactory?: (url: string, onError: (error: unknown) => void) => RedisStreamsAddClient;
}

export interface AceHandle {
	/** The resolved configuration, once the runtime started. */
	config: ResolvedAceConfig;
	/** Read by the tool handlers. */
	tools: ToolContext;
	/** Stop the runtime, the acknowledgement poller, and release in-flight observations. */
	stop(): Promise<void>;
}

/** One server this session is live on: its connection, and the channel named by this session there. */
interface ActiveServer {
	server: ResolvedServer;
	/** This session's sender name on that server — which is also its inbox channel there. */
	sender: string;
	registry: AgentRegistry;
}

/**
 * Start the ACE runtime for this Claude Code session.
 *
 * Every piece is the vendored runtime: configuration from `resolveAceConfig`, one transport per
 * derived subscription from `createTransports`, one lazily-opened Redis writer per server for
 * publishing, and the delivery policy (dedup, allowlists, burst spilling, `manual` retention) from
 * {@link AceRuntime}. A channel name is the address: this session registers the channel named by its
 * sender on every configured server, reads it back as its inbox, and addresses peers by channel name.
 * Only two things are host-specific: the {@link ClaudeCodeEngine}, which pushes events over the
 * channel and waits for observation, and the acknowledgement poller below, which turns the
 * `UserPromptSubmit` hook's trail into the "observed" signal the runtime needs before it acknowledges
 * the broker.
 *
 * Returns `undefined` — the caller reports the reason — when there is no usable configuration: an
 * absent or unreadable `.ace.json`. The server still runs then, its tools answer "not configured",
 * and a later session start in the same process may try again.
 */
export async function startAce(options: StartAceOptions): Promise<AceHandle | undefined> {
	const cwd = options.cwd;
	const env = options.env ?? process.env;
	const logger = options.logger;
	const codingAgent = options.codingAgent ?? "claude-code";
	const sessionId = options.sessionId;
	const configPath = env.ACE_CONFIG ?? join(cwd, ACE_CONFIG_FILENAME);
	if (!existsSync(configPath)) {
		logger.warn?.(
			`[ace] no ${ACE_CONFIG_FILENAME} in ${cwd}; the ACE tools are available but inert until one exists`,
		);
		return undefined;
	}

	let resolved: ResolvedAceConfig;
	try {
		resolved = resolveAceConfig({ cwd, env });
	} catch (error) {
		logger.error?.(`[ace] could not read ${configPath}: ${describeError(error)}`);
		return undefined;
	}

	const aceDir = join(cwd, ".ace");
	mkdirSync(aceDir, { recursive: true });
	mkdirSync(join(aceDir, "spool"), { recursive: true });

	const observer = new ChannelObserver();
	const engine = new ClaudeCodeEngine({
		push: options.push,
		observer,
		...(options.ackTimeoutMs === undefined ? {} : { ackTimeoutMs: options.ackTimeoutMs }),
		...(options.setTimeout === undefined ? {} : { setTimer: options.setTimeout }),
	});
	const deadLetters = new DeadLetterSink({
		dir: aceDir,
		logger,
		onError: (error) => logger.error?.(`[ace] dead letter: ${describeError(error)}`),
	});
	const metrics = new AceMetrics();
	let transportErrorReported = false;
	// Set around teardown: `unregister` removes the session's own stream (and its group), so a reader
	// still draining would report NOGROUP for a group we deleted on purpose.
	let shuttingDown = false;
	// Directory problems are reported once per distinct message; they never take a session down.
	let registryErrorReported: string | undefined;
	const reportRegistryError = (error: unknown): void => {
		const text = `[ace] agent directory: ${describeError(error)}`;
		if (registryErrorReported === text) return;
		registryErrorReported = text;
		logger.warn?.(text);
	};

	const storeFactory =
		options.registryStoreFactory ??
		((registryOptions: { url: string; namespace?: string; onError: (error: unknown) => void }) =>
			createRedisAgentRegistry(registryOptions));
	const makeTransports = options.transportsFactory ?? createTransports;
	const makeAddClient = options.addClientFactory ?? createRedisStreamsAddClient;

	// Register on every configured server, each with this session's own channel there, and read that
	// channel back. A server that is unreachable is skipped with a warning: the rest of the session
	// still runs. Nothing about the address is advertised — the channel name is the address.
	const multi = resolved.servers.length > 1;
	const activeServers: ActiveServer[] = [];
	const derived: EndpointConfig[] = [];
	let sessionInbox: EndpointConfig | undefined;
	/**
	 * A server's sender name with the session label this host has: the injected session id, or the
	 * runtime's no-session label when the host gave none.
	 */
	const readingSender = (server: ResolvedServer): string =>
		senderName({
			namespace: server.namespace,
			username: resolved.username,
			codingAgent,
			sessionId: sessionId ?? NO_SESSION_LABEL,
		});
	if (sessionId === undefined) {
		// Without a session id there is no channel to register under; the host (Claude Code) injects it
		// into the server environment as `CLAUDE_CODE_SESSION_ID`. Configured channels are still read.
		logger.warn?.(
			"[ace] no session id was injected (CLAUDE_CODE_SESSION_ID); not registering in the agent directory",
		);
	} else {
		for (const server of resolved.servers) {
			const sender = readingSender(server);
			const registry = new AgentRegistry({
				store: storeFactory({ url: server.url, namespace: server.namespace, onError: reportRegistryError }),
				namespace: server.namespace,
				logger,
				onError: reportRegistryError,
			});
			try {
				await registry.register({ sender, codingAgent, sessionId, cwd });
			} catch (error) {
				// Registration failed (e.g. the broker is down): leave the directory and run anyway —
				// a peer that finds this session cannot reach it while the broker is down.
				await registry.close().catch(() => {});
				logger.warn?.(`[ace] server "${server.name}" unreachable, skipping it: ${describeError(error)}`);
				continue;
			}
			activeServers.push({ server, sender, registry });
			const inbox = subscriptionEndpoint({
				channel: sender,
				// With more than one server the local inbox labels would collide; prefix them with the
				// server name so every transport key stays unique.
				name: multi ? `${server.name}:${SESSION_INBOX}` : SESSION_INBOX,
				url: server.url,
				namespace: server.namespace,
				sender,
				description: "this session's inbox — the channel named by its sender",
			});
			sessionInbox ??= inbox;
			derived.push(inbox);
		}
	}
	// Subscribed channel names are read on the server they were configured for, with that server's
	// sender as the reading identity; a subscription whose server did not come up is dropped.
	for (const subscribed of resolved.subscriptions) {
		const owner = activeServers.find((active) => active.server.name === subscribed.server.name);
		// Without a session id nothing was registered, but a configured channel is still readable under
		// the no-session sender; when registration was attempted and failed, the server is down — drop it.
		const sender = owner?.sender ?? (sessionId === undefined ? readingSender(subscribed.server) : undefined);
		if (sender === undefined) continue;
		derived.push(
			subscriptionEndpoint({
				channel: subscribed.channel,
				name: multi ? `${subscribed.server.name}:${subscribed.channel}` : subscribed.channel,
				url: subscribed.server.url,
				namespace: subscribed.server.namespace,
				sender,
				...(subscribed.server.description === undefined ? {} : { description: subscribed.server.description }),
			}),
		);
	}
	const subscriptions = derived;

	// Lazily opened writer per server URL: publishing needs no configured list of publications — the
	// stream is derived from the target channel's name.
	const addClients = new Map<string, RedisStreamsAddClient>();
	/** Complete a short channel name with this server's namespace and the user's name. */
	function complete(name: string, namespace: string): string {
		return name.includes(":") && name.split(":").length >= 3 ? name : channelName(namespace, resolved.username, name);
	}
	/**
	 * A target is a **channel name**. `<server>:<channel>` picks the server; with a single server the
	 * bare name is enough. Otherwise the name is looked up in each server's directory — that is how a
	 * peer is addressed, because a peer *is* the channel named by its sender. Guessing between two live
	 * channels would send an event to the wrong agent, so an ambiguous target fails and names them.
	 */
	async function resolvePublishTarget(name: string): Promise<PublishedTarget> {
		const first = name.split(":")[0] ?? "";
		const explicit = activeServers.find((active) => active.server.name === first);
		if (explicit !== undefined && name.includes(":")) {
			return {
				server: explicit.server,
				channel: complete(name.slice(first.length + 1), explicit.server.namespace),
				sender: explicit.sender,
			};
		}
		const only = activeServers.length === 1 ? activeServers[0] : undefined;
		if (only !== undefined) {
			return { server: only.server, channel: complete(name, only.server.namespace), sender: only.sender };
		}
		// A full name carries its server in its namespace, so it needs no directory entry to be accepted;
		// the directory is for short names, and for a namespace two live servers share.
		const namespaceServer = serverForChannel({
			servers: activeServers.map((active) => active.server),
			channel: name,
		});
		const byNamespace = activeServers.find((active) => active.server === namespaceServer);
		if (byNamespace !== undefined) {
			return {
				server: byNamespace.server,
				channel: complete(name, byNamespace.server.namespace),
				sender: byNamespace.sender,
			};
		}
		const matches: PublishedTarget[] = [];
		for (const active of activeServers) {
			const resolution = resolveTarget(await active.registry.list(), name);
			if (resolution.ok)
				matches.push({ server: active.server, channel: resolution.entry.channel, sender: active.sender });
		}
		const unique = matches[0];
		if (unique !== undefined && matches.length === 1) return unique;
		if (matches.length > 1) {
			throw new Error(
				TOOL_ERROR_TEXT.targetAmbiguous(
					name,
					matches.length,
					matches.map((match) => `${match.server.name}:${match.channel}`),
				),
			);
		}
		throw new Error(
			TOOL_ERROR_TEXT.targetNotFound(
				name,
				activeServers.map((active) => `${active.server.name}:<channel>`),
			),
		);
	}
	/** Publish to a channel: the stream is derived from the name, and one writer per server is opened on first use. */
	async function sendToChannel(target: PublishedTarget, message: AceMessage): Promise<void> {
		const url = target.server.url;
		let writer = addClients.get(url);
		if (writer === undefined) {
			writer = makeAddClient(url, reportRegistryError);
			addClients.set(url, writer);
		}
		await writer.add(
			channelStreamKey(target.server.namespace, target.channel),
			REDIS_STREAMS_DEFAULTS.field,
			JSON.stringify(message),
		);
	}
	const publish: PublishSurface = {
		senders: activeServers.map((active) => active.sender),
		serverNames: activeServers.map((active) => active.server.name),
		resolve: resolvePublishTarget,
		send: sendToChannel,
	};

	const runtime = new AceRuntime({
		engine,
		subscribe: subscriptions,
		spool: { dir: join(aceDir, "spool") },
		manual: resolved.manual,
		transports: makeTransports(subscriptions, {
			metrics,
			onDropped: (subscription, entry) => {
				void deadLetters.record(subscription, entry);
			},
			onError: (error) => {
				// Teardown drops this session's own stream; a reader that is still draining would report
				// NOGROUP for a group we just removed on purpose.
				if (shuttingDown) return;
				// A broker that dies mid-session would otherwise repeat the same error.
				if (transportErrorReported) return;
				transportErrorReported = true;
				logger.error?.(`[ace] transport error: ${describeError(error)}`);
			},
		}),
		...(resolved.defaultActivation === undefined ? {} : { defaultActivation: resolved.defaultActivation }),
		logger,
	});

	try {
		await runtime.start();
	} catch (error) {
		shuttingDown = true;
		// Nothing is running: stop the reader, leave every directory so a dead session is not
		// discoverable, and release the writers, so the next start in this process may try again.
		await shutdownAce({
			runtime,
			onError: (step, cause) => logger.warn?.(`[ace] ${step}: ${describeError(cause)}`),
		});
		for (const active of activeServers) {
			await shutdownAce({
				registry: active.registry,
				onError: (step, cause) => logger.warn?.(`[ace] ${step} (${active.server.name}): ${describeError(cause)}`),
			});
		}
		for (const writer of addClients.values()) await writer.close().catch(() => {});
		logger.error?.(
			`[ace] could not start: ${describeError(error)} (check the broker in ${ACE_CONFIG_FILENAME}, then restart the session)`,
		);
		return undefined;
	}
	for (const warning of resolved.warnings) logger.warn?.(`[ace] ${warning}`);

	const tools: ToolContext = {
		config: resolved,
		subscriptions,
		...(sessionInbox === undefined ? {} : { inbox: sessionInbox }),
		...(sessionId === undefined ? {} : { sessionId }),
		codingAgent,
		cwd,
		runtime,
		publish,
	};

	// The hook writes here; the runtime acknowledges only when the event shows up in the
	// conversation. A timed-out observation releases its waiter so the broker can redeliver.
	const poller = startAckPoller({
		cwd,
		observer,
		logger,
		...(options.setInterval === undefined ? {} : { setInterval: options.setInterval }),
	});

	const senders = activeServers.map((active) => active.sender);
	const servers = activeServers.map((active) => `${active.server.name} (${active.sender})`).join(", ");
	logger.info?.(
		`[ace] ${senders.join(", ") || "(no sender)"} listening (${resolved.source}): ` +
			`servers ${servers || "(none)"}; reading ${subscriptions.map(describeEndpoint).join(", ") || "(none)"}`,
	);

	return {
		config: resolved,
		tools,
		async stop() {
			poller.cancel();
			// The order (reader → directory entry and stream → client) and its best-effort error
			// handling live in the runtime, so every host gets it right by construction. The reader is
			// shared by every server, so it stops once; each server's registration is then dropped and
			// closed, and the publish writers are released last of all.
			shuttingDown = true;
			try {
				await shutdownAce({
					runtime,
					onError: (step, error) => logger.warn?.(`[ace] ${step}: ${describeError(error)}`),
				});
				for (const active of activeServers) {
					await shutdownAce({
						registry: active.registry,
						onError: (step, error) =>
							logger.warn?.(`[ace] ${step} (${active.server.name}): ${describeError(error)}`),
					});
				}
			} finally {
				// In-flight injections are the engine's own: each waits out its observation with a
				// bounded timer that releases itself, so stopping the runtime never strands an
				// unhandled promise.
				for (const writer of addClients.values()) await writer.close().catch(() => {});
				addClients.clear();
			}
		},
	};
}

interface AckPollerOptions {
	cwd: string;
	observer: ChannelObserver;
	logger: AceLogger;
	setInterval?: (callback: () => void, ms: number) => { cancel: () => void };
}

function startAckPoller(options: AckPollerOptions): { cancel: () => void } {
	// The local is named `schedule` so it does not shadow the global `setInterval` the real timer is built from.
	const schedule =
		options.setInterval ??
		((callback, ms) => {
			const handle = setInterval(callback, ms);
			return { cancel: () => clearInterval(handle) };
		});
	let offset = 0;
	// A hook line written before this server started would carry a turn that is already over; its
	// event is not one we are waiting for, so the first read starts clean.
	const timer = schedule(() => {
		void (async () => {
			try {
				const read = await readNewTrail(options.cwd, offset);
				offset = read.nextOffset ?? offset;
				if (read.observations.length === 0) return;
				for (const observation of read.observations) {
					options.observer.feed(observation);
				}
			} catch (error) {
				options.logger.warn?.(`[ace] ack trail: ${describeError(error)}`);
			}
		})();
	}, ACK_POLL_MS);
	return timer;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
