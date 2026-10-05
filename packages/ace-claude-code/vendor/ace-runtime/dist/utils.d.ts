/** Shared value helpers for protocol validation and runtime configuration checks. */
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