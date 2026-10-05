/**
 * `createBridge` agent-directory registration, driven by the scripted fake
 * app-server and an injected registry factory: the bridge registers the channel named by this
 * session's sender on every server, reads it back as a derived `session-inbox`, and a peer
 * publishes straight to that channel's stream and the runtime turns it into a turn.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AceLogger,
	AgentRegistry,
	type AgentRegistryStore,
	channelName,
	channelStreamKey,
	InMemoryTransport,
	type RegistryEntry,
	senderName,
} from "ace-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { type AceCodexBridge, createBridge, type RegistryFactory, SESSION_INBOX } from "../src/bridge.ts";
import { createMemoryConnections } from "../src/memory-connection.ts";
import { FakeAppServer } from "./support/fake-app-server.ts";

const REGISTRY_URL = "redis://127.0.0.1:6379";
const UP_URL = "redis://127.0.0.1:6379";
const DOWN_URL = "redis://127.0.0.1:6390";
const USERNAME = "tester";
const SILENT: AceLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** In-memory store backing the fake registry: presence index, entry hash, one stream per channel. */
class InMemoryRegistryStore implements AgentRegistryStore {
	channels = new Map<string, number>();
	entries = new Map<string, string>();
	streams = new Set<string>();

	async ensureStream(stream: string): Promise<void> {
		this.streams.add(stream);
	}
	async put(channel: string, description: string, expiresAt: number): Promise<void> {
		this.channels.set(channel, expiresAt);
		this.entries.set(channel, description);
	}
	async refresh(channel: string, expiresAt: number): Promise<void> {
		this.channels.set(channel, expiresAt);
	}
	async remove(channel: string): Promise<void> {
		this.channels.delete(channel);
		this.entries.delete(channel);
	}
	async dropStream(stream: string): Promise<void> {
		this.streams.delete(stream);
	}
	async list(now: number): Promise<RegistryEntry[]> {
		const live: RegistryEntry[] = [];
		for (const [channel, expiresAt] of this.channels) {
			if (expiresAt <= now) continue;
			const description = this.entries.get(channel);
			if (typeof description === "string") live.push({ channel, description, expiresAt });
		}
		return live;
	}
	async close(): Promise<void> {}
}

/** The real `AgentRegistry` over an in-memory store, with recording and an optional register failure. */
class FakeAgentRegistry extends AgentRegistry {
	readonly registryStore: InMemoryRegistryStore;
	readonly callOrder: string[];
	registerArgs: Parameters<AgentRegistry["register"]>[0][] = [];
	#failRegister = false;
	#registerGate: (() => Promise<void>) | undefined;
	#onRegister: (() => void) | undefined;

	constructor(
		store: InMemoryRegistryStore,
		callOrder: string[],
		options: {
			failRegister?: boolean;
			registerGate?: () => Promise<void>;
			onRegister?: () => void;
			namespace?: string;
		} = {},
	) {
		super({
			store,
			namespace: options.namespace,
			ttlMs: 60_000,
			// No heartbeat: a broker-free test should not run a refresh timer.
			refreshMs: 0,
			logger: SILENT,
			onError: () => {},
		});
		this.registryStore = store;
		this.callOrder = callOrder;
		this.#failRegister = options.failRegister ?? false;
		this.#registerGate = options.registerGate;
		this.#onRegister = options.onRegister;
	}

	async register(registration: Parameters<AgentRegistry["register"]>[0]) {
		this.registerArgs.push({ ...registration });
		this.callOrder.push("register");
		this.#onRegister?.();
		if (this.#failRegister) throw new Error("fake register failure");
		// Lets a test hold the registration open across a concurrent `stop()`.
		await this.#registerGate?.();
		return super.register(registration);
	}

	async unregister(): Promise<void> {
		this.callOrder.push("unregister");
		await super.unregister();
	}

	async close(): Promise<void> {
		this.callOrder.push("close");
		await super.close();
	}
}

interface Harness {
	bridge: AceCodexBridge;
	server: FakeAppServer;
	/** The first fake registry created (only valid once `start()` has run). */
	readonly registry: FakeAgentRegistry;
	registries: FakeAgentRegistry[];
	/** Resolves the instant the first `register` is entered. */
	registerCalled: Promise<void>;
	store: InMemoryRegistryStore;
	inboxTransport: InMemoryTransport;
	peerTransport: InMemoryTransport;
	callOrder: string[];
	cwd: string;
	namespace: string;
}

interface ServerSpec {
	name: string;
	url: string;
	namespace: string;
	subscribe?: readonly string[];
}

let current: Harness | undefined;
afterEach(async () => {
	const harness = current;
	current = undefined;
	if (harness) {
		await harness.bridge.stop().catch(() => {});
		rmSync(harness.cwd, { recursive: true, force: true });
	}
});

function writeAceConfig(cwd: string, servers: readonly ServerSpec[]): void {
	const config: Record<string, unknown> = {
		username: USERNAME,
		servers: Object.fromEntries(
			servers.map((server) => [
				server.name,
				{
					url: server.url,
					namespace: server.namespace,
					...(server.subscribe === undefined ? {} : { subscribe: [...server.subscribe] }),
				},
			]),
		),
	};
	writeFileSync(join(cwd, ".ace.json"), JSON.stringify(config));
}

/**
 * Assemble a bridge over the fake app-server with a temp working directory carrying `.ace.json`
 * (one or more servers). The registry is injected as a factory so no broker is needed, and every
 * derived subscription reads through a fake transport.
 */
async function setup(options: {
	servers?: readonly ServerSpec[];
	subscribe?: readonly string[];
	/** URLs whose registration must fail (a simulated unreachable broker). */
	failUrls?: ReadonlySet<string>;
	registerGate?: () => Promise<void>;
	logger?: AceLogger;
	/** When false, `start()` is returned un-awaited so a test can race `stop()` against it. */
	startNow?: boolean;
}): Promise<Harness> {
	const namespace = `ace-test-${Math.random().toString(16).slice(2)}`;
	const baseServers = options.servers ?? [{ name: "local", url: REGISTRY_URL, namespace }];
	const subscribe = options.subscribe ?? ["from-peer"];
	// A subscription belongs to the server that carries it: name it on the first server.
	const servers = baseServers.map((spec, index) =>
		index === 0 && subscribe.length > 0 ? { ...spec, subscribe } : spec,
	);
	const failUrls = options.failUrls ?? new Set<string>();
	const registerGate = options.registerGate;
	const logger = options.logger ?? SILENT;
	const startNow = options.startNow ?? true;
	const cwd = mkdtempSync(join(tmpdir(), "ace-codex-bridge-"));
	writeAceConfig(cwd, servers);

	const { a, b } = createMemoryConnections();
	const server = new FakeAppServer(b);
	const store = new InMemoryRegistryStore();
	const callOrder: string[] = [];
	const registries: FakeAgentRegistry[] = [];
	const { promise: registerCalled, resolve: markRegisterCalled } = Promise.withResolvers<void>();
	const registry: RegistryFactory = ({ url, namespace }) => {
		const fake = new FakeAgentRegistry(store, callOrder, {
			namespace,
			failRegister: failUrls.has(url),
			registerGate,
			onRegister: markRegisterCalled,
		});
		registries.push(fake);
		return fake;
	};
	const inboxTransport = new InMemoryTransport();
	const peerTransport = new InMemoryTransport();
	// Record when the runtime's transport stop ran, so the order is
	// runtime.stop (transport stop) → unregister → close.
	const originalStop = inboxTransport.stop.bind(inboxTransport);
	inboxTransport.stop = async () => {
		callOrder.push("runtime.stop:transport-stop");
		return originalStop();
	};

	// Transport keys follow the derived subscription names.
	const multi = servers.length > 1;
	const transportByName: Record<string, InMemoryTransport> = {};
	for (const spec of servers) {
		const prefix = multi ? `${spec.name}:` : "";
		transportByName[`${prefix}${SESSION_INBOX}`] = inboxTransport;
		for (const name of spec.subscribe ?? []) {
			const channel = channelName(spec.namespace, USERNAME, name);
			transportByName[`${prefix}${channel}`] = peerTransport;
		}
	}

	const env: Record<string, string | undefined> = { ...process.env };
	// Keep the resolver pointed at the temp workspace, not a host-configured ACE_CONFIG.
	delete env.ACE_CONFIG;

	const bridge = createBridge({
		config: { listener: "stdio", command: "codex" },
		cwd,
		connection: a,
		logger,
		env,
		// Registry seam: the recording factory, built from the in-memory store.
		registry,
		transports: transportByName,
	});

	current = {
		bridge,
		server,
		get registry() {
			return registries[0] as FakeAgentRegistry;
		},
		registries,
		registerCalled,
		store,
		inboxTransport,
		peerTransport,
		callOrder,
		cwd,
		namespace,
	};
	if (startNow) await bridge.start();
	return current;
}

describe("createBridge agent-directory registration", () => {
	it("registers the sender channel with codingAgent=codex, the Codex thread id and cwd", async () => {
		const harness = await setup({});
		const threadId = harness.bridge.threadId();
		expect(threadId).toBeDefined();
		const registration = harness.bridge.registration();
		expect(registration).toBeDefined();
		const expectedSender = senderName({
			namespace: harness.namespace,
			username: USERNAME,
			codingAgent: "codex",
			sessionId: threadId as string,
		});
		// The channel *is* the sender; the stream and group are derived from it.
		expect(registration?.channel).toBe(expectedSender);
		expect(registration?.stream).toBe(channelStreamKey(harness.namespace, expectedSender));
		expect(registration?.group).toBe(expectedSender);
		expect(harness.registry.registerArgs).toHaveLength(1);
		expect(harness.registry.registerArgs[0]).toMatchObject({
			sender: expectedSender,
			codingAgent: "codex",
			sessionId: threadId,
			cwd: harness.cwd,
		});
	});

	it("appends the derived session-inbox subscription and gives it a transport", async () => {
		const harness = await setup({});
		const registration = harness.bridge.registration();
		expect(registration).toBeDefined();
		expect(harness.bridge.sessionInbox()).toMatchObject({
			name: SESSION_INBOX,
			transport: "redis-streams",
			config: {
				stream: registration?.stream,
				group: registration?.group,
				url: REGISTRY_URL,
			},
		});
		const transports = harness.bridge.transports();
		expect(transports?.[SESSION_INBOX]).toBeDefined();
		// The runtime started it: the advertised inbox is actually being read.
		expect(harness.inboxTransport.started).toBe(true);
		// The configured subscription still has its own transport, named by its channel.
		const peerName = channelName(harness.namespace, USERNAME, "from-peer");
		expect(transports?.[peerName]).toBeDefined();
		expect(harness.peerTransport.started).toBe(true);
	});

	it("delivers an event published straight to the channel's stream, and acks it", async () => {
		const harness = await setup({});
		const message = JSON.stringify({
			aceVersion: "0.1",
			id: "evt_direct_1",
			sender: "peer-agent",
			activation: "next_turn",
			body: "Direct message from the directory test.",
		});
		// A peer that resolved this session through the directory publishes an ACE event to the
		// stream the channel name derives. `publish` awaits the runtime's full delivery (validate →
		// inject → delivery ack), so a resolved publish is the ack.
		await harness.inboxTransport.publish(message);
		expect(harness.server.count("turn/start")).toBe(1);
		const input = harness.server.last("turn/start")?.params as { input?: Array<{ text?: string }> };
		expect(input?.input?.[0]?.text).toContain("Direct message from the directory test.");
	});

	it("stops in the order runtime.stop → unregister → close", async () => {
		const harness = await setup({});
		expect(harness.callOrder).toEqual(["register"]);
		await harness.bridge.stop();
		const runtimeStop = harness.callOrder.indexOf("runtime.stop:transport-stop");
		const unregister = harness.callOrder.indexOf("unregister");
		const close = harness.callOrder.indexOf("close");
		expect(runtimeStop).toBeGreaterThanOrEqual(0);
		expect(unregister).toBeGreaterThan(runtimeStop);
		expect(close).toBeGreaterThan(unregister);
	});

	it("survives a failed registration: the bridge still starts, unregistered", async () => {
		const harness = await setup({ failUrls: new Set([REGISTRY_URL]) });
		expect(harness.bridge.registration()).toBeUndefined();
		expect(harness.bridge.sessionInbox()).toBeUndefined();
		expect(harness.registry.registerArgs).toHaveLength(1);
		// No derived subscription for a server that did not come up, so no reader started for it.
		expect(harness.inboxTransport.started).toBe(false);
		expect(harness.store.channels.size).toBe(0);
	});

	it("cleans up when `register` completes after `stop()` (no dangling registration)", async () => {
		let releaseGate: (() => void) | undefined;
		const gate = () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			releaseGate = resolve;
			return promise;
		};
		// Build without auto-starting, so `start()` and `stop()` can be raced deterministically.
		const harness = await setup({ registerGate: gate, startNow: false });
		const startPromise = harness.bridge.start();
		// Wait until `register` is actually held open at the gate (in flight).
		await harness.registerCalled;
		expect(harness.registries[0]?.registerArgs.length).toBe(1);
		// `stop()` lands while `register` is still in flight. It cannot unregister a registration
		// that does not exist yet, so the post-register cleanup must remove it when the gate opens.
		await harness.bridge.stop();
		releaseGate?.();
		await startPromise;
		// No dangling registration: the channel and its stream were removed from the directory.
		expect(harness.store.channels.size).toBe(0);
		expect(harness.store.streams.size).toBe(0);
		// And the cleanup path actually ran the unregister (not just `stop()`'s no-op one).
		expect(harness.callOrder.filter((call) => call === "unregister")).toHaveLength(2);
	});

	it("reports a failed registration exactly once as a warning, not an error", async () => {
		const warnings: string[] = [];
		const errors: string[] = [];
		const logger: AceLogger = {
			info: () => {},
			warn: (message) => warnings.push(message),
			error: (message) => errors.push(message),
		};
		await setup({ failUrls: new Set([REGISTRY_URL]), logger });
		// The bridge degraded and continued, surfacing the failure once via `warn`.
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("agent directory");
		expect(warnings[0]).toContain("unreachable");
		expect(errors).toHaveLength(0);
	});

	it("isolates servers: an unreachable one is skipped and the rest of the session still runs", async () => {
		const warnings: string[] = [];
		const logger: AceLogger = {
			info: () => {},
			warn: (message) => warnings.push(message),
			error: () => {},
		};
		const up: ServerSpec = { name: "up", url: UP_URL, namespace: `ace-up-${Math.random().toString(16).slice(2)}` };
		const down: ServerSpec = {
			name: "down",
			url: DOWN_URL,
			namespace: `ace-down-${Math.random().toString(16).slice(2)}`,
		};
		const harness = await setup({
			servers: [up, down],
			subscribe: ["from-peer"],
			failUrls: new Set([DOWN_URL]),
			logger,
		});
		// The reachable server registered; the unreachable one did not.
		const registration = harness.bridge.registration();
		expect(registration).toBeDefined();
		expect(registration?.channel).toBe(
			senderName({
				namespace: up.namespace,
				username: USERNAME,
				codingAgent: "codex",
				sessionId: harness.bridge.threadId() as string,
			}),
		);
		expect(harness.store.channels.size).toBe(1);
		// The failed server was reported once, never as an error, and never took the session down.
		expect(warnings.filter((w) => w.includes("down") && w.includes("unreachable"))).toHaveLength(1);
		expect(harness.bridge.transports()?.["up:session-inbox"]).toBeDefined();
		expect(harness.inboxTransport.started).toBe(true);
		expect(harness.peerTransport.started).toBe(true);
	});
});
