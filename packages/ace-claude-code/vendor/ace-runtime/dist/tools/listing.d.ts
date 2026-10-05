import type { RegistryEntry } from "../runtime/agent-registry.ts";
import type { EndpointConfig } from "../runtime/endpoint-config.ts";
/** Address of a channel inside its transport, whatever that transport calls it. */
export declare function addressOf(endpoint: EndpointConfig): string;
/** One directory row: the channel to address, what it says about itself (never shortened), and how fresh it is. */
export declare function describeDiscovered(entry: RegistryEntry): string;
/** One directory line: `"to-b" (agent-b) → redis-streams ace:in.b`. */
export declare function describeEndpoint(endpoint: EndpointConfig): string;
/**
 * The listing `ace_channels` returns: this session's channels as the model needs them — name, transport,
 * description, activation — without the deployment plumbing (`config`/`options`) or the burst internals.
 *
 * One section only: with channels living on a server and addresses derived from names, "what I publish
 * to" is any channel name the model chooses (a peer's sender name for a direct message), not a separate
 * configured list.
 */
export declare function formatChannelListing(subscriptions: readonly EndpointConfig[], options?: {
    derivedName?: string;
}): string;
/**
 * The inputs every channel surface lists: the channels this session subscribes to, plus the inbox the
 * agent directory registered for it. One function keeps `ace_channels`, `/ace list` and the manager from
 * disagreeing about what this session is wired to.
 */
export declare function channelListingInput(subscriptions: readonly EndpointConfig[], inbox?: EndpointConfig): {
    subscriptions: readonly EndpointConfig[];
    derivedName?: string;
};
/** Everything `/ace list` prints; the human face, so addresses are included (the tool's listing leaves them out). */
export interface ChannelReport {
    identity: string;
    agentState: string;
    source?: string;
    subscriptions: readonly EndpointConfig[];
    /** Name of the inbox the agent directory registered for this session, when there is one. */
    derivedName?: string;
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