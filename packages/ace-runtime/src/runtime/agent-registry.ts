import { networkInterfaces, hostname as osHostname } from "node:os";
import type { AceLogger } from "../logger.ts";
import { formatSessionLabel } from "../utils.ts";
import { channelStreamKey, NAMESPACE_DEFAULT } from "./naming.ts";

/** Expiry and heartbeat for a directory entry. Key names come from `naming.ts`. */
export const REGISTRY_DEFAULTS = {
	ttlMs: 90_000,
	refreshMs: 30_000,
} as const;

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
 * What is known about who reads `channel`, as **two separate checks**, each named for what it
 * actually tests, rather than one summary word:
 *
 * - `peerNamed` — a live directory entry names the channel and it is not one of this session's own
 *   channels: some *other* session's own channel (its sender name) equals it. This is a name
 *   equality check, not a subscription audit: a peer that merely subscribes to the channel — a topic
 *   reader — is not discoverable, because its subscriptions live in its own `.ace.json`.
 *   `peerNamed=no` therefore means "no live session is named by this channel", never "nobody reads
 *   it".
 * - `selfReads` — *this* session reads the channel: it is one of this session's own sender channels
 *   (one per live server) or one of its configured subscriptions. `selfReads=no` never means the
 *   channel is exclusive either; a peer that subscribes but is not named by it still reads it.
 *
 * `own` is the channel names this session's own sender carries, one per server it is live on. The
 * directory lists this session's own registration too, so without `own` a publish to one's own inbox
 * would count that entry and answer `peerNamed=true` — a "peer" that is the publisher itself. Only
 * the two sources are knowable, so publishing to a name neither check knows is legal (a channel is a
 * name, not a mailbox) but is what a typo looks like. The single word this replaces collapsed both
 * checks into `peer`/`self`/`none` and so overclaimed each: `peer` read as "a peer subscribed",
 * `self` as "the publisher is the only reader", `none` as "nobody reads it" — none of which the
 * check could establish.
 */
export interface ReaderFacts {
	/** A live directory entry names the channel — some other session's own channel equals it. */
	readonly peerNamed: boolean;
	/** This session reads the channel (its own sender channel, or a configured subscription). */
	readonly selfReads: boolean;
}

export function readerFactsOf(options: {
	channel: string;
	live: readonly RegistryEntry[];
	subscriptions: readonly string[];
	/** This session's own channel names (its sender, one per live server), excluded from the peer test. */
	own?: readonly string[];
}): ReaderFacts {
	const { channel, live, subscriptions, own = [] } = options;
	const isOwn = own.includes(channel);
	return {
		peerNamed: !isOwn && live.some((entry) => entry.channel === channel),
		selfReads: isOwn || subscriptions.includes(channel),
	};
}

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
	setTimer?: (callback: () => void, ms: number) => { cancel: () => void };
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
export class AgentRegistry {
	private readonly store: AgentRegistryStore;
	private readonly namespace: string;
	private readonly ttlMs: number;
	private readonly refreshMs: number;
	private readonly now: () => number;
	private readonly setTimer: (callback: () => void, ms: number) => { cancel: () => void };
	private readonly logger: AceLogger | undefined;
	private readonly onError: (error: unknown) => void;
	private registration: Registration | undefined;
	private timer: { cancel: () => void } | undefined;

	constructor(options: AgentRegistryOptions) {
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
		this.onError = options.onError ?? (() => {});
	}

	/** Open this session's channel, then keep it discoverable until {@link unregister}. */
	async register(registration: AgentRegistration): Promise<Registration> {
		const channel = registration.sender;
		const stream = channelStreamKey(this.namespace, channel);
		// The group is the channel name: unique per session, and it never leaves this machine's reader.
		const group = channel;
		const description = describeSender(hostFacts(registration));

		await this.store.ensureStream(stream, group);
		await this.store.put(channel, description, this.now() + this.ttlMs);
		const registered: Registration = { channel, stream, group };
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
	async unregister(): Promise<void> {
		const registered = this.registration;
		this.registration = undefined;
		this.timer?.cancel();
		this.timer = undefined;
		if (registered === undefined) return;
		await this.store.remove(registered.channel);
		await this.store.dropStream(registered.stream);
		this.logger?.info?.(`[ACE] unregistered ${registered.channel}`);
	}

	/** Live registrations, expired ones pruned on the way. */
	async list(): Promise<RegistryEntry[]> {
		return this.store.list(this.now());
	}

	async close(): Promise<void> {
		this.timer?.cancel();
		this.timer = undefined;
		await this.store.close();
	}

	/** Extend the expiry; a failure is reported and the next beat retries. */
	private async beat(channel: string): Promise<void> {
		try {
			await this.store.refresh(channel, this.now() + this.ttlMs);
		} catch (error) {
			this.onError(error);
		}
	}
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
export function hostFacts(options: {
	codingAgent: string;
	agentVersion?: string;
	sessionId: string;
	cwd: string;
}): HostFacts {
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

function primaryIpv4(): string | undefined {
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) return address.address;
		}
	}
	return undefined;
}

/** `agent=… | session=… | cwd=… | host=… | ip=… | platform=… | pid=…` — what a channel says about itself. */
export function describeSender(facts: HostFacts): string {
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

/** How a target resolves: an exact channel name, or a prefix that matches exactly one. */
export type TargetResolution =
	| { ok: true; entry: RegistryEntry }
	| { ok: false; reason: "not-found" | "ambiguous"; candidates: string[] };

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
export function codingAgentOf(entry: RegistryEntry): string | undefined {
	for (const field of entry.description.split("|")) {
		const trimmed = field.trim();
		if (!trimmed.startsWith(CODING_AGENT_FIELD)) continue;
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
export function resolveTarget(entries: readonly RegistryEntry[], target: string): TargetResolution {
	const exact = entries.find((entry) => entry.channel === target);
	if (exact) return { ok: true, entry: exact };

	// Any prefix that selects exactly one channel: typing a full name is tedious, and narrowing by the
	// agent name or the first hex digits of the session is unambiguous enough.
	const matches = entries.filter((entry) => entry.channel.startsWith(target));
	if (matches.length === 1 && matches[0]) return { ok: true, entry: matches[0] };
	if (matches.length > 1) {
		return { ok: false, reason: "ambiguous", candidates: matches.map((entry) => entry.channel).sort() };
	}
	return { ok: false, reason: "not-found", candidates: entries.map((entry) => entry.channel).sort() };
}
