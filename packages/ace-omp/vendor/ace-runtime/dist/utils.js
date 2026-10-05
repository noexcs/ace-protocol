/** Shared value helpers for protocol validation and runtime configuration checks. */
/** Whether `value` is a plain object (not `null`, not an array). */
export function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Short, log-safe description of a value. Never dumps object contents. */
export function describeValue(value) {
    if (typeof value === "string")
        return JSON.stringify(value);
    if (value === null)
        return "null";
    if (Array.isArray(value))
        return "array";
    return typeof value;
}
/** Characters kept when a session id is displayed: the tail distinguishes concurrent sessions. */
const SESSION_LABEL_LENGTH = 6;
/** The short session label shown next to a sender; the leading part is a shared timestamp. */
export function formatSessionLabel(sessionId) {
    return sessionId.length <= SESSION_LABEL_LENGTH ? sessionId : sessionId.slice(-SESSION_LABEL_LENGTH);
}
//# sourceMappingURL=utils.js.map