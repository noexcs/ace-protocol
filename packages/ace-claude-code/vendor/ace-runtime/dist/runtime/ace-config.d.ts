import type { ConcreteActivation } from "../protocol/ace-message.ts";
import type { AcePublisher } from "../transport/redis-streams-publisher.ts";
import type { DroppedEntry } from "../transport/redis-streams-transport.ts";
import type { Transport } from "../transport/transport.ts";
import { type EndpointConfig } from "./endpoint-config.ts";
import type { AceMetrics } from "./metrics.ts";
/**
 * Name of the runtime configuration file read from the session working directory.
 *
 * Every MQ setting (addresses, streams, groups, targets, identity) lives here; the code holds only
 * the generic mechanisms and the defaults a transport falls back to.
 */
export declare const ACE_CONFIG_FILENAME = ".ace.json";
/** Transport kinds this runtime can build from configuration (RFC §4.1 lists the others). */
export declare const SUPPORTED_TRANSPORTS: readonly string[];
/**
 * Runtime configuration (RFC §10) as stored in {@link ACE_CONFIG_FILENAME}.
 *
 * `subscribe` and `publish` use the vocabulary of MQ APIs (MQTT/AsyncAPI operations): from this
 * runtime's point of view, `subscribe` lists the channels it receives events from and `publish`
 * the channels its tools may send to.
 */
export interface AceConfigFile {
    /** Fallback activation for subscriptions and messages that delegate with `default` (RFC §8). */
    defaultActivation?: ConcreteActivation;
    /** Sender identifier this session publishes under (RFC §5.3); required once `publish` exists. */
    sender?: string;
    /** Channels this runtime receives ACE events from. */
    subscribe: EndpointConfig[];
    /** Channels this runtime may send ACE events to (RFC §19); the address stays here (§4.1). */
    publish?: EndpointConfig[];
    /** Retention limits for `manual` events (defaults: 100 events, 24h). */
    manual?: {
        max?: number;
        ttlMs?: number;
    };
    /** Agent directory this session publishes itself to (RFC §22 item 1). Absent: no registration. */
    registry?: {
        url: string;
        prefix?: string;
    };
}
export interface LoadedAceConfig {
    /** Path the configuration was read from, for logs and `/ace` output. */
    source: string;
    config: AceConfigFile;
}
/** Subscriptions, publications, identity, the activation default, and where they came from. */
export interface ResolvedAceConfig {
    /** Enabled subscriptions only. */
    subscribe: EndpointConfig[];
    /** Enabled publications only. */
    publish: EndpointConfig[];
    /** Channel names skipped because `enabled` is false. */
    disabled: string[];
    defaultActivation?: ConcreteActivation;
    /** Sender identity; absent when the configuration has no `publish` channels. */
    sender?: string;
    /** Configuration smells that are legal but almost always mistakes. */
    warnings: string[];
    /** Retention limits for `manual` events, resolved from the file. */
    manual: {
        max?: number;
        ttlMs?: number;
    };
    /** Agent directory to register in, when configured. */
    registry?: {
        url: string;
        prefix?: string;
    };
    source: string;
}
/** Validate a parsed `.ace.json` document. */
export declare function parseAceConfig(value: unknown, source: string): AceConfigFile;
/**
 * Configuration smells that are legal but almost always mistakes: more than one subscription reading
 * the same address from one agent either splits the events or delivers every event twice.
 */
export declare function channelWarnings(config: AceConfigFile): string[];
/**
 * Load `.ace.json` from `ACE_CONFIG` or `<cwd>/.ace.json`.
 *
 * Returns `undefined` when neither exists; {@link resolveAceConfig} turns that into an error.
 */
export declare function loadAceConfig(options: {
    cwd: string;
    env?: Readonly<Record<string, string | undefined>>;
}): LoadedAceConfig | undefined;
/**
 * Resolve everything a host needs to run ACE in a session.
 *
 * MQ configuration comes from `.ace.json` only — `ACE_CONFIG` selects a different file path, but
 * there is no environment-variable fallback for addresses, streams, or groups. Disabled channels are
 * filtered out here so no transport is ever started for them.
 */
export declare function resolveAceConfig(options: {
    cwd: string;
    env?: Readonly<Record<string, string | undefined>>;
}): ResolvedAceConfig;
/**
 * Create one transport per subscription, keyed by subscription name (the key
 * {@link AceRuntime} expects).
 */
export interface TransportFactoryOptions {
    onError: (error: unknown) => void;
    metrics?: AceMetrics;
    /**
     * Where an entry the transport gave up on goes (dead letters). The channel name is bound here,
     * so one sink can serve every subscription without the transport knowing its own name.
     */
    onDropped?: (subscription: string, entry: DroppedEntry) => void | Promise<void>;
}
export declare function createTransports(subscriptions: readonly EndpointConfig[], options: TransportFactoryOptions): Record<string, Transport>;
/**
 * Create one publisher per publication, keyed by publication name (the key the publishing tool
 * looks up).
 */
export declare function createPublishers(publications: readonly EndpointConfig[], options: {
    onError: (error: unknown) => void;
}): Record<string, AcePublisher>;
/**
 * Replace `${VAR}` in every string of the document with its environment value.
 *
 * An unset variable is an error rather than an empty string: silently connecting with a blank
 * password produces a confusing failure much later. Use `$${VAR}` for a literal.
 */
export declare function interpolateEnv(value: unknown, env: Readonly<Record<string, string | undefined>>, source: string, path?: string): unknown;
//# sourceMappingURL=ace-config.d.ts.map