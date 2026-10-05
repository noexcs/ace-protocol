import { rejectUnknownArguments } from "./publish.ts";
import { TOOL_ERROR_TEXT } from "./results.ts";
import { ACE_TOOL_NAMES, TOOL_ARGUMENTS } from "./spec.ts";

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
export function validateAgentsInput(params: Record<string, unknown>): AgentsInput {
	rejectUnknownArguments(ACE_TOOL_NAMES.agents, params, TOOL_ARGUMENTS.agents);

	const rawAgent = params.agent;
	let agent: string | undefined;
	if (rawAgent !== undefined) {
		if (typeof rawAgent !== "string") throw new Error(TOOL_ERROR_TEXT.invalidAgent(rawAgent));
		const trimmed = rawAgent.trim();
		// A blank filter names no coding agent, so it is no filter at all — never a filter that turns a
		// live directory into a `count=0` header indistinguishable from an empty one. The rows are then
		// the whole directory, which is exactly what "no filter" means.
		agent = trimmed.length === 0 ? undefined : trimmed;
	}

	const rawLimit = params.limit;
	if (rawLimit !== undefined && (typeof rawLimit !== "number" || !Number.isInteger(rawLimit))) {
		throw new Error(TOOL_ERROR_TEXT.invalidLimit(rawLimit));
	}
	// The documented clamp stays for an in-range integer: `limit: 0` is 1, `limit: 99` is 50.
	const limit = Math.min(Math.max(rawLimit ?? 20, 1), 50);

	return { ...(agent === undefined ? {} : { agent }), limit };
}
