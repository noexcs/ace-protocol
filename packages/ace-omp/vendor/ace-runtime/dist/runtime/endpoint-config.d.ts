import type { Activation } from "../protocol/ace-message.ts";
/** Roles a binding can have; they differ in which keys are legal. */
export type EndpointRole = "subscribe" | "publish";
/** Longest accepted `sender`; also the charset that keeps logs and rendered headers sane. */
export declare const MAX_SENDER_LENGTH = 128;
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
/** The transport address of a channel, whatever that transport calls it. */
export declare function endpointAddress(endpoint: EndpointConfig): string | undefined;
/** Thrown when runtime configuration is unusable (RFC-facing §10). */
export declare class AceConfigError extends Error {
    constructor(message: string);
}
/** Reject keys a binding or a transport config does not know: typos must not pass silently. */
export declare function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], subject: string): void;
/**
 * Validate one binding: `name`, `transport`, optional `description`/`enabled`/`config`/`options`,
 * and `activation` for subscriptions only.
 */
export declare function validateEndpointConfig(value: unknown, role: EndpointRole): EndpointConfig;
/** Validate the `sender` identity: stable, loggable, and impossible to forge a rendered header with. */
export declare function validateSender(value: unknown, source: string): string;
/** Read a required non-empty string setting from a transport config. */
export declare function requiredStringField(config: Record<string, unknown>, key: string, subject: string): string;
/** Read an optional non-empty string setting, falling back to a default. */
export declare function optionalStringField(config: Record<string, unknown>, key: string, fallback: string, subject: string): string;
/** Read an optional positive integer setting, falling back to a default. */
export declare function positiveIntegerField(config: Record<string, unknown>, key: string, fallback: number, subject: string): number;
//# sourceMappingURL=endpoint-config.d.ts.map