/** Shared value helpers for protocol validation and runtime configuration checks. */

/** Whether `value` is a plain object (not `null`, not an array). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Short, log-safe description of a value. Never dumps object contents. */
export function describeValue(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}
