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
	channelStreamKey,
	channelsToolText,
	codingAgentOf,
	compareDiscoveredSessions,
	createRedisAgentRegistry,
	createRedisStreamsAddClient,
	createRedisXferClient,
	createTransports,
	DeadLetterSink,
	deliveredChannel,
	describeDiscovered,
	describeEndpoint,
	describeSender,
	detectHostDelivery,
	duplicateTarget,
	type EndpointConfig,
	endpointAddress,
	failedTarget,
	formatChannelListing,
	formatChannelReport,
	formatDiscoveredSessions,
	formatPublishResult,
	formatSessionLabel,
	GET_FILE_PARAMETERS,
	hostFacts,
	isStreamKeyShaped,
	NO_SESSION_LABEL,
	PiExtensionAdapter,
	PUBLISH_PARAMETERS,
	type PublishTargetRow,
	REDIS_STREAMS_DEFAULTS,
	type RedisStreamsAddClient,
	type RedisXferClient,
	type RegistryEntry,
	type ResolvedAceConfig,
	type ResolvedChannelTarget,
	type ResolvedServer,
	readerFactsOf,
	receiveFile,
	rejectUnknownArguments,
	resolveAceConfig,
	resolveChannelTarget,
	resolvePublishTargets,
	SESSION_INBOX,
	STORE_FILE_PARAMETERS,
	senderName,
	serverAddress,
	shutdownAce,
	storeFile,
	subscriptionEndpoint,
	TOOL_ARGUMENTS,
	TOOL_ERROR_TEXT,
	TOOL_TEXT,
	validateAceMessage,
	validateAgentsInput,
	validateGetInput,
	validatePublishInput,
	validateStoreInput,
	withTrustPolicy,
	type XferTarget,
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
	/** The channel names behind {@link subscriptions}: what a publish target is checked against. */
	let readChannels = new Set<string>();
	/** Configured subscriptions whose server did not come up: listed so the gap is visible, not silent. */
	let unavailableSubscriptions: Array<{ channel: string; server: string }> = [];
	/** Configured servers that did not come up, even with no subscription: an unreachable server is never invisible. */
	let unavailableServers: Array<{ server: string; address: string }> = [];
	/** Lazily opened writer per server URL: publishing needs no configured list of publications. */
	const addClients = new Map<string, RedisStreamsAddClient>();
	/** Lazily opened blob client per live server name: a file transfer needs its own GET/SET seam. */
	const xferClients = new Map<string, RedisXferClient>();
	let resolvedConfig: ResolvedAceConfig | undefined;
	let sessionId: string | undefined;
	let transportErrorReported = false;
	let deadLetters: DeadLetterSink | undefined;
	let registryErrorReported: string | undefined;
	let claimedRuntime = false;
	/** The inboxes the directory registered for this session, one per live server; part of every channel listing. */
	let sessionInboxes: EndpointConfig[] = [];
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
	interface PublishTarget extends ResolvedChannelTarget {
		/** The live connection for {@link ResolvedChannelTarget.server}, resolved back from the name. */
		active: ActiveServer;
	}

	/**
	 * A target is a **channel name**. The rules live in the runtime (`resolveChannelTarget`), shared with
	 * every host: a `<server>:` prefix picks that server by name (up or not), a full name belongs to the
	 * namespace it names, a short name uses the one live server or the live directory. This adapter only
	 * hands the resolver the servers it has and maps the answer back to the live connection.
	 */
	async function resolvePublishTarget(name: string): Promise<PublishTarget> {
		const target = await resolveChannelTarget({
			name,
			active: activeServers.map((active) => ({
				server: active.server,
				sender: active.sender,
				list: () => active.registry.list(),
			})),
			configured: resolvedConfig?.servers ?? [],
			username: resolvedConfig?.username ?? "",
		});
		// The resolver only ever answers with a server it was given, so this lookup cannot miss.
		const active = activeServers.find((candidate) => candidate.server.name === target.server.name);
		if (active === undefined) throw new Error(TOOL_ERROR_TEXT.noDirectory);
		return { ...target, active };
	}

	/**
	 * Publish to a channel: the stream is derived from the name, and one writer per server is opened on
	 * first use. Nothing about the address is configured, advertised, or carried by the entry.
	 */
	async function publishToChannel(target: PublishTarget, message: AceMessage): Promise<void> {
		const url = target.server.url;
		let writer = addClients.get(url);
		if (writer === undefined) {
			writer = createRedisStreamsAddClient(url, reportRegistryError);
			addClients.set(url, writer);
		}
		await writer.add(
			channelStreamKey(target.server.namespace, target.channel),
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
				// Arguments are checked before the directory is read: an undeclared key, a non-string `agent`
				// and a non-integer `limit` all fail the call. `validateAgentsInput` also normalizes a blank
				// filter to no filter, so `agent: ""` lists the directory instead of reporting it empty.
				const input = validateAgentsInput(params);
				if (activeServers.length === 0) {
					throw new Error(TOOL_ERROR_TEXT.noDirectory);
				}
				const agent = input.agent;
				const live: Array<{ server: string; entry: RegistryEntry }> = [];
				for (const active of activeServers) {
					for (const entry of await active.registry.list()) {
						// This session is itself a live entry; listing it would be noise, not information.
						if (entry.channel === active.sender) continue;
						// The filter means the coding agent a session *runs*, which its self-description states;
						// the channel name only carries it as a middle segment, behind a possible `<server>:` prefix.
						if (agent !== undefined && codingAgentOf(entry) !== agent) continue;
						live.push({ server: active.server.name, entry });
					}
				}
				// Deterministic order: by channel name, then server name. The directory listings have no stable
				// order of their own, and `renews_in` is recomputed at each call (the peer renews its lease), so
				// sorting on it would reorder rows between two calls without the peers changing; a caller that
				// re-reads the tool must see the same peers in the same places. The rule is stated in the tool
				// description.
				live.sort(compareDiscoveredSessions);
				const limit = input.limit;
				// A channel name is unique per server, not across servers, so prefix the server when there is
				// more than one: the label is exactly the `<server>:<channel>` form ace_publish accepts as a
				// target. With one server the prefix is noise, so the row stays as it is.
				const many = activeServers.length > 1;
				const rows = live.slice(0, limit).map(({ server, entry }) =>
					describeDiscovered(entry, {
						...(many ? { server } : {}),
						// The same meaning as ace_channels: a channel this session's own sender names — on
						// any server, since the per-server `continue` above only drops this server's own entry.
						self: sessionInboxes.some((inbox) => (inbox.channel ?? inbox.name) === entry.channel),
					}),
				);
				return {
					content: [
						{
							type: "text",
							text: formatDiscoveredSessions(rows, {
								servers: activeServers.map((active) => active.server.name),
								...(agent === undefined ? {} : { filter: agent }),
							}),
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
			async execute(_toolCallId, params) {
				// `ace_channels` takes no arguments at all, so any key at all is refused by name.
				rejectUnknownArguments(ACE_TOOL_NAMES.channels, params, TOOL_ARGUMENTS.channels);
				// A configured server that never came up is still worth reporting, even when no other server
				// is live to list rows for — only a missing configuration means there is nothing to say.
				if (resolvedConfig === undefined || (activeServers.length === 0 && unavailableServers.length === 0)) {
					throw new Error(TOOL_ERROR_TEXT.notRunning);
				}
				const listing = channelListingInput(subscriptions, sessionInboxes);
				return {
					content: [
						{
							type: "text",
							text: formatChannelListing(listing.subscriptions, {
								...(listing.selfChannels.length === 0 ? {} : { selfChannels: listing.selfChannels }),
								unavailable: unavailableSubscriptions,
								deadServers: unavailableServers,
							}),
						},
					],
					details: {
						subscribe: listing.subscriptions.map((endpoint) => ({
							name: endpoint.channel ?? endpoint.name,
							transport: endpoint.transport,
							...(endpoint.description === undefined ? {} : { description: endpoint.description }),
							...(endpoint.activation === undefined ? {} : { activation: endpoint.activation }),
							self: listing.selfChannels.includes(endpoint.channel ?? endpoint.name),
						})),
						count: listing.subscriptions.length,
					},
				};
			},
		};
	}

	/** The live servers as transfer targets, opening a blob client per server name on first use. */
	function xferTargets(): XferTarget[] {
		return activeServers.map((active) => {
			const existing = xferClients.get(active.server.name);
			const client =
				existing ??
				createRedisXferClient({
					url: active.server.url,
					name: active.server.name,
					// A transfer connection problem takes the directory's report path, once per message.
					onError: reportRegistryError,
				});
			if (existing === undefined) xferClients.set(active.server.name, client);
			return { name: active.server.name, namespace: active.server.namespace, client };
		});
	}

	/**
	 * Store a local file on every live server and hand back the pickup code. Nothing is published:
	 * the model relays the result line itself, so the tool's whole job is the store and the report.
	 */
	function storeFileTool(): ToolDefinition<typeof STORE_FILE_PARAMETERS> {
		return {
			name: ACE_TOOL_NAMES.storeFile,
			label: "ACE Store File",
			description: TOOL_TEXT.storeFile.description,
			promptGuidelines: [...TOOL_TEXT.storeFile.guidelines],
			parameters: STORE_FILE_PARAMETERS,
			async execute(_toolCallId, params) {
				const input = validateStoreInput(params);
				if (activeServers.length === 0) throw new Error(TOOL_ERROR_TEXT.noDirectory);
				const result = await storeFile({
					root: sessionContext?.cwd ?? process.cwd(),
					input,
					targets: xferTargets(),
				});
				return {
					content: [{ type: "text", text: result.text }],
					details: { token: result.token, size: result.size, sha256: result.sha256, storedOn: result.storedOn },
				};
			},
		};
	}

	/** Fetch a token from the first live server that has it and write it into the quarantine directory. */
	function getFileTool(): ToolDefinition<typeof GET_FILE_PARAMETERS> {
		return {
			name: ACE_TOOL_NAMES.getFile,
			label: "ACE Get File",
			description: TOOL_TEXT.getFile.description,
			promptGuidelines: [...TOOL_TEXT.getFile.guidelines],
			parameters: GET_FILE_PARAMETERS,
			async execute(_toolCallId, params) {
				const input = validateGetInput(params);
				if (activeServers.length === 0) throw new Error(TOOL_ERROR_TEXT.noDirectory);
				const result = await receiveFile({
					root: sessionContext?.cwd ?? process.cwd(),
					token: input.token,
					sessionId: sessionId ?? NO_SESSION_LABEL,
					targets: xferTargets(),
				});
				return {
					content: [{ type: "text", text: result.text }],
					details: { path: result.path, sha256: result.sha256, size: result.size, from: result.from },
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
				// Input is checked before anything is built or sent. The whole argument object goes in, not
				// just the two known fields: an undeclared key must fail the call rather than be dropped, and
				// a value the host coerced (a number, an object) must reach this check as it was written.
				const input = validatePublishInput(params, {
					servers: resolvedConfig?.servers.map((server) => server.name) ?? [],
				});
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
				const activation = input.activation ?? "next_turn";
				// Resolution and de-duplication are shared: an input that resolves to a (server, channel)
				// pair an earlier input already produced becomes a duplicate row, whatever its input string.
				const resolution = await resolvePublishTargets(input.targets, resolvePublishTarget);
				const rows: PublishTargetRow[] = [];
				const senders: string[] = [];

				for (const outcome of resolution) {
					if (outcome.kind === "failure") {
						rows.push(failedTarget(outcome.name, outcome.detail));
						continue;
					}
					if (outcome.kind === "duplicate") {
						rows.push(duplicateTarget(outcome.name, outcome.of));
						continue;
					}
					const target = outcome.target;
					try {
						// `peerNamed` (a live directory entry names it) and `selfReads` (this session reads it)
						// are two checks, not a verdict, because `peer`/`self`/`none` used to read as claims on
						// who reads even when the only reader was the publisher itself.
						const facts = readerFactsOf({
							channel: target.channel,
							live: await target.active.registry.list(),
							subscriptions: [...readChannels],
							// The directory lists this session's own registration too; without this, publishing to
							// one's own inbox would see that entry and report a `peer` that is this very session.
							own: activeServers.map((active) => active.sender),
						});
						// A channel whose name is the transport's key shape is legal, but it is a copied stream
						// key rather than an address; naming it keeps it from looking like a working target.
						const streamKey = isStreamKeyShaped(target.channel);
						if (!senders.includes(target.sender)) senders.push(target.sender);
						// A sender name belongs to one server, so the event is built per target rather than once.
						const message = validateAceMessage({
							aceVersion: "0.1",
							id,
							sender: target.sender,
							...(sessionId === undefined ? {} : { sessionId }),
							senderDescription: description,
							activation,
							body: input.body,
						});
						await publishToChannel(target, message);
						rows.push(deliveredChannel(target.channel, facts, { streamKey }));
					} catch (error) {
						rows.push(failedTarget(outcome.name, describeError(error)));
					}
				}

				const failed = rows.filter(
					(row): row is Extract<PublishTargetRow, { status: "failed" }> => row.status === "failed",
				);
				const text = formatPublishResult({ id, sender: senders.join(","), activation, rows });
				// Nothing delivered is a failed call, but its text is the same field list — `delivered=0` with one
				// `status=failed` row per input — so the result shape does not depend on how many targets succeeded.
				if (!rows.some((row) => row.status === "delivered")) throw new Error(text);
				return {
					content: [{ type: "text", text }],
					details: {
						id,
						sender: senders.join(","),
						sessionId,
						activation,
						rows,
						delivered: rows.filter((row) => row.status === "delivered").length,
						failed: failed.length,
						duplicates: rows.filter((row) => row.status === "duplicate").length,
						bodyLength: input.body.length,
					},
				};
			},
		};
	}

	pi.registerTool(publishTool());
	pi.registerTool(agentsTool());
	pi.registerTool(channelsTool());
	pi.registerTool(storeFileTool());
	pi.registerTool(getFileTool());

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
		sessionInboxes = [];

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
		readChannels = new Set();
		unavailableSubscriptions = [];
		unavailableServers = [];
		sessionInboxes = [];
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
				unavailableServers.push({ server: server.name, address: serverAddress(server.url) });
				report(ctx, `[ace] server "${server.name}" unreachable, skipping it: ${describeError(error)}`, "warning");
				continue;
			}
			activeServers.push({ server, sender, registry });
			readChannels.add(sender);
			const inbox = subscriptionEndpoint({
				channel: sender,
				name: multi ? `${server.name}:${SESSION_INBOX}` : SESSION_INBOX,
				url: server.url,
				namespace: server.namespace,
				sender,
				description: "this session's inbox — the channel named by its sender",
			});
			sessionInboxes.push(inbox);
			derived.push(inbox);
		}
		// Subscribed channel names are read on the server they were configured for, with that server's
		// sender as the reading identity; a subscription whose server did not come up is dropped from the
		// readers and recorded as unavailable, so `ace_channels` can show the gap instead of hiding it.
		for (const subscribed of resolved.subscriptions) {
			const owner = activeServers.find((active) => active.server.name === subscribed.server.name);
			if (owner === undefined) {
				unavailableSubscriptions.push({ channel: subscribed.channel, server: subscribed.server.name });
				continue;
			}
			readChannels.add(subscribed.channel);
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
			// An event from one of these senders is this session's own publish echoed back by a channel
			// it reads; the block says `self: yes` so an echo cannot masquerade as a peer's message.
			selfSenders: activeServers.map((active) => active.sender),
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
		const activeXferClients = [...xferClients.values()];
		runtime = undefined;
		resolvedConfig = undefined;
		sessionContext = undefined;
		sessionInboxes = [];
		deadLetters = undefined;
		subscriptions = [];
		readChannels = new Set();
		unavailableSubscriptions = [];
		unavailableServers = [];
		activeServers = [];
		addClients.clear();
		xferClients.clear();
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
		for (const client of activeXferClients) await client.close();
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
				const listing = channelListingInput(subscriptions, sessionInboxes);
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
						...(sessionInboxes.some((inbox) => name === (inbox.channel ?? inbox.name))
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
						...(listing.selfChannels.length === 0 ? {} : { selfChannels: listing.selfChannels }),
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
