import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentRegistration,
	AgentRegistryStore,
	EndpointConfig,
	RegistryChannel,
	Transport,
	TransportFactoryOptions,
} from "ace-runtime";
import { AgentRegistry, registryGroup, registryMember, registryStream } from "ace-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_INBOX, startAce } from "../src/runtime.ts";

/**
 * The agent-directory wiring of `startAce`, without a broker: the registry store and the
 * subscribe transports are injected stand-ins that record their calls, so the tests assert the
 * registration parameters, the derived subscription, and the stop order directly.
 */
const SESSION_ID = "sess-42";
const CODING_AGENT = "claude-code";
const REGISTRY_URL = "redis://127.0.0.1:6379";
const REGISTRY_PREFIX = "ace:test";
const MEMBER = registryMember(CODING_AGENT, SESSION_ID);
const STREAM = registryStream(REGISTRY_PREFIX, MEMBER);
const GROUP = registryGroup(MEMBER);

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

const directories: string[] = [];

function configDirectory(withRegistry: boolean): string {
	const directory = mkdtempSync(join(tmpdir(), "ace-cc-runtime-"));
	directories.push(directory);
	const base = {
		subscribe: [
			{
				name: "inbox",
				transport: "redis-streams",
				config: { stream: "ace:test:in", group: "claude-code", url: REGISTRY_URL },
			},
		],
		publish: [{ name: "outbox", transport: "redis-streams", config: { stream: "ace:test:out", url: REGISTRY_URL } }],
	};
	writeFileSync(
		join(directory, ".ace.json"),
		JSON.stringify(withRegistry ? { ...base, registry: { url: REGISTRY_URL, prefix: REGISTRY_PREFIX } } : base),
	);
	return directory;
}

interface StoreRecording {
	calls: Array<readonly unknown[]>;
	store: AgentRegistryStore;
	factoryCalls: Array<{ url: string; prefix?: string }>;
}

/** A recording stand-in for `AgentRegistryStore`: every method logs its arguments in order. */
function recordingStoreFactory() {
	const recording: StoreRecording = {
		calls: [],
		store: {
			ensureStream: async (stream, group) => {
				recording.calls.push(["ensureStream", stream, group]);
			},
			put: async (member, channel, expiresAt) => {
				recording.calls.push(["put", member, channel, expiresAt]);
			},
			refresh: async (member, expiresAt) => {
				recording.calls.push(["refresh", member, expiresAt]);
			},
			remove: async (member) => {
				recording.calls.push(["remove", member]);
			},
			dropStream: async (stream) => {
				recording.calls.push(["dropStream", stream]);
			},
			list: async (now) => {
				recording.calls.push(["list", now]);
				return [];
			},
			close: async () => {
				recording.calls.push(["close"]);
			},
		},
		factoryCalls: [],
	};
	const factory = (options: {
		url: string;
		prefix?: string;
		onError: (error: unknown) => void;
	}): AgentRegistryStore => {
		recording.factoryCalls.push({
			url: options.url,
			...(options.prefix === undefined ? {} : { prefix: options.prefix }),
		});
		return recording.store;
	};
	return { recording, factory };
}

interface TransportRecording {
	subscriptions: EndpointConfig[][];
	order: string[];
}

/**
 * A no-op transport per subscription, keyed by name the way `createTransports` returns them;
 * `order` records start/stop interleaved with the registry call record the tests pass in.
 */
function fakeTransports(recording: TransportRecording) {
	return (subscriptions: readonly EndpointConfig[], _options: TransportFactoryOptions): Record<string, Transport> => {
		recording.subscriptions.push([...subscriptions]);
		const byName: Record<string, Transport> = {};
		for (const endpoint of subscriptions) {
			byName[endpoint.name] = {
				start: async () => {
					recording.order.push(`start:${endpoint.name}`);
				},
				stop: async () => {
					recording.order.push(`stop:${endpoint.name}`);
				},
			};
		}
		return byName;
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true });
});

describe("startAce with a configured registry", () => {
	it("registers with the session identity and broker, and appends the derived session-inbox", async () => {
		const originalRegister = AgentRegistry.prototype.register;
		const registeredArgs: AgentRegistration[] = [];
		vi.spyOn(AgentRegistry.prototype, "register").mockImplementation(function (
			this: AgentRegistry,
			registration: AgentRegistration,
		) {
			registeredArgs.push(registration);
			return originalRegister.call(this, registration);
		});

		const cwd = configDirectory(true);
		const { recording, factory } = recordingStoreFactory();
		const transports: TransportRecording = { subscriptions: [], order: [] };
		const handle = await startAce({
			cwd,
			push: async () => {},
			logger: quiet,
			sessionId: SESSION_ID,
			env: {},
			registryStoreFactory: factory,
			transportsFactory: fakeTransports(transports),
		});
		expect(handle).toBeDefined();

		// The store came from the configured broker and prefix.
		expect(recording.factoryCalls).toEqual([{ url: REGISTRY_URL, prefix: REGISTRY_PREFIX }]);
		// `register()` received this session's identity, its working directory, and its broker.
		expect(registeredArgs).toEqual([{ codingAgent: CODING_AGENT, sessionId: SESSION_ID, cwd, url: REGISTRY_URL }]);
		// The stream existed before the entry advertised it; the entry names the member and the address.
		const order = recording.calls.map((call) => call[0]);
		expect(order.indexOf("ensureStream")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("ensureStream")).toBeLessThan(order.indexOf("put"));
		expect(recording.calls.find((call) => call[0] === "ensureStream")).toEqual(["ensureStream", STREAM, GROUP]);
		const put = recording.calls.find((call) => call[0] === "put") as
			| readonly ["put", string, RegistryChannel, number]
			| undefined;
		expect(put?.[1]).toBe(MEMBER);
		expect(put?.[2].config).toEqual({ stream: STREAM, group: GROUP, url: REGISTRY_URL });

		// The derived subscription the runtime actually reads: named `session-inbox`, on the
		// registered stream/group, alongside the configured channels.
		const seen = transports.subscriptions[0] ?? [];
		expect(seen.map((endpoint) => endpoint.name)).toEqual(["inbox", SESSION_INBOX]);
		const inbox = seen.find((endpoint) => endpoint.name === SESSION_INBOX);
		expect(inbox?.transport).toBe("redis-streams");
		expect(inbox?.config).toMatchObject({ stream: STREAM, group: GROUP, url: REGISTRY_URL });
		// The member name reaches the tool surface the model reads.
		expect(handle?.tools.member).toBe(MEMBER);

		await handle?.stop();
	});

	it("keeps running when registration fails, exposing no member and no derived subscription", async () => {
		vi.spyOn(AgentRegistry.prototype, "register").mockRejectedValue(
			new Error("connect ECONNREFUSED 127.0.0.1:59999"),
		);
		const directory = configDirectory(true);
		const warnings: string[] = [];
		const { recording, factory } = recordingStoreFactory();
		const transports: TransportRecording = { subscriptions: [], order: [] };
		const handle = await startAce({
			cwd: directory,
			push: () => Promise.resolve(),
			logger: {
				warn: (m) => warnings.push(m),
				error: (m) => warnings.push(m),
			},
			sessionId: SESSION_ID,
			codingAgent: CODING_AGENT,
			transportsFactory: fakeTransports(transports),
			registryStoreFactory: factory,
		});
		expect(handle).toBeDefined();
		// The store was built (the configured broker and prefix); registration failed before any
		// entry was written, and the failed registry closed its client on the way out.
		expect(recording.factoryCalls).toEqual([{ url: REGISTRY_URL, prefix: REGISTRY_PREFIX }]);
		expect(recording.calls.map((call) => call[0])).toEqual(["close"]);
		// The runtime degrades to the configured channels: the list it reads holds no session-inbox,
		// and the tool surface does not advertise a name no peer could resolve.
		expect(transports.subscriptions[0]?.map((endpoint) => endpoint.name)).toEqual(["inbox"]);
		expect(handle?.tools.member).toBeUndefined();
		expect(warnings.some((message) => message.includes("ECONNREFUSED"))).toBe(true);
		await handle?.stop();
	});

	it("stops the reader before unregister, and closes the registry last", async () => {
		const originalUnregister = AgentRegistry.prototype.unregister;
		const originalClose = AgentRegistry.prototype.close;
		const order: string[] = [];
		vi.spyOn(AgentRegistry.prototype, "unregister").mockImplementation(function (this: AgentRegistry) {
			order.push("unregister");
			return originalUnregister.call(this);
		});
		vi.spyOn(AgentRegistry.prototype, "close").mockImplementation(function (this: AgentRegistry) {
			order.push("close");
			return originalClose.call(this);
		});

		const { recording, factory } = recordingStoreFactory();
		const transports: TransportRecording = { subscriptions: [], order };
		const handle = await startAce({
			cwd: configDirectory(true),
			push: async () => {},
			logger: quiet,
			sessionId: SESSION_ID,
			env: {},
			registryStoreFactory: factory,
			transportsFactory: fakeTransports(transports),
		});
		expect(handle).toBeDefined();
		await handle?.stop();

		// `unregister` drops this session's own stream, so every reader has to be gone first
		// (the 0.1.3 ordering), and the registry's client is released last of all.
		const firstStop = order.findIndex((step) => step.startsWith("stop:"));
		const lastStop = [...order.keys()].findLast((index) => order[index]?.startsWith("stop:"));
		expect(firstStop).toBeGreaterThanOrEqual(0);
		expect(lastStop).toBeGreaterThanOrEqual(0);
		expect(firstStop).toBeLessThan(order.indexOf("unregister"));
		expect(lastStop).toBeLessThan(order.indexOf("unregister"));
		expect(order.indexOf("unregister")).toBeLessThan(order.indexOf("close"));
		const subscriptions = transports.subscriptions[0] ?? [];
		for (const endpoint of subscriptions) expect(order).toContain(`stop:${endpoint.name}`);

		// The real `unregister` ran against the recording store: entry removed, stream dropped,
		// store closed once — after both.
		const storeOrder = recording.calls.map((call) => call[0]);
		expect(storeOrder).toContain("remove");
		expect(storeOrder).toContain("dropStream");
		expect(storeOrder[storeOrder.length - 1]).toBe("close");
		expect(recording.calls.find((call) => call[0] === "remove")).toEqual(["remove", MEMBER]);
		expect(recording.calls.find((call) => call[0] === "dropStream")).toEqual(["dropStream", STREAM]);
	});
});

describe("startAce without a registry", () => {
	it("registers nothing and adds no derived subscription", async () => {
		const { recording, factory } = recordingStoreFactory();
		const transports: TransportRecording = { subscriptions: [], order: [] };
		const handle = await startAce({
			cwd: configDirectory(false),
			push: async () => {},
			logger: quiet,
			sessionId: SESSION_ID,
			env: {},
			registryStoreFactory: factory,
			transportsFactory: fakeTransports(transports),
		});
		expect(handle).toBeDefined();
		expect(recording.factoryCalls).toEqual([]);
		expect(recording.calls).toEqual([]);
		const seen = transports.subscriptions[0] ?? [];
		expect(seen.map((endpoint) => endpoint.name)).toEqual(["inbox"]);
		expect(handle?.tools.member).toBeUndefined();
		await handle?.stop();
	});

	it("runs without the directory when a configured subscription already owns the inbox name", async () => {
		// A configured channel named `session-inbox` plus a `registry` would make the runtime refuse
		// to start (duplicate subscription names), so this session must run on the configured
		// channels instead — registering nothing — rather than fail over the naming collision.
		const directory = configDirectory(true);
		const config = JSON.parse(readFileSync(join(directory, ".ace.json"), "utf8")) as {
			subscribe: EndpointConfig[];
		};
		config.subscribe.push({
			name: SESSION_INBOX,
			transport: "redis-streams",
			config: { stream: "ace:test:mine", group: "claude-code", url: REGISTRY_URL },
			options: {},
		});
		writeFileSync(join(directory, ".ace.json"), JSON.stringify(config));

		const warnings: string[] = [];
		const { recording, factory } = recordingStoreFactory();
		const transports: TransportRecording = { subscriptions: [], order: [] };
		const handle = await startAce({
			cwd: directory,
			push: async () => {},
			logger: { ...quiet, warn: (message: string) => warnings.push(message) },
			sessionId: SESSION_ID,
			env: {},
			registryStoreFactory: factory,
			transportsFactory: fakeTransports(transports),
		});
		expect(handle).toBeDefined();
		expect(warnings.join(" ")).toMatch(/already named session-inbox/i);
		expect(recording.factoryCalls).toEqual([]);
		expect(recording.calls).toEqual([]);
		// The configured channel is what the runtime reads; no derived duplicate is appended.
		const seen = transports.subscriptions[0] ?? [];
		expect(seen.map((endpoint) => endpoint.name)).toEqual(["inbox", SESSION_INBOX]);
		expect(handle?.tools.member).toBeUndefined();
		await handle?.stop();
	});

	it("skips registration with a warning when the host injected no session id", async () => {
		const warnings: string[] = [];
		const { recording, factory } = recordingStoreFactory();
		const transports: TransportRecording = { subscriptions: [], order: [] };
		const handle = await startAce({
			cwd: configDirectory(true),
			push: async () => {},
			logger: { ...quiet, warn: (message: string) => warnings.push(message) },
			env: {},
			registryStoreFactory: factory,
			transportsFactory: fakeTransports(transports),
		});
		expect(handle).toBeDefined();
		expect(recording.factoryCalls).toEqual([]);
		expect(warnings.join(" ")).toMatch(/no session id/i);
		expect(handle?.tools.member).toBeUndefined();
		await handle?.stop();
	});
});

it("names the derived subscription session-inbox", () => {
	expect(SESSION_INBOX).toBe("session-inbox");
});
