import type { RegistryEntry } from "../runtime/agent-registry.ts";
import type { EndpointConfig } from "../runtime/endpoint-config.ts";
import { endpointAddress } from "../runtime/endpoint-config.ts";

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
 * One directory row as fields: `channel=<target> renews_in=<n>s self=<yes|no> description="<text>"`.
 *
 * `channel` is the publish-ready target — the channel a peer publishes to reach that session, with the
 * `<server>:` prefix folded in when `server` is given (a multi-server session's names are unique per
 * server, so the prefixed form is what ace_publish accepts). `self` marks this session's own channel;
 * the listing omits that entry, so it is `no` on every row here. The self-description is quoted and
 * never shortened.
 */
export function describeDiscovered(entry: RegistryEntry, options: { server?: string; self?: boolean } = {}): string {
	const renewsIn = Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000));
	const channel = options.server === undefined ? entry.channel : `${options.server}:${entry.channel}`;
	return [
		`channel=${channel}`,
		`renews_in=${renewsIn}s`,
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
 * across calls. `renews_in` is not the key: it is a liveness hint recomputed at each call and the peer
 * renews its lease, so it moves between calls even when the set of peers is unchanged, and a sort on it
 * would reorder rows for no reason.
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
 * channel=… transport=… activation=… self=… note=…
 * unavailable: …
 * ```
 *
 * The header counts what is actually there, so it stays true when `unavailable:` lines follow: `count=`
 * counts channel rows only, and every non-row line is counted by `unavailable=` (a dead server and each
 * subscription it dropped). The rows are flush-left and uniform because a model parses this more
 * reliably than prose; the legend that used to precede them lives in the tool description now.
 *
 * `channel`  the addressable name — what a peer publishes to (the only field that matters to another session)
 * `transport` the transport kind
 * `activation` the activation this receiver forces, or `default` to let the message decide
 * `self`     `yes` for a channel this session's own sender names on one of its servers — one per live
 *            server — because publishing there is how a peer reaches this session
 * `note`     the host's note about the channel — the unquoted tail of the row, empty when there is none;
 *            this is not the peer's self-description (`ace_agents` carries that)
 *
 * A channel is a shared topic, not a private mailbox: everyone subscribed reads every event published to
 * it. The local subscription label is a host detail, so it is not here; `/ace list` shows it.
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
	} = {},
): string {
	const isSelf = (name: string): boolean => options.selfChannels?.includes(name) === true;
	const line = (endpoint: EndpointConfig): string => {
		const name = endpoint.channel ?? endpoint.name;
		return [
			`channel=${name}`,
			`transport=${endpoint.transport}`,
			`activation=${endpoint.activation ?? "default"}`,
			`self=${isSelf(name) ? "yes" : "no"}`,
			// The note is the unquoted tail of the row: everything after `note=` is the note verbatim, so
			// a whitespace split never breaks and an empty note is simply `note=` at the end of the line.
			`note=${endpoint.description ?? ""}`,
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

/** Everything `/ace list` prints; the human face, so addresses are included (the tool's listing leaves them out). */
export interface ChannelReport {
	identity: string;
	agentState: string;
	source?: string;
	subscriptions: readonly EndpointConfig[];
	/** The session's own channel names, one per server: `/ace list` marks those rows as the ones peers reply to. */
	selfChannels?: readonly string[];
	pendingManual: number;
	deadLetters: { count: number; directory?: string };
}

/**
 * The `/ace list` report: one line per channel with its address, in the house style `/mcp` uses
 * (`name: state, detail`), plus the session header and the counters an operator asks about after a while.
 */
export function formatChannelReport(report: ChannelReport): string {
	const channel = (endpoint: EndpointConfig): string => {
		const target = endpoint.channel ?? endpoint.name;
		const stream = endpointAddress(endpoint);
		const extras = [
			endpoint.name === target ? undefined : `(as "${endpoint.name}")`,
			endpoint.activation === undefined ? undefined : `[${endpoint.activation}]`,
			report.selfChannels?.includes(target) === true ? "(self — peers reply here)" : undefined,
			endpoint.description === undefined ? undefined : `"${endpoint.description}"`,
		].filter((part) => part !== undefined);
		const where = `${endpoint.transport}${stream === undefined ? "" : ` ${stream}`}`;
		return `  ${target}: ${where}${extras.length === 0 ? "" : ` ${extras.join(" ")}`}`;
	};
	const lines = (endpoints: readonly EndpointConfig[]): string[] =>
		endpoints.length === 0 ? ["  (none)"] : endpoints.map(channel);
	const letters = `dead letters: ${report.deadLetters.count}${
		report.deadLetters.directory === undefined ? "" : ` at ${report.deadLetters.directory}`
	}`;
	return [
		`${report.identity} (agent ${report.agentState})${report.source === undefined ? "" : ` — ${report.source}`}`,
		"subscribe:",
		...lines(report.subscriptions),
		`manual: ${report.pendingManual} pending, ${letters}`,
	].join("\n");
}
