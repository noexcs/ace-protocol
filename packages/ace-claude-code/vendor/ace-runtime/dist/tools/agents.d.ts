/**
 * The model's `ace_agents` arguments, checked before the directory is read.
 *
 * `agent` and `limit` used to reach the tool already rewritten by the host — `agent: 5` became the
 * filter `"5"` and so reported an empty directory, `limit: true` became `1`, `limit: "5"` became `5` —
 * none of which can be told, from the caller's side, from the argument being honoured. The parameter
 * schema declares no type for either node (`AGENTS_PARAMETERS` in `tools/spec.ts`, the same reason
 * `ace_publish` declares none for `body`/`channel`), so the raw value arrives here and a wrong type is
 * refused, naming the value and the type it must have. `ace_channels` takes no arguments, so its
 * validation is `rejectUnknownArguments` alone.
 */
export interface AgentsInput {
    /** The coding-agent filter, trimmed; absent when none was given or the given one was blank. */
    agent?: string;
    /** The row limit, already clamped to 1..50. */
    limit: number;
}
/** Validate the raw `ace_agents` arguments; throws a usage error naming the offending value. */
export declare function validateAgentsInput(params: Record<string, unknown>): AgentsInput;
//# sourceMappingURL=agents.d.ts.map