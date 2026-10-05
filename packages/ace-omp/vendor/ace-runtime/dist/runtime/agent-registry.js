import { networkInterfaces, hostname as osHostname } from "node:os";
import { formatSessionLabel } from "../utils.js";
import { channelStreamKey, NAMESPACE_DEFAULT } from "./naming.js";
/** Expiry and heartbeat for a directory entry. Key names come from `naming.ts`. */
export const REGISTRY_DEFAULTS = {
    ttlMs: 90_000,
    refreshMs: 30_000,
};
export function readerFactsOf(options) {
    const { channel, live, subscriptions, own = [] } = options;
    const isOwn = own.includes(channel);
    return {
        peerNamed: !isOwn && live.some((entry) => entry.channel === channel),
        selfReads: isOwn || subscriptions.includes(channel),
    };
}
/**
 * Registers one session's channel in the shared directory (RFC §22 item 1 — not part of ACE 0.1).
 *
 * The directory answers what configuration cannot: *which channels are live right now*, and *what to
 * call them when publishing*. Presence is the ZSet score (an expiry the heartbeat refreshes), the
 * address is derived from the name, and a clean shutdown removes both the entry and the stream.
 */
export class AgentRegistry {
    store;
    namespace;
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
        this.namespace = options.namespace ?? NAMESPACE_DEFAULT;
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
    /** Open this session's channel, then keep it discoverable until {@link unregister}. */
    async register(registration) {
        const channel = registration.sender;
        const stream = channelStreamKey(this.namespace, channel);
        // The group is the channel name: unique per session, and it never leaves this machine's reader.
        const group = channel;
        const description = describeSender(hostFacts(registration));
        await this.store.ensureStream(stream, group);
        await this.store.put(channel, description, this.now() + this.ttlMs);
        const registered = { channel, stream, group };
        this.registration = registered;
        this.logger?.info?.(`[ACE] registered ${channel} stream=${stream} ttl=${this.ttlMs}ms`);
        if (this.refreshMs > 0) {
            const tick = () => {
                void this.beat(channel);
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
        await this.store.remove(registered.channel);
        await this.store.dropStream(registered.stream);
        this.logger?.info?.(`[ACE] unregistered ${registered.channel}`);
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
    async beat(channel) {
        try {
            await this.store.refresh(channel, this.now() + this.ttlMs);
        }
        catch (error) {
            this.onError(error);
        }
    }
}
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
/** `agent=… | session=… | cwd=… | host=… | ip=… | platform=… | pid=…` — what a channel says about itself. */
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
/** The description field that names the coding agent a channel runs (`describeSender` writes it first). */
const CODING_AGENT_FIELD = "agent=";
/**
 * The coding agent a directory entry says it runs: the first token of its `agent=…` self-description
 * field (`agent=oh-my-pi 18.5.0 | session=… | …`). `undefined` when the entry carries no such field.
 *
 * This is what `ace_agents`' `agent` filter means. A channel name is not the place to look: it carries
 * the coding agent too, but only as the third segment of a name that also carries the namespace and
 * the user, and a display or `<server>:` prefix can sit in front of it.
 */
export function codingAgentOf(entry) {
    for (const field of entry.description.split("|")) {
        const trimmed = field.trim();
        if (!trimmed.startsWith(CODING_AGENT_FIELD))
            continue;
        const value = trimmed.slice(CODING_AGENT_FIELD.length).trim();
        const space = value.indexOf(" ");
        return space === -1 ? value : value.slice(0, space);
    }
    return undefined;
}
/**
 * Resolve a `target` against the live channels.
 *
 * A prefix is accepted only when it matches exactly one channel: guessing between two sessions would
 * send an event to the wrong agent, and the caller can always ask for the full name.
 */
export function resolveTarget(entries, target) {
    const exact = entries.find((entry) => entry.channel === target);
    if (exact)
        return { ok: true, entry: exact };
    // Any prefix that selects exactly one channel: typing a full name is tedious, and narrowing by the
    // agent name or the first hex digits of the session is unambiguous enough.
    const matches = entries.filter((entry) => entry.channel.startsWith(target));
    if (matches.length === 1 && matches[0])
        return { ok: true, entry: matches[0] };
    if (matches.length > 1) {
        return { ok: false, reason: "ambiguous", candidates: matches.map((entry) => entry.channel).sort() };
    }
    return { ok: false, reason: "not-found", candidates: entries.map((entry) => entry.channel).sort() };
}
//# sourceMappingURL=agent-registry.js.map