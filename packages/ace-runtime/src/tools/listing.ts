import type { ResolvedAceConfig } from "../runtime/ace-config.ts";
import type { RegistryEntry } from "../runtime/agent-registry.ts";
import type { EndpointConfig } from "../runtime/endpoint-config.ts";
import { endpointAddress } from "../runtime/endpoint-config.ts";
import { SESSION_INBOX } from "../runtime/naming.ts";

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
 */
export function formatChannelListing(
	subscriptions: readonly EndpointConfig[],
	publications: readonly EndpointConfig[],
	options: { derivedName?: string; disabled?: readonly string[] } = {},
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
	return [
		"subscribe:",
		...subscriptions.map((endpoint) => `  ${line(endpoint)}`),
		"publish:",
		...(publications.length === 0 ? ["  (none)"] : publications.map((endpoint) => `  ${line(endpoint)}`)),
		...(options.disabled === undefined || options.disabled.length === 0
			? []
			: [`disabled: ${options.disabled.join(", ")}`]),
	].join("\n");
}

/**
 * The inputs every channel surface lists: the configured channels plus the inbox the agent directory
 * registered for this session. One function keeps `ace_channels`, `/ace list` and the manager from
 * disagreeing about what this session is wired to.
 */
export function channelListingInput(
	config: ResolvedAceConfig,
	inbox?: EndpointConfig,
): {
	subscriptions: readonly EndpointConfig[];
	publications: readonly EndpointConfig[];
	derivedName?: string;
	disabled: readonly string[];
} {
	return {
		subscriptions: inbox === undefined ? config.subscribe : [...config.subscribe, inbox],
		publications: config.publish,
		...(inbox === undefined ? {} : { derivedName: SESSION_INBOX }),
		disabled: config.disabled,
	};
}

/** Everything `/ace list` prints; the human face, so addresses are included (the tool's listing leaves them out). */
export interface ChannelReport {
	identity: string;
	agentState: string;
	source?: string;
	subscriptions: readonly EndpointConfig[];
	publications: readonly EndpointConfig[];
	/** Name of the inbox the agent directory registered for this session, when there is one. */
	derivedName?: string;
	disabled: readonly string[];
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
		"publish:",
		...lines(report.publications),
		`disabled: ${report.disabled.length === 0 ? "(none)" : report.disabled.join(", ")}`,
		`manual: ${report.pendingManual} pending, ${letters}`,
	].join("\n");
}
