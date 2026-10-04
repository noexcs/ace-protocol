/**
 * `createBridge` agent-directory registration, driven by the scripted fake
 * app-server and an in-memory fake registry — no broker needed.
 *
 * Mirrors the reference assembly in `packages/ace-runtime/extensions/ace.ts`
 * (and `docs/ace-runtime-api.md` §6): construct the registry →
 * `register({ codingAgent, sessionId, cwd, url })` with the Codex thread id as
 * `sessionId` → append the returned inbox as the derived `session-inbox`
 * subscription *and* give it a transport → `runtime.start()`. Stop is
 * `runtime.stop()` → `registry.unregister()` → `registry.close()`.
 *
 * The registry is injected through the `registry` seam (a factory) so the real
 * `AgentRegistry` derivation runs against an in-memory store. Both the
 * configured subscription and the derived `session-inbox` read through fake
 * transports, so the full start path runs with no broker: the delivery test
 * publishes straight to the member's inbox transport and the runtime turns it
 * into a turn.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AceLogger,
	AgentRegistry,
	type AgentRegistryStore,
	InMemoryTransport,
	type RegistryChannel,
	type RegistryEntry,
} from "ace-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { type AceCodexBridge, createBridge, SESSION_INBOX } from "../src/bridge.ts";
import { createMemoryConnections } from "../src/memory-connection.ts";
import { FakeAppServer } from "./support/fake-app-server.ts";

const REGISTRY_URL = "redis://127.0.0.1:6379";
const SILENT: AceLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** In-memory store backing the fake registry: presence index, entry hash, one stream per member. */
class InMemoryRegistryStore implements AgentRegistryStore {
	members = new Map<string, number>();
	entries = new Map<string, string>();
	streams = new Set<string>();

	async ensureStream(stream: string): Promise<void> {
		this.streams.add(stream);
	}
	async put(member: string, channel: RegistryChannel, expiresAt: number): Promise<void> {
		this.members.set(member, expiresAt);
		this.entries.set(member, JSON.stringify(channel));
	}
	async refresh(member: string, expiresAt: number): Promise<void> {
		this.members.set(member, expiresAt);
	}
	async remove(member: string): Promise<void> {
		this.members.delete(member);
		this.entries.delete(member);
	}
	async dropStream(stream: string): Promise<void> {
		this.streams.delete(stream);
	}
	async list(now: number): Promise<RegistryEntry[]> {
		const live: RegistryEntry[] = [];
		for (const [member, expiresAt] of this.members) {
			if (expiresAt <= now) continue;
			const raw = this.entries.get(member);
			if (typeof raw === "string") live.push({ member, channel: JSON.parse(raw) as RegistryChannel, expiresAt });
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

	constructor(
		store: InMemoryRegistryStore,
		callOrder: string[],
		options: { failRegister?: boolean; registerGate?: () => Promise<void> } = {},
	) {
		super({
			store,
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
	}

	async register(registration: Parameters<AgentRegistry["register"]>[0]) {
		this.registerArgs.push({ ...registration });
		this.callOrder.push("register");
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
	registry: FakeAgentRegistry;
	store: InMemoryRegistryStore;
	inboxTransport: InMemoryTransport;
	peerTransport: InMemoryTransport;
	callOrder: string[];
	cwd: string;
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

function writeAceConfig(cwd: string, prefix: string, withRegistry: boolean, nameConflict: boolean): void {
	const config: Record<string, unknown> = {
		subscribe: [
			{
				name: "from-peer",
				transport: "redis-streams",
				description: "a configured channel",
				config: { stream: `${prefix}:in.peer`, group: "codex", url: REGISTRY_URL },
				options: {},
			},
			...(nameConflict
				? [
						{
							name: SESSION_INBOX,
							transport: "redis-streams",
							description: "a pre-existing subscription that collides with the directory inbox",
							config: { stream: `${prefix}:in.inbox`, group: "codex", url: REGISTRY_URL },
							options: {},
						},
					]
				: []),
		],
		...(!withRegistry ? {} : { registry: { url: REGISTRY_URL, prefix } }),
	};
	writeFileSync(join(cwd, ".ace.json"), JSON.stringify(config));
}

/**
 * Assemble a bridge over the fake app-server with a temp working directory carrying `.ace.json`
 * (registry on/off). The registry is injected as a factory so no broker is needed, and both
 * subscriptions read through fake transports.
 */
async function setup(options: {
	withRegistry?: boolean;
	failRegister?: boolean;
	registerGate?: () => Promise<void>;
	logger?: AceLogger;
	/** When false, `start()` is returned un-awaited so a test can race `stop()` against it. */
	startNow?: boolean;
	/** When true, the configured `.ace.json` already declares a `session-inbox` subscription. */
	nameConflict?: boolean;
}): Promise<Harness> {
	const withRegistry = options.withRegistry ?? true;
	const failRegister = options.failRegister ?? false;
	const registerGate = options.registerGate;
	const logger = options.logger ?? SILENT;
	const startNow = options.startNow ?? true;
	const nameConflict = options.nameConflict ?? false;
	const cwd = mkdtempSync(join(tmpdir(), "ace-codex-bridge-"));
	const prefix = `ace:test:${Math.random().toString(16).slice(2)}`;
	writeAceConfig(cwd, prefix, withRegistry, nameConflict);

	const { a, b } = createMemoryConnections();
	const server = new FakeAppServer(b);
	const store = new InMemoryRegistryStore();
	const callOrder: string[] = [];
	const registry = new FakeAgentRegistry(store, callOrder, { failRegister, registerGate });
	const inboxTransport = new InMemoryTransport();
	const peerTransport = new InMemoryTransport();
	// Record when the runtime's transport stop ran, so the order is
	// runtime.stop (transport stop) → unregister → close.
	const originalStop = inboxTransport.stop.bind(inboxTransport);
	inboxTransport.stop = async () => {
		callOrder.push("runtime.stop:transport-stop");
		return originalStop();
	};

	const env: Record<string, string | undefined> = { ...process.env };
	// Keep the resolver pointed at the temp workspace, not a host-configured ACE_CONFIG.
	delete env.ACE_CONFIG;

	const bridge = createBridge({
		config: { listener: "stdio", command: "codex" },
		cwd,
		connection: a,
		logger,
		env,
		// Registry seam: the recording fake, built from the in-memory store.
		registry,
		transports: { "from-peer": peerTransport, [SESSION_INBOX]: inboxTransport },
	});

	current = {
		bridge,
		server,
		registry,
		store,
		inboxTransport,
		peerTransport,
		callOrder,
		cwd,
	};
	if (startNow) await bridge.start();
	return current;
}

describe("createBridge agent-directory registration", () => {
	it("registers with codingAgent=codex, the Codex thread id, cwd and the registry url", async () => {
		const harness = await setup({ withRegistry: true });
		const threadId = harness.bridge.threadId();
		expect(threadId).toBeDefined();
		const registration = harness.bridge.registration();
		expect(registration).toBeDefined();
		expect(registration?.member).toBe(`codex:${threadId}`);
		expect(harness.registry.registerArgs).toHaveLength(1);
		expect(harness.registry.registerArgs[0]).toMatchObject({
			codingAgent: "codex",
			sessionId: threadId,
			cwd: harness.cwd,
			url: REGISTRY_URL,
		});
	});

	it("appends the derived session-inbox subscription and gives it a transport", async () => {
		const harness = await setup({ withRegistry: true });
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
		// The configured subscription still has its own transport.
		expect(transports?.["from-peer"]).toBeDefined();
		expect(harness.peerTransport.started).toBe(true);
	});

	it("delivers an event published straight to the member's stream, and acks it", async () => {
		const harness = await setup({ withRegistry: true });
		const message = JSON.stringify({
			aceVersion: "0.1",
			id: "evt_direct_1",
			sender: "peer-agent",
			activation: "next_turn",
			body: "Direct message from the directory test.",
		});
		// A peer that resolved this session through the directory publishes an ACE event to the
		// stream the directory advertised. `publish` awaits the runtime's full delivery (validate →
		// inject → delivery ack), so a resolved publish is the ack.
		await harness.inboxTransport.publish(message);
		expect(harness.server.count("turn/start")).toBe(1);
		const input = harness.server.last("turn/start")?.params as { input?: Array<{ text?: string }> };
		expect(input?.input?.[0]?.text).toContain("Direct message from the directory test.");
	});

	it("stops in the order runtime.stop → unregister → close", async () => {
		const harness = await setup({ withRegistry: true });
		expect(harness.callOrder).toEqual(["register"]);
		await harness.bridge.stop();
		const runtimeStop = harness.callOrder.indexOf("runtime.stop:transport-stop");
		const unregister = harness.callOrder.indexOf("unregister");
		const close = harness.callOrder.indexOf("close");
		expect(runtimeStop).toBeGreaterThanOrEqual(0);
		expect(unregister).toBeGreaterThan(runtimeStop);
		expect(close).toBeGreaterThan(unregister);
	});

	it("does not register when the config has no registry", async () => {
		const harness = await setup({ withRegistry: false });
		expect(harness.bridge.registration()).toBeUndefined();
		expect(harness.bridge.sessionInbox()).toBeUndefined();
		expect(harness.registry.registerArgs).toHaveLength(0);
		expect(harness.callOrder).toEqual([]);
		expect(harness.store.members.size).toBe(0);
		// No derived subscription, so no reader is started for it.
		expect(harness.inboxTransport.started).toBe(false);
	});

	it("survives a failed registration: the bridge still starts, unregistered", async () => {
		const harness = await setup({ withRegistry: true, failRegister: true });
		expect(harness.bridge.registration()).toBeUndefined();
		expect(harness.bridge.sessionInbox()).toBeUndefined();
		expect(harness.registry.registerArgs).toHaveLength(1);
		// No derived subscription, so the inbox reader was never started.
		expect(harness.inboxTransport.started).toBe(false);
		// Still reading its configured channel.
		expect(harness.peerTransport.started).toBe(true);
	});

	it("cleans up when `register` completes after `stop()` (no dangling registration)", async () => {
		let releaseGate: (() => void) | undefined;
		const gate = () =>
			new Promise<void>((resolve) => {
				releaseGate = resolve;
			});
		// Build without auto-starting, so `start()` and `stop()` can be raced deterministically.
		const harness = await setup({ withRegistry: true, registerGate: gate, startNow: false });
		const startPromise = harness.bridge.start();
		// Wait until the registration is actually held open at the gate (in flight).
		const deadline = Date.now() + 2_000;
		while (harness.registry.registerArgs.length < 1 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(harness.registry.registerArgs.length).toBe(1);
		// `stop()` lands while `register` is still in flight. It cannot unregister a registration
		// that does not exist yet, so the post-register cleanup must remove it when the gate opens.
		await harness.bridge.stop();
		releaseGate?.();
		await startPromise;
		// Give the in-flight `register` continuation a tick to reach its post-register cleanup.
		await new Promise((resolve) => setTimeout(resolve, 50));
		// No dangling registration: the member and its stream were removed from the directory.
		expect(harness.store.members.size).toBe(0);
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
		await setup({ withRegistry: true, failRegister: true, logger });
		// The bridge degraded and continued, surfacing the failure once via `warn`.
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("agent directory");
		expect(errors).toHaveLength(0);
	});

	it("degrades (still reads configured channels) when a subscription is already named session-inbox", async () => {
		const warnings: string[] = [];
		const logger: AceLogger = {
			info: () => {},
			warn: (message) => warnings.push(message),
			error: () => {},
		};
		const harness = await setup({ withRegistry: true, nameConflict: true, logger });
		// No directory registration and no derived subscription…
		expect(harness.bridge.registration()).toBeUndefined();
		expect(harness.bridge.sessionInbox()).toBeUndefined();
		expect(harness.store.members.size).toBe(0);
		// …but the configured channel is still being read (the runtime started).
		expect(harness.peerTransport.started).toBe(true);
		// The collision was surfaced once, and not as an error.
		expect(warnings.some((w) => w.includes("already named"))).toBe(true);
	});
});
