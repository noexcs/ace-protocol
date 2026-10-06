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
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
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
	type ChannelReport,
	channelListingInput,
	channelStreamKey,
	channelsToolText,
	codingAgentOf,
	compareDiscoveredSessions,
	configRemovedChannels,
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
	formatDurationHuman,
	formatPublishResult,
	formatSessionLabel,
	GET_FILE_PARAMETERS,
	hostFacts,
	NO_SESSION_LABEL,
	PiExtensionAdapter,
	PUBLISH_PARAMETERS,
	type PublishTargetRow,
	REDIS_STREAMS_DEFAULTS,
	REGISTRY_DEFAULTS,
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
	resolveLocalName,
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
import {
	type AcePanel,
	type AgentRow,
	type AgentsPanelInput,
	agentsPanel,
	type ChannelDetails,
	channelForMenuValue,
	channelMenuItems,
	channelPanel,
	helpPanel,
	type PendingRow,
	pendingPanel,
	renderAcePanel,
	showAceManager,
	statsPanel,
} from "./ace-manager.ts";

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
 * Runtime logs go to stderr: the human face is `/ace`, and stderr is what print/RPC runs and the verify scripts
 * already read. (The TUI status line is a summary, not a log: it is written by {@link refreshStatus}.)
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

/**
 * Whether any configuration file is actually there — the same candidates {@link resolveAceConfig} reads, in
 * the same order, without parsing any of them.
 *
 * `/ace` needs this to tell the two failure modes apart: with no file anywhere the fix is to create one, and
 * with a file that will not parse the fix is to repair it. Guessing from the error text would break the day
 * the runtime rewords that message.
 */
function configFileExists(cwd: string): boolean {
	return [process.env.ACE_CONFIG, join(cwd, ACE_CONFIG_FILENAME), ompGlobalConfigPath(process.env)].some(
		(path) => path !== undefined && path.length > 0 && existsSync(path),
	);
}

function truncate(text: string, limit = 60): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * What only this host knows, appended to the tool descriptions as a `Host specifics:` paragraph.
 *
 * The core tool text states protocol semantics; these are oh-my-pi's own commands, limits and file
 * locations, so they belong to the host that implements them. Keeping them out of the core is what
 * stops one host's implementation from leaking into every host's prompt — and from rotting there when
 * this host's version changes.
 *
 * It is two unrelated paragraphs, and each tool gets only the ones it needs: the config-resolution
 * paragraph answers "where does `.ace.json` come from" and belongs to every tool that reads it, while
 * the `manual` retention store is only explained where `manual` activation is (the publish tool).
 */
const OMP_CONFIG_SPECIFICS =
	"The config file is resolved from `$ACE_CONFIG`, then the project `.ace.json`, then this host's " +
	"global file (`~/.omp/agent/ace.json`, or under `$XDG_CONFIG_HOME/omp` when `omp config init-xdg` was " +
	"used) — the first that exists wins — and the file that won and the global one it shadowed are both " +
	"printed at session start.";

/** The `manual` retention store: the publish tool's business only (see {@link OMP_CONFIG_SPECIFICS}). */
const OMP_MANUAL_SPECIFICS =
	"A `manual` event here is held in an in-memory pending store — 100 events " +
	"and 24h by default, spooled to `.ace/spool/manual-<subscription>.jsonl` — which this host's user " +
	"inspects and activates with `/ace pending` and `/ace activate <sender> <id>`.";

/** The publish tool is where `manual` is explained, so it carries both paragraphs. */
const OMP_PUBLISH_SPECIFICS = `${OMP_CONFIG_SPECIFICS} ${OMP_MANUAL_SPECIFICS}`;

/**
 * The `k=v` fields of a sender description that a person reads in `/ace agents`, named and ordered the way
 * `describeSender` writes them. The rest of that blob (`host`, `ip`, `platform`, `pid`) is debugging detail:
 * it belongs to the directory record and to the machine listing, not to a human row (see
 * {@link compactDescription}).
 */
const HUMAN_DESCRIPTION_FIELDS = ["agent", "session", "cwd"] as const;

/**
 * A peer's registry description as `/ace agents` shows it: the blob our own publisher writes into the directory
 * (`agent=… | session=… | cwd=… | host=… | ip=… | platform=… | pid=…`) is a machine record, and a person reading
 * the directory wants who runs there and where — the coding agent, the session, the working directory. The
 * debugging fields (`host`, `ip`, `platform`, `pid`) stay in the record itself and in what `ace_agents` returns;
 * nothing is rewritten where it is stored.
 *
 * A description that is not our blob — a foreign sender's own text, a different shape — is not touched: if none
 * of the fields a human uses is present, the description is shown whole, verbatim.
 */
export function compactDescription(description: string): string {
	const kept = description
		.split("|")
		.map((field) => field.trim())
		.filter((field) => HUMAN_DESCRIPTION_FIELDS.some((key) => field.startsWith(`${key}=`)));
	return kept.length === 0 ? description : kept.join(" | ");
}

/** Wrong or missing arguments get this, the way `/mcp` answers with its own usage line. */
const ACE_USAGE =
	"Usage: /ace (no argument opens the channel manager), /ace list, /ace pending, /ace agents [filter], " +
	"/ace activate [<sender> [<id>]], /ace stats, /ace help";

/** The subcommands `/ace` offers, with the hint text its completions show — `/mcp`'s pattern. */
const ACE_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
	{ name: "list", description: "channels this session reads; publish to any channel name" },
	{ name: "pending", description: "manual events retained for activation" },
	{ name: "activate", description: "inject one retained event: /ace activate <sender> <id>" },
	{ name: "agents", description: "other live sessions on the agent directory; optional coding-agent filter" },
	{ name: "stats", description: "per-channel counters, spool windows, dead letters" },
	{ name: "help", description: "list these commands" },
];

/** One retained `manual` event, as `/ace pending` and `/ace activate` read it (RFC §7.3). */
type PendingManualEvent = { message: AceMessage; subscriptionName: string; storedAt: number };

/**
 * How old a retained event must be before `/ace pending` flags it `(expires soon)`: the default retention is
 * 24h (`manual.ttlMs`), so four hours of warning leave room to act. The marker means "the window is closing",
 * not "this one is old" — an event kept for three days by a longer `ttlMs` is never flagged early.
 */
const PENDING_EXPIRES_SOON_MS = 20 * 60 * 60 * 1000;

/**
 * `/ace help` (and `/ace ?`, the help word every other host already accepts): the command list, in the same
 * order the completions offer, with bare `/ace` first because it is the one entry that has no argument word.
 */
function aceHelpText(): string {
	return [
		"[ace] commands:",
		"  /ace — open the channel manager where the host has one; /ace list prints the report in any mode",
		...ACE_COMMANDS.map((command) => `  ${command.name} — ${command.description}`),
	].join("\n");
}

/**
 * Completion candidates for `/ace`, shaped like `/mcp`'s: the action word (with its hint) while the argument is
 * still empty, the retained events for `activate`, and a hint — never silence — for every other subcommand,
 * because a completion list that comes back empty reads as a broken command, not as "this one takes no
 * argument".
 *
 * A candidate's `value` is the **whole argument text** (`activate ci evt_1`), and the host is why: it hands
 * `getArgumentCompletions` the argument text itself and replaces exactly that span with the chosen `value`
 * (`CombinedAutocompleteProvider.getSuggestions` / `applyCompletion`). Measured against omp 18.5.0 with a probe
 * command: typing `/probe one two` and completing produced the callback argument `prefix="one two"` and the
 * line `/probe PROBEVAL`. A value carrying only the remaining suffix would therefore delete the words the user
 * had already typed.
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
	if (action === "activate") {
		const typed = parts.slice(1).join(" ");
		const matches = pending.filter(
			(event) => `${event.sender} ${event.id}`.startsWith(typed) || event.sender.startsWith(typed),
		);
		return matches.length === 0
			? null
			: matches.map((event) => {
					const short = formatSessionLabel(event.id);
					return {
						// The value stays whole — it is what activates the event — while the label a person reads
						// carries only the id's tail (`formatSessionLabel`), the same shortening `/ace pending` uses.
						value: `activate ${event.sender} ${event.id}`,
						label: `${event.sender}/${short === event.id ? short : `…${short}`}`,
						description: event.body.slice(0, 60),
					};
				});
	}
	const command = ACE_COMMANDS.find((candidate) => candidate.name === action);
	if (command === undefined) return null;
	// The other subcommands take no argument, or (for `agents`) a free-form one no local list can enumerate.
	// The value is the text as it stands, so accepting the hint leaves the line exactly as the user typed it.
	return [
		{
			value: prefix,
			label: action,
			description: action === "agents" ? "optional coding-agent filter, e.g. codex" : `${action} takes no arguments`,
		},
	];
}

/** Marks a process that already runs an ACE runtime, whichever route loaded the extension. */
/**
 * What the ACE instance that owns this process publishes for a duplicate load to call.
 *
 * Measured against omp 18.5.0: the host resolves a registered command from the definitions that exist when it
 * loads the extensions, so a later `registerCommand` does not reach `/ace` — with the plugin discovered *and*
 * an explicit `--extension` of the same file, `/ace` stays bound to the copy that lost the runtime claim and
 * answers "not running". The owner therefore publishes this handle, and the other copy delegates to it, after
 * checking that both are looking at the same session (`cwd` and session id), which is the only case in which
 * delegating cannot mix two sessions' identities.
 */
const LIVE_ACE_MARKER = Symbol.for("ace-runtime.extension.live");

/** The minimal surface a duplicate copy calls: the owner's own `/ace` handler, plus what identifies it. */
interface LiveAceHandle {
	cwd: string;
	sessionId: string;
	command: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

const RUNTIME_CLAIMED_MARKER = Symbol.for("ace-runtime.extension.runtime-claimed");

/**
 * The one piece of wiring the host cannot hand the extension, so the extension builds it — unless a
 * caller passes one in.
 *
 * Production calls `aceExtension(pi)`: the extension probes the host and builds its own delivery
 * observer for oh-my-pi. The extension test injects an observer here so it can drive the host's
 * `agent_settled` / `session_shutdown` signals against a real pending observation, using the same
 * fake `ExtensionAPI` the other extension tests use.
 */
export interface AceExtensionInternals {
	/** Use this delivery observer instead of the host-detected one. */
	delivery?: AceDeliveryObserver;
}

export default function aceExtension(pi: ExtensionAPI, internals: AceExtensionInternals = {}): void {
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
	/** The handle this instance published for a duplicate copy, while it owns the runtime. */
	let liveHandle: LiveAceHandle | undefined;
	/**
	 * Why this session started without a runtime, in the words `/ace` should repeat — `undefined` when no
	 * configuration file was found at all, so the command can tell "create a file" from "fix this file".
	 */
	let startupFailure: string | undefined;
	/** The heartbeat that keeps the footer status line current; started with the runtime, cleared on shutdown. */
	let statusTimer: NodeJS.Timeout | undefined;
	/** One status refresh at a time: a slow directory read must not stack up behind the heartbeat. */
	let statusRefreshing = false;
	/**
	 * The label the human face shows for each channel: the local name the configuration file used
	 * (`from-wsl`), not the uploaded name the tools address (`ace:ana:from-wsl`). Only `/ace list` and the
	 * manager read it; `ace_channels` and the runtime keep the names they were given.
	 */
	const reportLabels = new Map<string, string>();
	/** The server each channel lives on, keyed by channel: the report prefixes a row with it when several are live. */
	const reportServers = new Map<string, string>();
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
	const delivery = internals.delivery ?? (host.supportsAside ? new AceDeliveryObserver() : undefined);
	if (delivery) pi.on("message_start", (event) => delivery.accept(event));

	const adapter = new PiExtensionAdapter({
		pi,
		isIdle: () => sessionContext?.isIdle() ?? true,
		host,
		// Runtime log lines go to stderr (see `createLogger`); a suppressed duplicate is reported here so a
		// host can tell adapter-level duplication from render-level duplication.
		logger: { info: (line) => console.error(line) },
		...(delivery ? { observeDelivery: delivery } : {}),
	});

	/**
	 * End every queued wait whose text never surfaced in the run it was queued for.
	 *
	 * A queued `aside`/`followUp` has no wall clock — its surface time is the next step boundary —
	 * so a run that settles without surfacing one used to leave the wait pending forever: the entry
	 * was never acked, the transport's `inFlight` guard kept skipping it, and one of the 256
	 * delivery-queue slots was gone for good. `agent_settled` is the signal that ends that: it fires
	 * only once no automatic retry, compaction or queued continuation will run, so nothing more from
	 * that run is coming. Releasing fails the wait as *not delivered* (never as a surface), `inject`
	 * rejects, the entry leaves `inFlight`, and reclaim → `reclaimAttempts` → the dead-letter file
	 * take over.
	 *
	 * Idempotent by construction: the observer drops a waiter the moment its text surfaces, so a
	 * delivery that already surfaced is never released, and a repeat signal finds nothing pending.
	 * It also cannot touch the adapter's identity record, so a redelivery re-attaches to the
	 * observation instead of calling `sendUserMessage` again.
	 */
	function releaseUnsurfacedDeliveries(): void {
		delivery?.failPending();
	}
	pi.on("agent_settled", () => releaseUnsurfacedDeliveries());

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

	/**
	 * A sender as a person reads it: the session-id segment shortened to its tail, which is exactly the label
	 * the runtime's logs and rendered events already put on a session ({@link formatSessionLabel}). A sender
	 * name is `<namespace>:<username>:<coding agent>:<session id>`, so only the last segment can want
	 * shortening — a short name is returned untouched.
	 *
	 * This is for *labels about this session* (the `/ace list` header, the start-up lines). A name in a
	 * target position is never shortened: the manager's detail view keeps `name:`/`address:` verbatim, so the
	 * exact address stays discoverable.
	 */
	function shortSender(sender: string): string {
		const segments = sender.split(":");
		const id = segments[segments.length - 1] ?? "";
		const short = formatSessionLabel(id);
		return segments.length < 4 || short === id ? sender : [...segments.slice(0, -1), `…${short}`].join(":");
	}

	/** What one directory read yields: the rows to show, plus the shape a caller needs to render them. */
	interface LiveDirectory {
		/** Every other live session, in the directory's stable order. */
		live: Array<{ server: string; entry: RegistryEntry }>;
		/** The servers this session is live on, in registration order. */
		servers: string[];
		/** Whether more than one server is live, so a channel name needs its `<server>:` prefix to be a target. */
		many: boolean;
	}

	/**
	 * Every other live session this session can see, across every server it is on — one answer for both
	 * `ace_agents` and `/ace agents`, so the model's view of the directory and the human's cannot disagree.
	 *
	 * Three rules, stated here once instead of twice: this session's own entry on each server is dropped (it
	 * is not a peer), the optional filter matches the coding agent a session *runs* — which its
	 * self-description states, not the channel name — and the order is the runtime's stable `(channel,
	 * server)` order, because `renews_in` shrinks as peers renew and sorting on it would reorder rows
	 * between two calls without anyone changing.
	 */
	async function discoverLiveSessions(agent: string | undefined): Promise<LiveDirectory> {
		const live: Array<{ server: string; entry: RegistryEntry }> = [];
		for (const active of activeServers) {
			for (const entry of await active.registry.list()) {
				if (entry.channel === active.sender) continue;
				if (agent !== undefined && codingAgentOf(entry) !== agent) continue;
				live.push({ server: active.server.name, entry });
			}
		}
		live.sort(compareDiscoveredSessions);
		return { live, servers: activeServers.map((active) => active.server.name), many: activeServers.length > 1 };
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
				const { live, servers, many } = await discoverLiveSessions(input.agent);
				// A channel name is unique per server, not across servers, so prefix the server when there is
				// more than one: the label is exactly the `<server>:<channel>` form ace_publish accepts as a
				// target. With one server the prefix is noise, so the row stays as it is.
				const rows = live.slice(0, input.limit).map(({ server, entry }) =>
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
								servers,
								...(input.agent === undefined ? {} : { filter: input.agent }),
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
			description: channelsToolText({ hostSpecifics: OMP_CONFIG_SPECIFICS }),
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
				// `.ace.json` was read once at session start, so a channel removed since then is still read
				// until restart. Re-resolve the current file here (best-effort) and mark those rows.
				const removed =
					resolvedConfig === undefined
						? []
						: configRemovedChannels({
								subscriptions: resolvedConfig.subscriptions,
								cwd: sessionContext?.cwd ?? process.cwd(),
								env: process.env,
								globalConfigPaths: [ompGlobalConfigPath(process.env)],
							});
				return {
					content: [
						{
							type: "text",
							text: formatChannelListing(listing.subscriptions, {
								...(listing.selfChannels.length === 0 ? {} : { selfChannels: listing.selfChannels }),
								unavailable: unavailableSubscriptions,
								deadServers: unavailableServers,
								...(removed.length === 0 ? {} : { configRemoved: removed }),
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
	 * Store a local file on every live server and hand back the token. Nothing is published:
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
			...buildPublishToolText(config, sessionId, activeServers[0]?.sender ?? "", OMP_PUBLISH_SPECIFICS),
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
						// A resolved channel that differs from the input name means the runtime completed a
						// short name (`noexcs:inbox` → `ace:noexcs:noexcs:inbox`); a full name is stored as
						// written, so the caller sees which name the event actually landed on.
						const completedShortName = outcome.name !== target.channel;
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
						rows.push(deliveredChannel(target.channel, facts, { completedShortName }));
					} catch (error) {
						rows.push(failedTarget(outcome.name, describeError(error)));
					}
				}

				const failed = rows.filter(
					(row): row is Extract<PublishTargetRow, { status: "failed" }> => row.status === "failed",
				);
				const text = formatPublishResult({ id, sender: senders.join(","), activation, rows });
				// Nothing stored is a failed call, but its text is the same field list — `stored=0` with one
				// `status=failed` row per input — so the result shape does not depend on how many targets succeeded.
				if (!rows.some((row) => row.status === "stored")) throw new Error(text);
				// A delivery is one of the moments the status line's numbers can change (the peer count comes from
				// the same directory walk, and a peer may have appeared while this call was resolving targets).
				void refreshStatus();
				return {
					content: [{ type: "text", text }],
					details: {
						id,
						sender: senders.join(","),
						sessionId,
						activation,
						rows,
						stored: rows.filter((row) => row.status === "stored").length,
						failed: failed.length,
						duplicates: rows.filter((row) => row.status === "duplicate").length,
						bodyLength: input.body.length,
					},
				};
			},
		};
	}

	// The five ACE tools and the `/ace` command are registered by `registerOwnedSurfaces`: at the end of this
	// factory, and again by the instance that takes this process's runtime claim (see `session_start`).

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

		const process_ = globalThis as unknown as Record<symbol, unknown>;
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
			const message = describeError(error);
			// A file that is there but will not parse and a file that is not there at all need different
			// fixes, so `/ace` repeats which one this was (`undefined` = nothing to fix, something to create).
			startupFailure = configFileExists(ctx.cwd) ? `config error: ${message}` : undefined;
			report(ctx, `[ace] not started: ${message}`, "warning");
			return;
		}

		// The runtime claim below is also the *surface* claim, and it is the only one needed: whoever runs this
		// process's ACE is the instance whose `/ace` and tools must be the ones the host keeps. Two instances of
		// this file in one session (plugin discovery plus an explicit `--extension` of the same path) both
		// register at load time, and the host keeps the **last** definition of a name — which would be the copy
		// that then refuses to start a second runtime. Measured against omp 18.5.0 with both routes loaded:
		// `/ace agents` reached that copy and answered `not running: another ACE runtime already runs…`, as if
		// ACE were absent. So the winner re-registers the surfaces right after it takes the claim, and the loser
		// registers nothing at all.
		if (process_[RUNTIME_CLAIMED_MARKER] === true) {
			startupFailure =
				"another ACE runtime already runs in this process — this copy is inactive: drop the redundant --extension/-e flag (a linked plugin is discovered by itself)";
			report(ctx, `[ace] not starting a second runtime: ${startupFailure}`, "warning");
			return;
		}
		process_[RUNTIME_CLAIMED_MARKER] = true;
		claimedRuntime = true;
		registerOwnedSurfaces();
		liveHandle = {
			cwd: ctx.cwd,
			sessionId: currentSessionId,
			command: (commandArgs, commandCtx) => aceCommand.handler(commandArgs, commandCtx),
		};
		process_[LIVE_ACE_MARKER] = liveHandle;
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
		reportLabels.clear();
		reportServers.clear();
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
			// The human face names this row by the inbox label the file uses (`session-inbox`), not by the
			// sender name the tools address; the row's own channel is the sender name either way.
			reportLabels.set(sender, SESSION_INBOX);
			reportServers.set(sender, server.name);
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
			reportServers.set(subscribed.channel, subscribed.server.name);
			// The human report shows the name the file used (`from-wsl`), not the uploaded one
			// (`ace:ana:from-wsl`): the row already carries the server prefix and the publishable target, and
			// the channel name in `(as "…")` is a label, not an address. Recomputing the upload name from each
			// configured entry is the only way back to the local name — the resolver keeps the channel only.
			reportLabels.set(
				subscribed.channel,
				(subscribed.server.subscribe ?? []).find(
					(local) =>
						resolveLocalName({
							namespace: subscribed.server.namespace,
							username: resolved.username,
							name: local,
						}) === subscribed.channel,
				) ?? subscribed.channel,
			);
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
			startupFailure = undefined;
			pi.registerTool(publishTool(resolved));
			// Two human lines, and the width hogs are gone: the stream key, the transport kind and the lease
			// ttl used to sit in the middle of a startup sentence nothing could read. They stay in the runtime's
			// own log lines and in the manager's detail view; `ACE_DEBUG=1` prints the full reading list here.
			// Startup chatter stays on stderr: stderr is what print/RPC runs and the verify harness read.
			const identity = [...new Set(activeServers.map((active) => shortSender(active.sender)))].join(", ");
			for (const active of activeServers) {
				console.error(
					`[ace] up ${shortSender(active.sender)} on ${active.server.name} (ns=${active.server.namespace})`,
				);
			}
			console.error(`[ace] ${identity} · config ${resolved.source} · ${subscriptions.length} channel(s)`);
			if (process.env.ACE_DEBUG === "1") {
				console.error(`[ace] reading ${subscriptions.map(describeEndpoint).join(", ")}`);
			}
			for (const warning of resolved.warnings) console.error(`[ace] warning: ${warning}`);
			// The footer status line follows the same ~30s cadence the directory heartbeat renews its leases on
			// (`REGISTRY_DEFAULTS.refreshMs`), so the peer count is at most one heartbeat stale and no second
			// magic number enters the file.
			statusTimer = setInterval(() => void refreshStatus(), REGISTRY_DEFAULTS.refreshMs);
			statusTimer.unref();
			void refreshStatus();
		} catch (error) {
			// Nothing is running, so the next session in this process may try again.
			if (claimedRuntime) {
				process_[RUNTIME_CLAIMED_MARKER] = false;
				claimedRuntime = false;
			}
			runtime = undefined;
			resolvedConfig = undefined;
			startupFailure = `could not start: ${describeError(error)}`;
			report(
				ctx,
				`[ace] could not start: ${describeError(error)} (check the broker in .ace.json, then restart Pi)`,
				"error",
			);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (isSubagentContext(ctx)) return;
		// The status line describes a running runtime, and this session is going away: stop the heartbeat and
		// clear the slot, so no stale peer count survives into whatever the host shows next.
		if (statusTimer !== undefined) {
			clearInterval(statusTimer);
			statusTimer = undefined;
		}
		if (typeof ctx.ui.setStatus === "function") ctx.ui.setStatus("ace", undefined);
		// Backstop for `agent_settled`: a session can end mid-run. Must run *before* `shutdownAce`
		// stops the reader — the transport's `stop()` drains the delivery queue, and a queued wait
		// that never gets released would make that drain hang on the entry it is holding.
		releaseUnsurfacedDeliveries();
		// Order matters: `unregister` drops this session's own stream (and its group), so the reader has to
		// be gone first — otherwise it wakes up to a deleted group and reports NOGROUP on the way out.
		shuttingDown = true;
		const process_ = globalThis as unknown as Record<symbol, unknown>;
		if (process_[LIVE_ACE_MARKER] === liveHandle) process_[LIVE_ACE_MARKER] = undefined;
		liveHandle = undefined;
		if (claimedRuntime) {
			// A session switch inside one process starts a fresh session with a fresh runtime.
			process_[RUNTIME_CLAIMED_MARKER] = false;
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
		reportLabels.clear();
		reportServers.clear();
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

	/**
	 * The channel listing the human face draws: the same rows, each named by the local label the configuration
	 * file used instead of the uploaded name the tools address.
	 *
	 * Only `/ace list` and the manager read this. `ace_channels`, the spool file names and every log line keep
	 * exactly the names they were given, so nothing model-visible or on-disk moves.
	 */
	function humanListing(listing: { subscriptions: readonly EndpointConfig[]; selfChannels: readonly string[] }): {
		subscriptions: readonly EndpointConfig[];
		selfChannels: readonly string[];
	} {
		return {
			subscriptions: listing.subscriptions.map((endpoint) => {
				const label = reportLabels.get(endpoint.channel ?? endpoint.name);
				return label === undefined || label === endpoint.name ? endpoint : { ...endpoint, name: label };
			}),
			selfChannels: listing.selfChannels,
		};
	}

	/**
	 * `/ace agents [filter]`: the same directory `ace_agents` reads, in a TUI as the panel grammar in the
	 * session's record and everywhere else as the lines this host has always printed.
	 *
	 * The rows are built once and rendered twice, so the panel text and the report cannot disagree about who
	 * is live or how long a peer's lease has left.
	 */
	async function agentsCommand(filter: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
		const { live, servers, many } = await discoverLiveSessions(filter);
		const rows: AgentRow[] = live.map(({ server, entry }) => ({
			// The name is the publish-ready target: with several servers it already carries the `<server>:`
			// prefix, so the row needs no second copy of the server name.
			target: many ? `${server}:${entry.channel}` : entry.channel,
			renewsIn: Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000)),
			description: JSON.stringify(compactDescription(entry.description)),
		}));
		// What this session is itself registered as: the directory lists these too, and the rows above exclude
		// them, so the count and the rows stay reconcilable.
		const mine = activeServers.map((active) =>
			many ? `${active.server.name}:${shortSender(active.sender)}` : shortSender(active.sender),
		);
		if (showPanel(ctx, () => agentsPanel({ rows, servers, mine, filter }))) return;
		report(ctx, agentsReport({ rows, servers, mine, filter }));
	}

	/** The printed `/ace agents` report, from the same rows the panel text carries. */
	function agentsReport(input: AgentsPanelInput): string {
		const where = `(servers: ${input.servers.join(", ")})`;
		// Two empty directories, two different pieces of news: a filter that matched nothing blames the filter,
		// an empty directory says nobody is registered at all.
		if (input.rows.length === 0) {
			return input.filter === undefined
				? `[ace] no other live sessions ${where}`
				: `[ace] no live session matches agent filter ${JSON.stringify(input.filter)} ${where}`;
		}
		const rows = input.rows.map(
			(row) => `  ${row.target} — renews in ${formatDurationHuman(row.renewsIn)} — ${row.description}`,
		);
		return [
			`[ace] live agents (${input.rows.length}) — servers ${input.servers.join(", ")}`,
			...rows,
			`  (this session: ${input.mine.join(", ")} — not listed)`,
		].join("\n");
	}

	/**
	 * `/ace pending`: the retained `manual` events, as the panel text in a TUI and as lines everywhere else.
	 *
	 * The rows are built once, so the panel text and the report cannot disagree about what is waiting.
	 */
	function pendingCommand(ctx: ExtensionCommandContext, events: readonly PendingManualEvent[]): void {
		const rows = pendingRows(events);
		if (showPanel(ctx, () => pendingPanel(rows))) return;
		report(ctx, pendingReport(rows));
	}

	/** The retained events as rows: the full id stays in `/ace activate`'s own listing, never as a value to type. */
	function pendingRows(events: readonly PendingManualEvent[]): PendingRow[] {
		const now = Date.now();
		return events.map((event) => {
			const ageMs = Math.max(0, now - event.storedAt);
			const short = formatSessionLabel(event.message.id);
			return {
				sender: event.message.sender,
				// A label, not a value to type: the full id is what `/ace activate` lists and takes, and the row
				// only needs to tell two retained events apart while someone reads the list.
				idLabel: short === event.message.id ? short : `…${short}`,
				...(event.message.sessionId === undefined
					? {}
					: { sessionLabel: formatSessionLabel(event.message.sessionId) }),
				ageSeconds: ageMs / 1000,
				subscription: event.subscriptionName,
				expiring: ageMs >= PENDING_EXPIRES_SOON_MS,
				body: truncate(event.message.body),
			};
		});
	}

	/** The printed `/ace pending` report, short enough to scan in one screen. */
	function pendingReport(rows: readonly PendingRow[]): string {
		if (rows.length === 0) return "[ace] no pending manual events";
		const lines = rows.map(
			(row) =>
				`  ${[
					row.sender,
					...(row.sessionLabel === undefined ? [] : [`session ${row.sessionLabel}`]),
					row.idLabel,
					`${formatDurationHuman(row.ageSeconds)} ago`,
					row.subscription,
					...(row.expiring ? ["(expires soon)"] : []),
				].join(" · ")} — ${JSON.stringify(row.body)}`,
		);
		return [
			`[ace] pending manual events (${rows.length}):`,
			...lines,
			"activate with: /ace activate <sender> <id>",
		].join("\n");
	}

	/**
	 * `/ace activate [<sender> [<id>]]`: name exactly one retained event and inject it.
	 *
	 * The identity is an exact `(sender, id)` pair, never a prefix of one. `PendingEventStore.take` answers the
	 * first exact match, so completing a prefix would silently activate a *different* event than the one the
	 * user meant; "no such event", "several events from that sender" and "several pending in total" all answer
	 * with the candidate list, one runnable command per event. With no argument at all a single pending event
	 * is unambiguous and is activated directly, and several are a list to choose from — the chooser is a
	 * printed command, never `ctx.ui.select`, because the host's `--auto-approve` picks a selector's first row
	 * by itself, which is how the wrong event would get activated.
	 */
	async function activateCommand(rest: readonly string[], ctx: ExtensionCommandContext): Promise<string> {
		const active = runtime;
		if (active === undefined) return notRunningMessage(ctx.cwd);
		const pending = active.pendingEvents;
		if (pending.length === 0) return "[ace] no pending manual events";
		const runnable = (event: PendingManualEvent): string =>
			`  /ace activate ${event.message.sender} ${event.message.id} — ${JSON.stringify(truncate(event.message.body))}`;
		const [sender, id] = rest;
		const matches =
			sender === undefined
				? []
				: pending.filter(
						(event) => event.message.sender === sender && (id === undefined || event.message.id === id),
					);
		// Exactly one candidate activates: with no argument it is the only pending event, with a sender it is
		// that sender's only event, and with a sender and an id it is the exact pair. Nothing else does.
		const only =
			sender === undefined
				? pending.length === 1
					? pending[0]
					: undefined
				: matches.length === 1
					? matches[0]
					: undefined;
		if (only !== undefined) {
			await active.activatePendingEvent(only.message.sender, only.message.id);
			const session =
				only.message.sessionId === undefined ? "" : ` (session ${formatSessionLabel(only.message.sessionId)})`;
			return `[ace] activated ${only.message.sender}/${only.message.id}${session}`;
		}
		// Everything else is a list to choose from, one runnable command per event.
		if (sender === undefined) {
			return [
				`[ace] ${pending.length} pending manual events — activate exactly one:`,
				...pending.map(runnable),
			].join("\n");
		}
		const why =
			id === undefined
				? `sender ${JSON.stringify(sender)}`
				: `${JSON.stringify(sender)} with id ${JSON.stringify(id)}`;
		return matches.length > 1
			? [
					`[ace] ${matches.length} pending events from ${JSON.stringify(sender)} — activate exactly one:`,
					...matches.map(runnable),
				].join("\n")
			: [`[ace] nothing pending for ${why} — pending events:`, ...pending.map(runnable)].join("\n");
	}

	/**
	 * `/ace stats`: the counters, the spool windows, and whether the transport is still up — as the panel text
	 * in a TUI and as lines everywhere else.
	 *
	 * The counters are read once, through the runtime's own `snapshot()` and `render()`, so the panel's rows
	 * and the printed lines report the same moment.
	 */
	function statsCommand(ctx: ExtensionCommandContext): void {
		// The two states a reader asks about: a configured server that never came up, and a broker that died
		// after it did. Both are already reported once (a warning, an error); this is where they are summarised.
		const transport = transportErrorReported || unavailableServers.length > 0 ? "down" : "ok";
		const deadLettersSummary: { count: number; directory?: string } = deadLetters ?? { count: 0 };
		if (
			showPanel(ctx, () =>
				statsPanel({
					counters: runtime?.metrics.snapshot() ?? {},
					windows: runtime?.openSpoolWindows() ?? [],
					deadLetters: deadLettersSummary,
					transport,
				}),
			)
		) {
			return;
		}
		report(ctx, statsReport(transport, deadLettersSummary));
	}

	/** The printed `/ace stats` report: the counters as the runtime renders them. */
	function statsReport(transport: "ok" | "down", letters: { count: number; directory?: string }): string {
		const lines = runtime?.metrics.render() ?? [];
		const windows = (runtime?.openSpoolWindows() ?? []).map(
			(window) => `  spooling ${window.subscription}: ${window.buffered} buffered → ${window.path}`,
		);
		// `→ <dir>` is a path, and a path with zero letters is a line about nothing.
		const lettersLine = `dead letters: ${letters.count}${
			letters.count > 0 && letters.directory !== undefined ? ` → ${letters.directory}` : ""
		}`;
		return [
			`[ace] stats — ${lettersLine}`,
			`  transport: ${transport}`,
			...(lines.length > 0
				? lines.map((line) => `  ${line}`)
				: [
						"  (no counters yet — one line per channel appears here as events arrive, counting received,",
						"   injected, deduped, spooled, reclaimed and dropped)",
					]),
			...windows,
		].join("\n");
	}

	/** Why `/ace` cannot act, in the words the start-up failure left behind. */
	function notRunningMessage(cwd: string): string {
		return `[ace] not running: ${startupFailure ?? `add ${ACE_CONFIG_FILENAME} to ${cwd} and restart Pi`}`;
	}

	/**
	 * Put a read-only report into the session's record, and say whether it went there.
	 *
	 * `false` means "print the report instead", which is every mode that is not the TUI: `report()` would send
	 * the *print* text there, and the printed report is what those modes read.
	 *
	 * Why `notify` and not a view: a report is something the user reads while continuing to work, and a modal
	 * view holds the session until esc and takes its content with it when closed. Measured on omp 18.5.0 in a
	 * real TUI (pty, raw ANSI): one `ctx.ui.notify` keeps its newlines, keeps the colours `theme.fg` put in it
	 * (the host wraps the message in its dim style, and the coloured spans override it), a second command
	 * executes while the block is on screen, and a turn after it leaves the block in the record. The same host
	 * source (`UiHelpers.showStatus`) shows the one caveat: it appends `[Spacer, Text]` to the chat container
	 * and *rewrites* that block when it is the immediately preceding chat entry — its anti-spam rule for
	 * back-to-back status lines — so two `/ace` reports with no chat activity in between show the newer one,
	 * while any turn pins each report as its own block.
	 *
	 * The obvious workaround does not work, measured rather than assumed: emitting a separator status
	 * (`notify(" ", "info")`) before each report does not protect the earlier one — the separator is itself a
	 * status slot, so the report rewrites *it*, and the next separator rewrites the previous report away (frame
	 * for this in `/tmp/ace-frames/sep`). A separator *after* a report erases that report outright. The only
	 * chat-appending calls besides `showStatus` are `showWarning`/`showError`, which inject `Warning: `/
	 * `Error: ` and recolour the whole line, so using them for a listing would state something false about it.
	 * The coalescing therefore stays a host behaviour ACE documents instead of working around.
	 */
	function showPanel(ctx: ExtensionCommandContext, panel: () => AcePanel): boolean {
		if (ctx.mode !== "tui") return false;
		report(ctx, renderAcePanel(ctx.ui.theme, panel()));
		return true;
	}

	/**
	 * Refresh the footer status line: ` ace · N peers · M pending`, or `<server> down` in the warning colour
	 * when a configured server never came up or the transport reported an error.
	 *
	 * Written at the three moments the numbers can change — after every `/ace` report, after a publish, and on
	 * the directory's own ~30s heartbeat (`REGISTRY_DEFAULTS.refreshMs`) — and cleared on shutdown. The peer
	 * count is the same walk `ace_agents` and `/ace agents` do, so the footer and those listings cannot
	 * disagree; `M` is the runtime's own pending list, so it cannot disagree with `/ace pending` either.
	 *
	 * Main session only: `sessionContext` is never set in a subagent (one runtime, in the session a human
	 * talks to). A host with no status row — print and RPC modes, older builds — is a no-op, because the call
	 * is checked before it is made.
	 */
	async function refreshStatus(): Promise<void> {
		const ctx = sessionContext;
		if (ctx === undefined || isSubagentContext(ctx) || statusRefreshing) return;
		if (typeof ctx.ui.setStatus !== "function") return;
		statusRefreshing = true;
		try {
			// A status line describes a running runtime; with none there is nothing true to say, so the slot is
			// cleared rather than left showing the last session's numbers.
			if (runtime === undefined) {
				ctx.ui.setStatus("ace", undefined);
				return;
			}
			const down = unavailableServers.map((server) => server.server);
			const warning =
				down.length > 0 ? `${down.join(", ")} down` : transportErrorReported ? "transport down" : undefined;
			if (warning !== undefined) {
				const theme = ctx.ui.theme;
				ctx.ui.setStatus("ace", typeof theme?.fg === "function" ? theme.fg("warning", warning) : warning);
				return;
			}
			let peers = 0;
			try {
				peers = (await discoverLiveSessions(undefined)).live.length;
			} catch {
				// A directory that cannot be read must not blank the line: the pending count below is still true.
			}
			ctx.ui.setStatus(
				"ace",
				` ace · ${peers} peer${peers === 1 ? "" : "s"} · ${runtime.pendingEvents.length} pending`,
			);
		} finally {
			statusRefreshing = false;
		}
	}

	/**
	 * `/ace list`, and bare `/ace` where the host has a TUI: the manager view, the channel report in the
	 * session, or the printed report.
	 *
	 * One function for all three so the manager's rows, its detail view, the report in the session and the
	 * printed report can never disagree about what this session is wired to: they read one listing and one
	 * {@link ChannelReport}.
	 */
	async function listCommand(
		args: string,
		ctx: ExtensionCommandContext,
		pending: readonly PendingManualEvent[],
	): Promise<void> {
		const listing = humanListing(channelListingInput(subscriptions, sessionInboxes));
		const identity = [...new Set(activeServers.map((active) => shortSender(active.sender)))].join(", ");
		const describeChannel = (value: string): ChannelDetails | undefined => {
			// The row's value addresses the channel (`in:<channel>`), never the row's local label — see
			// `channelForMenuValue`, which is the same lookup the row was built with.
			const endpoint = channelForMenuValue(listing.subscriptions, value);
			if (endpoint === undefined) return { title: value, lines: [`${value} is not a channel this session reads`] };
			const target = endpoint.channel ?? endpoint.name;
			const inbox = sessionInboxes.some((candidate) => (candidate.channel ?? candidate.name) === target);
			return {
				// The title is the address itself, plain: the manager's rows are styled for the terminal.
				title: target,
				lines: [
					// `name:` and `address:` stay verbatim: this is where the exact address is still discoverable after
					// the header and the rows above have shortened this session's own session-id segment.
					`name: ${endpoint.name}`,
					`transport: ${endpoint.transport}`,
					`address: ${endpointAddress(endpoint) ?? "(none)"}`,
					...(endpoint.activation === undefined ? [] : [`activation: ${endpoint.activation}`]),
					...(endpoint.description === undefined ? [] : [`description: ${endpoint.description}`]),
					// Every row says where it came from: a configured subscription names the file it was configured
					// in, and an inbox says it is named by this session's own sender, which is auto-registered.
					inbox
						? "origin: named by this session's sender on the agent directory"
						: `origin: configured in ${basename(resolvedConfig?.source ?? ACE_CONFIG_FILENAME)}`,
					...(resolvedConfig?.shadowed === undefined
						? []
						: [`config: ${resolvedConfig.source} (project file shadows ${resolvedConfig.shadowed})`]),
				],
			};
		};
		const header = `${identity} (agent ${adapter.isRunning() ? "running" : "idle"})${
			resolvedConfig?.source === undefined ? "" : ` — ${resolvedConfig.source}`
		}`;
		// `/ace` with no arguments opens the manager where the host has a TUI. `/ace list` puts the channel
		// report into the session there, and every other mode prints it — a host that takes no panel text never
		// loses the report.
		if (args.trim().length === 0 && ctx.mode === "tui") {
			try {
				await showAceManager(
					ctx,
					(theme) => ({
						title: "ACE channels",
						details: header,
						items: channelMenuItems({ ...listing, theme }),
						empty: `No channels configured in ${ACE_CONFIG_FILENAME}.`,
					}),
					describeChannel,
				);
				return;
			} catch (error) {
				console.error(`[ace] manager view failed, printing the report instead: ${describeError(error)}`);
			}
		}
		// The core prefixes each row with its server when several are live, so it wants one server name per row in
		// the rows' own order. A row whose server cannot be named falls back to no prefix at all, rather than
		// prefixing the wrong row.
		const rowServers =
			activeServers.length > 1
				? listing.subscriptions.map((endpoint) => reportServers.get(endpoint.channel ?? endpoint.name))
				: [];
		const servers =
			rowServers.length === 0 || rowServers.some((name) => name === undefined)
				? undefined
				: (rowServers as readonly string[]);
		// A channel removed from `.ace.json` since this session started is still being read until restart, so it
		// is marked rather than silently listed as if it were still configured (`ace_channels` marks it too).
		const removed =
			resolvedConfig === undefined
				? []
				: configRemovedChannels({
						subscriptions: resolvedConfig.subscriptions,
						cwd: sessionContext?.cwd ?? process.cwd(),
						env: process.env,
						globalConfigPaths: [ompGlobalConfigPath(process.env)],
					});
		const channelReport: ChannelReport = {
			identity,
			agentState: adapter.isRunning() ? "running" : "idle",
			...(resolvedConfig?.source === undefined ? {} : { source: resolvedConfig.source }),
			subscriptions: listing.subscriptions,
			...(listing.selfChannels.length === 0 ? {} : { selfChannels: listing.selfChannels }),
			...(resolvedConfig?.shadowed === undefined ? {} : { shadowed: resolvedConfig.shadowed }),
			...(servers === undefined ? {} : { servers }),
			...(unavailableServers.length === 0
				? {}
				: {
						unavailableServers: unavailableServers.map((server) => ({
							name: server.server,
							address: server.address,
						})),
					}),
			...(unavailableSubscriptions.length === 0 ? {} : { unavailableSubscriptions }),
			...(removed.length === 0 ? {} : { configRemoved: removed }),
			pendingManual: pending.length,
			deadLetters: {
				count: deadLetters?.count ?? 0,
				...(deadLetters?.directory === undefined ? {} : { directory: deadLetters.directory }),
			},
		};
		if (showPanel(ctx, () => channelPanel(channelReport))) return;
		report(ctx, formatChannelReport(channelReport));
	}

	/** The `/ace` command definition: registered at the end of this factory, and again by the surface owner. */
	const aceCommand = {
		description:
			"ACE event runtime: channels, pending manual events, activation, live agents — bare /ace opens the manager",
		// Completions follow `/mcp`: the action word with its hint, then the retained events for `activate`.
		getArgumentCompletions: (prefix: string) =>
			aceCompletions(
				prefix,
				(runtime?.pendingEvents ?? []).map((event) => ({
					sender: event.message.sender,
					id: event.message.id,
					body: event.message.body,
				})),
			),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [subcommand = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);

			if (isSubagentContext(ctx)) {
				report(ctx, "[ace] this is a subagent session; ACE runs in the main session", "warning");
				return;
			}

			// `/ace` may be this copy's definition while another copy of this file runs ACE: the host resolves
			// commands from the definitions present when it loaded them (measured), so a later registration never
			// reaches this name. Delegate to the copy that owns the runtime, after the subagent guard above — a
			// subagent's registry has no owner of its own and must keep answering for itself.
			//
			// The guard is the working directory, not the session id: both copies are loaded into **one** session's
			// registry (a second session gets its own), but they report *different* session ids for it (measured:
			// comparing them made this delegate never fire). The owner of the process's runtime claim is, by
			// construction, the copy serving whichever session this registry belongs to.
			const live = (globalThis as unknown as Record<symbol, unknown>)[LIVE_ACE_MARKER] as LiveAceHandle | undefined;
			if (!claimedRuntime && live !== undefined && live.cwd === ctx.cwd) {
				return live.command(args, ctx);
			}

			// `help` answers with or without a runtime: it describes the command, not this session's wiring.
			if (subcommand === "help" || subcommand === "?") {
				if (showPanel(ctx, () => helpPanel(ACE_COMMANDS))) return;
				report(ctx, aceHelpText());
				return;
			}

			if (!runtime) {
				report(ctx, notRunningMessage(ctx.cwd), "warning");
				return;
			}

			try {
				if (subcommand === "activate") {
					report(ctx, await activateCommand(rest, ctx));
					return;
				}
				if (subcommand === "agents") {
					await agentsCommand(rest[0], ctx);
					return;
				}
				if (subcommand === "pending") {
					pendingCommand(ctx, runtime.pendingEvents);
					return;
				}
				if (subcommand === "stats") {
					statsCommand(ctx);
					return;
				}
				if (subcommand === "list") {
					await listCommand(args, ctx, runtime.pendingEvents);
					return;
				}
				report(ctx, ACE_USAGE, "warning");
			} catch (error) {
				report(ctx, `[ace] ${describeError(error)}`, "error");
			} finally {
				// The footer follows every report, so what the status line says and what was just printed cannot
				// drift apart. It is deliberately not awaited: a status refresh reads the directory over the
				// network, and the text the user asked for must not wait behind it.
				void refreshStatus();
			}
		},
	};

	/**
	 * Register the surfaces this instance owns: the five ACE tools and the `/ace` command.
	 *
	 * Called once when the factory loads — so the surfaces exist even where `session_start` never fires — and
	 * again from the instance that claims {@link the runtime claim}, because the host keeps the **last**
	 * definition of each name: a duplicate load (plugin discovery plus an explicit `--extension` of this same
	 * file) would otherwise leave `/ace` and the tools bound to the copy that is not running ACE.
	 */
	function registerOwnedSurfaces(): void {
		pi.registerTool(publishTool());
		pi.registerTool(agentsTool());
		pi.registerTool(channelsTool());
		pi.registerTool(storeFileTool());
		pi.registerTool(getFileTool());
		pi.registerCommand("ace", aceCommand);
	}

	registerOwnedSurfaces();
}
