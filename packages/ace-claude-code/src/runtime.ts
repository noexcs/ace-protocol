import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
	AceLogger,
	AgentRegistryStore,
	EndpointConfig,
	ResolvedAceConfig,
	Transport,
	TransportFactoryOptions,
} from "ace-runtime";
import {
	ACE_CONFIG_FILENAME,
	AceMetrics,
	AceRuntime,
	AgentRegistry,
	createPublishers,
	createRedisAgentRegistry,
	createTransports,
	DeadLetterSink,
	resolveAceConfig,
} from "ace-runtime";
import { readNewTrail } from "./ack.ts";
import type { ChannelPush } from "./engine.ts";
import { ClaudeCodeEngine } from "./engine.ts";
import { ChannelObserver } from "./observer.ts";
import type { ToolContext } from "./tools.ts";

/**
 * The subscription name of the inbox the agent directory registers for this session: peers find
 * the session in the directory and publish to its stream, which the runtime consumes like any
 * other subscription.
 */
export const SESSION_INBOX = "session-inbox";

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
	/** Coding agent name shown in the sender description. */
	codingAgent?: string;
	env?: Readonly<Record<string, string | undefined>>;
	/** Injectable timers for tests. */
	setInterval?: (callback: () => void, ms: number) => { cancel: () => void };
	setTimeout?: (callback: () => void, ms: number) => { cancel: () => void };
	/**
	 * The host session id (`CLAUDE_CODE_SESSION_ID`), when the host injected it. The agent directory
	 * builds the member name from it, so registration is skipped without one.
	 */
	sessionId?: string;
	/** Build the agent directory store; tests inject a recording stand-in. Production uses `createRedisAgentRegistry`. */
	registryStoreFactory?: (options: {
		url: string;
		prefix?: string;
		onError: (error: unknown) => void;
	}) => AgentRegistryStore;
	/** Build the transport per subscription; tests inject a no-op stand-in so the runtime starts without a broker. */
	transportsFactory?: (
		subscriptions: readonly EndpointConfig[],
		options: TransportFactoryOptions,
	) => Record<string, Transport>;
}

export interface AceHandle {
	/** The resolved configuration, once the runtime started. */
	config: ResolvedAceConfig;
	/** Read by the tool handlers. */
	tools: ToolContext;
	/** Stop the runtime, the acknowledgement poller, and release in-flight observations. */
	stop(): Promise<void>;
}

/**
 * Start the ACE runtime for this Claude Code session.
 *
 * Every piece is the vendored runtime: configuration from `resolveAceConfig`, one transport per
 * subscription from `createTransports`, one publisher per publication from `createPublishers`, and
 * the delivery policy (dedup, allowlists, burst spilling, `manual` retention) from {@link AceRuntime}.
 * Only two things are host-specific: the {@link ClaudeCodeEngine}, which pushes events over the
 * channel and waits for observation, and the acknowledgement poller below, which turns the
 * `UserPromptSubmit` hook's trail into the "observed" signal the runtime needs before it
 * acknowledges the broker.
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
	const publishers = createPublishers(resolved.publish, {
		onError: (error) => logger.error?.(`[ace] publish transport error: ${describeError(error)}`),
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
	let registry: AgentRegistry | undefined;
	let registration: { member: string; stream: string; group: string } | undefined;
	// The configured channels, plus the inbox the directory registers for this session when one is
	// configured — the runtime consumes that inbox like any other subscription.
	let subscriptions = resolved.subscribe;
	// A configured channel that already takes the derived name would make the runtime refuse to start
	// (duplicate subscription names), so in that case this session runs without the directory instead
	// of failing over a naming collision; a configured stream is not one nobody reads anyway.
	const inboxNameTaken = resolved.subscribe.some((endpoint) => endpoint.name === SESSION_INBOX);
	if (inboxNameTaken) {
		logger.warn?.(
			`[ace] a subscription is already named ${SESSION_INBOX}; not registering in the agent directory (the derived inbox would collide with it)`,
		);
	}
	// Register before the runtime starts, so the entry advertises the stream the runtime will read.
	// A down broker is reported and the session runs without a directory, like a down subscription.
	if (resolved.registry !== undefined && !inboxNameTaken) {
		const storeFactory =
			options.registryStoreFactory ??
			((registryOptions: { url: string; prefix?: string; onError: (error: unknown) => void }) =>
				createRedisAgentRegistry(registryOptions));
		// Without a session id there is no member name to register under; the host (Claude Code)
		// injects it into the server environment as `CLAUDE_CODE_SESSION_ID`.
		const sessionId = options.sessionId;
		if (sessionId === undefined) {
			logger.warn?.(
				"[ace] registry is configured but no session id was injected (CLAUDE_CODE_SESSION_ID); not registering in the agent directory",
			);
		} else {
			try {
				registry = new AgentRegistry({
					store: storeFactory({
						url: resolved.registry.url,
						...(resolved.registry.prefix === undefined ? {} : { prefix: resolved.registry.prefix }),
						onError: reportRegistryError,
					}),
					...(resolved.registry.prefix === undefined ? {} : { prefix: resolved.registry.prefix }),
					logger,
					onError: reportRegistryError,
				});
				registration = await registry.register({
					codingAgent,
					sessionId,
					cwd,
					url: resolved.registry.url,
				});
				const inbox: EndpointConfig = {
					name: SESSION_INBOX,
					transport: "redis-streams",
					description: "this session's inbox (agent directory)",
					config: {
						stream: registration.stream,
						group: registration.group,
						url: resolved.registry.url,
					},
					options: {},
				};
				subscriptions = [...resolved.subscribe, inbox];
			} catch (error) {
				// Registration failed (e.g. the broker is down): leave the directory and run anyway —
				// a peer that finds this session cannot reach it while the broker is down.
				registration = undefined;
				await registry?.close().catch(() => {});
				registry = undefined;
				logger.warn?.(`[ace] not registered in the agent directory: ${describeError(error)}`);
			}
		}
	}
	const makeTransports = options.transportsFactory ?? createTransports;
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
		await runtime.stop().catch(() => {});
		// Nothing is running: leave the directory so a dead session is not discoverable, and release
		// the registry's client, so the next start in this process may try again.
		if (registry !== undefined && registration !== undefined) await registry.unregister().catch(() => {});
		await registry?.close().catch(() => {});
		registry = undefined;
		registration = undefined;
		logger.error?.(
			`[ace] could not start: ${describeError(error)} (check the broker in ${ACE_CONFIG_FILENAME}, then restart the session)`,
		);
		return undefined;
	}
	for (const warning of resolved.warnings) logger.warn?.(`[ace] ${warning}`);

	const tools: ToolContext = {
		config: resolved,
		sender: resolved.sender,
		// The session id is only known to the server (which spawns with the session env); the runtime
		// resolves the sender identity from the config, and the server layers the id on top.
		codingAgent,
		publishers,
		runtime,
		...(registration === undefined ? {} : { member: registration.member }),
	};

	// The hook writes here; the runtime acknowledges only when the event shows up in the
	// conversation. A timed-out observation releases its waiter so the broker can redeliver.
	const poller = startAckPoller({
		cwd,
		observer,
		logger,
		...(options.setInterval === undefined ? {} : { setInterval: options.setInterval }),
	});

	logger.info?.(
		`[ace] ${resolved.sender ?? "(no sender)"} listening (${resolved.source}): ` +
			`subscribe ${subscriptions.map((e) => e.name).join(", ") || "(none)"}; ` +
			`publish ${resolved.publish.map((e) => e.name).join(", ") || "(none)"}; ` +
			`registered as ${registration?.member ?? "(none)"}`,
	);

	return {
		config: resolved,
		tools,
		async stop() {
			poller.cancel();
			// Order matters (0.1.3): `unregister` deletes this session's stream (and group), so the
			// reader has to be gone first — otherwise it wakes up to a deleted group and reports
			// NOGROUP on the way out.
			shuttingDown = true;
			try {
				// In-flight injections are the engine's own: each waits out its observation with a
				// bounded timer that releases itself, so stopping the runtime never strands an
				// unhandled promise.
				await runtime.stop();
			} finally {
				if (registry !== undefined && registration !== undefined) await registry.unregister().catch(() => {});
				await registry?.close().catch(() => {});
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
