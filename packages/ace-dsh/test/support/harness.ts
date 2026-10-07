/**
 * An in-memory broker and a fake agent, so the plugin's own logic can be exercised without Redis, without
 * DeepSeek Harness, and without a model.
 *
 * The broker is not a mock of the core — it is a fake of the *broker*: it keeps a directory, keeps stream
 * entries, and routes a published event to whichever transports are reading that stream. The core
 * (`AceRuntime`, `AgentRegistry`, the transports' contract) runs for real, so an assertion here is about
 * the plugin's wiring and never about a stubbed-out core.
 */

import type { AceDelivery, DshAgentPort, DshAgentStatus } from "../../src/dsh.ts";
import { DshAgentEngine } from "../../src/engine.ts";
import type { AceFactories } from "../../src/session.ts";
import { AceSession } from "../../src/session.ts";
import type {
	AceMessage,
	AgentRegistryStore,
	DroppedEntry,
	EndpointConfig,
	RedisStreamsAddClient,
	RedisXferClient,
	RegistryEntry,
	Transport,
	XferSetCommand,
} from "../../vendor/ace-runtime/dist/index.js";

/** One stored stream entry, as the broker keeps it. */
interface StreamEntry {
	readonly stream: string;
	readonly field: string;
	readonly payload: unknown;
}

/** A transport the test can push an event into: the broker's side of the runtime's read loop. */
export class FakeTransport implements Transport {
	readonly name: string;
	readonly stream: string;
	readonly group: string;
	started = false;
	private handler: ((raw: unknown, receivedAt?: number) => Promise<void>) | undefined;

	constructor(endpoint: EndpointConfig) {
		this.name = endpoint.name;
		this.stream = String(endpoint.config.stream);
		this.group = String(endpoint.config.group);
	}

	async start(handler: (raw: unknown, receivedAt?: number) => Promise<void>): Promise<void> {
		this.started = true;
		this.handler = handler;
	}

	async stop(): Promise<void> {
		this.started = false;
		this.handler = undefined;
	}

	/** Deliver one raw event the way the broker would. */
	async deliver(raw: unknown, receivedAt?: number): Promise<void> {
		await this.handler?.(raw, receivedAt);
	}
}

/** A shared in-memory broker: one directory, one set of streams, one blob store. */
export class FakeBroker {
	private readonly directory = new Map<string, { description: string; expiresAt: number }>();
	private readonly streams = new Map<string, StreamEntry[]>();
	readonly transports: FakeTransport[] = [];
	/** Every directory operation in order — start-up ordering is asserted against this. */
	readonly journal: string[] = [];
	/** Every stored event, in publish order. */
	readonly published: StreamEntry[] = [];
	readonly blobs = new Map<string, Uint8Array>();
	readonly droppedStreams: string[] = [];
	/** Server names whose directory operations must fail, standing in for a configured-but-down server. */
	readonly unreachableServers = new Set<string>();

	/** Make every directory operation fail, standing in for an unreachable server. */
	unreachable = false;
	/** Make every directory *read* fail, standing in for a directory that went away mid-session. */
	directoryReadFails = false;

	/** The dead-letter hook the session handed its transports, so a test can fire one. */
	capturedOnDropped: ((subscription: string, entry: DroppedEntry) => void | Promise<void>) | undefined;

	factories(): Partial<AceFactories> {
		return {
			registryStore: (server) => this.registryStore(server?.name),
			transports: (endpoints, _onError, _onNotice, onDropped) => {
				this.capturedOnDropped = onDropped;
				return this.transportsFor(endpoints);
			},
			addClient: () => this.addClient(),
			xferClient: (server) => this.xferClient(`xfer:${server.name}`),
		};
	}

	/** One transport per endpoint, kept so a test can deliver into a specific subscription. */
	private transportsFor(endpoints: readonly EndpointConfig[]): Record<string, Transport> {
		const created: Record<string, Transport> = {};
		for (const endpoint of endpoints) {
			const transport = new FakeTransport(endpoint);
			this.transports.push(transport);
			created[endpoint.name] = transport;
		}
		return created;
	}

	/** The transport reading `stream`, when one exists. */
	transportForStream(stream: string): FakeTransport | undefined {
		return this.transports.find((transport) => transport.stream === stream);
	}

	private registryStore(serverName?: string): AgentRegistryStore {
		const store: AgentRegistryStore = {
			ensureStream: async (stream, group) => {
				this.failWhenUnreachable(serverName);
				this.journal.push(`ensureStream:${stream}:${group}`);
				this.streams.set(stream, this.streams.get(stream) ?? []);
			},
			put: async (channel, description, expiresAt) => {
				this.failWhenUnreachable(serverName);
				this.journal.push(`put:${channel}`);
				this.directory.set(channel, { description, expiresAt });
			},
			refresh: async (channel, expiresAt) => {
				this.failWhenUnreachable(serverName);
				const entry = this.directory.get(channel);
				if (entry !== undefined) this.directory.set(channel, { ...entry, expiresAt });
				return entry !== undefined;
			},
			remove: async (channel) => {
				this.failWhenUnreachable(serverName);
				this.journal.push(`remove:${channel}`);
				this.directory.delete(channel);
			},
			dropStream: async (stream) => {
				this.failWhenUnreachable();
				this.journal.push(`dropStream:${stream}`);
				this.droppedStreams.push(stream);
				this.streams.delete(stream);
			},
			list: async (now, _streamGraceMs: number) => {
				if (this.directoryReadFails) throw new Error("directory unavailable");
				this.failWhenUnreachable();
				const live: RegistryEntry[] = [];
				for (const [channel, entry] of [...this.directory.entries()]) {
					if (entry.expiresAt <= now) {
						this.directory.delete(channel);
						this.streams.delete(streamOf(channel));
						continue;
					}
					live.push({ channel, description: entry.description, expiresAt: entry.expiresAt });
				}
				return live;
			},
			close: async () => {},
		};
		return store;
	}

	private addClient(): RedisStreamsAddClient {
		return {
			add: async (stream, field, value) => {
				this.failWhenUnreachable();
				const payload: unknown = JSON.parse(value);
				const entry: StreamEntry = { stream, field, payload };
				this.published.push(entry);
				const kept = this.streams.get(stream) ?? [];
				kept.push(entry);
				this.streams.set(stream, kept);
				// The broker's routing: every started transport reading this stream gets the event, which is
				// what makes a self-echo and a peer delivery real in these tests.
				await this.transportForStream(stream)?.deliver(payload);
				return `${this.published.length}-1`;
			},
			close: async () => {},
		};
	}

	private xferClient(name: string): RedisXferClient {
		return {
			name,
			get: async (key) => this.blobs.get(key),
			setMany: async (commands: readonly XferSetCommand[]) => {
				for (const command of commands) {
					this.blobs.set(
						command.key,
						typeof command.value === "string" ? new TextEncoder().encode(command.value) : command.value,
					);
				}
			},
			close: async () => {},
		};
	}

	/** Live directory entries, expired ones pruned on the way. */
	liveChannels(now = Date.now()): RegistryEntry[] {
		const live: RegistryEntry[] = [];
		for (const [channel, entry] of this.directory.entries()) {
			if (entry.expiresAt > now) live.push({ channel, description: entry.description, expiresAt: entry.expiresAt });
		}
		return live;
	}

	private failWhenUnreachable(serverName?: string): void {
		if (serverName !== undefined && this.unreachableServers.has(serverName)) {
			throw new Error(`server "${serverName}" is unreachable`);
		}
		if (this.unreachable) throw new Error("broker is unreachable");
	}
}

/** The stream key a channel's events live on, without importing the core's naming module into assertions. */
export function streamOf(channel: string, namespace = "ace"): string {
	return `${namespace}:ch:${channel}`;
}

/** A structured fake agent: it records what it was handed instead of running a turn. */
export class FakeAgent implements DshAgentPort {
	status: DshAgentStatus = "idle";
	readonly received: Array<{ kind: "followup" | "steer"; message: unknown }> = [];
	readonly sessionId: string;
	readonly cwd: string;
	private readonly errorListeners: Array<(error: unknown) => void> = [];

	constructor(sessionId = "s-1", cwd = "/work") {
		this.sessionId = sessionId;
		this.cwd = cwd;
	}

	followup(message: unknown): void {
		this.received.push({ kind: "followup", message });
	}

	steer(message: unknown): void {
		this.received.push({ kind: "steer", message });
	}

	async whenIdle(): Promise<void> {}

	onRunError(listener: (error: unknown) => void): () => void {
		this.errorListeners.push(listener);
		return () => {
			const index = this.errorListeners.indexOf(listener);
			if (index >= 0) this.errorListeners.splice(index, 1);
		};
	}

	/** Report one failed turn the way the host does. */
	failRun(error: unknown): void {
		for (const listener of [...this.errorListeners]) listener(error);
	}

	/** The rendered text of the last delivery, as the engine handed it over. */
	get lastText(): string {
		const last = this.received.at(-1);
		return typeof last?.message === "object" && last.message !== null && "text" in last.message
			? String((last.message as { text: unknown }).text)
			: "";
	}
}

/** One ACE message as another session would publish it. */
export function aceEvent(overrides: Partial<AceMessage> = {}): AceMessage {
	return {
		aceVersion: "0.1",
		id: "evt-1",
		sender: "ace:peer:dsh:peer-1",
		activation: "next_turn",
		body: "build failed on main",
		...overrides,
	} as AceMessage;
}

/** What a test may vary about the resolved configuration. */
export interface TestConfigOptions {
	username?: string;
	serverName?: string;
	namespace?: string;
	manual?: { max?: number; ttlMs?: number };
	defaultActivation?: "immediate" | "next_turn" | "manual";
	/** Extra servers to configure, e.g. one that never comes up. */
	extraServers?: Array<{ name: string; url?: string; namespace?: string }>;
	warnings?: string[];
	subscriptions?: Array<{ channel: string; serverName?: string }>;
}

/** A resolved configuration with one reachable server, unless a test says otherwise. */
export function testConfig(options: TestConfigOptions = {}) {
	const serverName = options.serverName ?? "local";
	const namespace = options.namespace ?? "ace";
	return {
		username: options.username ?? "tester",
		servers: [
			{ name: serverName, url: "redis://fake:6379", namespace },
			...(options.extraServers ?? []).map((server) => ({
				name: server.name,
				url: server.url ?? "redis://fake:6379",
				namespace: server.namespace ?? namespace,
			})),
		],
		subscriptions: (options.subscriptions ?? []).map((subscription) => ({
			server: { name: subscription.serverName ?? serverName, url: "redis://fake:6379", namespace },
			channel: subscription.channel,
			name: subscription.channel,
		})),
		manual: options.manual ?? {},
		warnings: options.warnings ?? [],
		source: "/work/.ace.json",
		...(options.defaultActivation === undefined ? {} : { defaultActivation: options.defaultActivation }),
	};
}

/** Open one session against a fake broker, with a fake agent behind it. */
export async function openTestSession(options: {
	broker: FakeBroker;
	agent?: FakeAgent;
	sessionId?: string;
	cwd?: string;
	config?: ReturnType<typeof testConfig>;
	problems?: string[];
}): Promise<{
	session: AceSession;
	agent: FakeAgent;
	engine: DshAgentEngine;
	problems: string[];
}> {
	const agent = options.agent ?? new FakeAgent(options.sessionId, options.cwd);
	const problems = options.problems ?? [];
	const engine = new DshAgentEngine({
		agent,
		// The host's own minting is the only part faked here: a delivery becomes the text the agent is handed.
		buildMessage: (delivery: AceDelivery) => ({ text: delivery.text, summary: delivery.summary }),
	});
	const session = await AceSession.open({
		engine,
		config: options.config ?? testConfig(),
		sessionId: agent.sessionId,
		codingAgent: "dsh",
		cwd: agent.cwd,
		factories: options.broker.factories(),
		onProblem: (message, error) => {
			problems.push(error === undefined ? message : `${message}: ${String(error)}`);
		},
	});
	return { session, agent, engine, problems };
}
