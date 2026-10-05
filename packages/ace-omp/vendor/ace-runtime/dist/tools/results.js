import { ACE_CONFIG_FILENAME } from "../runtime/ace-config.js";
/**
 * The text the tools hand back to the model. It is model-visible exactly like the tool descriptions,
 * so it lives with the spec: when a mechanism changes — a new transport, a renamed config key, a
 * different target rule — one file changes, not one file per host.
 *
 * The hosts keep only what is theirs: turning a core result into the host's tool-result shape.
 */
/**
 * `channel "outbox"` — the target channel name an event was published to.
 *
 * `unknownSubscriber` adds the note that neither the live directory nor this session's own subscriptions
 * name the channel. Publishing to a name nobody reads is legal — a channel is a name, not a mailbox — but
 * it is exactly what a typo looks like, so the result says so instead of reporting a silent success.
 */
export function deliveredChannel(name, unknownSubscriber = false) {
    return unknownSubscriber ? `channel "${name}" (no known subscriber)` : `channel "${name}"`;
}
/** One entry of the failure list: `"<channel>": reason`. */
export function failedTarget(target, detail) {
    return `"${target}": ${detail}`;
}
/** The `ace_publish` result: what went out, and what did not (with the memory of ids and sender). */
export function formatPublishResult(options) {
    const head = `Published id=${options.id} from ${options.sender} to ${options.delivered.length} target(s): ` +
        `${options.delivered.join(", ")} (activation: ${options.activation}).`;
    const lines = options.failures.length === 0 ? [head] : [head, `Failed: ${options.failures.join("; ")}`];
    const unknown = options.unknownSubscribers ?? [];
    if (unknown.length > 0) {
        lines.push(`No subscriber is known for ${unknown.map((name) => `"${name}"`).join(", ")}: the event is stored on ` +
            "the channel and will be read if one subscribes later.");
    }
    return lines.join("\n");
}
/** The sentence the directory tool answers with when nobody else is online. */
export const NO_LIVE_SESSIONS = "No other agent sessions are registered right now.";
/** The `ace_agents`/directory result: one row per live session, or the sentence that says there are none. */
export function formatDiscoveredSessions(rows) {
    return rows.length === 0 ? NO_LIVE_SESSIONS : rows.join("\n");
}
/** Live channels named in a not-found failure before the list is truncated — the message stays short. */
const LIVE_CHANNELS_IN_ERROR = 5;
/** The messages the tools return when they cannot do their job — read by the model, so defined once. */
export const TOOL_ERROR_TEXT = {
    notRunning: `ACE is not running in this session; ${ACE_CONFIG_FILENAME} is missing or did not load`,
    noDirectory: `no agent directory: no server from ${ACE_CONFIG_FILENAME} is reachable`,
    usagePublish: "ace_publish requires a non-empty `body` and a `channel` (string or list of strings)",
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
    nothingPublished: (failures) => `nothing published: ${failures.join("; ")}`,
};
//# sourceMappingURL=results.js.map