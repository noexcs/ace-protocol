import type { RegistryEntry } from "../runtime/agent-registry.ts";
import type { EndpointConfig } from "../runtime/endpoint-config.ts";
/** Address of a channel inside its transport, whatever that transport calls it. */
export declare function addressOf(endpoint: EndpointConfig): string;
/**
 * The dial address of a configured server's URL, without scheme or credentials — `ghost:6379` rather
 * than `redis://user:pass@ghost:6379/0`. Used when naming an unreachable server, so the reason shows
 * exactly where the reader would have connected and nothing they should not see.
 */
export declare function serverAddress(url: string): string;
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
export declare function describeDiscovered(entry: RegistryEntry, options?: {
    server?: string;
    self?: boolean;
}): string;
/** One directory line: `"to-b" (agent-b) → redis-streams ace:in.b`. */
export declare function describeEndpoint(endpoint: EndpointConfig): string;
/**
 * The directory's row order: by channel name ascending, then by server name for the same channel name
 * on two servers. `ace_agents` merges several servers' directories and the underlying listings have no
 * stable order of their own, so without an explicit sort the same peers came back in a different order
 * across calls. `renews_in` is not the key: it is the peer's remaining lease at the moment of the call
 * and the peer renews its lease, so it moves between calls even when the set of peers is unchanged, and
 * a sort on it would reorder rows for no reason.
 */
export declare function compareDiscoveredSessions(a: {
    server: string;
    entry: RegistryEntry;
}, b: {
    server: string;
    entry: RegistryEntry;
}): number;
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
export declare function formatChannelListing(subscriptions: readonly EndpointConfig[], options?: {
    /**
     * The channel names this session's own sender names, one per server it is live on: every matching
     * row is marked `self=yes`, so a mirror of the same inbox on another server is marked too.
     */
    selfChannels?: readonly string[];
    /**
     * Configured subscriptions whose server never came up: they are not read, but they are not
     * silently absent either — one trailing line says which channel is missing and why.
     */
    unavailable?: readonly {
        channel: string;
        server: string;
    }[];
    /**
     * Configured servers that never came up, whether or not they carried a subscription: one trailing
     * line each, so an unreachable server is never invisible just because nothing subscribed to it.
     */
    deadServers?: readonly {
        server: string;
        address: string;
    }[];
    /**
     * Channel names a live subscription still reads that the current configuration file no longer
     * lists ({@link configRemovedChannels}). Their rows carry `config-removed` in `note`, so a channel
     * removed since session start — and therefore still read until restart — is visible as stale.
     */
    configRemoved?: readonly string[];
}): string;
/**
 * The inputs every channel surface lists: the channels this session subscribes to, plus the inboxes the
 * agent directory registered for it — one per live server, so a multi-server session has one own channel
 * per server, not one overall. One function keeps `ace_channels`, `/ace list` and the manager from
 * disagreeing about what this session is wired to.
 */
export declare function channelListingInput(subscriptions: readonly EndpointConfig[], inboxes?: readonly EndpointConfig[]): {
    subscriptions: readonly EndpointConfig[];
    /** Every channel name this session's own sender names — the rows `ace_channels` marks `self=yes`. */
    selfChannels: readonly string[];
};
/** Everything `/ace list` prints; the human face, so addresses are included (the tool's listing leaves them out). */
export interface ChannelReport {
    identity: string;
    agentState: string;
    source?: string;
    subscriptions: readonly EndpointConfig[];
    /** The session's own channel names, one per server: `/ace list` marks those rows as the ones peers reply to. */
    selfChannels?: readonly string[];
    pendingManual: number;
    deadLetters: {
        count: number;
        directory?: string;
    };
}
/**
 * The `/ace list` report: one line per channel with its address, in the house style `/mcp` uses
 * (`name: state, detail`), plus the session header and the counters an operator asks about after a while.
 */
export declare function formatChannelReport(report: ChannelReport): string;
//# sourceMappingURL=listing.d.ts.map