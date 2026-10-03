import { networkInterfaces, hostname as osHostname } from "node:os";
import type { AceLogger } from "../logger.ts";
import { formatSessionLabel } from "../utils.ts";

/** Key layout, expiry and heartbeat, derived from `.ace.json` `registry.prefix`. */
export const REGISTRY_DEFAULTS = {
	prefix: "ace:agents",
	/** A registration whose score is in the past is offline; the heartbeat keeps it fresh. */
	ttlMs: 90_000,
	/** Refresh interval; 0 keeps the entry until the session unregisters (no crash recovery). */
	refreshMs: 30_000,
} as const;

/** The channel entry stored for one session, exactly as peers read it back. */
export interface RegistryChannel {
	/** The member itself: what a peer passes as `target`. */
	name: string;
	transport: "redis-streams";
	description: string;
	config: { stream: string; group: string; url: string };
}

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
	setTimer?: (callback: () => void, ms: number) => { cancel: () => void };
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
export class AgentRegistry {
	private readonly store: AgentRegistryStore;
	private readonly prefix: string;
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
		this.onError = options.onError ?? (() => {});
	}

	/** Publish this session's stream, then keep it discoverable until {@link unregister}. */
	async register(registration: AgentRegistration): Promise<Registration> {
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
		const registered: Registration = { member, stream, group, channel };
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
	async unregister(): Promise<void> {
		const registered = this.registration;
		this.registration = undefined;
		this.timer?.cancel();
		this.timer = undefined;
		if (registered === undefined) return;
		await this.store.remove(registered.member);
		await this.store.dropStream(registered.stream);
		this.logger?.info?.(`[ACE] unregistered ${registered.member}`);
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
	private async beat(member: string): Promise<void> {
		try {
			await this.store.refresh(member, this.now() + this.ttlMs);
		} catch (error) {
			this.onError(error);
		}
	}
}

/** `<coding-agent>:<sessionId>` — what a peer passes as `target` and what the ZSet indexes. */
export function registryMember(codingAgent: string, sessionId: string): string {
	return `${codingAgent}:${sessionId}`;
}

/** Each session gets its own stream; nothing is shared between sessions. */
export function registryStream(prefix: string, member: string): string {
	return `${prefix}:events:${member}`;
}

/** The consumer group the session itself reads its stream in. */
export function registryGroup(member: string): string {
	return `ace:${member}`;
}

/** The stored channel entry: the member, the session's stream, and where this agent runs. */
export function registryChannel(options: {
	member: string;
	stream: string;
	group: string;
	url: string;
	description: string;
}): RegistryChannel {
	return {
		name: options.member,
		transport: "redis-streams",
		description: options.description,
		config: { stream: options.stream, group: options.group, url: options.url },
	};
}

/** What the channel's own description text starts with, before the host details. */
export const REGISTRY_CHANNEL_NOTE = "direct messages addressed to me";

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

/** `direct messages addressed to me | agent=… | session=… | cwd=… | host=… | ip=… | platform=… | pid=…`. */
export function describeLocation(facts: HostFacts): string {
	return [
		REGISTRY_CHANNEL_NOTE,
		`agent=${facts.agentVersion === undefined ? facts.codingAgent : `${facts.codingAgent} ${facts.agentVersion}`}`,
		`session=${formatSessionLabel(facts.sessionId)}`,
		`cwd=${facts.cwd}`,
		`host=${facts.hostname}`,
		...(facts.ip === undefined ? [] : [`ip=${facts.ip}`]),
		`platform=${facts.platform}`,
		`pid=${facts.pid}`,
	].join(" | ");
}

/** How a member resolves for publishing: exact member, or a prefix that matches exactly one. */
export type TargetResolution =
	| { ok: true; entry: RegistryEntry }
	| { ok: false; reason: "not-found" | "ambiguous"; candidates: string[] };

/**
 * Resolve a `target` against the live registrations.
 *
 * A prefix is accepted only when it matches exactly one session: guessing between two sessions would
 * send an event to the wrong agent, and the caller can always ask for the full member.
 */
export function resolveTarget(entries: readonly RegistryEntry[], target: string): TargetResolution {
	const exact = entries.find((entry) => entry.member === target);
	if (exact) return { ok: true, entry: exact };

	// Any prefix that selects exactly one session: typing a 36-character member is tedious, and
	// narrowing by the agent name or the first hex digits of the session is unambiguous enough.
	const matches = entries.filter((entry) => entry.member.startsWith(target));
	if (matches.length === 1 && matches[0]) return { ok: true, entry: matches[0] };
	if (matches.length > 1) {
		return { ok: false, reason: "ambiguous", candidates: matches.map((entry) => entry.member).sort() };
	}
	return { ok: false, reason: "not-found", candidates: entries.map((entry) => entry.member).sort() };
}
