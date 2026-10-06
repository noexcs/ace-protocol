/** Shared value helpers for protocol validation and runtime configuration checks. */

/**
 * A whole number of seconds as an ISO 8601 duration. Days, hours, minutes and seconds are decomposed so
 * the result is the shortest form that names the value: `0` → `PT0S`, `33` → `PT33S`, `90` → `PT1M30S`,
 * `3600` → `PT1H`, `86400` → `P1D`, `90061` → `P1DT1H1M1S`. A zero time component is never written
 * (`PT1H`), a zero value is `PT0S` (never `PT`), fractions are rounded, and a negative or non-finite
 * value is treated as zero.
 */
export function formatIsoDuration(totalSeconds: number): string {
	const seconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.round(totalSeconds)) : 0;
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	const secs = seconds % 60;
	const time = `${hours > 0 ? `${hours}H` : ""}${minutes > 0 ? `${minutes}M` : ""}${secs > 0 ? `${secs}S` : ""}`;
	if (days > 0) return `P${days}D${time === "" ? "" : `T${time}`}`;
	return `PT${time === "" ? "0S" : time}`;
}

/**
 * A whole number of seconds in the house's human style: the largest units first, space-separated, zero
 * components dropped, at most one of each unit — `0` → `0s`, `130` → `2m 10s`, `3600` → `1h`,
 * `90000` → `1d 1h`, `3661` → `1h 1m 1s`. This is what a person reads in a report; the ISO 8601 twin
 * ({@link formatIsoDuration}) is what a log or a directory field carries. Fractions are rounded and a
 * negative or non-finite value is treated as zero, exactly as {@link formatIsoDuration} does, and a
 * value that rounds to zero is `0s` rather than the empty string.
 */
export function formatDurationHuman(seconds: number): string {
	const total = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
	const days = Math.floor(total / 86_400);
	const hours = Math.floor((total % 86_400) / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	const secs = total % 60;
	const parts = [
		days > 0 ? `${days}d` : "",
		hours > 0 ? `${hours}h` : "",
		minutes > 0 ? `${minutes}m` : "",
		secs > 0 ? `${secs}s` : "",
	].filter((part) => part !== "");
	return parts.length === 0 ? "0s" : parts.join(" ");
}

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
