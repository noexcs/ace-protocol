import type { ReaderFacts } from "../runtime/agent-registry.ts";
/**
 * The text the tools hand back to the model. It is model-visible exactly like the tool descriptions,
 * so it lives with the spec: when a mechanism changes — a new transport, a renamed config key, a
 * different target rule — one file changes, not one file per host.
 *
 * The hosts keep only what is theirs: turning a core result into the host's tool-result shape.
 */
/**
 * A stored row's `note`, naming the target's shape: `completed-short-name` when the target was a short
 * name the runtime auto-completed (`noexcs:inbox` → `ace:noexcs:noexcs:inbox`).
 */
export type PublishNote = "completed-short-name";
/**
 * One row of the `ace_publish` result: one input target and what happened to it. The result is a field
 * list, so a caller reads `status` instead of scraping a sentence.
 *
 * A stored row is `status=stored`: ACE stored the event on the channel, which is not an acknowledgement
 * that anything read it. Its `note` is set when the target's name has a shape worth naming (see
 * {@link PublishNote}); a row for a `manual` publish additionally carries `awaiting_activation=yes`,
 * added by {@link formatPublishResult} from the publish's own activation.
 */
export type PublishTargetRow = {
    readonly target: string;
    readonly status: "stored";
    readonly peerNamed: boolean;
    readonly selfReads: boolean;
    readonly note?: PublishNote;
} | {
    readonly target: string;
    readonly status: "duplicate";
    readonly of: string;
} | {
    readonly target: string;
    readonly status: "failed";
    readonly error: string;
};
/**
 * A stored target: the channel the event was written to, and what the two reader checks found. The
 * event is stored, not acknowledged — nothing here says a reader consumed it.
 *
 * `peerNamed` and `selfReads` are the two independent answers from {@link readerFactsOf}, rendered as
 * `peer_named=yes|no` and `self_reads=yes|no`. They are deliberately two fields named for the check
 * they report, not one word drawn from them: `peer_named=yes` says a live directory entry names the
 * channel (another session's own channel equals it), while `peer_named=no` does **not** say nobody
 * else reads it — a peer's subscriptions are in its own file and are not visible here — and
 * `self_reads=yes` does not say this session is the only reader. The single word this replaced read
 * as a verdict on who reads the channel (`peer` = "a peer subscribed", `none` = "nobody"), which the
 * name-equality check could not support. Publishing to a channel neither check names is legal (a
 * channel is a name, not a mailbox) but it is what a typo looks like. What each field means is
 * spelled out once in the tool description, not per result.
 *
 * `completedShortName` marks a target the runtime auto-completed from a short name (`noexcs:inbox` →
 * `ace:noexcs:noexcs:inbox`), so the caller sees the name that was actually stored. It is not refused;
 * it is named.
 */
export declare function deliveredChannel(target: string, facts: ReaderFacts, options?: {
    completedShortName?: boolean;
}): PublishTargetRow;
/**
 * An input target that failed to resolve or deliver, reported by the input string as written — after a
 * failed resolution that is all that is known about it. `error` is the reason, quoted in the row.
 */
export declare function failedTarget(target: string, detail: string): PublishTargetRow;
/**
 * An input target dropped because an earlier input resolved to the same `(server, channel)` pair. It is
 * a row of its own rather than silently absent, so `targets=` can count every input and a caller sees
 * that its second name was the same delivery. `of` is the **resolved channel** the earlier input
 * produced — the delivery identity, and the same value that earlier delivered row carries as its
 * `target=` — never the earlier input string, which a delivered row does not show. Resolution and
 * de-duplication run on the resolved pair (`resolvePublishTargets`), so the resolved channel is what
 * the two rows share.
 */
export declare function duplicateTarget(target: string, of: string): PublishTargetRow;
/**
 * The `ace_publish` result: a header counting the call, then one row per input target, in input order.
 *
 * Rows, not prose: a caller reads `stored=`/`duplicates=`/`failed=` and each row's `status` instead of
 * parsing a sentence, and the non-atomic mixed list is visible in the counts as well as the rows.
 * `duplicates=` is always present, `0` when there was none, so the header's arithmetic
 * `targets = stored + duplicates + failed` holds in every result: `targets=2 stored=1` alone
 * would look like a failure when the second input was merely a duplicate.
 *
 * A `status=stored` row means the event was stored on the channel, not that anything read it. On a
 * `manual` activation every stored row additionally carries `awaiting_activation=yes`, because the
 * event is waiting for the receiver's user to activate it.
 *
 * This is also the text of the all-failed outcome, which a host throws instead of collapsing to a
 * sentence: `stored=0` with one `status=failed` row per input. The shape therefore does not depend
 * on how many targets succeeded — a caller that parses it once parses every outcome.
 *
 * The one deliberate shape difference is `id=`/`sender=`: an all-failed call created no event, so the
 * header carries neither and says `event=none` in their place. Printing an empty `sender=` beside a
 * freshly minted `id=` made a failed-only call look like a stored event with no origin, which is
 * exactly the reading the marker exists to prevent. `activation=` and the counts stay in every header.
 */
export declare function formatPublishResult(options: {
    id: string;
    sender: string;
    activation: string;
    rows: readonly PublishTargetRow[];
}): string;
/** The sentence the directory tool adds under a `count=0` header when nobody else is online and no filter was given. */
export declare const NO_LIVE_SESSIONS = "No other agent sessions are registered right now.";
/**
 * The `ace_agents`/directory result: a header counting the rows, then one field row per live session
 * (rendered by {@link describeDiscovered}). The header is always emitted — `count=0` when there are no
 * rows, `servers=<name>,<name>` naming the live servers the lookup merged (in config order) and
 * `filter=<agent>` when a filter was given — so a header-only parser never has to recognise a sentence
 * to read the count, and a reader can tell a server that has no peers from one that was never searched.
 * Under an empty header, a sentence says whether there are no sessions at all or the `agent` filter
 * simply matched nothing — a real difference when a caller automates lookups, because "nothing
 * registered" and "no "pi" here" call for different next steps.
 *
 * A filter that is empty or whitespace-only after trimming is **no filter**, not a filter that matches
 * nothing: it cannot name a coding agent, and treating it as one turned a live directory into a
 * `count=0` header that read exactly like an empty one. The rows passed here are then the whole
 * directory (or an already-filtered one), so the `count=0` header and the sentence stay true.
 */
export declare function formatDiscoveredSessions(rows: readonly string[], options?: {
    filter?: string;
    servers?: readonly string[];
}): string;
/**
 * One server's directory as the lookup read it: its name and the channel names the entries carry.
 *
 * The not-found message names what was actually found, so a caller hands over the entries it already
 * listed instead of a placeholder per server.
 */
export interface LiveChannelDirectory {
    /** The server's configured name (`<server>` in a `<server>:<channel>` target). */
    readonly server: string;
    /** The channel names the server's directory listed, exactly as the entries carry them. */
    readonly channels: readonly string[];
}
/**
 * Why a `channel` name cannot be used as written, appended to the message that names the value. A
 * name is an address, so a name no reader can type back — one carrying whitespace or a control
 * character, or one with an empty segment — is a usage error rather than something to complete.
 */
export declare const INVALID_NAME_REASON: {
    readonly whitespace: "contains interior whitespace or a control character, which a channel name cannot carry";
    readonly emptySegment: "has an empty segment — \":\" separates the segments, so every segment must be non-empty";
};
/** The messages the tools return when they cannot do their job — read by the model, so defined once. */
export declare const TOOL_ERROR_TEXT: {
    readonly notRunning: "ACE is not running in this session; .ace.json is missing or did not load";
    readonly noDirectory: "no agent directory: no server from .ace.json is reachable";
    /** A `<server>:` prefix names a server that is configured but did not come up: never resolve it as a short name. */
    readonly serverNotUp: (server: string) => string;
    readonly namespaceNotUp: (namespace: string, server: string) => string;
    /** A full name whose namespace no configured server owns: nothing can store or deliver it. */
    readonly namespaceUnclaimed: (namespace: string) => string;
    readonly invalidBody: (value: unknown) => string;
    readonly invalidActivation: (value: unknown) => string;
    readonly invalidChannel: (value: unknown) => string;
    readonly invalidChannelEntry: (value: unknown, index: number, count: number) => string;
    /** A name that is a string but not usable as an address: whitespace, a control character, an empty segment. */
    readonly invalidChannelName: (value: string, reason: string) => string;
    readonly invalidChannelEntryName: (value: string, index: number, count: number, reason: string) => string;
    /**
     * A `<server>:` prefix whose remainder has two segments: it reads as a local name that contains a
     * colon *and* as a full name with its namespace left off, so completing it either way writes an
     * event nobody can read. The earlier prefix defect published such a name as `<ns>:<user>:<remainder>`.
     */
    readonly ambiguousServerRemainder: (server: string, remainder: string) => string;
    /** A tool argument the tool does not declare: an unhonoured argument must never look like an honoured one. */
    readonly unknownArguments: (tool: string, unknown: readonly string[], known: readonly string[]) => string;
    readonly targetAmbiguous: (target: string, candidateCount: number, candidates: readonly string[]) => string;
    readonly targetNotFound: (target: string, live: readonly LiveChannelDirectory[]) => string;
    /** An `ace_agents` argument the tool cannot use: a wrong type is named, never coerced. */
    readonly invalidAgent: (value: unknown) => string;
    readonly invalidLimit: (value: unknown) => string;
};
//# sourceMappingURL=results.d.ts.map