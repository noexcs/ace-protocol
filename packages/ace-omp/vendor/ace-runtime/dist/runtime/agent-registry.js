import { networkInterfaces, hostname as osHostname } from "node:os";
import { formatSessionLabel } from "../utils.js";
/** Subscription name of the inbox the agent directory registers for this session. */
export const SESSION_INBOX = "session-inbox";
/**
 * The subscription that reads the inbox the directory registered: the address peers are told to
 * publish to. Every host wires this up, and it has to be the same shape everywhere — so it is built
 * here from the {@link Registration} the registry returned, not spelled out per host.
 */
export function sessionInboxEndpoint(registration, url) {
    return {
        name: SESSION_INBOX,
        transport: "redis-streams",
        description: "this session's inbox (agent directory)",
        config: { stream: registration.stream, group: registration.group, url },
        options: {},
    };
}
/** What a sender is called when the host has no session id to name it by. */
export const NO_SESSION_LABEL = "(no session)";
/**
 * The identity this session publishes under: its directory member when it has one, otherwise the same
 * `<coding-agent>:<sessionId>` shape. A sender never needs to be registered to send, but when it is,
 * member and sender are the same value — which is what lets a peer answer the session that wrote to it.
 */
export function senderIdentity(options) {
    return options.member ?? registryMember(options.codingAgent, options.sessionId ?? NO_SESSION_LABEL);
}
/** Key layout, expiry and heartbeat, derived from `.ace.json` `registry.prefix`. */
export const REGISTRY_DEFAULTS = {
    prefix: "ace:agents",
    /** A registration whose score is in the past is offline; the heartbeat keeps it fresh. */
    ttlMs: 90_000,
    /** Refresh interval; 0 keeps the entry until the session unregisters (no crash recovery). */
    refreshMs: 30_000,
};
/**
 * Read the publish endpoint out of a directory entry.
 *
 * The entry's own `transport`, `config.url`, `config.stream` and `config.field` are used as
 * advertised: a session may live on another broker, and a peer is expected to reach it there. A
 * caller that cannot speak `transport` must say so rather than fall back to its own broker.
 */
export function publishEndpointOf(entry, defaultField = "message") {
    return {
        transport: entry.channel.transport,
        url: entry.channel.config.url,
        stream: entry.channel.config.stream,
        field: entry.channel.config.field ?? defaultField,
    };
}
/**
 * Registers one session in the shared agent directory (RFC §22 item 1 — not part of ACE 0.1).
 *
 * The registry answers what configuration cannot: *which sessions are online right now*, and *where
 * to send to each of them*. Presence is the ZSet score (an expiry the heartbeat refreshes), the
 * address is the session's own stream, and a clean shutdown removes both the entry and the stream.
 */
export class AgentRegistry {
    store;
    prefix;
    ttlMs;
    refreshMs;
    now;
    setTimer;
    logger;
    onError;
    registration;
    timer;
    constructor(options) {
        this.store = options.store;
        this.prefix = options.prefix ?? REGISTRY_DEFAULTS.prefix;
        this.ttlMs = options.ttlMs ?? REGISTRY_DEFAULTS.ttlMs;
        this.refreshMs = options.refreshMs ?? REGISTRY_DEFAULTS.refreshMs;
        this.now = options.now ?? (() => Date.now());
        this.setTimer =
            options.setTimer ??
                ((callback, ms) => {
                    const handle = setTimeout(callback, ms);
                    handle.unref?.();
                    return { cancel: () => clearTimeout(handle) };
                });
        this.logger = options.logger;
        this.onError = options.onError ?? (() => { });
    }
    /** Publish this session's stream, then keep it discoverable until {@link unregister}. */
    async register(registration) {
        const member = registryMember(registration.codingAgent, registration.sessionId);
        const stream = registryStream(this.prefix, member);
        const group = registryGroup(member);
        const channel = registryChannel({
            member,
            stream,
            group,
            url: registration.url,
            description: describeLocation(hostFacts({ ...registration, sessionId: registration.sessionId })),
        });
        await this.store.ensureStream(stream, group);
        await this.store.put(member, channel, this.now() + this.ttlMs);
        const registered = { member, stream, group, channel };
        this.registration = registered;
        this.logger?.info?.(`[ACE] registered ${member} stream=${stream} ttl=${this.ttlMs}ms`);
        if (this.refreshMs > 0) {
            const tick = () => {
                void this.beat(member);
                this.timer = this.setTimer(tick, this.refreshMs);
            };
            this.timer = this.setTimer(tick, this.refreshMs);
        }
        return registered;
    }
    /** Leave the directory: remove the entry and the session's stream. */
    async unregister() {
        const registered = this.registration;
        this.registration = undefined;
        this.timer?.cancel();
        this.timer = undefined;
        if (registered === undefined)
            return;
        await this.store.remove(registered.member);
        await this.store.dropStream(registered.stream);
        this.logger?.info?.(`[ACE] unregistered ${registered.member}`);
    }
    /** Live registrations, expired ones pruned on the way. */
    async list() {
        return this.store.list(this.now());
    }
    async close() {
        this.timer?.cancel();
        this.timer = undefined;
        await this.store.close();
    }
    /** Extend the expiry; a failure is reported and the next beat retries. */
    async beat(member) {
        try {
            await this.store.refresh(member, this.now() + this.ttlMs);
        }
        catch (error) {
            this.onError(error);
        }
    }
}
/** `<coding-agent>:<sessionId>` — what a peer passes as `target` and what the ZSet indexes. */
export function registryMember(codingAgent, sessionId) {
    return `${codingAgent}:${sessionId}`;
}
/** Each session gets its own stream; nothing is shared between sessions. */
export function registryStream(prefix, member) {
    return `${prefix}:events:${member}`;
}
/** The consumer group the session itself reads its stream in. */
export function registryGroup(member) {
    return `ace:${member}`;
}
/** The stored channel entry: the member, the session's stream, and where this agent runs. */
export function registryChannel(options) {
    return {
        name: options.member,
        transport: "redis-streams",
        description: options.description,
        config: { stream: options.stream, group: options.group, url: options.url },
    };
}
/** What the channel's own description text starts with, before the host details. */
export const REGISTRY_CHANNEL_NOTE = "direct messages addressed to me";
/** Collect what the description needs; the IP is advisory, everything else is exact. */
export function hostFacts(options) {
    const ip = primaryIpv4();
    return {
        codingAgent: options.codingAgent,
        sessionId: options.sessionId,
        cwd: options.cwd,
        hostname: osHostname(),
        platform: `${process.platform}-${process.arch}`,
        pid: process.pid,
        ...(options.agentVersion === undefined ? {} : { agentVersion: options.agentVersion }),
        ...(ip === undefined ? {} : { ip }),
    };
}
function primaryIpv4() {
    for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family === "IPv4" && !address.internal)
                return address.address;
        }
    }
    return undefined;
}
/** `agent=… | session=… | cwd=… | host=… | ip=… | platform=… | pid=…` — what a sender says about itself. */
export function describeSender(facts) {
    return [
        `agent=${facts.agentVersion === undefined ? facts.codingAgent : `${facts.codingAgent} ${facts.agentVersion}`}`,
        `session=${formatSessionLabel(facts.sessionId)}`,
        `cwd=${facts.cwd}`,
        `host=${facts.hostname}`,
        ...(facts.ip === undefined ? [] : [`ip=${facts.ip}`]),
        `platform=${facts.platform}`,
        `pid=${facts.pid}`,
    ].join(" | ");
}
/** `direct messages addressed to me | agent=… | session=… | cwd=… | host=… | ip=… | platform=… | pid=…`. */
export function describeLocation(facts) {
    return [REGISTRY_CHANNEL_NOTE, describeSender(facts)].join(" | ");
}
/**
 * Resolve a `target` against the live registrations.
 *
 * A prefix is accepted only when it matches exactly one session: guessing between two sessions would
 * send an event to the wrong agent, and the caller can always ask for the full member.
 */
export function resolveTarget(entries, target) {
    const exact = entries.find((entry) => entry.member === target);
    if (exact)
        return { ok: true, entry: exact };
    // Any prefix that selects exactly one session: typing a 36-character member is tedious, and
    // narrowing by the agent name or the first hex digits of the session is unambiguous enough.
    const matches = entries.filter((entry) => entry.member.startsWith(target));
    if (matches.length === 1 && matches[0])
        return { ok: true, entry: matches[0] };
    if (matches.length > 1) {
        return { ok: false, reason: "ambiguous", candidates: matches.map((entry) => entry.member).sort() };
    }
    return { ok: false, reason: "not-found", candidates: entries.map((entry) => entry.member).sort() };
}
//# sourceMappingURL=agent-registry.js.map