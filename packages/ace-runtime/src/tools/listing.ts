import type { RegistryEntry } from "../runtime/agent-registry.ts";
import type { EndpointConfig } from "../runtime/endpoint-config.ts";
import { endpointAddress } from "../runtime/endpoint-config.ts";
import { formatIsoDuration, formatSessionLabel } from "../utils.ts";

/** Address of a channel inside its transport, whatever that transport calls it. */
export function addressOf(endpoint: EndpointConfig): string {
	return `${endpoint.transport} ${endpointAddress(endpoint) ?? "(no address)"}`;
}

/**
 * The dial address of a configured server's URL, without scheme or credentials — `ghost:6379` rather
 * than `redis://user:pass@ghost:6379/0`. Used when naming an unreachable server, so the reason shows
 * exactly where the reader would have connected and nothing they should not see.
 */
export function serverAddress(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.host.length === 0 ? url : parsed.host;
	} catch {
		return url;
	}
}

/**
 * One directory row as fields: `channel=<target> renews_in=<ISO 8601 duration> self=<yes|no> description="<text>"`.
 *
 * `channel` is the publish-ready target — the channel a peer publishes to reach that session, with the
 * `<server>:` prefix folded in when `server` is given (a multi-server session's names are unique per
 * server, so the prefixed form is what ace_publish accepts). `self` marks this session's own channel;
 * the listing omits that entry, so it is `no` on every row here. `renews_in` is the peer's remaining
 * lease as an ISO 8601 duration (`PT33S`, `PT1M30S`, `PT1H`), never a bare `33s`. The self-description
 * is quoted and never shortened.
 */
export function describeDiscovered(entry: RegistryEntry, options: { server?: string; self?: boolean } = {}): string {
	const renewsIn = Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000));
	const channel = options.server === undefined ? entry.channel : `${options.server}:${entry.channel}`;
	return [
		`channel=${channel}`,
		`renews_in=${formatIsoDuration(renewsIn)}`,
		`self=${options.self === true ? "yes" : "no"}`,
		`description=${JSON.stringify(entry.description)}`,
	].join(" ");
}

/** One directory line: `"to-b" (agent-b) → redis-streams ace:in.b`. */
export function describeEndpoint(endpoint: EndpointConfig): string {
	return `"${endpoint.name}"${endpoint.description ? ` (${endpoint.description})` : ""} → ${addressOf(endpoint)}`;
}

/**
 * The directory's row order: by channel name ascending, then by server name for the same channel name
 * on two servers. `ace_agents` merges several servers' directories and the underlying listings have no
 * stable order of their own, so without an explicit sort the same peers came back in a different order
 * across calls. `renews_in` is not the key: it is the peer's remaining lease at the moment of the call
 * and the peer renews its lease, so it moves between calls even when the set of peers is unchanged, and
 * a sort on it would reorder rows for no reason.
 */
export function compareDiscoveredSessions(
	a: { server: string; entry: RegistryEntry },
	b: { server: string; entry: RegistryEntry },
): number {
	if (a.entry.channel !== b.entry.channel) return a.entry.channel < b.entry.channel ? -1 : 1;
	if (a.server !== b.server) return a.server < b.server ? -1 : 1;
	return 0;
}

/**
 * The listing `ace_channels` returns: this session's channels as the model needs them. It follows the
 * same convention as `ace_agents` — a machine header, then one flush-left field row per channel:
 *
 * ```
 * ace 0.1 channels count=<channel rows> self=<rows marked self=yes> unavailable=<unavailable lines>
 * channel=… activation=… self=… note=…
 * unavailable: …
 * ```
 *
 * The header counts what is actually there, so it stays true when `unavailable:` lines follow: `count=`
 * counts channel rows only, and every non-row line is counted by `unavailable=` (a dead server and each
 * subscription it dropped). The rows are flush-left and uniform because a model parses this more
 * reliably than prose; the legend that used to precede them lives in the tool description now.
 *
 * `channel`  the addressable name — what a peer publishes to (the only field that matters to another session)
 * `activation` the activation this receiver forces, or `default` to let the message decide
 * `self`     `yes` for a channel this session's own sender names on one of its servers — one per live
 *            server — because publishing there is how a peer reaches this session
 * `note`     the host's note about the channel — the unquoted tail of the row, empty when there is none.
 *            When there is more than one remark it is a comma-joined list in a fixed order: the
 *            configured description first, then `config-removed` for a channel a live subscription still
 *            reads that the current configuration no longer lists. This is not the peer's self-description
 *            (`ace_agents` carries that).
 *
 * A channel is a shared topic, not a private mailbox: everyone subscribed reads every event published to
 * it. The local subscription label is a host detail, so it is not here; `/ace list` shows it.
 *
 * Rows carry no `transport=` field: the transport kind is a deployment detail, and a channel row is
 * about the channel, not about what carries it.
 */
export function formatChannelListing(
	subscriptions: readonly EndpointConfig[],
	options: {
		/**
		 * The channel names this session's own sender names, one per server it is live on: every matching
		 * row is marked `self=yes`, so a mirror of the same inbox on another server is marked too.
		 */
		selfChannels?: readonly string[];
		/**
		 * Configured subscriptions whose server never came up: they are not read, but they are not
		 * silently absent either — one trailing line says which channel is missing and why.
		 */
		unavailable?: readonly { channel: string; server: string }[];
		/**
		 * Configured servers that never came up, whether or not they carried a subscription: one trailing
		 * line each, so an unreachable server is never invisible just because nothing subscribed to it.
		 */
		deadServers?: readonly { server: string; address: string }[];
		/**
		 * Channel names a live subscription still reads that the current configuration file no longer
		 * lists ({@link configRemovedChannels}). Their rows carry `config-removed` in `note`, so a channel
		 * removed since session start — and therefore still read until restart — is visible as stale.
		 */
		configRemoved?: readonly string[];
	} = {},
): string {
	const isSelf = (name: string): boolean => options.selfChannels?.includes(name) === true;
	const configRemoved = new Set(options.configRemoved ?? []);
	const line = (endpoint: EndpointConfig): string => {
		const name = endpoint.channel ?? endpoint.name;
		// `note` is a comma-joined list of remarks, in a fixed order: the configured description first,
		// then `config-removed`. Both are the unquoted tail of the row, so a whitespace split never breaks.
		const note = [
			...(endpoint.description === undefined ? [] : [endpoint.description]),
			...(configRemoved.has(name) ? ["config-removed"] : []),
		].join(", ");
		return [
			`channel=${name}`,
			`activation=${endpoint.activation ?? "default"}`,
			`self=${isSelf(name) ? "yes" : "no"}`,
			// The note is the unquoted tail of the row: everything after `note=` is the note verbatim, so
			// a whitespace split never breaks and an empty note is simply `note=` at the end of the line.
			`note=${note}`,
		].join(" ");
	};
	// The server-level problem comes first (it is the cause), then each subscription it dropped.
	const deadServers = (options.deadServers ?? []).map(
		(entry) => `unavailable: server "${entry.server}" did not come up (${entry.address} is not reachable)`,
	);
	const unavailable = (options.unavailable ?? []).map(
		(entry) => `unavailable: ${entry.channel} (server "${entry.server}" did not come up)`,
	);
	const selfCount = subscriptions.filter((endpoint) => isSelf(endpoint.channel ?? endpoint.name)).length;
	return [
		`ace 0.1 channels count=${subscriptions.length} self=${selfCount} unavailable=${
			deadServers.length + unavailable.length
		}`,
		...subscriptions.map(line),
		...deadServers,
		...unavailable,
	].join("\n");
}

/**
 * The inputs every channel surface lists: the channels this session subscribes to, plus the inboxes the
 * agent directory registered for it — one per live server, so a multi-server session has one own channel
 * per server, not one overall. One function keeps `ace_channels`, `/ace list` and the manager from
 * disagreeing about what this session is wired to.
 */
export function channelListingInput(
	subscriptions: readonly EndpointConfig[],
	inboxes: readonly EndpointConfig[] = [],
): {
	subscriptions: readonly EndpointConfig[];
	/** Every channel name this session's own sender names — the rows `ace_channels` marks `self=yes`. */
	selfChannels: readonly string[];
} {
	const known = new Set(subscriptions.map((endpoint) => endpoint.channel ?? endpoint.name));
	const missing = inboxes.filter((inbox) => !known.has(inbox.channel ?? inbox.name));
	return {
		subscriptions: missing.length === 0 ? subscriptions : [...subscriptions, ...missing],
		selfChannels: inboxes.map((inbox) => inbox.channel ?? inbox.name),
	};
}

/**
 * Everything `/ace list` prints; the human face, so it is prose a person reads rather than the field
 * rows `ace_channels` returns.
 */
export interface ChannelReport {
	identity: string;
	agentState: string;
	source?: string;
	subscriptions: readonly EndpointConfig[];
	/** The session's own channel names, one per server: `/ace list` marks those rows as the ones peers reply to. */
	selfChannels?: readonly string[];
	/**
	 * The later configuration candidate the winning file shadowed (`loadAceConfig`). Its presence adds the
	 * `config:` line, so a project file that quietly overrode a host-global one is visible rather than
	 * silently explaining why the session talks to the wrong Redis.
	 */
	shadowed?: string;
	/**
	 * The server carrying each subscription, **same order and length as `subscriptions`**. Given more than
	 * one server, every line is prefixed `<server>:` so the name shown is already the publish-ready target
	 * (the same prefixed form `ace_channels` reports); a single server needs no prefix.
	 */
	servers?: readonly string[];
	/** Configured servers that never came up — one cause line each, in `formatChannelListing`'s wording. */
	unavailableServers?: readonly { name: string; address: string }[];
	/** Subscriptions dropped because their server never came up — one effect line each, same wording. */
	unavailableSubscriptions?: readonly { channel: string; server: string }[];
	/** Channel names a live subscription still reads that the current configuration no longer lists. */
	configRemoved?: readonly string[];
	pendingManual: number;
	deadLetters: { count: number; directory?: string };
}

/**
 * The `/ace list` report: the session header, one line per channel, then the counters an operator asks
 * about after a while — columns a person reads, in the house style `/mcp` uses (`name: state, detail`).
 *
 * ```text
 * <identity> (agent <state>) — <config file>
 * config: <config file> (project file shadows <shadowed file>)
 * subscribe:
 *   <target>: <transport> [activation] "description" (self — peers reply here) (config-removed)
 *   (none)
 *   add channels under a server's "subscribe" in .ace.json to read them.
 * unavailable: server "ghost" did not come up (ghost:6379 is not reachable)
 * unavailable: ace:ana:noop (server "ghost" did not come up)
 * manual: 2 pending, dead letters: 1 at /work/.ace
 * ```
 *
 * The line's name is the **publish-ready target**: with several servers it carries the `<server>:`
 * prefix `ace_publish` expects. The transport **stream key** (`ace:ch:…`) is deliberately not printed —
 * it is the width hog, and the manager's detail view has the full address.
 *
 * A session's own inbox is *named by its sender* (`<ns>:<username>:<coding-agent>:<session id>`), so its
 * trailing session-id segment is shortened with {@link formatSessionLabel}; every other name is a
 * publish target and is printed verbatim. `config-removed` marks a row a live subscription still reads
 * although the current file no longer lists it, and the `config:` line appears only when this file
 * shadowed a later candidate. `at <dir>` on the last line appears only when dead letters exist.
 */
export function formatChannelReport(report: ChannelReport): string {
	const removing = new Set(report.configRemoved ?? []);
	// A full session id is the one thing in a name a person never types: it identifies a session, and its
	// tail alone does that. Only this session's own channels are sender-named, so only they are eligible;
	// and only a segment that looks like an opaque id is shortened, so a local name is never mangled.
	//
	// Tradeoff: a self row is an address position, so the shortened form must not read as a usable target.
	// The omitted middle is therefore an explicit `…`, never a silently shorter name — `<ns>:<user>:<agent>:…4e5f6`
	// is visibly truncated. Nothing is lost: the manager's detail view (`/ace` with no argument) shows the
	// full name in its `address:` line, which is the derived stream key `ace:ch:<full name>`.
	const humanize = (name: string, self: boolean): string => {
		if (!self) return name;
		const segments = name.split(":");
		if (segments.length < 4) return name;
		const sessionId = segments[segments.length - 1] as string;
		if (sessionId.length <= 6 || !/^[A-Za-z0-9_.-]+$/.test(sessionId)) return name;
		return [...segments.slice(0, -1), `…${formatSessionLabel(sessionId)}`].join(":");
	};
	const channel = (endpoint: EndpointConfig, index: number): string => {
		const target = endpoint.channel ?? endpoint.name;
		const self = report.selfChannels?.includes(target) === true;
		const server = report.servers?.[index];
		const label = server === undefined ? humanize(target, self) : `${server}:${humanize(target, self)}`;
		const extras = [
			endpoint.name === target ? undefined : `(as "${endpoint.name}")`,
			endpoint.activation === undefined ? undefined : `[${endpoint.activation}]`,
			self ? "(self — peers reply here)" : undefined,
			endpoint.description === undefined ? undefined : `"${endpoint.description}"`,
			removing.has(target) ? "(config-removed)" : undefined,
		].filter((part) => part !== undefined);
		return `  ${label}: ${endpoint.transport}${extras.length === 0 ? "" : ` ${extras.join(" ")}`}`;
	};
	const deadServers = (report.unavailableServers ?? []).map(
		(entry) => `unavailable: server "${entry.name}" did not come up (${entry.address} is not reachable)`,
	);
	const unavailable = (report.unavailableSubscriptions ?? []).map(
		(entry) => `unavailable: ${entry.channel} (server "${entry.server}" did not come up)`,
	);
	const letters = `dead letters: ${report.deadLetters.count}${
		report.deadLetters.count > 0 && report.deadLetters.directory !== undefined
			? ` at ${report.deadLetters.directory}`
			: ""
	}`;
	return [
		`${report.identity} (agent ${report.agentState})${report.source === undefined ? "" : ` — ${report.source}`}`,
		...(report.shadowed === undefined
			? []
			: [`config: ${report.source ?? "this file"} (project file shadows ${report.shadowed})`]),
		"subscribe:",
		...(report.subscriptions.length === 0
			? ["  (none)", `  add channels under a server's "subscribe" in .ace.json to read them.`]
			: report.subscriptions.map(channel)),
		...deadServers,
		...unavailable,
		`manual: ${report.pendingManual} pending, ${letters}`,
	].join("\n");
}
