/**
 * ACE 0.1 extension for Pi: receive external events into the session you are chatting in, and
 * publish events to peers.
 *
 * Configuration is read from `.ace.json` in the session working directory (RFC §10 runtime
 * configuration), or from `ACE_CONFIG` when that points somewhere else. `subscribe` and `publish`
 * use the vocabulary of MQ APIs (MQTT/AsyncAPI operations), seen from this agent; each channel
 * keeps transport-independent fields at its top level and the broker's own settings in `config`:
 *
 * ```json
 * {
 *   "defaultActivation": "next_turn",
 *   "subscribe": [
 *     { "name": "inbox", "transport": "redis-streams", "description": "direct messages from peers",
 *       "config": { "stream": "ace:in.a", "group": "agent-a" } }
 *   ],
 *   "publish": [
 *     { "name": "to-b", "transport": "redis-streams", "description": "agent-b",
 *       "config": { "stream": "ace:in.b" } }
 *   ]
 * }
 * ```
 *
 * Start Pi with the extension:
 *
 * ```bash
 * pi --extension /path/to/ace-omp/extensions/ace.ts
 * ```
 *
 * Receiving: `immediate` events cut into a running turn (`steer`) and start one when the agent is idle;
 * `next_turn` events never interrupt — they queue for the next boundary (`followUp` on Pi, `aside` on
 * oh-my-pi, which also starts a turn when idle). Where the host cannot promise the agent will see an
 * injected event (oh-my-pi's idle queue), the adapter waits until the event shows up in the conversation
 * before letting the transport acknowledge it, so a stalled session leaves the event pending instead of
 * losing it. `manual` events are retained in memory — inspect and activate them with `/ace`,
 * `/ace pending`, `/ace activate <sender> <id>`.
 *
 * Publishing: once the configuration is known, `ace_publish` is re-registered with a description that
 * names this agent (with its session label), every channel it can reach, and where events land. The
 * address stays in configuration, never in the message (RFC §4.1). Every published event carries the
 * session's id (RFC §5.4) and a member-shaped `sender` (`<sender>:<sessionId>`), so a peer can show who
 * sent it and which session it came from — and a self-description (`senderDescription`) so that peer can
 * also show where this session runs without looking anything up.
 *
 * `ACE_CONFIG` points at a different configuration file; every MQ setting stays in that file.
 * `ACE_LOG=1` also logs runtime lines in modes without a UI.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	ACE_CONFIG_FILENAME,
	// The model-facing tool surface — names, descriptions, guidelines and parameter schemas — lives in
	// the runtime, so every host registers the same tools; this plugin only binds them to the host.
	ACE_TOOL_NAMES,
	AceDeliveryObserver,
	type AceLogger,
	type AceMessage,
	AceMetrics,
	AceRuntime,
	AGENTS_PARAMETERS,
	AgentRegistry,
	buildPublishToolText,
	CHANNELS_PARAMETERS,
	channelListingInput,
	channelName,
	channelStreamKey,
	channelsToolText,
	createRedisAgentRegistry,
	createRedisStreamsAddClient,
	createTransports,
	DeadLetterSink,
	deliveredChannel,
	describeDiscovered,
	describeEndpoint,
	describeSender,
	detectHostDelivery,
	type EndpointConfig,
	endpointAddress,
	failedTarget,
	formatChannelListing,
	formatChannelReport,
	formatDiscoveredSessions,
	formatPublishResult,
	formatSessionLabel,
	hostFacts,
	NO_SESSION_LABEL,
	PiExtensionAdapter,
	PUBLISH_PARAMETERS,
	REDIS_STREAMS_DEFAULTS,
	type RedisStreamsAddClient,
	type RegistryEntry,
	type ResolvedAceConfig,
	type ResolvedServer,
	resolveAceConfig,
	resolveTarget,
	SESSION_INBOX,
	senderName,
	shutdownAce,
	subscriptionEndpoint,
	TOOL_ERROR_TEXT,
	TOOL_TEXT,
	validateAceMessage,
	withTrustPolicy,
} from "../vendor/ace-runtime/dist/index.js";
import { channelMenuItems, showAceManager } from "./ace-manager.ts";

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Report to the user: notification in UI modes, stderr in print/JSON modes. */
function report(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	console.error(message);
}

/**
 * Whether this context belongs to a subagent session.
 *
 * oh-my-pi rebinds extensions to every session it spawns ("Each child rebinds fresh Extension
 * instances to its OWN ExtensionAPI", `loader.ts`), so this factory runs again per subagent with its
 * own locals. ACE must run once, in the session the human talks to: a runtime per subagent would
 * join the same consumer group and silently take over events meant for the main session. The host
 * exposes `ctx.agent.kind` for exactly this decision (`types.ts`: "Check this, not `depth`, to tell
 * subagents apart").
 */
function isSubagentContext(ctx: ExtensionContext): boolean {
	if (!("agent" in ctx)) return false; // upstream Pi has no subagent rebinding: one session per process
	const agent: unknown = ctx.agent;
	if (typeof agent !== "object" || agent === null || !("kind" in agent)) return false;
	return agent.kind === "sub";
}

/**
 * The failure a finished turn ended with, when the host reports one.
 *
 * Pi ends a failed run with an assistant message whose `stopReason` is `error` or `aborted`
 * (`@earendil-works/pi-agent-core` types); a normal turn stops with `stop`. Read without assuming a
 * shape, because upstream Pi and oh-my-pi type this event slightly differently.
 */
function turnFailureReason(event: unknown): string | undefined {
	if (typeof event !== "object" || event === null || !("message" in event)) return undefined;
	const message: unknown = event.message;
	if (typeof message !== "object" || message === null || !("stopReason" in message)) return undefined;
	const reason = message.stopReason;
	return reason === "error" || reason === "aborted" ? reason : undefined;
}

/** Which coding agent this extension runs in; `ACE_AGENT_NAME` overrides the probe. */
function codingAgentName(pi: unknown): string {
	const override = process.env.ACE_AGENT_NAME?.trim();
	if (override !== undefined && override.length > 0) return override;
	const marker = pi !== null && typeof pi === "object" && "pi" in pi ? pi.pi : undefined;
	return marker === undefined ? "pi" : "oh-my-pi";
}

/**
 * Runtime logs go to stderr: the human face is `/ace list` (ACE writes nothing to the UI status slot), and
 * stderr is what print/RPC runs and the verify scripts already read.
 */
function createLogger(ctx: ExtensionContext): AceLogger {
	return {
		info: (line) => console.error(line),
		warn: (line) => report(ctx, line, "warning"),
		error: (line) => report(ctx, line, "error"),
	};
}

/**
 * Where oh-my-pi keeps its global state — `omp config path` reports this directory — so ACE's global
 * config file sits beside `config.yml`. A host initialised with `omp config init-xdg` keeps the same
 * information under `$XDG_CONFIG_HOME/omp` instead.
 *
 * This is the one thing the runtime cannot know: which host it runs in, and where that host puts its
 * own files. The host computes it and hands it over as a fallback candidate.
 */
export function ompGlobalConfigPath(env: Readonly<Record<string, string | undefined>>): string {
	const directory =
		env.XDG_CONFIG_HOME === undefined ? join(env.HOME ?? "", ".omp", "agent") : join(env.XDG_CONFIG_HOME, "omp");
	return join(directory, "ace.json");
}

function truncate(text: string, limit = 60): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Wrong or missing arguments get this, the way `/mcp` answers with its own usage line. */
const ACE_USAGE = "Usage: /ace list, /ace pending, /ace activate <sender> <id>, /ace stats";

/** The subcommands `/ace` offers, with the hint text its completions show — `/mcp`'s pattern. */
const ACE_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
	{ name: "list", description: "channels this session reads; publish to any channel name" },
	{ name: "pending", description: "manual events retained for activation" },
	{ name: "activate", description: "inject one retained event: /ace activate <sender> <id>" },
	{ name: "stats", description: "per-channel counters, spool windows, dead letters" },
];

/**
 * Completion candidates for `/ace`, shaped like `/mcp`'s: the action word (with its hint) while the
 * arguments are still empty, then the retained events themselves for `activate`.
 */
export function aceCompletions(
	prefix: string,
	pending: ReadonlyArray<{ sender: string; id: string; body: string }> = [],
): Array<{ value: string; label: string; description: string }> | null {
	const parts = prefix.trimStart().split(/\s+/);
	const action = parts[0] ?? "";
	if (parts.length === 1) {
		const matches = ACE_COMMANDS.filter((command) => command.name.startsWith(action));
		return matches.length === 0
			? null
			: matches.map((command) => ({
					value: `${command.name} `,
					label: command.name,
					description: command.description,
				}));
	}
	if (action !== "activate") return null;
	const typed = parts.slice(1).join(" ");
	const matches = pending.filter(
		(event) => `${event.sender} ${event.id}`.startsWith(typed) || event.sender.startsWith(typed),
	);
	return matches.length === 0
		? null
		: matches.map((event) => ({
				value: `activate ${event.sender} ${event.id}`,
				label: `${event.sender}/${event.id}`,
				description: event.body.slice(0, 60),
			}));
}

/** Marks a process that already runs an ACE runtime, whichever route loaded the extension. */
const RUNTIME_CLAIMED_MARKER = Symbol.for("ace-runtime.extension.runtime-claimed");

export default function aceExtension(pi: ExtensionAPI): void {
	/** One server this session is live on: its connection, and the channel named by this session there. */
	interface ActiveServer {
		server: ResolvedServer;
		/** This session's sender name on that server — which is also its inbox channel there. */
		sender: string;
		registry: AgentRegistry;
	}
	let sessionContext: ExtensionContext | undefined;
	let runtime: AceRuntime | undefined;
	let activeServers: ActiveServer[] = [];
	/** Channels this session reads (derived): subscribed names plus one inbox per server. */
	let subscriptions: EndpointConfig[] = [];
	/** Lazily opened writer per server URL: publishing needs no configured list of publications. */
	const addClients = new Map<string, RedisStreamsAddClient>();
	let resolvedConfig: ResolvedAceConfig | undefined;
	let sessionId: string | undefined;
	let transportErrorReported = false;
	let deadLetters: DeadLetterSink | undefined;
	let registryErrorReported: string | undefined;
	let claimedRuntime = false;
	/** The inbox the directory registered for this session; part of every channel listing while it lives. */
	let sessionInbox: EndpointConfig | undefined;
	let shuttingDown = false;

	/** Directory problems are reported once per distinct message; they never fail a session. */
	function reportRegistryError(error: unknown): void {
		const text = describeError(error);
		if (registryErrorReported === text) return;
		registryErrorReported = text;
		if (sessionContext) report(sessionContext, `[ace] agent directory: ${text}`, "warning");
		else console.error(`[ace] agent directory: ${text}`);
	}

	// Where the host's delivery cannot be trusted to reach the agent (oh-my-pi queues into an idle
	// session without starting a turn), wait for the event to appear in the conversation. Upstream Pi's
	// `sendUserMessage` always starts a turn, so wiring the observer there would add a wait with no
	// measured problem behind it.
	const host = detectHostDelivery(pi);
	const delivery = host.supportsAside ? new AceDeliveryObserver() : undefined;
	if (delivery) pi.on("message_start", (event) => delivery.accept(event));

	const adapter = new PiExtensionAdapter({
		pi,
		isIdle: () => sessionContext?.isIdle() ?? true,
		host,
		...(delivery ? { observeDelivery: delivery } : {}),
	});

	// Registered once without configuration, then re-registered at session start with the channel
	// directory. Same name replaces the definition, and Pi rebuilds tool declarations per request.
	/** Where a publish call goes: a channel on one of the servers this session is live on. */
	interface PublishTarget {
		server: ActiveServer;
		channel: string;
	}

	/**
	 * A target is a **channel name**. `<server>:<channel>` picks the server; with a single server the
	 * bare name is enough. Otherwise the name is looked up in each server's directory — that is how a
	 * peer is addressed, because a peer *is* the channel named by its sender. Guessing between two live
	 * channels would send an event to the wrong agent, so an ambiguous target fails and names them.
	 */
	async function resolvePublishTarget(name: string): Promise<PublishTarget> {
		const first = name.split(":")[0] ?? "";
		const explicit = activeServers.find((active) => active.server.name === first);
		if (explicit !== undefined && name.includes(":")) {
			const short = name.slice(first.length + 1);
			return { server: explicit, channel: complete(short, explicit.server.namespace) };
		}

		const only = activeServers.length === 1 ? activeServers[0] : undefined;
		if (only !== undefined) return { server: only, channel: complete(name, only.server.namespace) };

		const matches: Array<{ server: ActiveServer; channel: string }> = [];
		for (const active of activeServers) {
			const resolution = resolveTarget(await active.registry.list(), name);
			if (resolution.ok) matches.push({ server: active, channel: resolution.entry.channel });
		}
		const unique = matches[0];
		if (unique !== undefined && matches.length === 1) return unique;
		if (matches.length > 1) {
			throw new Error(
				TOOL_ERROR_TEXT.targetAmbiguous(
					name,
					matches.length,
					matches.map((match) => `${match.server.server.name}:${match.channel}`),
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

	/** Complete a short channel name with this server's namespace and the user's name. */
	function complete(name: string, namespace: string): string {
		return name.includes(":") && name.split(":").length >= 3
			? name
			: channelName(namespace, resolvedConfig?.username ?? "", name);
	}

	/**
	 * Publish to a channel: the stream is derived from the name, and one writer per server is opened on
	 * first use. Nothing about the address is configured, advertised, or carried by the entry.
	 */
	async function publishToChannel(target: PublishTarget, message: AceMessage): Promise<void> {
		const url = target.server.server.url;
		let writer = addClients.get(url);
		if (writer === undefined) {
			writer = createRedisStreamsAddClient(url, reportRegistryError);
			addClients.set(url, writer);
		}
		await writer.add(
			channelStreamKey(target.server.server.namespace, target.channel),
			REDIS_STREAMS_DEFAULTS.field,
			JSON.stringify(message),
		);
	}

	/** The sessions other than this one that are live right now, across every server this session is on. */
	function agentsTool(): ToolDefinition<typeof AGENTS_PARAMETERS> {
		return {
			name: ACE_TOOL_NAMES.agents,
			label: "ACE Agents",
			description: TOOL_TEXT.agents.description,
			promptGuidelines: [...TOOL_TEXT.agents.guidelines],
			parameters: AGENTS_PARAMETERS,
			async execute(_toolCallId, params) {
				if (activeServers.length === 0) {
					throw new Error(TOOL_ERROR_TEXT.noDirectory);
				}
				const agentPrefix = params.agent === undefined ? undefined : `${params.agent}:`;
				const live: Array<{ server: string; entry: RegistryEntry }> = [];
				for (const active of activeServers) {
					for (const entry of await active.registry.list()) {
						// This session is itself a live entry; listing it would be noise, not information.
						if (entry.channel === active.sender) continue;
						if (agentPrefix !== undefined && !entry.channel.startsWith(agentPrefix)) continue;
						live.push({ server: active.server.name, entry });
					}
				}
				live.sort((a, b) => b.entry.expiresAt - a.entry.expiresAt);
				const limit = Math.min(Math.max(Math.trunc(params.limit ?? 20), 1), 50);
				// A channel name is unique per server, not across servers, so name the server when there is
				// more than one; otherwise the extra column is noise.
				const many = activeServers.length > 1;
				const rows = live
					.slice(0, limit)
					.map(({ server, entry }) =>
						many ? `${server}: ${describeDiscovered(entry)}` : describeDiscovered(entry),
					);
				return {
					content: [
						{
							type: "text",
							text: formatDiscoveredSessions(rows),
						},
					],
					details: { count: rows.length },
				};
			},
		};
	}

	/**
	 * The channels this session reads and can write, straight from `.ace.json`.
	 *
	 * Read-only on purpose: there is no channel policy to mutate — whether a sender may drive the session is
	 * a decision the user makes in the conversation, not a setting here.
	 */
	function channelsTool(): ToolDefinition<typeof CHANNELS_PARAMETERS> {
		return {
			name: ACE_TOOL_NAMES.channels,
			label: "ACE Channels",
			description: channelsToolText(),
			promptGuidelines: [...TOOL_TEXT.channels.guidelines],
			parameters: CHANNELS_PARAMETERS,
			async execute() {
				if (resolvedConfig === undefined || activeServers.length === 0) {
					throw new Error(TOOL_ERROR_TEXT.notRunning);
				}
				const listing = channelListingInput(subscriptions);
				return {
					content: [
						{
							type: "text",
							text: formatChannelListing(listing.subscriptions, {
								...(sessionInbox === undefined ? {} : { derivedName: sessionInbox.name }),
							}),
						},
					],
					details: {
						subscribe: listing.subscriptions.map((endpoint) => ({
							name: endpoint.name,
							transport: endpoint.transport,
							...(endpoint.description === undefined ? {} : { description: endpoint.description }),
							...(endpoint.activation === undefined ? {} : { activation: endpoint.activation }),
							derived: endpoint.name === sessionInbox?.name,
						})),
						count: listing.subscriptions.length,
					},
				};
			},
		};
	}

	function publishTool(config?: ResolvedAceConfig): ToolDefinition<typeof PUBLISH_PARAMETERS> {
		return {
			name: ACE_TOOL_NAMES.publish,
			label: "ACE Publish",
			...buildPublishToolText(config, sessionId, activeServers[0]?.sender ?? ""),
			parameters: PUBLISH_PARAMETERS,

			async execute(_toolCallId, params) {
				// The id is the runtime's: the caller reads it back from the result instead of choosing it.
				// The sender carries a self-description, so a receiver can show who and where it is without
				// any lookup: the sender does not need to be registered anywhere in order to send.
				const id = `evt_${randomUUID()}`;
				const description = describeSender(
					hostFacts({
						codingAgent: codingAgentName(pi),
						sessionId: sessionId ?? NO_SESSION_LABEL,
						cwd: sessionContext?.cwd ?? process.cwd(),
					}),
				);
				const activation = params.activation ?? "next_turn";
				const targets = [...new Set(typeof params.target === "string" ? [params.target] : params.target)];
				const delivered: string[] = [];
				const failures: string[] = [];
				const sentStreams = new Set<string>();
				const senders: string[] = [];

				for (const name of targets) {
					try {
						const target = await resolvePublishTarget(name);
						const stream = channelStreamKey(target.server.server.namespace, target.channel);
						// The same channel twice in one call is one delivery.
						const address = `${target.server.server.url}#${stream}`;
						if (sentStreams.has(address)) {
							delivered.push(deliveredChannel(target.channel));
							continue;
						}
						sentStreams.add(address);
						if (!senders.includes(target.server.sender)) senders.push(target.server.sender);
						// A sender name belongs to one server, so the event is built per target rather than once.
						const message = validateAceMessage({
							aceVersion: "0.1",
							id,
							sender: target.server.sender,
							...(sessionId === undefined ? {} : { sessionId }),
							senderDescription: description,
							activation,
							body: params.body,
						});
						await publishToChannel(target, message);
						delivered.push(deliveredChannel(target.channel));
					} catch (error) {
						failures.push(failedTarget(name, describeError(error)));
					}
				}

				if (delivered.length === 0) {
					throw new Error(TOOL_ERROR_TEXT.nothingPublished(failures));
				}
				return {
					content: [
						{
							type: "text",
							text: formatPublishResult({
								id,
								sender: senders.join(", "),
								activation,
								delivered,
								failures,
							}),
						},
					],
					details: {
						id,
						sender: senders.join(", "),
						sessionId,
						activation,
						delivered,
						failed: failures,
						bodyLength: params.body.length,
					},
				};
			},
		};
	}

	pi.registerTool(publishTool());
	pi.registerTool(agentsTool());
	pi.registerTool(channelsTool());

	// A failed run does not reject `inject`; the failure shows up on the assistant message that ends
	// it. Watch `message_end`, not `turn_end`: oh-my-pi treats `turn_end` as a *boundary* event, and
	// merely registering for it stopped the session from ever settling (measured, 2/2 runs).
	pi.on("message_end", (event) => {
		const reason = turnFailureReason(event);
		if (reason !== undefined) adapter.reportRunFailure(new Error(`turn ended with stopReason=${reason}`));
	});

	// Trust in an event's source is a soft constraint, stated once in the system prompt instead of in
	// every injected event: the user decides, their answer lives in the conversation, and the runtime
	// neither records verdicts nor blocks senders.
	pi.on("before_agent_start", (event, ctx) => {
		if (isSubagentContext(ctx) || resolvedConfig === undefined) return;
		return { systemPrompt: withTrustPolicy(event.systemPrompt) };
	});

	pi.on("session_start", async (_event, ctx) => {
		if (isSubagentContext(ctx)) return; // one runtime, in the interactive session
		sessionContext = ctx;
		if (runtime) return;

		const currentSessionId = ctx.sessionManager.getSessionId();
		sessionId = currentSessionId;

		let resolved: ResolvedAceConfig;
		try {
			resolved = resolveAceConfig({
				cwd: ctx.cwd,
				env: process.env,
				// A project `.ace.json` wins; this is the file a session falls back to wherever it starts.
				globalConfigPaths: [ompGlobalConfigPath(process.env)],
			});
		} catch (error) {
			report(ctx, `[ace] not started: ${describeError(error)}`, "warning");
			return;
		}

		// Two instances of this extension can live in one process: plugin discovery plus an explicit
		// `--extension` both resolve to this file (subagent rebinding stops above). A second runtime would
		// join the same consumer group and silently split every channel's events between them, so only the
		// first session in the process starts one.
		const process_ = globalThis as unknown as Record<symbol, boolean | undefined>;
		if (process_[RUNTIME_CLAIMED_MARKER] === true) {
			report(
				ctx,
				"[ace] another ACE runtime already runs in this process; not starting a second one (extension discovery and --extension/-e both resolve to ace.ts — keep one)",
				"warning",
			);
			return;
		}
		process_[RUNTIME_CLAIMED_MARKER] = true;
		claimedRuntime = true;
		sessionInbox = undefined;

		const logger = createLogger(ctx);
		// Bursts are always spooled, with built-in thresholds (see DEFAULT_SPOOL_RULE); the directory is not
		// configuration, so it simply sits next to the session's other ACE state.
		const spoolDir = join(ctx.cwd, ".ace", "spool");

		// Register on every configured server, each with this session's own channel there, and read that
		// channel back. A server that is unreachable is skipped with a warning: the rest of the session
		// still runs. Nothing about the address is advertised — the channel name is the address.
		const multi = resolved.servers.length > 1;
		const derived: EndpointConfig[] = [];
		activeServers = [];
		sessionInbox = undefined;
		for (const server of resolved.servers) {
			const sender = senderName({
				namespace: server.namespace,
				username: resolved.username,
				codingAgent: codingAgentName(pi),
				sessionId: currentSessionId,
			});
			const registry = new AgentRegistry({
				store: createRedisAgentRegistry({
					url: server.url,
					namespace: server.namespace,
					onError: reportRegistryError,
				}),
				namespace: server.namespace,
				logger,
				onError: reportRegistryError,
			});
			try {
				await registry.register({
					sender,
					codingAgent: codingAgentName(pi),
					sessionId: currentSessionId,
					cwd: ctx.cwd,
				});
			} catch (error) {
				await registry.close().catch(() => {});
				report(ctx, `[ace] server "${server.name}" unreachable, skipping it: ${describeError(error)}`, "warning");
				continue;
			}
			activeServers.push({ server, sender, registry });
			const inbox = subscriptionEndpoint({
				channel: sender,
				name: multi ? `${server.name}:${SESSION_INBOX}` : SESSION_INBOX,
				url: server.url,
				namespace: server.namespace,
				sender,
				description: "this session's inbox — the channel named by its sender",
			});
			sessionInbox ??= inbox;
			derived.push(inbox);
		}
		// Subscribed channel names are read on the server they were configured for, with that server's
		// sender as the reading identity; a subscription whose server did not come up is dropped.
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
		subscriptions = derived;

		const metrics = new AceMetrics();
		// Dead letters go next to the burst files: same directory, different prefix. Nothing is written
		// until an entry is actually given up on.
		deadLetters = new DeadLetterSink({
			dir: join(ctx.cwd, ".ace"),
			logger,
			onError: (error) => report(ctx, `[ace] dead letter: ${describeError(error)}`, "error"),
		});
		runtime = new AceRuntime({
			engine: adapter,
			metrics,
			subscribe: subscriptions,
			spool: { dir: spoolDir },
			manual: resolved.manual,
			transports: createTransports(subscriptions, {
				metrics,
				onDropped: (subscription, entry) => deadLetters?.record(subscription, entry),
				onError: (error) => {
					// Teardown drops this session's own stream; a reader that is still draining would report
					// NOGROUP for a group we just removed on purpose.
					if (shuttingDown) return;
					// A broker that dies mid-session would otherwise repeat the same error.
					if (transportErrorReported) return;
					transportErrorReported = true;
					report(ctx, `[ace] transport error: ${describeError(error)}`, "error");
				},
			}),
			...(resolved.defaultActivation ? { defaultActivation: resolved.defaultActivation } : {}),
			logger,
		});

		try {
			await runtime.start();
			resolvedConfig = resolved;
			pi.registerTool(publishTool(resolved));
			const identity = activeServers.map((active) => active.sender).join(", ");
			const servers = activeServers.map((active) => `${active.server.name} (${active.sender})`).join(", ");
			// Startup chatter stays on stderr: the session UI should not repeat the same three lines every
			// time ACE starts, and stderr is what print/RPC runs and the `/ace` status already cover.
			console.error(
				`[ace] ${identity} listening (${resolved.source}): servers ${servers}; reading ${subscriptions.map(describeEndpoint).join(", ")}`,
			);
			for (const warning of resolved.warnings) console.error(`[ace] warning: ${warning}`);
		} catch (error) {
			// Nothing is running, so the next session in this process may try again.
			if (claimedRuntime) {
				process_[RUNTIME_CLAIMED_MARKER] = false;
				claimedRuntime = false;
			}
			runtime = undefined;
			resolvedConfig = undefined;
			report(
				ctx,
				`[ace] could not start: ${describeError(error)} (check the broker in .ace.json, then restart Pi)`,
				"error",
			);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (isSubagentContext(ctx)) return;
		// Order matters: `unregister` drops this session's own stream (and its group), so the reader has to
		// be gone first — otherwise it wakes up to a deleted group and reports NOGROUP on the way out.
		shuttingDown = true;
		if (claimedRuntime) {
			// A session switch inside one process starts a fresh session with a fresh runtime.
			(globalThis as unknown as Record<symbol, boolean | undefined>)[RUNTIME_CLAIMED_MARKER] = false;
			claimedRuntime = false;
		}
		const active = runtime;
		const closing = activeServers;
		const activeAddClients = [...addClients.values()];
		runtime = undefined;
		resolvedConfig = undefined;
		sessionContext = undefined;
		sessionInbox = undefined;
		deadLetters = undefined;
		subscriptions = [];
		activeServers = [];
		addClients.clear();
		// The order (reader → directory entry and stream → client) and its best-effort error handling
		// live in the runtime, so every host gets it right by construction. The reader is shared by every
		// server, so it stops once; each server's registration is then dropped and closed.
		await shutdownAce({
			runtime: active,
			onError: (step, error) => report(ctx, `[ace] ${step}: ${describeError(error)}`, "warning"),
		});
		for (const server of closing) {
			await shutdownAce({
				registry: server.registry,
				onError: (step, error) =>
					report(ctx, `[ace] ${step} (${server.server.name}): ${describeError(error)}`, "warning"),
			});
		}
		for (const writer of activeAddClients) await writer.close();
		shuttingDown = false;
	});

	pi.registerCommand("ace", {
		description: "ACE event runtime: list channels, pending manual events, activation",
		// Completions follow `/mcp`: the action word with its hint, then the retained events for `activate`.
		getArgumentCompletions: (prefix) =>
			aceCompletions(
				prefix,
				(runtime?.pendingEvents ?? []).map((event) => ({
					sender: event.message.sender,
					id: event.message.id,
					body: event.message.body,
				})),
			),
		handler: async (args, ctx) => {
			const [subcommand = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);

			if (isSubagentContext(ctx)) {
				report(ctx, "[ace] this is a subagent session; ACE runs in the main session", "warning");
				return;
			}

			if (!runtime) {
				report(ctx, `[ace] not running: add ${ACE_CONFIG_FILENAME} to ${ctx.cwd} and restart Pi`, "warning");
				return;
			}

			if (subcommand === "activate") {
				const [sender, id] = rest;
				if (!sender || !id) {
					report(ctx, "[ace] usage: /ace activate <sender> <id>", "warning");
					return;
				}
				try {
					await runtime.activatePendingEvent(sender, id);
					report(ctx, `[ace] activated ${sender}/${id}`);
				} catch (error) {
					report(ctx, `[ace] ${describeError(error)}`, "error");
				}
				return;
			}

			const pending = runtime.pendingEvents;
			if (subcommand === "stats") {
				const lines = runtime.metrics.render();
				const windows = runtime
					.openSpoolWindows()
					.map((window) => `  spooling ${window.subscription}: ${window.buffered} buffered → ${window.path}`);
				report(
					ctx,
					[
						`[ace] stats (pending manual: ${pending.length}, dead letters: ${deadLetters?.count ?? 0} → ${deadLetters?.directory ?? "none"}${activeServers.length > 0 ? `, sender ${activeServers.map((active) => active.sender).join(", ")}` : ""})`,
						...(lines.length > 0 ? lines.map((line) => `  ${line}`) : ["  (nothing yet)"]),
						...windows,
					].join("\n"),
				);
				return;
			}

			if (subcommand === "pending") {
				if (pending.length === 0) {
					report(ctx, "[ace] no pending manual events");
					return;
				}
				const lines = pending.map((event) => {
					const session =
						event.message.sessionId === undefined
							? ""
							: ` (session ${formatSessionLabel(event.message.sessionId)})`;
					return `${event.message.sender}${session}/${event.message.id}: ${truncate(event.message.body)}`;
				});
				report(ctx, `[ace] pending manual events (${pending.length}):\n${lines.join("\n")}`);
				return;
			}

			if (subcommand === "list") {
				const listing = channelListingInput(subscriptions);
				const identity = activeServers.map((active) => active.sender).join(", ");
				const describeChannel = (value: string): string[] | undefined => {
					const [direction, name] = value.split(":");
					if (direction !== "in") {
						return [`${name} is not a channel this session reads`];
					}
					const endpoint = listing.subscriptions.find((candidate) => candidate.name === name);
					if (endpoint === undefined) return undefined;
					return [
						`name: ${endpoint.name}`,
						`direction: subscribed`,
						`transport: ${endpoint.transport}`,
						`address: ${endpointAddress(endpoint) ?? "(none)"}`,
						...(endpoint.activation === undefined ? [] : [`activation: ${endpoint.activation}`]),
						...(endpoint.description === undefined ? [] : [`description: ${endpoint.description}`]),
						...(name === sessionInbox?.name
							? ["origin: named by this session's sender on the agent directory"]
							: []),
					];
				};
				const header = `${identity} (agent ${adapter.isRunning() ? "running" : "idle"})${
					resolvedConfig?.source === undefined ? "" : ` — ${resolvedConfig.source}`
				}`;
				// `/ace` with no arguments opens the manager where the host has a TUI; `/ace list` always prints, so
				// scripts and non-TUI modes keep the text report.
				if (args.trim().length === 0 && ctx.mode === "tui") {
					try {
						await showAceManager(
							ctx,
							() => ({
								title: "ACE channels",
								details: header,
								items: channelMenuItems(listing),
								empty: `No channels configured in ${ACE_CONFIG_FILENAME}.`,
							}),
							describeChannel,
						);
						return;
					} catch (error) {
						console.error(`[ace] manager view failed, printing the report instead: ${describeError(error)}`);
					}
				}
				report(
					ctx,
					formatChannelReport({
						identity,
						agentState: adapter.isRunning() ? "running" : "idle",
						...(resolvedConfig?.source === undefined ? {} : { source: resolvedConfig.source }),
						subscriptions: listing.subscriptions,
						...(sessionInbox === undefined ? {} : { derivedName: sessionInbox.name }),
						pendingManual: pending.length,
						deadLetters: {
							count: deadLetters?.count ?? 0,
							...(deadLetters?.directory === undefined ? {} : { directory: deadLetters.directory }),
						},
					}),
				);
				return;
			}

			report(ctx, ACE_USAGE, "warning");
		},
	});
}
