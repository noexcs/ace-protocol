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
	return `${entry.channel} — ${entry.description} (renews in ${renewsIn}s)`;
}

/** One directory line: `"to-b" (agent-b) → redis-streams ace:in.b`. */
export function describeEndpoint(endpoint: EndpointConfig): string {
	return `"${endpoint.name}"${endpoint.description ? ` (${endpoint.description})` : ""} → ${addressOf(endpoint)}`;
}

/**
 * The listing `ace_channels` returns: this session's channels as the model needs them — name, transport,
 * description, activation — without the deployment plumbing (`config`/`options`) or the burst internals.
 *
 * One section only: with channels living on a server and addresses derived from names, "what I publish
 * to" is any channel name the model chooses (a peer's sender name for a direct message), not a separate
 * configured list.
 */
export function formatChannelListing(
	subscriptions: readonly EndpointConfig[],
	options: { derivedName?: string } = {},
): string {
	const line = (endpoint: EndpointConfig): string =>
		[
			endpoint.name,
			endpoint.transport,
			endpoint.description === undefined ? undefined : `"${endpoint.description}"`,
			endpoint.activation === undefined ? undefined : `[${endpoint.activation}]`,
			endpoint.name === options.derivedName ? "(registered for this session)" : undefined,
		]
			.filter((part) => part !== undefined)
			.join(" · ");
	return ["subscribe:", ...subscriptions.map((endpoint) => `  ${line(endpoint)}`)].join("\n");
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
	derivedName?: string;
} {
	const all = inbox === undefined ? subscriptions : [...subscriptions, inbox];
	return {
		subscriptions: all,
		...(inbox === undefined ? {} : { derivedName: inbox.name }),
	};
}

/** Everything `/ace list` prints; the human face, so addresses are included (the tool's listing leaves them out). */
export interface ChannelReport {
	identity: string;
	agentState: string;
	source?: string;
	subscriptions: readonly EndpointConfig[];
	/** Name of the inbox the agent directory registered for this session, when there is one. */
	derivedName?: string;
	pendingManual: number;
	deadLetters: { count: number; directory?: string };
}

/**
 * The `/ace list` report: one line per channel with its address, in the house style `/mcp` uses
 * (`name: state, detail`), plus the session header and the counters an operator asks about after a while.
 */
export function formatChannelReport(report: ChannelReport): string {
	const channel = (endpoint: EndpointConfig): string => {
		const address = endpointAddress(endpoint);
		const extras = [
			endpoint.activation === undefined ? undefined : `[${endpoint.activation}]`,
			endpoint.name === report.derivedName ? "(registered for this session)" : undefined,
			endpoint.description === undefined ? undefined : `"${endpoint.description}"`,
		].filter((part) => part !== undefined);
		const where = `${endpoint.transport}${address === undefined ? "" : ` ${address}`}`;
		return `  ${endpoint.name}: ${where}${extras.length === 0 ? "" : ` ${extras.join(" ")}`}`;
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
