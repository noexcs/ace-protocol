import { describeValue } from "../utils.js";
/** The transport address of a channel, whatever that transport calls it. */
export function endpointAddress(endpoint) {
    const address = endpoint.config.stream ?? endpoint.config.subject ?? endpoint.config.topic ?? endpoint.config.queue;
    return typeof address === "string" ? address : undefined;
}
/** Thrown when runtime configuration is unusable (RFC-facing §10). */
export class AceConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = "AceConfigError";
    }
}
/** Reject keys a binding or a transport config does not know: typos must not pass silently. */
export function rejectUnknownKeys(value, allowed, subject) {
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
        throw new AceConfigError(`${subject} has unknown setting(s) ${unknown.map((key) => `"${key}"`).join(", ")} (supported: ${allowed.join(", ")})`);
    }
}
/** Read a required non-empty string setting from a transport config. */
export function requiredStringField(config, key, subject) {
    const value = config[key];
    if (typeof value !== "string" || value.length === 0) {
        throw new AceConfigError(`${subject} needs a non-empty "${key}", received ${describeValue(value)}`);
    }
    return value;
}
/** Read an optional non-empty string setting, falling back to a default. */
export function optionalStringField(config, key, fallback, subject) {
    const value = config[key];
    if (value === undefined)
        return fallback;
    if (typeof value !== "string" || value.length === 0) {
        throw new AceConfigError(`${subject} has invalid "${key}": ${describeValue(value)}`);
    }
    return value;
}
/** Read an optional positive integer setting, falling back to a default. */
export function positiveIntegerField(config, key, fallback, subject) {
    const value = config[key];
    if (value === undefined)
        return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new AceConfigError(`${subject} has invalid "${key}": ${describeValue(value)} (needs an integer >= 1)`);
    }
    return value;
}
//# sourceMappingURL=endpoint-config.js.map