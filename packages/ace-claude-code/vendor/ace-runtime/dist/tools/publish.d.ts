import { type Activation } from "../protocol/ace-message.ts";
import { type ResolvedServer } from "../runtime/ace-config.ts";
import type { RegistryEntry } from "../runtime/agent-registry.ts";
/**
 * The model's `ace_publish` arguments, checked before anything is resolved or sent.
 *
 * An invalid argument used to become a valid-looking channel: `""` was completed to `<ns>:<user>:`,
 * a number was stringified, and a list holding an empty entry had the whole array serialised as one
 * name. Every one of those produces a name nobody can read on a server that is up, so the call would
 * report success while nothing could ever be delivered. Validation fails the call instead, naming
 * the offending value — and it checks the arguments the host passed rather than a schema-checked
 * copy, because a host that coerces (see `PUBLISH_PARAMETERS` in `tools/spec.ts`) would have
 * rewritten them already.
 */
export interface PublishInput {
    /** The event body, unchanged. */
    body: string;
    /**
     * The requested activation, or `undefined` when the caller omitted it (the hosts then send
     * `next_turn`). Checked here, not by the declared schema: a host's enum rejection pre-empts the
     * house sentence (`invalidActivation`), and a declared type would let a coercing host rewrite a
     * wrong value into a legal-looking one.
     */
    activation?: Activation;
    /**
     * The channel names, in call order, trimmed, with **every input kept** — including an exact repeat.
     * Dropping exact repeats here (as this function once did, on the string) collapsed two inputs into
     * one row: `["team", "team"]` reported `targets=1` and no `duplicates=`, while two spellings of one
     * channel (`local:team` and `ace:noexcs:team`) correctly reported `targets=2 duplicates=1`. One row
     * per input is the contract, so the only de-duplication is {@link resolvePublishTargets}' on the
     * *resolved* `(server, channel)` pair, and `targets=` counts inputs uniformly.
     */
    targets: string[];
}
/**
 * Refuse an argument the tool does not declare.
 *
 * Parameter schemas leave unknown keys visible to the tool on purpose (`AGENTS_PARAMETERS` in
 * `tools/spec.ts`: a host that closes the object may delete an extra key before the tool runs, which
 * is exactly the silent no-op this check exists to stop). An argument that reaches the tool and is then ignored is
 * indistinguishable, from the caller's side, from one that was honoured, so the call fails instead
 * and names every key the tool does not take.
 */
export declare function rejectUnknownArguments(tool: string, params: unknown, known: readonly string[]): void;
/** Validate the raw `ace_publish` arguments; throws a usage error naming the offending value. */
export declare function validatePublishInput(params: Record<string, unknown>, 
/**
 * The configured server names, so a `<server>:` prefix can be recognised here. Optional because the
 * prefix check is the only rule that needs the configuration; a caller that omits it still gets every
 * other check, and `resolveChannelTarget` keeps its own guard as a backstop.
 */
options?: {
    servers?: readonly string[];
}): PublishInput;
/**
 * One server this session is live on, as target resolution needs it: the configured server, this
 * session's sender name on it (which is also its inbox channel), and its live directory.
 */
export interface TargetServer {
    server: ResolvedServer;
    sender: string;
    list(): Promise<RegistryEntry[]>;
}
/** A target resolved to a server: the uploaded channel name and the sender to publish as. */
export interface ResolvedChannelTarget {
    server: ResolvedServer;
    /** Uploaded channel name (`<ns>:<username>:<name>`, or a full name exactly as written). */
    channel: string;
    /** This session's sender name on that server. */
    sender: string;
}
/**
 * What happened to one input target, in call order. A duplicate is reported rather than dropped in
 * silence, so the rendered result can carry one row per input and a caller sees that its second name
 * was the same delivery as an earlier one. `of` is the **resolved channel** the earlier input produced
 * — the delivery identity, the value a delivered row shows as its `target=` — not the earlier input
 * string.
 */
export type PublishTargetOutcome<T extends ResolvedChannelTarget = ResolvedChannelTarget> = {
    readonly kind: "target";
    readonly name: string;
    readonly target: T;
} | {
    readonly kind: "duplicate";
    readonly name: string;
    readonly of: string;
} | {
    readonly kind: "failure";
    readonly name: string;
    readonly detail: string;
};
/**
 * Resolve every `channel` argument and keep at most one delivery per resolved channel.
 *
 * One outcome per input, in call order, so the caller can render the result as one row per input. Each
 * input is attempted, so every input that fails is reported; but when a later input resolves to a
 * (server, channel) pair an earlier one already produced, it becomes a `duplicate` outcome instead of a
 * second delivery — string de-duplication cannot see that, because the two names differ. The duplicate
 * carries the earlier target's **resolved channel** as `of`, so it names the earlier delivery the way
 * that row does. The target type is generic, so a host can resolve to a richer target (a live
 * connection, say) and still get the original type back.
 */
export declare function resolvePublishTargets<T extends ResolvedChannelTarget>(names: readonly string[], resolve: (name: string) => Promise<T>): Promise<PublishTargetOutcome<T>[]>;
/**
 * Resolve a `channel` argument to a server and an uploaded channel name.
 *
 * A target is a channel name. `<server>:<channel>` picks the server by its configured name — even
 * when that server is down, so a prefix is never mistaken for a short name and published to the
 * wrong server under a mangled name; it fails with `serverNotUp`. After that prefix the remainder is
 * either a one-segment local name (completed on that server) or a full name of three or more
 * segments (used as written); a two-segment remainder fails as ambiguous, because it reads both as a
 * local name that contains a colon and as a full name whose namespace was left off — completing it
 * either way writes an event nobody can read (`second:noexcs:remote` used to become
 * `ace2:noexcs:noexcs:remote`). A name of three or more segments is a full name whose first segment
 * is a namespace: only a server that owns that namespace may store the event, and one that is
 * configured but down fails with `namespaceNotUp` rather than accepting an event nobody can read. A
 * shorter name is a short name: with exactly one live server it becomes that server's channel,
 * otherwise the live directory decides which server holds it.
 */
export declare function resolveChannelTarget(options: {
    name: string;
    /** The servers this session is live on. */
    active: readonly TargetServer[];
    /** Every server in `.ace.json`, whether or not it came up. */
    configured: readonly ResolvedServer[];
    username: string;
}): Promise<ResolvedChannelTarget>;
//# sourceMappingURL=publish.d.ts.map