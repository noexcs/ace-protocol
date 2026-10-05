/**
 * The text the tools hand back to the model. It is model-visible exactly like the tool descriptions,
 * so it lives with the spec: when a mechanism changes — a new transport, a renamed config key, a
 * different target rule — one file changes, not one file per host.
 *
 * The hosts keep only what is theirs: turning a core result into the host's tool-result shape.
 */
/** `channel "outbox"` — a configured channel an event was published to. */
export declare function deliveredChannel(name: string): string;
/** `member "a:b"`, or `member "a:b" (already sent)` when the same call targeted it twice. */
export declare function deliveredMember(member: string, alreadySent?: boolean): string;
/** One entry of the failure list: `"target": reason`. */
export declare function failedTarget(target: string, detail: string): string;
/** The `ace_publish` result: what went out, and what did not (with the memory of ids and sender). */
export declare function formatPublishResult(options: {
    id: string;
    sender: string;
    activation: string;
    delivered: readonly string[];
    failures: readonly string[];
}): string;
/** The sentence the directory tool answers with when nobody else is online. */
export declare const NO_LIVE_SESSIONS = "No other agent sessions are registered right now.";
/** The `ace_agents`/directory result: one row per live session, or the sentence that says there are none. */
export declare function formatDiscoveredSessions(rows: readonly string[]): string;
/** The messages the tools return when they cannot do their job — read by the model, so defined once. */
export declare const TOOL_ERROR_TEXT: {
    readonly notRunning: "ACE is not running in this session; .ace.json is missing or did not load";
    readonly noDirectory: "no agent directory configured; add \"registry\" to .ace.json";
    readonly usagePublish: "ace_publish requires a non-empty `body` and a `target` (string or list of strings)";
    readonly targetUnknown: (target: string, configured: readonly string[]) => string;
    readonly targetAmbiguous: (target: string, candidateCount: number, candidates: readonly string[]) => string;
    readonly targetNotFound: (target: string, live: readonly string[]) => string;
    readonly transportUnsupported: (member: string, transport: string) => string;
    readonly nothingPublished: (failures: readonly string[]) => string;
};
//# sourceMappingURL=results.d.ts.map