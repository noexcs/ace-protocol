import { ACE_CONFIG_FILENAME } from "../runtime/ace-config.js";
import { describeValue } from "../utils.js";
/**
 * A delivered target: the channel the event was written to, and what the two reader checks found.
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
 * `streamKey` marks a target whose channel has the transport's key shape; it is named, never refused.
 */
export function deliveredChannel(target, facts, options = {}) {
    return {
        target,
        status: "delivered",
        peerNamed: facts.peerNamed,
        selfReads: facts.selfReads,
        ...(options.streamKey === true ? { note: "stream-key" } : {}),
    };
}
/**
 * An input target that failed to resolve or deliver, reported by the input string as written — after a
 * failed resolution that is all that is known about it. `error` is the reason, quoted in the row.
 */
export function failedTarget(target, detail) {
    return { target, status: "failed", error: detail };
}
/**
 * An input target dropped because an earlier input resolved to the same `(server, channel)` pair. It is
 * a row of its own rather than silently absent, so `targets=` can count every input and a caller sees
 * that its second name was the same delivery. `of` is the **resolved channel** the earlier input
 * produced — the delivery identity, and the same value that earlier delivered row carries as its
 * `target=` — never the earlier input string, which a delivered row does not show. Resolution and
 * de-duplication run on the resolved pair (`resolvePublishTargets`), so the resolved channel is what
 * the two rows share.
 */
export function duplicateTarget(target, of) {
    return { target, status: "duplicate", of };
}
/** One rendered row: lowercase `<field>=<value>` tokens, quoted only where a value can carry spaces. */
function renderPublishRow(row) {
    switch (row.status) {
        case "delivered":
            return `target=${row.target} status=delivered peer_named=${row.peerNamed ? "yes" : "no"} self_reads=${row.selfReads ? "yes" : "no"}${row.note === undefined ? "" : ` note=${row.note}`}`;
        case "duplicate":
            return `target=${row.target} status=duplicate of=${row.of}`;
        case "failed":
            return `target=${row.target} status=failed error=${JSON.stringify(row.error)}`;
    }
}
/**
 * The `ace_publish` result: a header counting the call, then one row per input target, in input order.
 *
 * Rows, not prose: a caller reads `delivered=`/`duplicates=`/`failed=` and each row's `status` instead of
 * parsing a sentence, and the non-atomic mixed list is visible in the counts as well as the rows.
 * `duplicates=` is always present, `0` when there was none, so the header's arithmetic
 * `targets = delivered + duplicates + failed` holds in every result: `targets=2 delivered=1` alone
 * would look like a failure when the second input was merely a duplicate.
 *
 * This is also the text of the all-failed outcome, which a host throws instead of collapsing to a
 * sentence: `delivered=0` with one `status=failed` row per input. The shape therefore does not depend
 * on how many targets succeeded — a caller that parses it once parses every outcome.
 *
 * The one deliberate shape difference is `id=`/`sender=`: an all-failed call created no event, so the
 * header carries neither and says `event=none` in their place. Printing an empty `sender=` beside a
 * freshly minted `id=` made a failed-only call look like a stored event with no origin, which is
 * exactly the reading the marker exists to prevent. `activation=` and the counts stay in every header.
 */
export function formatPublishResult(options) {
    const delivered = options.rows.filter((row) => row.status === "delivered").length;
    const failed = options.rows.filter((row) => row.status === "failed").length;
    const duplicates = options.rows.filter((row) => row.status === "duplicate").length;
    const head = [
        "ace 0.1 publish",
        // No delivery means no event was created, so there is no id to hand out and no sender to name.
        ...(delivered === 0 ? ["event=none"] : [`id=${options.id}`, `sender=${options.sender}`]),
        `activation=${options.activation}`,
        `targets=${options.rows.length}`,
        `delivered=${delivered}`,
        `failed=${failed}`,
        `duplicates=${duplicates}`,
    ].join(" ");
    return [head, ...options.rows.map(renderPublishRow)].join("\n");
}
/** The sentence the directory tool adds under a `count=0` header when nobody else is online and no filter was given. */
export const NO_LIVE_SESSIONS = "No other agent sessions are registered right now.";
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
export function formatDiscoveredSessions(rows, options = {}) {
    const filter = options.filter?.trim();
    const effective = filter !== undefined && filter.length > 0 ? filter : undefined;
    // The filter is a header field, so it is quoted when it would otherwise break the one-line shape.
    const shown = effective === undefined
        ? ""
        : /[\s\u0000-\u001f\u007f-\u009f]/.test(effective)
            ? ` filter=${JSON.stringify(effective)}`
            : ` filter=${effective}`;
    const servers = ` servers=${(options.servers ?? []).join(",")}`;
    const head = `ace 0.1 agents count=${rows.length}${servers}${shown}`;
    if (rows.length > 0)
        return [head, ...rows].join("\n");
    return [
        head,
        effective === undefined ? NO_LIVE_SESSIONS : `No live session matches the agent filter "${effective}".`,
    ].join("\n");
}
/** Live channels named in a not-found failure before the list is truncated — the message stays short. */
const LIVE_CHANNELS_IN_ERROR = 5;
/**
 * Why a `channel` name cannot be used as written, appended to the message that names the value. A
 * name is an address, so a name no reader can type back — one carrying whitespace or a control
 * character, or one with an empty segment — is a usage error rather than something to complete.
 */
export const INVALID_NAME_REASON = {
    // The name is trimmed before this check, so any whitespace still in it is interior — say so, so
    // "leading/trailing whitespace is accepted" cannot be read as contradicted by this message.
    whitespace: "contains interior whitespace or a control character, which a channel name cannot carry",
    emptySegment: 'has an empty segment — ":" separates the segments, so every segment must be non-empty',
};
/** The messages the tools return when they cannot do their job — read by the model, so defined once. */
export const TOOL_ERROR_TEXT = {
    notRunning: `ACE is not running in this session; ${ACE_CONFIG_FILENAME} is missing or did not load`,
    noDirectory: `no agent directory: no server from ${ACE_CONFIG_FILENAME} is reachable`,
    /** A `<server>:` prefix names a server that is configured but did not come up: never resolve it as a short name. */
    serverNotUp: (server) => `server "${server}" did not come up (it is configured in ${ACE_CONFIG_FILENAME} but is not reachable)`,
    namespaceNotUp: (namespace, server) => `namespace "${namespace}" belongs to server "${server}", which did not come up (it is configured in ${ACE_CONFIG_FILENAME} but is not reachable)`,
    /** A full name whose namespace no configured server owns: nothing can store or deliver it. */
    namespaceUnclaimed: (namespace) => `no configured server owns namespace "${namespace}", so nothing will store or deliver this event`,
    invalidBody: (value) => `ace_publish \`body\` must contain at least one non-whitespace character, received ${describeValue(value)}`,
    invalidActivation: (value) => `ace_publish \`activation\` must be one of "immediate", "next_turn", "manual", "default", received ${describeValue(value)}`,
    invalidChannel: (value) => `ace_publish \`channel\` must be a non-empty string or an array of non-empty strings, received ${describeValue(value)}`,
    invalidChannelEntry: (value, index, count) => `ace_publish \`channel\` entry ${index + 1} of ${count} must be a non-empty string, received ${describeValue(value)}`,
    /** A name that is a string but not usable as an address: whitespace, a control character, an empty segment. */
    invalidChannelName: (value, reason) => `ace_publish \`channel\` ${describeValue(value)} ${reason}`,
    invalidChannelEntryName: (value, index, count, reason) => `ace_publish \`channel\` entry ${index + 1} of ${count} ${describeValue(value)} ${reason}`,
    /**
     * A `<server>:` prefix whose remainder has two segments: it reads as a local name that contains a
     * colon *and* as a full name with its namespace left off, so completing it either way writes an
     * event nobody can read. The earlier prefix defect published such a name as `<ns>:<user>:<remainder>`.
     */
    ambiguousServerRemainder: (server, remainder) => `after the server prefix "${server}", ${describeValue(remainder)} is a two-segment name and reads two ` +
        `ways — a local name that contains a colon, or a full name with its namespace left off; write the full ` +
        `name "<ns>:<username>:<name>" or a one-segment name on "${server}"`,
    /** A tool argument the tool does not declare: an unhonoured argument must never look like an honoured one. */
    unknownArguments: (tool, unknown, known) => `${tool} does not take ${unknown.map((key) => JSON.stringify(key)).join(", ")}; it takes ${known.length === 0 ? "no arguments" : known.map((key) => `\`${key}\``).join(", ")}`,
    targetAmbiguous: (target, candidateCount, candidates) => `target "${target}" matches ${candidateCount} live channels; pass the full channel name: ${candidates.join(", ")}`,
    targetNotFound: (target, live) => {
        const named = [];
        const withoutChannel = [];
        for (const server of live) {
            if (server.channels.length === 0)
                withoutChannel.push(server.server);
            for (const channel of server.channels)
                named.push(`${server.server}:${channel}`);
        }
        const shown = named.slice(0, LIVE_CHANNELS_IN_ERROR);
        const details = [
            ...(shown.length === 0
                ? []
                : [
                    `live session channels: ${shown.join(", ")}${named.length > shown.length ? `, +${named.length - shown.length} more` : ""} — a channel is a valid target with no registered reader, so a service channel never appears here`,
                ]),
            ...(withoutChannel.length === 0 ? [] : [`no live channel on ${withoutChannel.join(", ")}`]),
        ];
        return `no live channel matches "${target}"${details.length === 0 ? "" : ` (${details.join("; ")})`}`;
    },
    /** An `ace_agents` argument the tool cannot use: a wrong type is named, never coerced. */
    invalidAgent: (value) => `ace_agents \`agent\` must be a string, received ${describeValue(value)}`,
    invalidLimit: (value) => `ace_agents \`limit\` must be an integer, received ${describeValue(value)}`,
};
//# sourceMappingURL=results.js.map