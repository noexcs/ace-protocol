import type { Activation } from "../protocol/ace-message.ts";
import { isActivation } from "../protocol/ace-message.ts";
import { describeValue, isPlainObject } from "../utils.ts";

/** Roles a binding can have; they differ in which keys are legal. */
export type EndpointRole = "subscribe" | "publish";

/** Keys every binding may carry, whatever its transport kind. */
const COMMON_KEYS = ["name", "transport", "description", "enabled", "config", "options"] as const;

/** Longest accepted `sender`; also the charset that keeps logs and rendered headers sane. */
export const MAX_SENDER_LENGTH = 128;
const SENDER_PATTERN = /^[A-Za-z0-9._@:-]{1,128}$/;

/**
 * One MQ binding in `.ace.json`, under `subscribe` or `publish` (RFC §10 runtime configuration).
 *
 * `name`/`transport`/`description`/`activation`/`enabled` are transport-independent; everything a
 * specific broker needs sits in {@link config} (validated against that kind) and every raw client
 * option the operator wants to pass through sits in {@link options} (not validated).
 *
 * Not an ACE protocol object: the address and the transport belong to the deployment, and an ACE
 * message never carries them (RFC §4).
 */
export interface EndpointConfig {
	name: string;
	transport: string;
	/** Human/model-readable note about this channel, e.g. which peer sits on the other end. */
	description?: string;
	/** Subscriptions only: activation this receiver forces (RFC §8); `default` delegates to the message. */
	activation?: Activation;
	/** Whether the runtime starts this channel at all; defaults to `true`. */
	enabled?: boolean;
	/** Transport-specific settings, validated by that kind. */
	config: Record<string, unknown>;
	/** Raw options handed to the transport's client library; never validated, never interpreted. */
	options: Record<string, unknown>;
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

/**
 * Validate one binding: `name`, `transport`, optional `description`/`enabled`/`config`/`options`,
 * and `activation` for subscriptions only.
 */
export function validateEndpointConfig(value: unknown, role: EndpointRole): EndpointConfig {
	const subject = role;
	if (!isPlainObject(value)) {
		throw new AceConfigError(`${subject} entry must be an object, received ${describeValue(value)}`);
	}

	const { name, transport, description, activation, enabled, config, options } = value;
	if (typeof name !== "string" || name.length === 0) {
		throw new AceConfigError(`${subject} entry requires a non-empty name`);
	}
	const named = `${subject} "${name}"`;

	if (typeof transport !== "string" || transport.length === 0) {
		throw new AceConfigError(`${named} requires a non-empty transport`);
	}
	if (description !== undefined && (typeof description !== "string" || description.length === 0)) {
		throw new AceConfigError(`${named} has invalid description: ${describeValue(description)}`);
	}
	if (enabled !== undefined && typeof enabled !== "boolean") {
		throw new AceConfigError(`${named} has invalid enabled: ${describeValue(enabled)}`);
	}
	if (config !== undefined && !isPlainObject(config)) {
		throw new AceConfigError(`${named} has invalid config: ${describeValue(config)}`);
	}
	if (options !== undefined && !isPlainObject(options)) {
		throw new AceConfigError(`${named} has invalid options: ${describeValue(options)}`);
	}

	if (activation !== undefined) {
		if (role === "publish") {
			throw new AceConfigError(`${named} must not set activation: the receiver decides activation (RFC §8)`);
		}
		if (!isActivation(activation)) {
			throw new AceConfigError(`${named} has invalid activation: ${describeValue(activation)}`);
		}
	}

	const allowed = role === "subscribe" ? [...COMMON_KEYS, "activation"] : [...COMMON_KEYS];
	rejectUnknownKeys(value, allowed, named);

	return {
		name,
		transport,
		...(description === undefined ? {} : { description }),
		...(activation === undefined ? {} : { activation }),
		...(enabled === undefined ? {} : { enabled }),
		config: config ?? {},
		options: options ?? {},
	};
}

/** Validate the `sender` identity: stable, loggable, and impossible to forge a rendered header with. */
export function validateSender(value: unknown, source: string): string {
	if (typeof value !== "string" || !SENDER_PATTERN.test(value)) {
		throw new AceConfigError(
			`${source}: sender must match [A-Za-z0-9._@:-]{1,${MAX_SENDER_LENGTH}} (no spaces, newlines, or control characters), received ${describeValue(value)}`,
		);
	}
	return value;
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
