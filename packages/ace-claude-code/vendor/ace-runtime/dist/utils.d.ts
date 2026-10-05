/** Shared value helpers for protocol validation and runtime configuration checks. */
/**
 * A whole number of seconds as an ISO 8601 duration. Days, hours, minutes and seconds are decomposed so
 * the result is the shortest form that names the value: `0` → `PT0S`, `33` → `PT33S`, `90` → `PT1M30S`,
 * `3600` → `PT1H`, `86400` → `P1D`, `90061` → `P1DT1H1M1S`. A zero time component is never written
 * (`PT1H`), a zero value is `PT0S` (never `PT`), fractions are rounded, and a negative or non-finite
 * value is treated as zero.
 */
export declare function formatIsoDuration(totalSeconds: number): string;
/** Whether `value` is a plain object (not `null`, not an array). */
export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
/**
 * Short, log-safe description of a value. Never dumps object contents.
 *
 * A primitive is named by its value, not its type — `received 2.5`, `received NaN`, `received true` —
 * so a usage error says which value was refused, as the string and null cases already did. Only a
 * non-empty array (whose contents are never dumped) and a plain object fall back to their type word;
 * an empty array is named as the empty list it is.
 */
export declare function describeValue(value: unknown): string;
/** The short session label shown next to a sender; the leading part is a shared timestamp. */
export declare function formatSessionLabel(sessionId: string): string;
//# sourceMappingURL=utils.d.ts.map