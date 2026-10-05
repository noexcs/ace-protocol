import type { Activation } from "../protocol/ace-message.ts";
import { describeValue } from "../utils.ts";

/**
 * One channel binding, as the runtime sees it after configuration is resolved.
 *
 * `name` is the local subscription label, `transport` is fixed to Redis, `config` carries the address
 * settings the Redis transport reads (stream, group, url, field…), and `options` is passed through to
 * the client library untouched.
 *
 * These endpoints are **derived**, not written: a channel's address comes from its name
 * (`<ns>:ch:<name>`) and its group from the subscribing session's sender name. `docs/ace-plan.md` and
 * `runtime-contracts.ts` carry the model; this file only defines the shape the transport consumes.
 */
export interface EndpointConfig {
	name: string;
	transport: string;
	/** Human/model-readable note about this channel, e.g. which peer sits on the other end. */
	description?: string;
	/** Subscriptions only: activation this receiver forces; `default` delegates to the message. */
	activation?: Activation;
	/** Transport-specific settings, validated by that transport. */
	config: Record<string, unknown>;
	/** Raw options handed to the transport's client library; never validated, never interpreted. */
	options: Record<string, unknown>;
}

/** The transport address of a channel, whatever that transport calls it. */
export function endpointAddress(endpoint: EndpointConfig): string | undefined {
	const address = endpoint.config.stream ?? endpoint.config.subject ?? endpoint.config.topic ?? endpoint.config.queue;
	return typeof address === "string" ? address : undefined;
}

/** Thrown when runtime configuration is unusable (RFC-facing §10). */
export class AceConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AceConfigError";
	}
}

/** Reject keys a binding or a transport config does not know: typos must not pass silently. */
export function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], subject: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) {
		throw new AceConfigError(
			`${subject} has unknown setting(s) ${unknown.map((key) => `"${key}"`).join(", ")} (supported: ${allowed.join(", ")})`,
		);
	}
}

/** Read a required non-empty string setting from a transport config. */
export function requiredStringField(config: Record<string, unknown>, key: string, subject: string): string {
	const value = config[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new AceConfigError(`${subject} needs a non-empty "${key}", received ${describeValue(value)}`);
	}
	return value;
}

/** Read an optional non-empty string setting, falling back to a default. */
export function optionalStringField(
	config: Record<string, unknown>,
	key: string,
	fallback: string,
	subject: string,
): string {
	const value = config[key];
	if (value === undefined) return fallback;
	if (typeof value !== "string" || value.length === 0) {
		throw new AceConfigError(`${subject} has invalid "${key}": ${describeValue(value)}`);
	}
	return value;
}

/** Read an optional positive integer setting, falling back to a default. */
export function positiveIntegerField(
	config: Record<string, unknown>,
	key: string,
	fallback: number,
	subject: string,
): number {
	const value = config[key];
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new AceConfigError(`${subject} has invalid "${key}": ${describeValue(value)} (needs an integer >= 1)`);
	}
	return value;
}
