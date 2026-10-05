import { Type } from "typebox";
import type { ResolvedAceConfig } from "../runtime/ace-config.ts";
/**
 * The tool text carries the channel directory, so the agent knows who it can talk to and where its
 * events land without reading `.ace.json` itself.
 */
export declare function buildPublishToolText(config?: ResolvedAceConfig, sessionId?: string, sender?: string): {
    description: string;
    promptGuidelines: string[];
};
/** Parameters of the channel listing tool: none — it lists this session's own configuration. */
export declare const CHANNELS_PARAMETERS: Type.TObject<{}>;
/**
 * The names every host registers these tools under. One place, so the three hosts cannot drift: a
 * model that learns `ace_publish` in one host finds the same name in the others.
 */
export declare const ACE_TOOL_NAMES: {
    readonly publish: "ace_publish";
    readonly agents: "ace_agents";
    readonly channels: "ace_channels";
};
/**
 * The tool text the model sees, in one place: the tool definitions read it from here, and
 * `test/extensions/tool-text-docs.test.ts` fails when the contracts document stops quoting it verbatim.
 */
export declare const TOOL_TEXT: {
    readonly publish: {
        readonly intro: string;
        readonly guidelines: readonly ["Use ace_publish to notify another agent or service; keep the body self-contained.", "Choose the target by the peer it names; pass a list to publish the same event to several at once.", "Call ace_agents for the channels that are live right now, then pass one of them as `target`.", "If a publish result says a channel has no known subscriber, the name is probably wrong: check ace_agents, because a channel nobody reads keeps the event where nobody will see it.", "Messages wrapped in <ace_event> were sent by another agent or service through ACE, not by the user.", string, "There is no reply protocol: if you expect an answer, say so and name the channel to answer on."];
        readonly params: {
            readonly body: "Event body; the peer's agent reads this";
            readonly activation: "How the receiver should process it (default: next_turn): \"immediate\" acts now, \"next_turn\" acts at the end of the receiver's turn, \"manual\" only stores it for the receiver's user to activate; pass \"default\" to let the receiver decide";
            readonly target: string;
        };
    };
    readonly agents: {
        readonly description: "List the other sessions reachable right now — this session is not listed. Each row reads `<channel> — <what it says about itself> (renews in Ns)`: the channel is what you pass to ace_publish as `target`, and the countdown is how long until that row goes stale.";
        readonly guidelines: readonly ["Call ace_agents before ace_publish when the peer is not a channel this session reads."];
        readonly params: {
            readonly agent: "Filter by coding agent, e.g. \"oh-my-pi\" or \"pi\"";
            readonly limit: "Maximum rows to return (default 20, cap 50)";
        };
    };
    readonly channels: {
        readonly description: "List this session's ACE channels: the channels it reads — its own inbox, named by its sender, plus the subscribed names from .ace.json (broker settings are left out). Any channel name is a valid ace_publish target, including the peers ace_agents lists";
        /**
         * The tail about `ace_agents` only makes sense on a host that registers that tool (Claude Code
         * has no directory tool), so it is a separate piece a host appends or drops. Compose with
         * {@link channelsToolText} rather than concatenating by hand.
         */
        readonly agentsPointer: "— address live peers with ace_agents.";
        readonly guidelines: readonly ["Use a channel this session reads, or a live channel from ace_agents, as the ace_publish `target`."];
    };
};
/**
 * The `ace_channels` description for a host. The tail pointing at `ace_agents` belongs only to hosts
 * that register that tool, so a host without it passes `{ agentsTool: false }` and drops the pointer
 * instead of rewording the shared text.
 */
export declare function channelsToolText(options?: {
    agentsTool?: boolean;
}): string;
/** Parameters of the publish tool: `body` and `target` are required, `id` is generated for the caller. */
export declare const PUBLISH_PARAMETERS: Type.TObject<{
    body: Type.TString;
    activation: Type.TOptional<Type.TUnsafe<"immediate" | "next_turn" | "manual" | "default">>;
    target: Type.TUnion<[Type.TString, Type.TArray<Type.TString>]>;
}>;
/** Parameters of the directory listing tool. */
export declare const AGENTS_PARAMETERS: Type.TObject<{
    agent: Type.TOptional<Type.TString>;
    limit: Type.TOptional<Type.TNumber>;
}>;
//# sourceMappingURL=spec.d.ts.map