import type { ConcreteActivation } from "../protocol/ace-message.ts";
import { type DroppedEntry } from "../transport/redis-streams-transport.ts";
import type { Transport } from "../transport/transport.ts";
import { type EndpointConfig } from "./endpoint-config.ts";
import type { AceMetrics } from "./metrics.ts";
/**
 * Name of the runtime configuration file read from the session working directory.
 *
 * The file holds **only local deployment information**: who this user is, and which servers this
 * machine talks to. Channels, subscriptions and presence all live on a server.
 */
export declare const ACE_CONFIG_FILENAME = ".ace.json";
/** One server in the local file: where it is, and which namespace it owns. */
export interface ServerEntry {
    /** Redis connection string; `${VAR}` is interpolated from the environment. */
    url: string;
    /** Namespace this server owns; keys live under it. Defaults to `ace`. */
    namespace?: string;
    description?: string;
    /**
     * Channel names this session reads **on this server**: a subscription belongs to the server that
     * carries it, because the name is uploaded under that server's namespace and read over its url.
     * A short name (`ci-ok`) is uploaded as `<namespace>:<username>:<name>`; a full channel name passes
     * through. Absent: direct messages only (the derived inbox).
     */
    subscribe?: string[];
}
/**
 * Runtime configuration as stored in {@link ACE_CONFIG_FILENAME}.
 *
 * `username` is the real user's name or nick, and it is the second level of the naming hierarchy
 * (`<ns>:<username>:<name>`): it keeps several people sharing one server from colliding, and it is
 * only ever *prepended to names* — never stored as a field.
 */
export interface AceConfigFile {
    username: string;
    servers: Record<string, ServerEntry>;
    /** Activation used when neither the subscription nor the message decides. */
    defaultActivation?: ConcreteActivation;
    /** Retention limits for `manual` events (defaults: 100 events, 24h). */
    manual?: {
        max?: number;
        ttlMs?: number;
    };
    /**
     * Only meaningful in a **host-global** file: `"ignore"` makes that file win over a project one, so a
     * cloned repository cannot redirect a session the user configured centrally.
     */
    projectConfig?: "ignore";
}
export interface LoadedAceConfig {
    /** Path the configuration was read from, for logs and `/ace` output. */
    source: string;
    config: AceConfigFile;
    /** The later candidate this file shadowed, when one exists. */
    shadowed?: string;
    /** `username` to fall back to (the global file's), when the winning file does not carry one. */
    usernameFallback?: string;
}
/** One server after resolution: keys and names are settled, nothing is left to default. */
export interface ResolvedServer {
    name: string;
    url: string;
    namespace: string;
    description?: string;
    /** Channel names this session reads on this server, as written in the file. */
    subscribe?: string[];
}
/**
 * One configured subscription after resolution: which server carries it, and the channel name on it.
 *
 * Only names here — the address, the group and the transport settings are derived by
 * {@link subscriptionEndpoint}, because the group depends on the *subscribing session's* sender name,
 * which the configuration layer does not know.
 */
export interface ResolvedSubscription {
    server: ResolvedServer;
    /** Uploaded channel name (`<ns>:<username>:<name>`). */
    channel: string;
    /** Local label for this subscription (equals the channel name unless a host renames it). */
    name: string;
}
/** Everything a host needs to run ACE in a session. */
export interface ResolvedAceConfig {
    username: string;
    servers: ResolvedServer[];
    subscriptions: ResolvedSubscription[];
    defaultActivation?: ConcreteActivation;
    manual: {
        max?: number;
        ttlMs?: number;
    };
    /** Configuration smells that are legal but almost always mistakes. */
    warnings: string[];
    source: string;
    /**
     * The later configuration candidate the winning file shadowed, when there is one. Exposed so a host's
     * human face can say *which* global file the project file overrode, not only warn that it did.
     */
    shadowed?: string;
}
/** Validate a parsed `.ace.json` document. */
export declare function parseAceConfig(value: unknown, source: string): AceConfigFile;
/**
 * Load `.ace.json` from `$ACE_CONFIG`, `<cwd>/.ace.json`, then the host's global candidates.
 *
 * Returns `undefined` when none exists; {@link resolveAceConfig} turns that into an error.
 */
export declare function loadAceConfig(options: {
    cwd: string;
    env?: Readonly<Record<string, string | undefined>>;
    /**
     * Host-owned global candidates, in the host's own order: the files a session should fall back to
     * wherever it was started. The runtime knows no host's convention — it only applies the order.
     */
    globalConfigPaths?: readonly string[];
}): LoadedAceConfig | undefined;
/**
 * Resolve everything a host needs to run ACE in a session.
 *
 * The `username` chain is the one place a file inherits from another: this file → the global file →
 * `$USER` → error. Every other field is taken whole from the winning file.
 */
export declare function resolveAceConfig(options: {
    cwd: string;
    env?: Readonly<Record<string, string | undefined>>;
    /** Host-owned global candidates, in the host's own order — see {@link loadAceConfig}. */
    globalConfigPaths?: readonly string[];
}): ResolvedAceConfig;
/**
 * The channel names a live subscription still reads that the **current** configuration no longer lists.
 *
 * `.ace.json` is read once at session start, so a channel removed from the file since then is still
 * read — the removal takes effect only on restart (RFC §10). Naming those channels lets a host mark
 * their rows `note=config-removed` instead of leaving the stale subscription invisible.
 *
 * Best-effort by design: a current file that cannot be read, parsed or resolved yields no names at
 * all, because a stale `config-removed` would be worse than no note. `subscriptions` are the
 * resolved-at-start subscriptions; the current file is resolved the same way
 * {@link resolveAceConfig} resolves it, and a start subscription whose uploaded channel name is no
 * longer produced by it is reported.
 */
export declare function configRemovedChannels(options: {
    /** Subscriptions resolved at session start (the snapshot `ace_channels` lists). */
    subscriptions: readonly ResolvedSubscription[];
    cwd: string;
    env?: Readonly<Record<string, string | undefined>>;
    /** Host-owned global candidates, in the host's own order — see {@link loadAceConfig}. */
    globalConfigPaths?: readonly string[];
}): string[];
/**
 * The server a **full** channel name belongs to, from the name alone: a server owns exactly one
 * namespace, and the namespace is the name's first segment (`<ns>:<username>:<local>` everywhere).
 *
 * `undefined` for a short name — fewer than three segments carry no namespace to trust, so the caller
 * falls back to the live directory — and for a namespace several servers share, where only the
 * directory can say which one holds the session. Hosts call this before a directory lookup so a full
 * name is accepted as written even when no session happens to be registered under it.
 */
export declare function serverForChannel(options: {
    servers: readonly ResolvedServer[];
    channel: string;
}): ResolvedServer | undefined;
/**
 * The runtime endpoint for a subscribed channel: the address and the group are derived from the
 * channel name, so nothing here can disagree with what a peer computes.
 */
export declare function subscriptionEndpoint(options: {
    channel: string;
    url: string;
    namespace: string;
    /** The subscribing session's sender name — the group equals it. */
    sender: string;
    /** Local label for this subscription; defaults to the channel name. */
    name?: string;
    activation?: ConcreteActivation;
    description?: string;
}): EndpointConfig;
/** Create one transport per subscription, keyed by subscription name (the key `AceRuntime` expects). */
export interface TransportFactoryOptions {
    onError: (error: unknown) => void;
    metrics?: AceMetrics;
    onDropped?: (subscription: string, entry: DroppedEntry) => void | Promise<void>;
    /** Notices (reconnect, reclaimed entry, dropped entry), kept out of `onError`. */
    onNotice?: (message: string) => void;
}
export declare function createTransports(subscriptions: readonly EndpointConfig[], options: TransportFactoryOptions): Record<string, Transport>;
/**
 * Replace `${VAR}` in every string of the document with its environment value.
 *
 * An unset variable is an error rather than an empty string: silently connecting with a blank password
 * produces a confusing failure much later. Use `$${VAR}` for a literal.
 */
export declare function interpolateEnv(value: unknown, env: Readonly<Record<string, string | undefined>>, source: string, path?: string): unknown;
//# sourceMappingURL=ace-config.d.ts.map