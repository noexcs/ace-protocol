import type { RegistryEntry } from "../runtime/agent-registry.ts";
import type { EndpointConfig } from "../runtime/endpoint-config.ts";
import { endpointAddress } from "../runtime/endpoint-config.ts";

/** Address of a channel inside its transport, whatever that transport calls it. */
export function addressOf(endpoint: EndpointConfig): string {
	return `${endpoint.transport} ${endpointAddress(endpoint) ?? "(no address)"}`;
}

/** One directory row: the channel to address, what it says about itself (never shortened), and how fresh it is. */
export function describeDiscovered(entry: RegistryEntry): string {
	const renewsIn = Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000));
	return `${entry.channel} — self-description: ${entry.description} (renews in ${renewsIn}s)`;
}

/** One directory line: `"to-b" (agent-b) → redis-streams ace:in.b`. */
export function describeEndpoint(endpoint: EndpointConfig): string {
	return `"${endpoint.name}"${endpoint.description ? ` (${endpoint.description})` : ""} → ${addressOf(endpoint)}`;
}

/**
 * The listing `ace_channels` returns: this session's channels as the model needs them. Every row carries
 * the same keys in the same order, because a model parses this more reliably than prose:
 *
 * `channel`  the addressable name — what a peer publishes to (the only field that matters to another session)
 * `transport` the transport kind
 * `activation` the activation this receiver forces, or `default` to let the message decide
 * `self`     `yes` for this session's own channel: publishing there is how a peer reaches this session
 * `note`     the host's note about the channel — this is not the peer's self-description (`ace_agents` carries that)
 *
 * The local subscription label is a host detail, so it is not here; `/ace list` shows it.
 */
export function formatChannelListing(
	subscriptions: readonly EndpointConfig[],
	options: { selfChannel?: string } = {},
): string {
	const line = (endpoint: EndpointConfig): string => {
		const target = endpoint.channel ?? endpoint.name;
		return [
			`channel=${target}`,
			`transport=${endpoint.transport}`,
			`activation=${endpoint.activation ?? "default"}`,
			`self=${target === options.selfChannel ? "yes" : "no"}`,
			`note=${endpoint.description === undefined ? '""' : JSON.stringify(endpoint.description)}`,
		].join(" ");
	};
	return [
		"subscribe: one row per channel; `self=yes` is this session's own channel (peers publish there to reach it)",
		...(subscriptions.length === 0 ? ["  (none)"] : subscriptions.map((endpoint) => `  ${line(endpoint)}`)),
	].join("\n");
}

/**
 * The inputs every channel surface lists: the channels this session subscribes to, plus the inbox the
 * agent directory registered for it. One function keeps `ace_channels`, `/ace list` and the manager from
 * disagreeing about what this session is wired to.
 */
export function channelListingInput(
	subscriptions: readonly EndpointConfig[],
	inbox?: EndpointConfig,
): {
	subscriptions: readonly EndpointConfig[];
	/** The channel this session's own sender names: the row `ace_channels` marks `self=yes`. */
	selfChannel?: string;
} {
	const all = inbox === undefined ? subscriptions : [...subscriptions, inbox];
	return {
		subscriptions: all,
		...(inbox === undefined ? {} : { selfChannel: inbox.channel ?? inbox.name }),
	};
}

/** Everything `/ace list` prints; the human face, so addresses are included (the tool's listing leaves them out). */
export interface ChannelReport {
	identity: string;
	agentState: string;
	source?: string;
	subscriptions: readonly EndpointConfig[];
	/** The session's own channel: `/ace list` marks that row as the one peers reply to. */
	selfChannel?: string;
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
			target === report.selfChannel ? "(self — peers reply here)" : undefined,
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
