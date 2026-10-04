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
 *   5. the agent directory registration (when `.ace.json` has a `registry`):
 *      the bridge registers itself under `codex:<threadId>` and appends the
 *      returned inbox as a derived `session-inbox` subscription — with a
 *      transport — so the address it advertises is actually read;
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
	resolveAceConfig,
	type Transport,
} from "ace-runtime";
import { AppServerClient, type InitializeResult } from "./client.ts";
import type { CodexConnectionConfig } from "./config.ts";
import { type AppServerConnection, createStdioConnection, createWebSocketConnection } from "./connection.ts";
import { CodexEngine } from "./engine.ts";

/** Coding agent this bridge reports as in the agent directory; its members read `codex:<threadId>`. */
export const CODEX_AGENT_NAME = "codex";

/**
 * The derived subscription name: the inbox the registry registers for this session is appended to
 * the configured subscriptions under this name (derived, not from `.ace.json`).
 */
export const SESSION_INBOX = "session-inbox";

/**
 * Registry seam for tests: a ready-made registry, or a factory for one. Used only when the
 * resolved `.ace.json` has a `registry`; omitted (default), the registry is built from that
 * config (a Redis-backed store). Tests inject a fake so no broker is needed.
 */
export type RegistryFactory =
	| AgentRegistry
	| ((options: {
			url: string;
			prefix?: string;
			logger?: AceLogger;
			onError?: (error: unknown) => void;
	  }) => AgentRegistry);

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
	/** The agent directory registry; see {@link RegistryFactory}. */
	readonly registry?: RegistryFactory;
	/**
	 * Extra transport instances keyed by subscription name, merged over
	 * {@link createTransports}' output (winning on collision). Lets tests observe — or replace —
	 * the transport the runtime reads a subscription with, in particular the derived
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
	/** The registration in the agent directory (member, stream, group), when it succeeded. */
	registration(): Registration | undefined;
	/** The derived `session-inbox` subscription, when a registration succeeded. */
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

	let runtime: AceRuntime | undefined;
	let registry: AgentRegistry | undefined;
	let registration: Registration | undefined;
	let inbox: EndpointConfig | undefined;
	let transports: Record<string, Transport> | undefined;
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

		// The advertised stream is this session's inbox: subscribe to it, or the address a peer
		// discovered through the directory would have nobody reading it.
		let subscriptions: readonly EndpointConfig[] = resolved.subscribe;
		if (resolved.registry) {
			const { url, prefix } = resolved.registry;
			// Local handle: `stop()` may null the shared `registry` while `register` is in
			// flight, and the post-register cleanup below must still reach this instance.
			let active: AgentRegistry | undefined;
			try {
				active =
					typeof options.registry === "function"
						? options.registry({
								url,
								...(prefix === undefined ? {} : { prefix }),
								logger,
								onError: reportRegistryError,
							})
						: (options.registry ??
							new AgentRegistry({
								store: createRedisAgentRegistry({
									url,
									...(prefix === undefined ? {} : { prefix }),
									onError: reportRegistryError,
								}),
								...(prefix === undefined ? {} : { prefix }),
								logger,
								onError: reportRegistryError,
							}));
				registry = active;
				// A `.ace.json` that already names a subscription `session-inbox` would collide with
				// the derived one the directory adds. Degrade instead of dying: skip the registration
				// (and the derived subscription) and still start the runtime so the configured
				// channels keep being read.
				if (resolved.subscribe.some((subscription) => subscription.name === SESSION_INBOX)) {
					logger.warn?.(
						`[ace-codex] a configured subscription is already named "${SESSION_INBOX}"; ` +
							"skipping agent-directory registration (remove it to use the directory)",
					);
					registry = undefined;
					await active
						.close()
						.catch((error: unknown) => logger.warn?.(`[ace-codex] registry close: ${describe(error)}`));
					active = undefined;
				} else {
					const threadId = engine.threadId;
					if (threadId === undefined) throw new Error("no thread id after engine.start()");
					registration = await active.register({
						codingAgent: CODEX_AGENT_NAME,
						sessionId: threadId,
						cwd,
						url,
					});
					// A stop() that landed while `register` was in flight must not be left behind:
					// leave the directory best-effort and do not build a runtime no one will stop.
					if (stopped) {
						try {
							await active.unregister();
						} catch (error) {
							logger.warn?.(`[ace-codex] registry unregister: ${describe(error)}`);
						}
						registry = undefined;
						active = undefined;
						return;
					}
					const derived: EndpointConfig = {
						name: SESSION_INBOX,
						transport: "redis-streams",
						description: "this session's inbox (agent directory)",
						config: { stream: registration.stream, group: registration.group, url },
						options: {},
					};
					inbox = derived;
					subscriptions = [...resolved.subscribe, derived];
				}
			} catch (error) {
				registration = undefined;
				// The broker may be exactly what just failed: a `close()` rejection must not take
				// the session down with it (the original register error is still reported below).
				if (active !== undefined) {
					await active
						.close()
						.catch((closeError: unknown) => logger.warn?.(`[ace-codex] registry close: ${describe(closeError)}`));
				}
				registry = undefined;
				inbox = undefined;
				reportRegistryError(error);
			}
		}

		transports = {
			...createTransports(subscriptions, {
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
			subscribe: subscriptions,
			spool: { dir: join(cwd, ".ace", "spool") },
			manual: resolved.manual,
			transports,
			...(resolved.defaultActivation ? { defaultActivation: resolved.defaultActivation } : {}),
			logger,
		});
		await runtime.start();
		const directory = registration === undefined ? "" : `; registered as ${registration.member}`;
		logger.info?.(`[ace-codex] bridge ready thread=${engine.threadId} cwd=${cwd}${directory}`);
	};

	const stop = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		// Order matters: `unregister` drops this session's own stream (and its group), so the
		// reader has to be gone first — otherwise it wakes up to a deleted group and reports
		// NOGROUP on the way out.
		try {
			await runtime?.stop();
		} catch (error) {
			logger.warn?.(`[ace-codex] runtime stop: ${describe(error)}`);
		}
		// `unregister` is a no-op when nothing registered, so it is safe to call whenever a
		// registry instance exists — this also covers a `register` that completes after `stop`.
		if (registry !== undefined) {
			try {
				await registry.unregister();
			} catch (error) {
				logger.warn?.(`[ace-codex] registry unregister: ${describe(error)}`);
			}
		}
		try {
			await registry?.close();
		} catch (error) {
			logger.warn?.(`[ace-codex] registry close: ${describe(error)}`);
		}
		runtime = undefined;
		registry = undefined;
		registration = undefined;
		inbox = undefined;
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
		registration: () => registration,
		sessionInbox: () => inbox,
		transports: () => transports,
		start,
		stop,
	};
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
