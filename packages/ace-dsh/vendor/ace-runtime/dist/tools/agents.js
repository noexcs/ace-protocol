import { rejectUnknownArguments } from "./publish.js";
import { TOOL_ERROR_TEXT } from "./results.js";
import { ACE_TOOL_NAMES, TOOL_ARGUMENTS } from "./spec.js";
/** Validate the raw `ace_agents` arguments; throws a usage error naming the offending value. */
export function validateAgentsInput(params) {
    rejectUnknownArguments(ACE_TOOL_NAMES.agents, params, TOOL_ARGUMENTS.agents);
    const rawAgent = params.agent;
    let agent;
    if (rawAgent !== undefined) {
        if (typeof rawAgent !== "string")
            throw new Error(TOOL_ERROR_TEXT.invalidAgent(rawAgent));
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
//# sourceMappingURL=agents.js.map