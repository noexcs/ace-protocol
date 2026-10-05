import { endpointAddress } from "../runtime/endpoint-config.js";
/** Address of a channel inside its transport, whatever that transport calls it. */
export function addressOf(endpoint) {
    return `${endpoint.transport} ${endpointAddress(endpoint) ?? "(no address)"}`;
}
/**
 * The dial address of a configured server's URL, without scheme or credentials — `ghost:6379` rather
 * than `redis://user:pass@ghost:6379/0`. Used when naming an unreachable server, so the reason shows
 * exactly where the reader would have connected and nothing they should not see.
 */
export function serverAddress(url) {
    try {
        const parsed = new URL(url);
        return parsed.host.length === 0 ? url : parsed.host;
    }
    catch {
        return url;
    }
}
/** One directory row: the channel to address, what it says about itself (never shortened), and how fresh it is. */
export function describeDiscovered(entry) {
    const renewsIn = Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000));
    return `${entry.channel} — self-description: ${entry.description} (renews in ${renewsIn}s)`;
}
/** One directory line: `"to-b" (agent-b) → redis-streams ace:in.b`. */
export function describeEndpoint(endpoint) {
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
 * `note`     the host's note about the channel — the unquoted tail of the row, empty when there is none;
 *            this is not the peer's self-description (`ace_agents` carries that)
 *
 * The local subscription label is a host detail, so it is not here; `/ace list` shows it.
 */
export function formatChannelListing(subscriptions, options = {}) {
    const line = (endpoint) => {
        const name = endpoint.channel ?? endpoint.name;
        return [
            `channel=${name}`,
            `transport=${endpoint.transport}`,
            `activation=${endpoint.activation ?? "default"}`,
            `self=${name === options.selfChannel ? "yes" : "no"}`,
            // The note is the unquoted tail of the row: everything after `note=` is the note verbatim, so
            // a whitespace split never breaks and an empty note is simply `note=` at the end of the line.
            `note=${endpoint.description ?? ""}`,
        ].join(" ");
    };
    // The server-level problem comes first (it is the cause), then each subscription it dropped.
    const deadServers = (options.deadServers ?? []).map((entry) => `  unavailable: server "${entry.server}" did not come up (${entry.address} is not reachable)`);
    const unavailable = (options.unavailable ?? []).map((entry) => `  unavailable: ${entry.channel} (server "${entry.server}" did not come up)`);
    return [
        "subscribe: one row per channel; `self=yes` is this session's own channel (peers publish there to reach it); `note` runs to the end of the line",
        ...(subscriptions.length === 0 ? ["  (none)"] : subscriptions.map((endpoint) => `  ${line(endpoint)}`)),
        ...deadServers,
        ...unavailable,
    ].join("\n");
}
/**
 * The inputs every channel surface lists: the channels this session subscribes to, plus the inbox the
 * agent directory registered for it. One function keeps `ace_channels`, `/ace list` and the manager from
 * disagreeing about what this session is wired to.
 */
export function channelListingInput(subscriptions, inbox) {
    const all = inbox === undefined ? subscriptions : [...subscriptions, inbox];
    return {
        subscriptions: all,
        ...(inbox === undefined ? {} : { selfChannel: inbox.channel ?? inbox.name }),
    };
}
/**
 * The `/ace list` report: one line per channel with its address, in the house style `/mcp` uses
 * (`name: state, detail`), plus the session header and the counters an operator asks about after a while.
 */
export function formatChannelReport(report) {
    const channel = (endpoint) => {
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
    const lines = (endpoints) => endpoints.length === 0 ? ["  (none)"] : endpoints.map(channel);
    const letters = `dead letters: ${report.deadLetters.count}${report.deadLetters.directory === undefined ? "" : ` at ${report.deadLetters.directory}`}`;
    return [
        `${report.identity} (agent ${report.agentState})${report.source === undefined ? "" : ` — ${report.source}`}`,
        "subscribe:",
        ...lines(report.subscriptions),
        `manual: ${report.pendingManual} pending, ${letters}`,
    ].join("\n");
}
//# sourceMappingURL=listing.js.map