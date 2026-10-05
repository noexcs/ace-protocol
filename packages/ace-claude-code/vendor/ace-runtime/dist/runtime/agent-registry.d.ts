import type { AceLogger } from "../logger.ts";
/** Subscription name of the inbox the agent directory registers for this session. */
export declare const SESSION_INBOX = "session-inbox";
/** Key layout, expiry and heartbeat, derived from `.ace.json` `registry.prefix`. */
export declare const REGISTRY_DEFAULTS: {
    readonly prefix: "ace:agents";
    /** A registration whose score is in the past is offline; the heartbeat keeps it fresh. */
    readonly ttlMs: 90000;
    /** Refresh interval; 0 keeps the entry until the session unregisters (no crash recovery). */
    readonly refreshMs: 30000;
};
/** The channel entry stored for one session, exactly as peers read it back. */
export interface RegistryChannel {
    /** The member itself: what a peer passes as `target`. */
    name: string;
    transport: string;
    description: string;
    /** `field` is optional: a peer publishing here uses the runtime default when it is absent. */
    config: {
        stream: string;
        group: string;
        url: string;
        field?: string;
    };
}
/** Where a directory entry says to publish: its own broker, stream and field. */
export interface PublishEndpoint {
    transport: string;
    url: string;
    stream: string;
    field: string;
}
/**
 * Read the publish endpoint out of a directory entry.
 *
 * The entry's own `transport`, `config.url`, `config.stream` and `config.field` are used as
 * advertised: a session may live on another broker, and a peer is expected to reach it there. A
 * caller that cannot speak `transport` must say so rather than fall back to its own broker.
 */
export declare function publishEndpointOf(entry: RegistryEntry, defaultField?: string): PublishEndpoint;
/** One live registration, as discovery sees it. */
export interface RegistryEntry {
    member: string;
    channel: RegistryChannel;
    /** ZSet score: the instant this registration stops being discoverable. */
    expiresAt: number;
}
/**
 * The registry as the runtime needs it: a presence index with expiry, the channel payload, and one
 * stream per session. `transport/redis-agent-registry.ts` implements it against Redis; tests
 * implement it in memory.
 */
export interface AgentRegistryStore {
    /** Create this session's stream and group when absent; idempotent. */
    ensureStream(stream: string, group: string): Promise<void>;
    put(member: string, channel: RegistryChannel, expiresAt: number): Promise<void>;
    /** Extend the expiry without rewriting the entry. */
    refresh(member: string, expiresAt: number): Promise<void>;
    remove(member: string): Promise<void>;
    /** Drop the session's stream: nothing can be addressed to a closed session. */
    dropStream(stream: string): Promise<void>;
    /** Live entries, expired members pruned on the way. */
    list(now: number): Promise<RegistryEntry[]>;
    close(): Promise<void>;
}
/** What one session needs to register: who it is, where it runs, which broker it talks to. */
export interface AgentRegistration {
    /** Coding agent this session runs in, e.g. `oh-my-pi`, `pi`, `codex`. */
    codingAgent: string;
    agentVersion?: string;
    /** Full session id; the member is built from it. */
    sessionId: string;
    cwd: string;
    /** Broker of the session's own stream; what peers are told to publish to. */
    url: string;
}
export interface AgentRegistryOptions {
    store: AgentRegistryStore;
    prefix?: string;
    ttlMs?: number;
    refreshMs?: number;
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => {
        cancel: () => void;
    };
    logger?: AceLogger;
    /** Registry problems must never take a session down; they are reported here. */
    onError?: (error: unknown) => void;
}
/** Where this session is reachable: the registered view of one registration. */
export interface Registration {
    member: string;
    stream: string;
    group: string;
    channel: RegistryChannel;
}
/**
 * Registers one session in the shared agent directory (RFC §22 item 1 — not part of ACE 0.1).
 *
 * The registry answers what configuration cannot: *which sessions are online right now*, and *where
 * to send to each of them*. Presence is the ZSet score (an expiry the heartbeat refreshes), the
 * address is the session's own stream, and a clean shutdown removes both the entry and the stream.
 */
export declare class AgentRegistry {
    private readonly store;
    private readonly prefix;
    private readonly ttlMs;
    private readonly refreshMs;
    private readonly now;
    private readonly setTimer;
    private readonly logger;
    private readonly onError;
    private registration;
    private timer;
    constructor(options: AgentRegistryOptions);
    /** Publish this session's stream, then keep it discoverable until {@link unregister}. */
    register(registration: AgentRegistration): Promise<Registration>;
    /** Leave the directory: remove the entry and the session's stream. */
    unregister(): Promise<void>;
    /** Live registrations, expired ones pruned on the way. */
    list(): Promise<RegistryEntry[]>;
    close(): Promise<void>;
    /** Extend the expiry; a failure is reported and the next beat retries. */
    private beat;
}
/** `<coding-agent>:<sessionId>` — what a peer passes as `target` and what the ZSet indexes. */
export declare function registryMember(codingAgent: string, sessionId: string): string;
/** Each session gets its own stream; nothing is shared between sessions. */
export declare function registryStream(prefix: string, member: string): string;
/** The consumer group the session itself reads its stream in. */
export declare function registryGroup(member: string): string;
/** The stored channel entry: the member, the session's stream, and where this agent runs. */
export declare function registryChannel(options: {
    member: string;
    stream: string;
    group: string;
    url: string;
    description: string;
}): RegistryChannel;
/** What the channel's own description text starts with, before the host details. */
export declare const REGISTRY_CHANNEL_NOTE = "direct messages addressed to me";
export interface HostFacts {
    codingAgent: string;
    agentVersion?: string;
    /** Session the description belongs to; shown as a short label. */
    sessionId: string;
    cwd: string;
    hostname: string;
    platform: string;
    pid: number;
    /** Best-effort primary IPv4; advisory only (a laptop has several, and NAT hides it). */
    ip?: string;
}
/** Collect what the description needs; the IP is advisory, everything else is exact. */
export declare function hostFacts(options: {
    codingAgent: string;
    agentVersion?: string;
    sessionId: string;
    cwd: string;
}): HostFacts;
/** `agent=… | session=… | cwd=… | host=… | ip=… | platform=… | pid=…` — what a sender says about itself. */
export declare function describeSender(facts: HostFacts): string;
/** `direct messages addressed to me | agent=… | session=… | cwd=… | host=… | ip=… | platform=… | pid=…`. */
export declare function describeLocation(facts: HostFacts): string;
/** How a member resolves for publishing: exact member, or a prefix that matches exactly one. */
export type TargetResolution = {
    ok: true;
    entry: RegistryEntry;
} | {
    ok: false;
    reason: "not-found" | "ambiguous";
    candidates: string[];
};
/**
 * Resolve a `target` against the live registrations.
 *
 * A prefix is accepted only when it matches exactly one session: guessing between two sessions would
 * send an event to the wrong agent, and the caller can always ask for the full member.
 */
export declare function resolveTarget(entries: readonly RegistryEntry[], target: string): TargetResolution;
//# sourceMappingURL=agent-registry.d.ts.map