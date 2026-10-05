/** Shared value helpers for protocol validation and runtime configuration checks. */
/** Whether `value` is a plain object (not `null`, not an array). */
export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
/** Short, log-safe description of a value. Never dumps object contents. */
export declare function describeValue(value: unknown): string;
/** The short session label shown next to a sender; the leading part is a shared timestamp. */
export declare function formatSessionLabel(sessionId: string): string;
//# sourceMappingURL=utils.d.ts.map