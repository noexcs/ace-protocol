import type { RegistryEntry } from "../runtime/agent-registry.ts";
import type { EndpointConfig } from "../runtime/endpoint-config.ts";
/** Address of a channel inside its transport, whatever that transport calls it. */
export declare function addressOf(endpoint: EndpointConfig): string;
/** One directory row: the channel to address, what it says about itself (never shortened), and how fresh it is. */
export declare function describeDiscovered(entry: RegistryEntry): string;
/** One directory line: `"to-b" (agent-b) → redis-streams ace:in.b`. */
export declare function describeEndpoint(endpoint: EndpointConfig): string;
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
export declare function formatChannelListing(subscriptions: readonly EndpointConfig[], options?: {
    selfChannel?: string;
}): string;
/**
 * The inputs every channel surface lists: the channels this session subscribes to, plus the inbox the
 * agent directory registered for it. One function keeps `ace_channels`, `/ace list` and the manager from
 * disagreeing about what this session is wired to.
 */
export declare function channelListingInput(subscriptions: readonly EndpointConfig[], inbox?: EndpointConfig): {
    subscriptions: readonly EndpointConfig[];
    /** The channel this session's own sender names: the row `ace_channels` marks `self=yes`. */
    selfChannel?: string;
};
/** Everything `/ace list` prints; the human face, so addresses are included (the tool's listing leaves them out). */
export interface ChannelReport {
    identity: string;
    agentState: string;
    source?: string;
    subscriptions: readonly EndpointConfig[];
    /** The session's own channel: `/ace list` marks that row as the one peers reply to. */
    selfChannel?: string;
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