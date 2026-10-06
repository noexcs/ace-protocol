import { Type } from "typebox";
import type { ResolvedAceConfig } from "../runtime/ace-config.ts";
/**
 * The tool text carries the channel directory, so the agent knows who it can talk to and where its
 * events land without reading `.ace.json` itself.
 *
 * `hostSpecifics` is where a host appends what only it knows — its own commands for a `manual` event,
 * its pending-store limits and spool paths, the config file's resolution order and global candidate,
 * and so on. Core text states protocol semantics only: a host detail written into the core rots with
 * the host's version and leaks one host's implementation into every host's prompt.
 */
export declare function buildPublishToolText(config?: ResolvedAceConfig, sessionId?: string, sender?: string, hostSpecifics?: string): {
    description: string;
    promptGuidelines: string[];
};
/**
 * Parameters of the channel listing tool: none — it lists this session's own configuration.
 *
 * Every ACE tool leaves `additionalProperties` open, and each handler refuses an undeclared argument
 * itself (`rejectUnknownArguments` in `tools/publish.ts`). Closing the object would delegate the
 * decision to the host, and oh-my-pi answers an unrecognized key by *deleting* it before the tool
 * runs: with `additionalProperties: false`, `ace_channels {"foo": 1}` would reach the handler looking
 * exactly like no arguments at all — the silent no-op these schemas exist to stop. Left open, the
 * unknown key reaches the tool, which fails the call naming it.
 */
export declare const CHANNELS_PARAMETERS: Type.TObject<{}>;
/**
 * The argument names every ACE tool declares, next to the schemas that declare them.
 *
 * A host may hand an undeclared argument through, and one that reaches a handler is either ignored
 * (a silent no-op) or refused; the handlers refuse it (`rejectUnknownArguments`, `tools/publish.ts`),
 * naming every key the tool does not take. `channels` takes none.
 */
export declare const TOOL_ARGUMENTS: {
    readonly publish: readonly ["body", "channel", "activation"];
    readonly agents: readonly ["agent", "limit"];
    readonly channels: readonly [];
    readonly storeFile: readonly ["path", "ttl", "name"];
    readonly getFile: readonly ["token"];
};
/**
 * The names every host registers these tools under. One place, so the three hosts cannot drift: a
 * model that learns `ace_publish` in one host finds the same name in the others.
 */
export declare const ACE_TOOL_NAMES: {
    readonly publish: "ace_publish";
    readonly agents: "ace_agents";
    readonly channels: "ace_channels";
    readonly storeFile: "ace_store_file";
    readonly getFile: "ace_get_file";
};
/**
 * The result-line grammar `ace_store_file` and `ace_get_file` share, verbatim, so a reader of either
 * alone learns the same syntax — including how whitespace is quoted — and the two cannot drift.
 * `test/tools/prompt-consistency.test.ts` pins that both descriptions carry it unchanged.
 */
export declare const RESULT_LINE_GRAMMAR: string;
/**
 * The tool text the model sees, in one place: the tool definitions read it from here, and
 * `test/extensions/tool-text-docs.test.ts` fails when the contracts document stops quoting it verbatim.
 */
export declare const TOOL_TEXT: {
    readonly publish: {
        readonly intro: string;
        readonly guidelines: readonly ["Use ace_publish to notify another agent or service; keep the body self-contained.", "Choose the target by the peer it names; pass a list to publish the same event to several at once.", string, "Call ace_agents for the channels that are live right now, then pass one of them as `channel`.", string, string, string, string];
        readonly params: {
            readonly body: string;
            readonly activation: string;
            readonly channel: string;
        };
    };
    readonly agents: {
        readonly description: string;
        readonly guidelines: readonly ["Call ace_agents before ace_publish when the peer is not a channel this session reads."];
        readonly params: {
            readonly agent: string;
            readonly limit: string;
        };
    };
    readonly channels: {
        readonly description: string;
        /**
         * The tail about `ace_agents` only makes sense on a host that registers that tool, so it is a
         * separate piece a host appends or drops. Compose with {@link channelsToolText} rather than
         * concatenating by hand.
         */
        readonly agentsPointer: "— address live peers with ace_agents.";
        readonly guidelines: readonly ["Use a channel this session reads, or a live channel from ace_agents, as the ace_publish `channel`."];
    };
    readonly storeFile: {
        readonly description: string;
        readonly guidelines: readonly [string, string, string, "Storing needs SET and fetching needs GET; when a copy did not land, check the permission on that server.", string];
        readonly params: {
            readonly path: string;
            readonly ttl: string;
            readonly name: string;
        };
    };
    readonly getFile: {
        readonly description: string;
        readonly guidelines: readonly [string, string, string, string];
        readonly params: {
            readonly token: string;
        };
    };
};
/**
 * The `ace_channels` description for a host. The tail pointing at `ace_agents` belongs only to hosts
 * that register that tool, so a host without it passes `{ agentsTool: false }` and drops the pointer
 * instead of rewording the shared text. `hostSpecifics` is the same host-supplied paragraph
 * {@link buildPublishToolText} takes (see there for why).
 */
export declare function channelsToolText(options?: {
    agentsTool?: boolean;
    hostSpecifics?: string;
}): string;
/**
 * Parameters of the publish tool: all three are declared optional and none declares a type, and the
 * event id is generated for the caller. The tool itself validates every one of them.
 *
 * `body` and `channel` declare **no type at all** (`Type.Unsafe` over a description) on purpose, and
 * the descriptions carry the type. Both hosts rewrite tool arguments before the tool runs, and both key
 * on a declared type: Pi's `validateToolArguments` runs TypeBox's `Value.Convert` and then its own
 * schema-directed `coerceWithJsonSchema` (`42` → `"42"`, `null` → `""` in a string list), while
 * oh-my-pi repairs every type issue its validator reports by stringifying the value (`42` → `"42"`, a
 * container → its compact JSON). A node declaring `type: "string"` — a plain JSON-schema node
 * included, which is why the previous round's change did not stop it — therefore reached the tool
 * already rewritten into a valid-looking channel (`channel: 42` published as `ace:<user>:42`). A node
 * that declares no type leaves the validator with no issue to report and the converter with no type to
 * convert, so the raw value reaches `validatePublishInput` (`tools/publish.ts`), which refuses a
 * number, an object or an array and names it (`ace_publish \`channel\` must be a non-empty string or an
 * array of non-empty strings, received 42`). Callers therefore pass strings; a JSON-encoded list is
 * a string, not a list, and is refused rather than parsed.
 *
 * All three are also **optional in the declared schema**. A host's JSON-schema validator runs before
 * the tool: a missing declared-required key is rejected with the host's own wording and the whole tool
 * document echoed back (`channel must be (In: unknown) => To<unknown> (was missing)`), which pre-empts
 * the house sentence `validatePublishInput` would have written. The same goes for a declared `enum`:
 * `activation: "later"` was rejected by the host's enum check, never by ours. Declared optional, the
 * call reaches the tool, which names the missing value (`ace_publish \`body\` must contain at least one
 * non-whitespace character, received undefined`) and refuses an activation outside the four values. The four values stay
 * listed in the `activation` description — the description is what the host shows — so nothing the
 * model reads is lost; only the *rejection wording* moves to us, uniform with every other ACE refusal.
 */
export declare const PUBLISH_PARAMETERS: Type.TObject<{
    body: Type.TOptional<Type.TUnsafe<string>>;
    activation: Type.TOptional<Type.TUnsafe<string>>;
    channel: Type.TOptional<Type.TUnsafe<string | string[]>>;
}>;
/**
 * Parameters of the directory listing tool.
 *
 * Like every ACE tool, the object is left open and the handler refuses undeclared arguments (see
 * {@link CHANNELS_PARAMETERS}). Like `ace_publish`'s `body`/`channel`, both declared nodes also declare
 * **no type** (`Type.Unsafe` over a description): a host rewrites an argument keyed on its declared
 * type, and with `agent` declared `string` and `limit` declared `number` it silently produced
 * `agent: 5` → `"5"` (an empty directory) and `limit: "5"`/`limit: true` → `5`/`1`. With no declared
 * type the raw value reaches `validateAgentsInput` (`tools/agents.ts`), which refuses a non-string
 * `agent` and a non-integer `limit`, naming the value and the type.
 */
export declare const AGENTS_PARAMETERS: Type.TObject<{
    agent: Type.TOptional<Type.TUnsafe<string>>;
    limit: Type.TOptional<Type.TUnsafe<number>>;
}>;
/**
 * Parameters of `ace_store_file`. Like every ACE tool the object is left open and the handler refuses
 * undeclared arguments; like `ace_publish`'s nodes, each declares **no type** (`Type.Unsafe` over a
 * description) so a host that rewrites an argument keyed on its declared type has nothing to rewrite
 * and the raw value reaches `validateStoreInput`, which names a wrong one.
 */
export declare const STORE_FILE_PARAMETERS: Type.TObject<{
    path: Type.TOptional<Type.TUnsafe<string>>;
    ttl: Type.TOptional<Type.TUnsafe<string>>;
    name: Type.TOptional<Type.TUnsafe<string>>;
}>;
/** Parameters of `ace_get_file`; `token` declares no type for the same reason as the nodes above. */
export declare const GET_FILE_PARAMETERS: Type.TObject<{
    token: Type.TOptional<Type.TUnsafe<string>>;
}>;
//# sourceMappingURL=spec.d.ts.map