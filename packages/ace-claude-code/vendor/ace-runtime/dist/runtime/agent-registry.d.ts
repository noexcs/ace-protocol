import type { AceLogger } from "../logger.ts";
/** Expiry and heartbeat for a directory entry. Key names come from `naming.ts`. */
export declare const REGISTRY_DEFAULTS: {
    readonly ttlMs: 90000;
    readonly refreshMs: 30000;
};
/**
 * One live registration, as discovery sees it: **a channel** — the one a session opened under its own
 * sender name. There is no second kind of entity and no second name: `channel` *is* that session's
 * sender, and `target` is nothing but this string.
 */
export interface RegistryEntry {
    /** The uploaded channel name (= the session's sender name). */
    channel: string;
    /** What the channel says about where it runs. Self-reported: shown, never trusted. */
    description: string;
    /** ZSet score: the instant this registration stops being discoverable. */
    expiresAt: number;
}
/**
 * Whether anything is *known* to read `channel`: a live directory entry (a session's own channel), or
 * one of the channels the calling session itself subscribes to. Only those two are knowable — another
 * session's configured subscriptions live in its own file — so a `false` here means "no subscriber we
 * know of", which is what a mistyped target looks like. It is not a delivery precondition: a channel is a
 * name, and publishing to a name that has no subscriber yet is legal.
 */
export declare function hasKnownSubscriber(options: {
    channel: string;
    live: readonly RegistryEntry[];
    subscriptions: readonly string[];
}): boolean;
/**
 * The directory as the runtime needs it: a presence index with expiry, and one stream per live
 * channel. `transport/redis-agent-registry.ts` implements it against Redis; tests implement it in
 * memory.
 */
export interface AgentRegistryStore {
    /** Create this session's stream and group when absent; idempotent. */
    ensureStream(stream: string, group: string): Promise<void>;
    put(channel: string, description: string, expiresAt: number): Promise<void>;
    /** Extend the expiry without rewriting the entry. */
    refresh(channel: string, expiresAt: number): Promise<void>;
    remove(channel: string): Promise<void>;
    /** Drop the session's stream: nothing can be addressed to a closed session. */
    dropStream(stream: string): Promise<void>;
    /** Live entries, expired channels pruned on the way. */
    list(now: number): Promise<RegistryEntry[]>;
    close(): Promise<void>;
}
/**
 * What one session needs to register: the name it answers to, and enough to describe where it runs.
 * The sender name is computed by the host (it owns `username`, the namespace and the session id) —
 * the registry only publishes what it is handed.
 */
export interface AgentRegistration {
    /** This session's sender name, which is also the channel it registers. */
    sender: string;
    /** Coding agent this session runs in, e.g. `oh-my-pi`, `pi`, `codex`. */
    codingAgent: string;
    agentVersion?: string;
    /** Session the description belongs to; shown as a short label. */
    sessionId: string;
    cwd: string;
}
export interface AgentRegistryOptions {
    store: AgentRegistryStore;
    /** Namespace this server owns; keys live under it. Defaults to `ace`. */
    namespace?: string;
    ttlMs?: number;
    refreshMs?: number;
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => {
        cancel: () => void;
    };
    logger?: AceLogger;
    /** Directory problems must never take a session down; they are reported here. */
    onError?: (error: unknown) => void;
}
/** What one registration produced — everything else is derived from the channel name. */
export interface Registration {
    /** The channel that was registered; equals the session's sender name. */
    channel: string;
    /** Stream key that carries the channel's events (`<ns>:ch:<channel>`). */
    stream: string;
    /** The group this session reads its own channel in. **Equals the channel name.** */
    group: string;
}
/**
 * Registers one session's channel in the shared directory (RFC §22 item 1 — not part of ACE 0.1).
 *
 * The directory answers what configuration cannot: *which channels are live right now*, and *what to
 * call them when publishing*. Presence is the ZSet score (an expiry the heartbeat refreshes), the
 * address is derived from the name, and a clean shutdown removes both the entry and the stream.
 */
export declare class AgentRegistry {
    private readonly store;
    private readonly namespace;
    private readonly ttlMs;
    private readonly refreshMs;
    private readonly now;
    private readonly setTimer;
    private readonly logger;
    private readonly onError;
    private registration;
    private timer;
    constructor(options: AgentRegistryOptions);
    /** Open this session's channel, then keep it discoverable until {@link unregister}. */
    register(registration: AgentRegistration): Promise<Registration>;
    /** Leave the directory: remove the entry and the session's stream. */
    unregister(): Promise<void>;
    /** Live registrations, expired ones pruned on the way. */
    list(): Promise<RegistryEntry[]>;
    close(): Promise<void>;
    /** Extend the expiry; a failure is reported and the next beat retries. */
    private beat;
}
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
/** `agent=… | session=… | cwd=… | host=… | ip=… | platform=… | pid=…` — what a channel says about itself. */
export declare function describeSender(facts: HostFacts): string;
/** `direct messages addressed to me | agent=… | session=… | cwd=… | host=… | ip=… | platform=… | pid=…`. */
export declare function describeLocation(facts: HostFacts): string;
/** What the channel's own description text starts with, before the host details. */
export declare const REGISTRY_CHANNEL_NOTE = "direct messages addressed to me";
/** How a target resolves: an exact channel name, or a prefix that matches exactly one. */
export type TargetResolution = {
    ok: true;
    entry: RegistryEntry;
} | {
    ok: false;
    reason: "not-found" | "ambiguous";
    candidates: string[];
};
/**
 * Resolve a `target` against the live channels.
 *
 * A prefix is accepted only when it matches exactly one channel: guessing between two sessions would
 * send an event to the wrong agent, and the caller can always ask for the full name.
 */
export declare function resolveTarget(entries: readonly RegistryEntry[], target: string): TargetResolution;
//# sourceMappingURL=agent-registry.d.ts.map