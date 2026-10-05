/** Shared value helpers for protocol validation and runtime configuration checks. */

/** Whether `value` is a plain object (not `null`, not an array). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Short, log-safe description of a value. Never dumps object contents.
 *
 * A primitive is named by its value, not its type — `received 2.5`, `received NaN`, `received true` —
 * so a usage error says which value was refused, as the string and null cases already did. Only a
 * non-empty array (whose contents are never dumped) and a plain object fall back to their type word;
 * an empty array is named as the empty list it is.
 */
export function describeValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "boolean") return String(value);
	if (value === null) return "null";
	if (Array.isArray(value)) return value.length === 0 ? "an empty list" : "array";
	return typeof value;
}

/** Characters kept when a session id is displayed: the tail distinguishes concurrent sessions. */
const SESSION_LABEL_LENGTH = 6;

/** The short session label shown next to a sender; the leading part is a shared timestamp. */
export function formatSessionLabel(sessionId: string): string {
	return sessionId.length <= SESSION_LABEL_LENGTH ? sessionId : sessionId.slice(-SESSION_LABEL_LENGTH);
}
