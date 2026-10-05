import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentRegistryStore,
	EndpointConfig,
	RedisStreamsAddClient,
	RegistryEntry,
	Transport,
	TransportFactoryOptions,
} from "ace-runtime";
import { AgentRegistry, channelName, channelStreamKey, SESSION_INBOX, senderName } from "ace-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAce } from "../src/runtime.ts";

/**
 * The agent-directory wiring of `startAce`, without a broker: the registry store, the subscribe
 * transports and the publish writers are injected stand-ins that record their calls, so the tests
 * assert the registration channel, the derived subscriptions, per-server isolation and the stop
 * order directly.
 */
const USERNAME = "tester";
const SESSION_ID = "sess-42";
const CODING_AGENT = "claude-code";
const URL_A = "redis://127.0.0.1:6379";
const URL_B = "redis://127.0.0.1:6380";
const NS_A = "lan";
const NS_B = "wan";
const senderFor = (namespace: string) =>
	senderName({ namespace, username: USERNAME, codingAgent: CODING_AGENT, sessionId: SESSION_ID });
const SENDER_A = senderFor(NS_A);
const SENDER_B = senderFor(NS_B);
const STREAM_A = channelStreamKey(NS_A, SENDER_A);
const STREAM_B = channelStreamKey(NS_B, SENDER_B);

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

const directories: string[] = [];

interface ServerSpec {
	url: string;
	namespace?: string;
	subscribe?: string[];
}

function configDirectory(servers: Record<string, ServerSpec>, subscribe: string[] = []): string {
	const directory = mkdtempSync(join(tmpdir(), "ace-cc-runtime-"));
	directories.push(directory);
	// A subscription belongs to the server that carries it: put these names on the first server.
	const entries = Object.entries(servers).map(([name, server], index) => [
		name,
		index === 0 && subscribe.length > 0 ? { ...server, subscribe } : server,
	]);
	writeFileSync(
		join(directory, ".ace.json"),
		JSON.stringify({ username: USERNAME, servers: Object.fromEntries(entries), defaultActivation: "next_turn" }),
	);
	return directory;
}

interface StoreRecording {
	calls: Array<readonly unknown[]>;
	factoryCalls: Array<{ url: string; namespace?: string }>;
}

/**
 * A recording stand-in for `AgentRegistryStore`, one per server URL: every method logs its
 * arguments, and `failStream` makes a registration fail like an unreachable broker.
 */
function recordingStores(
	options: { failStream?: (url: string) => boolean; entries?: Record<string, RegistryEntry[]> } = {},
): {
	recording: StoreRecording;
	factory: (options: { url: string; namespace?: string; onError: (error: unknown) => void }) => AgentRegistryStore;
} {
	const recording: StoreRecording = { calls: [], factoryCalls: [] };
	const factory = (storeOptions: {
		url: string;
		namespace?: string;
		onError: (error: unknown) => void;
	}): AgentRegistryStore => {
		const url = storeOptions.url;
		recording.factoryCalls.push({
			url,
			...(storeOptions.namespace === undefined ? {} : { namespace: storeOptions.namespace }),
		});
		return {
			ensureStream: async (stream, group) => {
				recording.calls.push(["ensureStream", url, stream, group]);
				if (options.failStream?.(url)) throw new Error(`connect ECONNREFUSED ${url}`);
			},
			put: async (channel, description, expiresAt) => {
				recording.calls.push(["put", url, channel, description, expiresAt]);
			},
			refresh: async (channel, expiresAt) => {
				recording.calls.push(["refresh", url, channel, expiresAt]);
			},
			remove: async (channel) => {
				recording.calls.push(["remove", url, channel]);
			},
			dropStream: async (stream) => {
				recording.calls.push(["dropStream", url, stream]);
			},
			list: async (now) => {
				recording.calls.push(["list", url, now]);
				return options.entries?.[url] ?? [];
			},
			close: async () => {
				recording.calls.push(["close", url]);
			},
		};
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

interface WriterRecording {
	adds: Array<{ stream: string; field: string; value: string }>;
	closed: boolean;
}

/** Records what each lazily-opened writer is asked to append, so publish stays broker-free. */
function recordingAddClients(): {
	writers: Map<string, WriterRecording>;
	factory: (url: string, onError: (error: unknown) => void) => RedisStreamsAddClient;
} {
	const writers = new Map<string, WriterRecording>();
	const factory = (url: string, _onError: (error: unknown) => void): RedisStreamsAddClient => {
		const writer: WriterRecording = { adds: [], closed: false };
		writers.set(url, writer);
		return {
			add: async (stream, field, value) => {
				writer.adds.push({ stream, field, value });
				return "1-1";
			},
			close: async () => {
				writer.closed = true;
			},
		};
	};
	return { writers, factory };
}

function entry(channel: string): RegistryEntry {
	return { channel, description: "", expiresAt: Date.now() + 60_000 };
}

afterEach(() => {
	vi.restoreAllMocks();
	while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true });
});

describe("startAce registration and inbox derivation", () => {
	it("registers the channel named by its sender and reads it back as the inbox", async () => {
		const cwd = configDirectory({ primary: { url: URL_A, namespace: NS_A } }, ["inbox"]);
		const { recording, factory } = recordingStores();
		const transports: TransportRecording = { subscriptions: [], order: [] };
		const writers = recordingAddClients();
		const handle = await startAce({
			cwd,
			push: async () => {},
			logger: quiet,
			sessionId: SESSION_ID,
			env: {},
			registryStoreFactory: factory,
			transportsFactory: fakeTransports(transports),
			addClientFactory: writers.factory,
		});
		if (!handle) throw new Error("startAce returned undefined");

		// The store came from the configured server and its namespace.
		expect(recording.factoryCalls).toEqual([{ url: URL_A, namespace: NS_A }]);
		// The stream existed before the entry advertised it; the entry names the sender channel, and
		// the group it is read in is the channel name itself.
		const order = recording.calls.map((call) => call[0]);
		expect(order.indexOf("ensureStream")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("ensureStream")).toBeLessThan(order.indexOf("put"));
		expect(recording.calls.find((call) => call[0] === "ensureStream")).toEqual([
			"ensureStream",
			URL_A,
			STREAM_A,
			SENDER_A,
		]);
		const put = recording.calls.find((call) => call[0] === "put");
		expect(put?.[2]).toBe(SENDER_A);

		// The derived subscriptions: the inbox (the channel named by the sender) plus the configured
		// channel, read on the same server with the same reading sender.
		const seen = transports.subscriptions[0] ?? [];
		expect(seen.map((endpoint) => endpoint.name)).toEqual([SESSION_INBOX, "lan:tester:inbox"]);
		const inbox = seen.find((endpoint) => endpoint.name === SESSION_INBOX);
		expect(inbox?.transport).toBe("redis-streams");
		expect(inbox?.config).toMatchObject({ stream: STREAM_A, group: SENDER_A, url: URL_A });
		expect(handle.tools.inbox?.name).toBe(SESSION_INBOX);
		expect(handle.tools.publish?.senders).toEqual([SENDER_A]);

		await handle.stop();
	});

	it("keeps one registration, inbox and sender per server", async () => {
		const cwd = configDirectory({
			primary: { url: URL_A, namespace: NS_A },
			secondary: { url: URL_B, namespace: NS_B },
		});
		const { recording, factory } = recordingStores();
		const transports: TransportRecording = { subscriptions: [], order: [] };
		const writers = recordingAddClients();
		const handle = await startAce({
			cwd,
			push: async () => {},
			logger: quiet,
			sessionId: SESSION_ID,
			env: {},
			registryStoreFactory: factory,
			transportsFactory: fakeTransports(transports),
			addClientFactory: writers.factory,
		});
		if (!handle) throw new Error("startAce returned undefined");

		expect(recording.factoryCalls).toEqual([
			{ url: URL_A, namespace: NS_A },
			{ url: URL_B, namespace: NS_B },
		]);
		// Each inbox is derived from that server's namespace, and local labels stay unique across servers.
		const seen = transports.subscriptions[0] ?? [];
		expect(seen.map((endpoint) => endpoint.name)).toEqual(["primary:session-inbox", "secondary:session-inbox"]);
		expect(seen[0]?.config).toMatchObject({ stream: STREAM_A, group: SENDER_A, url: URL_A });
		expect(seen[1]?.config).toMatchObject({ stream: STREAM_B, group: SENDER_B, url: URL_B });
		expect(handle.tools.publish?.senders).toEqual([SENDER_A, SENDER_B]);

		await handle.stop();
	});

	it("reads a configured subscription with its server's namespace and the reading sender", async () => {
		const cwd = configDirectory({ primary: { url: URL_A, namespace: NS_A } }, ["ci-failures"]);
		const { factory } = recordingStores();
		const transports: TransportRecording = { subscriptions: [], order: [] };
		const writers = recordingAddClients();
		const handle = await startAce({
			cwd,
			push: async () => {},
			logger: quiet,
			sessionId: SESSION_ID,
			env: {},
			registryStoreFactory: factory,
			transportsFactory: fakeTransports(transports),
			addClientFactory: writers.factory,
		});
		if (!handle) throw new Error("startAce returned undefined");

		const channel = channelName(NS_A, USERNAME, "ci-failures");
		const seen = transports.subscriptions[0] ?? [];
		expect(seen.map((endpoint) => endpoint.name)).toEqual([SESSION_INBOX, channel]);
		expect(seen[1]?.config).toMatchObject({
			stream: channelStreamKey(NS_A, channel),
			group: SENDER_A,
			url: URL_A,
		});

		await handle.stop();
	});
});

describe("startAce when a server is unreachable", () => {
	it("skips that server and keeps the rest of the session running", async () => {
		const cwd = configDirectory({
			primary: { url: URL_A, namespace: NS_A },
			secondary: { url: URL_B, namespace: NS_B, subscribe: ["ci"] },
		});
		const warnings: string[] = [];
		const { recording, factory } = recordingStores({ failStream: (url) => url === URL_B });
		const transports: TransportRecording = { subscriptions: [], order: [] };
		const writers = recordingAddClients();
		const handle = await startAce({
			cwd,
			push: async () => {},
			logger: { ...quiet, warn: (message: string) => warnings.push(message) },
			sessionId: SESSION_ID,
			env: {},
			registryStoreFactory: factory,
			transportsFactory: fakeTransports(transports),
			addClientFactory: writers.factory,
		});
		if (!handle) throw new Error("startAce returned undefined");

		expect(warnings.join(" ")).toMatch(/ECONNREFUSED/);
		// The failed registry closed its client on the way out.
		expect(recording.calls).toContainEqual(["close", URL_B]);
		// Only the reachable server's inbox is read; the configured subscription on the failed server
		// is dropped with it.
		expect(transports.subscriptions[0]?.map((endpoint) => endpoint.name)).toEqual(["primary:session-inbox"]);
		expect(handle.tools.publish?.senders).toEqual([SENDER_A]);

		await handle.stop();
	});

	it("registers nothing and reads only configured channels without a session id", async () => {
		const cwd = configDirectory({ primary: { url: URL_A, namespace: NS_A } }, ["inbox"]);
		const warnings: string[] = [];
		const { recording, factory } = recordingStores();
		const transports: TransportRecording = { subscriptions: [], order: [] };
		const writers = recordingAddClients();
		const handle = await startAce({
			cwd,
			push: async () => {},
			logger: { ...quiet, warn: (message: string) => warnings.push(message) },
			env: {},
			registryStoreFactory: factory,
			transportsFactory: fakeTransports(transports),
			addClientFactory: writers.factory,
		});
		if (!handle) throw new Error("startAce returned undefined");

		expect(warnings.join(" ")).toMatch(/no session id/i);
		expect(recording.factoryCalls).toEqual([]);
		expect(transports.subscriptions[0]?.map((endpoint) => endpoint.name)).toEqual(["lan:tester:inbox"]);
		expect(handle.tools.publish?.senders).toEqual([]);

		await handle.stop();
	});
});

describe("startAce shutdown order", () => {
	it("stops the reader, then unregisters and closes the registry, then the writers", async () => {
		const order: string[] = [];
		const originalUnregister = AgentRegistry.prototype.unregister;
		const originalClose = AgentRegistry.prototype.close;
		vi.spyOn(AgentRegistry.prototype, "unregister").mockImplementation(async function (this: AgentRegistry) {
			order.push("unregister");
			return originalUnregister.call(this);
		});
		vi.spyOn(AgentRegistry.prototype, "close").mockImplementation(async function (this: AgentRegistry) {
			order.push("close");
			return originalClose.call(this);
		});

		const cwd = configDirectory({ primary: { url: URL_A, namespace: NS_A } }, ["inbox"]);
		const { recording, factory } = recordingStores();
		const transports: TransportRecording = { subscriptions: [], order };
		const writers = recordingAddClients();
		const handle = await startAce({
			cwd,
			push: async () => {},
			logger: quiet,
			sessionId: SESSION_ID,
			env: {},
			registryStoreFactory: factory,
			transportsFactory: fakeTransports(transports),
			addClientFactory: writers.factory,
		});
		if (!handle) throw new Error("startAce returned undefined");
		// Open the lazy writer so shutdown has one to close.
		const surface = handle.tools.publish;
		if (!surface) throw new Error("no publish surface");
		const target = await surface.resolve("outbox");
		await surface.send(target, {
			aceVersion: "0.1",
			id: "evt_1",
			sender: target.sender,
			activation: "next_turn",
			body: "hi",
		});
		await handle.stop();

		// `unregister` drops this session's own stream, so every reader has to be gone first, and the
		// registry's client is released after that; the publish writers go last of all.
		const firstStop = order.findIndex((step) => step.startsWith("stop:"));
		expect(firstStop).toBeGreaterThanOrEqual(0);
		expect(firstStop).toBeLessThan(order.indexOf("unregister"));
		expect(order.indexOf("unregister")).toBeLessThan(order.indexOf("close"));
		expect(recording.calls).toContainEqual(["remove", URL_A, SENDER_A]);
		expect(recording.calls).toContainEqual(["dropStream", URL_A, STREAM_A]);
		expect(recording.calls[recording.calls.length - 1]).toEqual(["close", URL_A]);
		expect([...writers.writers.values()].every((writer) => writer.closed)).toBe(true);
	});
});

describe("publish surface", () => {
	it("completes a short channel name on a single server and writes to its derived stream", async () => {
		const cwd = configDirectory({ primary: { url: URL_A, namespace: NS_A } });
		const { factory } = recordingStores();
		const transports: TransportRecording = { subscriptions: [], order: [] };
		const writers = recordingAddClients();
		const handle = await startAce({
			cwd,
			push: async () => {},
			logger: quiet,
			sessionId: SESSION_ID,
			env: {},
			registryStoreFactory: factory,
			transportsFactory: fakeTransports(transports),
			addClientFactory: writers.factory,
		});
		if (!handle) throw new Error("startAce returned undefined");
		const surface = handle.tools.publish;
		if (!surface) throw new Error("no publish surface");

		// A short name is completed to `<ns>:<username>:<name>`; the sender is that server's channel.
		const target = await surface.resolve("outbox");
		expect(target.channel).toBe(channelName(NS_A, USERNAME, "outbox"));
		expect(target.sender).toBe(SENDER_A);
		expect(target.server).toEqual({ name: "primary", url: URL_A, namespace: NS_A });
		// An explicit `<server>:<channel>` prefix picks the server.
		expect((await surface.resolve("primary:thing")).channel).toBe(channelName(NS_A, USERNAME, "thing"));

		const message = {
			aceVersion: "0.1" as const,
			id: "evt_1",
			sender: target.sender,
			activation: "next_turn" as const,
			body: "hi",
		};
		await surface.send(target, message);
		const writer = writers.writers.get(URL_A);
		expect(writer?.adds).toHaveLength(1);
		expect(writer?.adds[0]?.stream).toBe(channelStreamKey(NS_A, target.channel));
		expect(writer?.adds[0]?.field).toBe("message");
		expect(JSON.parse(writer?.adds[0]?.value ?? "{}")).toMatchObject({ id: "evt_1", body: "hi" });

		await handle.stop();
		expect(writer?.closed).toBe(true);
	});

	it("resolves a full channel name by its namespace when no directory entry names it", async () => {
		const entries: Record<string, RegistryEntry[]> = { [URL_A]: [], [URL_B]: [] };
		const cwd = configDirectory({
			primary: { url: URL_A, namespace: NS_A },
			secondary: { url: URL_B, namespace: NS_B },
		});
		const { factory } = recordingStores({ entries });
		const transports: TransportRecording = { subscriptions: [], order: [] };
		const writers = recordingAddClients();
		const handle = await startAce({
			cwd,
			push: async () => {},
			logger: quiet,
			sessionId: SESSION_ID,
			env: {},
			registryStoreFactory: factory,
			transportsFactory: fakeTransports(transports),
			addClientFactory: writers.factory,
		});
		if (!handle) throw new Error("startAce returned undefined");
		const surface = handle.tools.publish;
		if (!surface) throw new Error("no publish surface");

		// Both directories are empty: only the namespace in the name itself can pick the server, so the
		// name is accepted as written rather than rejected for having no registered session under it.
		const full = channelName(NS_A, USERNAME, "eval-sink");
		await expect(surface.resolve(full)).resolves.toMatchObject({
			server: { name: "primary", url: URL_A, namespace: NS_A },
			channel: full,
			sender: SENDER_A,
		});
		// A full name whose namespace no live server owns is still the directory's to settle, and empty
		// directories settle it with a failure.
		await expect(surface.resolve("zzz:tester:nobody")).rejects.toThrow(/no live channel matches/);

		await handle.stop();
	});

	it("keeps short names and a shared namespace with the directories, ambiguity included", async () => {
		const entries: Record<string, RegistryEntry[]> = { [URL_A]: [], [URL_B]: [] };
		// Both servers own the same namespace, so a full name cannot pick one on its own: only the
		// directory can, which is exactly where that ambiguity is supposed to stay.
		const cwd = configDirectory({
			primary: { url: URL_A, namespace: NS_A },
			secondary: { url: URL_B, namespace: NS_A },
		});
		const { factory } = recordingStores({ entries });
		const transports: TransportRecording = { subscriptions: [], order: [] };
		const writers = recordingAddClients();
		const handle = await startAce({
			cwd,
			push: async () => {},
			logger: quiet,
			sessionId: SESSION_ID,
			env: {},
			registryStoreFactory: factory,
			transportsFactory: fakeTransports(transports),
			addClientFactory: writers.factory,
		});
		if (!handle) throw new Error("startAce returned undefined");
		const surface = handle.tools.publish;
		if (!surface) throw new Error("no publish surface");

		// A short (two-segment) name carries no namespace: it is looked up in the live directories.
		await expect(surface.resolve("lan:tester")).rejects.toThrow(/no live channel matches/);
		entries[URL_A] = [entry(channelName(NS_A, USERNAME, "peer"))];
		await expect(surface.resolve("lan:tester")).resolves.toMatchObject({ server: { name: "primary" } });
		// The full name is shared-namespace ambiguous too, and the directory settles it the same way.
		await expect(surface.resolve(channelName(NS_A, USERNAME, "peer"))).resolves.toMatchObject({
			server: { name: "primary" },
		});
		// The same prefix live on two servers is ambiguous: guessing would address the wrong agent.
		entries[URL_B] = [entry(channelName(NS_A, USERNAME, "other"))];
		await expect(surface.resolve("lan:tester")).rejects.toThrow(/matches 2 live channels/);

		await handle.stop();
	});

	it("names the live channels it found in a not-found failure, never a placeholder", async () => {
		const entries: Record<string, RegistryEntry[]> = {
			[URL_A]: [entry(channelName(NS_A, USERNAME, "peer"))],
			[URL_B]: [],
		};
		const cwd = configDirectory({
			primary: { url: URL_A, namespace: NS_A },
			secondary: { url: URL_B, namespace: NS_B },
		});
		const { factory } = recordingStores({ entries });
		const transports: TransportRecording = { subscriptions: [], order: [] };
		const writers = recordingAddClients();
		const handle = await startAce({
			cwd,
			push: async () => {},
			logger: quiet,
			sessionId: SESSION_ID,
			env: {},
			registryStoreFactory: factory,
			transportsFactory: fakeTransports(transports),
			addClientFactory: writers.factory,
		});
		if (!handle) throw new Error("startAce returned undefined");
		const surface = handle.tools.publish;
		if (!surface) throw new Error("no publish surface");

		// The failure names the channel the directory actually listed — server-prefixed, the form
		// ace_publish accepts — and says the other server has none, instead of a `<channel>` placeholder.
		await expect(surface.resolve("definitely-not-a-channel")).rejects.toThrow(
			`no live channel matches "definitely-not-a-channel" (live session channels: primary:${channelName(NS_A, USERNAME, "peer")} — a channel is a valid target with no registered reader, so a service channel never appears here; no live channel on secondary)`,
		);

		// With no live entries on any server, the live list is gone and the message names the servers instead.
		entries[URL_A] = [];
		await expect(surface.resolve("definitely-not-a-channel")).rejects.toThrow(
			'no live channel matches "definitely-not-a-channel" (no live channel on primary, secondary)',
		);

		await handle.stop();
	});
});

it("names the derived inbox session-inbox", () => {
	expect(SESSION_INBOX).toBe("session-inbox");
});
