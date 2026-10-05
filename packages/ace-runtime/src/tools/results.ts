import { ACE_CONFIG_FILENAME } from "../runtime/ace-config.ts";

/**
 * The text the tools hand back to the model. It is model-visible exactly like the tool descriptions,
 * so it lives with the spec: when a mechanism changes — a new transport, a renamed config key, a
 * different target rule — one file changes, not one file per host.
 *
 * The hosts keep only what is theirs: turning a core result into the host's tool-result shape.
 */

/** `channel "outbox"` — a configured channel an event was published to. */
export function deliveredChannel(name: string): string {
	return `channel "${name}"`;
}

/** `member "a:b"`, or `member "a:b" (already sent)` when the same call targeted it twice. */
export function deliveredMember(member: string, alreadySent = false): string {
	return `member "${member}"${alreadySent ? " (already sent)" : ""}`;
}

/** One entry of the failure list: `"target": reason`. */
export function failedTarget(target: string, detail: string): string {
	return `"${target}": ${detail}`;
}

/** The `ace_publish` result: what went out, and what did not (with the memory of ids and sender). */
export function formatPublishResult(options: {
	id: string;
	sender: string;
	activation: string;
	delivered: readonly string[];
	failures: readonly string[];
}): string {
	const head =
		`Published id=${options.id} from ${options.sender} to ${options.delivered.length} target(s): ` +
		`${options.delivered.join(", ")} (activation: ${options.activation}).`;
	return options.failures.length === 0 ? head : [head, `Failed: ${options.failures.join("; ")}`].join("\n");
}

/** The sentence the directory tool answers with when nobody else is online. */
export const NO_LIVE_SESSIONS = "No other agent sessions are registered right now.";

/** The `ace_agents`/directory result: one row per live session, or the sentence that says there are none. */
export function formatDiscoveredSessions(rows: readonly string[]): string {
	return rows.length === 0 ? NO_LIVE_SESSIONS : rows.join("\n");
}

/** The messages the tools return when they cannot do their job — read by the model, so defined once. */
export const TOOL_ERROR_TEXT = {
	notRunning: `ACE is not running in this session; ${ACE_CONFIG_FILENAME} is missing or did not load`,
	noDirectory: `no agent directory configured; add "registry" to ${ACE_CONFIG_FILENAME}`,
	usagePublish: "ace_publish requires a non-empty `body` and a `target` (string or list of strings)",
	targetUnknown: (target: string, configured: readonly string[]): string =>
		`unknown target "${target}" (configured: ${configured.join(", ") || "none"}; no agent directory configured)`,
	targetAmbiguous: (target: string, candidateCount: number, candidates: readonly string[]): string =>
		`target "${target}" matches ${candidateCount} sessions; pass the full member: ${candidates.join(", ")}`,
	targetNotFound: (target: string, live: readonly string[]): string =>
		`no live session matches "${target}"${live.length === 0 ? "" : ` (live: ${live.join(", ")})`}`,
	transportUnsupported: (member: string, transport: string): string =>
		`member "${member}" advertises transport "${transport}", which this runtime cannot publish to`,
	nothingPublished: (failures: readonly string[]): string => `nothing published: ${failures.join("; ")}`,
} as const;
