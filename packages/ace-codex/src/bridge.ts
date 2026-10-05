/**
 * Top-level assembly of the ACE → Codex bridge.
 *
 * Wires, in order:
 *   1. a connection to a `codex app-server` (stdio child, or an out-bound
 *      `ws`/`unix` connection to an already-running server);
 *   2. the {@link AppServerClient} over it, running the `initialize` handshake;
 *   3. the {@link CodexEngine}, which starts (or resumes) a thread and turns
 *      ACE events into `turn/start` / `turn/steer`;
 *   4. the delivery observer the engine acks against;
 *   5. per configured server, this session's agent-directory registration:
 *      it registers the channel named by its own sender
 *      (`<ns>:<username>:codex:<threadId>`) and reads that channel back as a
 *      derived `session-inbox` subscription — with a transport — so the address
 *      it advertises is actually read. A server that cannot be reached is
 *      skipped with a warning; the rest of the session still runs;
 *   6. the ACE runtime (`resolveAceConfig` + `createTransports` +
 *      `AceRuntime`) on top of that engine.
 *
 * Only non-experimental `app-server` methods are used, so no experimental
 * capability is requested and `manual` events stay in the ACE runtime's own
 * pending store (the runtime re-dispatches them as `next_turn` on explicit
 * activation — the Pi/oh-my-pi extension works identically).
 */

import { join } from "node:path";
import {
	AceDeliveryObserver,
	type AceLogger,
	AceMetrics,
	AceRuntime,
	AgentRegistry,
	consoleAceLogger,
	createRedisAgentRegistry,
	createTransports,
	DeadLetterSink,
	type EndpointConfig,
	type Registration,
	type ResolvedServer,
	resolveAceConfig,
	SESSION_INBOX,
	senderName,
	shutdownAce,
	subscriptionEndpoint,
	type Transport,
} from "ace-runtime";
import { AppServerClient, type InitializeResult } from "./client.ts";
import type { CodexConnectionConfig } from "./config.ts";
import { type AppServerConnection, createStdioConnection, createWebSocketConnection } from "./connection.ts";
import { CodexEngine } from "./engine.ts";

/** Coding agent this bridge reports as in the agent directory; its channel reads `…:codex:<threadId>`. */
export const CODEX_AGENT_NAME = "codex";

/**
 * The derived subscription label for this session's inbox channel. Single server: the bare label;
 * with several, each server's inbox is prefixed with that server's name so transport keys stay
 * unique. The channel it reads is never this label — the channel is the session's sender name.
 */
export { SESSION_INBOX };

/**
 * Registry seam for tests: a factory that builds one {@link AgentRegistry} for a server. Omitted
 * (default), the registry is built over a Redis-backed store from that server's `url`/`namespace`.
 * Tests inject a fake so no broker is needed.
 */
export type RegistryFactory = (options: {
	url: string;
	namespace: string;
	logger?: AceLogger;
	onError?: (error: unknown) => void;
}) => AgentRegistry;

export interface BridgeOptions {
	readonly config: CodexConnectionConfig;
	/**
	 * The working directory the bridge runs in: where `.ace.json` lives, where
	 * spool/dead-letter state goes, and the default `cwd` for the Codex thread.
	 * Defaults to the process cwd.
	 */
	readonly cwd?: string;
	readonly logger?: AceLogger;
	/**
	 * A pre-built connection to the app-server, used instead of
	 * {@link buildConnection}. Injectable for tests (an in-memory peer); production builds it from
	 * `config`.
	 */
	readonly connection?: AppServerConnection;
	/** Injectable for tests; defaults to `process.env`. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** The agent-directory registry factory; see {@link RegistryFactory}. */
	readonly registry?: RegistryFactory;
	/**
	 * Extra transport instances keyed by subscription name, merged over
	 * {@link createTransports}' output (winning on collision). Lets tests observe — or replace —
	 * the transport the runtime reads a subscription with, in particular a derived
	 * `session-inbox`, without a broker.
	 */
	readonly transports?: Readonly<Record<string, Transport>>;
}

/** A fully assembled bridge: an ACE runtime driving a live Codex thread. */
export interface AceCodexBridge {
	readonly engine: CodexEngine;
	/** Resolves with the initialize result once the handshake completes. */
	readonly ready: Promise<InitializeResult>;
	/** The durable thread id (UUIDv7) once the thread is started. */
	threadId(): string | undefined;
	/**
	 * The registration on the **first server that came up** (channel, stream, group), when one did.
	 * With several servers, each has its own registration; this is the first in configuration order.
	 */
	registration(): Registration | undefined;
	/** The derived `session-inbox` subscription of that same first active server, when one registered. */
	sessionInbox(): EndpointConfig | undefined;
	/** The transports the runtime reads (keyed by subscription name), once started. */
	transports(): Record<string, Transport> | undefined;
	start(): Promise<void>;
	stop(): Promise<void>;
}

function buildConnection(config: CodexConnectionConfig): AppServerConnection {
	if (config.listener === "ws") {
		return createWebSocketConnection({ url: config.endpoint as string });
	}
	if (config.listener === "unix") {
		// The CLI serves `unix://PATH` with a WebSocket over a unix socket; open the
		// socket ourselves and let `ws` run the handshake over it.
		return createWebSocketConnection({ url: "ws://unix", unixPath: config.endpoint });
	}
	return createStdioConnection({
		command: config.command,
		args: config.args,
		cwd: config.cwd,
	});
}

/** Assemble a bridge. Nothing connects until {@link start}. */
export function createBridge(options: BridgeOptions): AceCodexBridge {
	const logger = options.logger ?? consoleAceLogger;
	const cwd = options.cwd ?? process.cwd();
	const config: CodexConnectionConfig = { ...options.config, cwd: options.config.cwd ?? cwd };
	const env = options.env ?? process.env;
	const connection = options.connection ?? buildConnection(config);
	const { client, ready } = AppServerClient.begin(connection, {
		clientInfo: {
			name: config.clientName ?? "ace-codex-bridge",
			version: config.clientVersion ?? "0.1.0",
		},
	});
	const engine = new CodexEngine(client, config);
	const observer = new AceDeliveryObserver();
	engine.setObserver(observer);

	/** One server this session is live on: its connection, and the channel named by this session there. */
	interface ActiveServer {
		server: ResolvedServer;
		/** This session's sender name on that server — which is also its inbox channel there. */
		sender: string;
		registry: AgentRegistry;
		registration: Registration;
		/** The derived inbox subscription for that server. */
		inbox: EndpointConfig;
	}

	let runtime: AceRuntime | undefined;
	let activeServers: ActiveServer[] = [];
	let transports: Record<string, Transport> | undefined;
	/** Every registry this session created, so a `stop()` can reach one whose `register` is in flight. */
	const registries = new Set<AgentRegistry>();
	/** Messages already reported by the registry/transport error hook (distinct, not one-shot). */
	const reportedErrors = new Set<string>();
	let stopped = false;

	/** Directory problems are reported once per distinct message; they never take the bridge down. */
	const reportRegistryError = (error: unknown): void => {
		const message = describe(error);
		if (reportedErrors.has(message)) return;
		reportedErrors.add(message);
		logger.warn?.(`[ace-codex] agent directory: ${message}`);
	};

	/** Build this server's registry: the injected factory in tests, otherwise a Redis-backed one. */
	const createRegistry = (server: ResolvedServer): AgentRegistry => {
		if (options.registry !== undefined) {
			return options.registry({
				url: server.url,
				namespace: server.namespace,
				logger,
				onError: reportRegistryError,
			});
		}
		return new AgentRegistry({
			store: createRedisAgentRegistry({
				url: server.url,
				namespace: server.namespace,
				onError: reportRegistryError,
			}),
			namespace: server.namespace,
			logger,
			onError: reportRegistryError,
		});
	};

	const start = async (): Promise<void> => {
		await ready;
		await engine.start();
		const resolved = resolveAceConfig({ cwd, env });
		const metrics = new AceMetrics();
		const deadLetters = new DeadLetterSink({
			dir: join(cwd, ".ace"),
			logger,
			onError: (error) => logger.error?.(`[ace-codex] dead letter: ${describe(error)}`),
		});

		for (const warning of resolved.warnings) logger.warn?.(`[ace-codex] warning: ${warning}`);

		const threadId = engine.threadId;
		if (threadId === undefined) throw new Error("no thread id after engine.start()");

		// Register on every configured server, each under this session's own sender name there, and
		// read that channel back. The channel name is the address; nothing else is advertised. A
		// server that is unreachable is skipped with a warning — the rest of the session still runs.
		const multi = resolved.servers.length > 1;
		const derived: EndpointConfig[] = [];
		activeServers = [];
		for (const server of resolved.servers) {
			const sender = senderName({
				namespace: server.namespace,
				username: resolved.username,
				codingAgent: CODEX_AGENT_NAME,
				sessionId: threadId,
			});
			const registry = createRegistry(server);
			registries.add(registry);
			try {
				const registration = await registry.register({
					sender,
					codingAgent: CODEX_AGENT_NAME,
					sessionId: threadId,
					cwd,
				});
				// A stop() that landed while `register` was in flight must not be left behind: leave
				// the directory best-effort and do not build a runtime no one will stop.
				if (stopped) {
					registries.delete(registry);
					await shutdownAce({
						registry,
						onError: (step, error) => logger.warn?.(`[ace-codex] ${step}: ${describe(error)}`),
					});
					return;
				}
				const inbox = subscriptionEndpoint({
					channel: sender,
					name: multi ? `${server.name}:${SESSION_INBOX}` : SESSION_INBOX,
					url: server.url,
					namespace: server.namespace,
					sender,
					description: "this session's inbox — the channel named by its sender",
				});
				activeServers.push({ server, sender, registry, registration, inbox });
				derived.push(inbox);
			} catch (error) {
				registries.delete(registry);
				// The broker may be exactly what just failed: a `close()` rejection must not take the
				// session down with it. One unreachable server is skipped, never fatal; the failure is
				// surfaced once (distinct messages only) and the rest of the session still runs.
				await registry
					.close()
					.catch((closeError: unknown) => logger.warn?.(`[ace-codex] registry close: ${describe(closeError)}`));
				const message = describe(error);
				if (!reportedErrors.has(message)) {
					reportedErrors.add(message);
					logger.warn?.(
						`[ace-codex] agent directory: server "${server.name}" unreachable, skipping it: ${message}`,
					);
				}
			}
		}

		// A configured channel is read on the server it was configured for, with that server's sender
		// as the reading identity; a subscription whose server did not come up is dropped.
		for (const subscribed of resolved.subscriptions) {
			const owner = activeServers.find((active) => active.server.name === subscribed.server.name);
			if (owner === undefined) continue;
			derived.push(
				subscriptionEndpoint({
					channel: subscribed.channel,
					name: multi ? `${subscribed.server.name}:${subscribed.channel}` : subscribed.channel,
					url: subscribed.server.url,
					namespace: subscribed.server.namespace,
					sender: owner.sender,
					...(subscribed.server.description === undefined ? {} : { description: subscribed.server.description }),
				}),
			);
		}

		transports = {
			...createTransports(derived, {
				metrics,
				onDropped: (subscription, entry) => deadLetters.record(subscription, entry),
				onError: (error) => {
					// A reader that drains during shutdown sees its own stream deleted and reports
					// NOGROUP; that is the expected end-of-life, not a transport error.
					if (stopped) return;
					logger.error?.(`[ace-codex] transport error: ${describe(error)}`);
				},
			}),
			...options.transports,
		};
		runtime = new AceRuntime({
			engine,
			metrics,
			subscribe: derived,
			spool: { dir: join(cwd, ".ace", "spool") },
			manual: resolved.manual,
			// An event from one of these senders is this session's own publish echoed back by a channel it
			// reads; the block says `self: yes` so an echo cannot masquerade as a peer's message.
			selfSenders: activeServers.map((active) => active.sender),
			transports,
			...(resolved.defaultActivation ? { defaultActivation: resolved.defaultActivation } : {}),
			logger,
		});
		await runtime.start();
		const directory = activeServers
			.map((active) => `${active.server.name} (${active.registration.channel})`)
			.join(", ");
		logger.info?.(
			`[ace-codex] bridge ready thread=${engine.threadId} cwd=${cwd}${directory ? `; registered as ${directory}` : ""}`,
		);
	};

	const stop = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		// Order matters: `unregister` drops this session's own stream (and its group), so the reader
		// has to be gone first — otherwise it wakes up to a deleted group and reports NOGROUP on the
		// way out. `shutdownAce` encodes reader → unregister → close; every server's registration is
		// then dropped, including one whose `register` is still in flight (unregister is a no-op).
		const closing = [...registries];
		registries.clear();
		await shutdownAce({
			runtime,
			onError: (step, error) => logger.warn?.(`[ace-codex] ${step}: ${describe(error)}`),
		});
		for (const registry of closing) {
			await shutdownAce({
				registry,
				onError: (step, error) => logger.warn?.(`[ace-codex] ${step}: ${describe(error)}`),
			});
		}
		runtime = undefined;
		activeServers = [];
		transports = undefined;
		engine.dispose();
		client.close();
		connection.close();
	};

	// If the app-server dies mid-session, tear the runtime down so it stops
	// holding a dead engine (in-flight injects already rejected, so the broker
	// keeps those events pending for redelivery).
	client.onConnectionEnd = (reason) => {
		if (stopped) return;
		logger.error?.(`[ace-codex] app-server connection ended${reason ? `: ${reason}` : ""}; stopping`);
		void stop();
	};

	return {
		engine,
		ready,
		threadId: () => engine.threadId,
		registration: () => activeServers[0]?.registration,
		sessionInbox: () => activeServers[0]?.inbox,
		transports: () => transports,
		start,
		stop,
	};
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
