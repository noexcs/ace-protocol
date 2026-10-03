import { describe, expect, it } from "vitest";
import {
	AgentRegistry,
	type AgentRegistryStore,
	publishEndpointOf,
	REGISTRY_CHANNEL_NOTE,
	type RegistryChannel,
	type RegistryEntry,
	registryGroup,
	registryMember,
	registryStream,
	resolveTarget,
} from "../../src/runtime/agent-registry.ts";

/** In-memory stand-in for the Redis store; records what the registry asked for. */
class FakeStore implements AgentRegistryStore {
	readonly ensured: Array<{ stream: string; group: string }> = [];
	readonly entries = new Map<string, { channel: RegistryChannel; expiresAt: number }>();
	readonly dropped: string[] = [];
	closed = false;

	async ensureStream(stream: string, group: string): Promise<void> {
		this.ensured.push({ stream, group });
	}

	async put(member: string, channel: RegistryChannel, expiresAt: number): Promise<void> {
		this.entries.set(member, { channel, expiresAt });
	}

	async refresh(member: string, expiresAt: number): Promise<void> {
		const entry = this.entries.get(member);
		if (!entry) throw new Error(`unknown member ${member}`);
		entry.expiresAt = expiresAt;
	}

	async remove(member: string): Promise<void> {
		this.entries.delete(member);
	}

	async dropStream(stream: string): Promise<void> {
		this.dropped.push(stream);
	}

	async list(now: number): Promise<RegistryEntry[]> {
		return [...this.entries]
			.filter(([, entry]) => entry.expiresAt > now)
			.map(([member, entry]) => ({ member, channel: entry.channel, expiresAt: entry.expiresAt }));
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

/** Timer the heartbeat uses; tests fire ticks by hand. */
class ManualTimer {
	private callbacks: Array<() => void> = [];

	setTimer = (callback: () => void, _ms: number): { cancel: () => void } => {
		this.callbacks.push(callback);
		return {
			cancel: () => {
				this.callbacks = this.callbacks.filter((entry) => entry !== callback);
			},
		};
	};

	async fire(): Promise<void> {
		const callbacks = this.callbacks;
		this.callbacks = [];
		for (const callback of callbacks) callback();
		await Promise.resolve();
	}

	get armed(): number {
		return this.callbacks.length;
	}
}

function setup(options: { refreshMs?: number; onError?: (error: unknown) => void } = {}) {
	const store = new FakeStore();
	const timer = new ManualTimer();
	let now = 1_000;
	const registry = new AgentRegistry({
		store,
		ttlMs: 90_000,
		refreshMs: options.refreshMs ?? 30_000,
		now: () => now,
		setTimer: timer.setTimer,
		...(options.onError === undefined ? {} : { onError: options.onError }),
	});
	return {
		store,
		timer,
		registry,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

const sessionId = "01a102b6-9dac-75b6-80ca-21cbbf58e914";
const registration = {
	codingAgent: "oh-my-pi",
	sessionId,
	cwd: "/Users/noexcs/Projects/ace-protocol",
	url: "redis://127.0.0.1:6379",
};

describe("registry key layout", () => {
	it("names the member, the session stream and its group after the coding agent and the session", () => {
		expect(registryMember("oh-my-pi", sessionId)).toBe(`oh-my-pi:${sessionId}`);
		expect(registryStream("ace:agents", `oh-my-pi:${sessionId}`)).toBe(`ace:agents:events:oh-my-pi:${sessionId}`);
		expect(registryGroup(`oh-my-pi:${sessionId}`)).toBe(`ace:oh-my-pi:${sessionId}`);
	});
});

describe("AgentRegistry", () => {
	it("creates the session's own stream before publishing the entry", async () => {
		const { store, registry } = setup();

		const registered = await registry.register(registration);

		expect(store.ensured).toEqual([
			{ stream: `ace:agents:events:oh-my-pi:${sessionId}`, group: `ace:oh-my-pi:${sessionId}` },
		]);
		expect(registered.member).toBe(`oh-my-pi:${sessionId}`);
		expect(registered.stream).toBe(`ace:agents:events:oh-my-pi:${sessionId}`);
	});

	it("stores the channel entry peers read back, with the location in its description", async () => {
		const { store, registry } = setup();

		await registry.register(registration);

		const stored = store.entries.get(`oh-my-pi:${sessionId}`);
		expect(stored?.expiresAt).toBe(1_000 + 90_000);
		expect(stored?.channel).toEqual({
			name: `oh-my-pi:${sessionId}`,
			transport: "redis-streams",
			description: expect.stringContaining(
				`${REGISTRY_CHANNEL_NOTE} | agent=oh-my-pi | session=${sessionId.slice(-6)} | cwd=/Users/noexcs/Projects/ace-protocol | host=`,
			),
			config: {
				stream: `ace:agents:events:oh-my-pi:${sessionId}`,
				group: `ace:oh-my-pi:${sessionId}`,
				url: "redis://127.0.0.1:6379",
			},
		});
		expect(stored?.channel.description).toContain("platform=");
		expect(stored?.channel.description).toContain(`pid=${process.pid}`);
	});

	it("extends the expiry on every heartbeat", async () => {
		const { store, timer, registry, advance } = setup();
		await registry.register(registration);

		advance(30_000);
		await timer.fire();

		expect(store.entries.get(`oh-my-pi:${sessionId}`)?.expiresAt).toBe(31_000 + 90_000);
	});

	it("reports a heartbeat that cannot extend the entry", async () => {
		const errors: unknown[] = [];
		const { store, timer, registry } = setup({ refreshMs: 1, onError: (error) => errors.push(error) });
		await registry.register(registration);
		store.entries.clear();

		await timer.fire();

		expect(errors).toHaveLength(1);
	});

	it("removes the entry and the session's stream on a clean shutdown", async () => {
		const { store, timer, registry } = setup();
		await registry.register(registration);

		await registry.unregister();

		expect(store.entries.size).toBe(0);
		expect(store.dropped).toEqual([`ace:agents:events:oh-my-pi:${sessionId}`]);
		expect(timer.armed).toBe(0);
	});

	it("stops being discoverable once the registration expires", async () => {
		const { registry, advance } = setup();
		await registry.register(registration);
		expect(await registry.list()).toHaveLength(1);

		advance(90_001);

		expect(await registry.list()).toEqual([]);
	});

	it("closes the store on shutdown", async () => {
		const { store, registry } = setup();
		await registry.register(registration);

		await registry.close();

		expect(store.closed).toBe(true);
	});
});

describe("resolveTarget", () => {
	const entries: RegistryEntry[] = [
		{
			member: `oh-my-pi:${sessionId}`,
			channel: {
				name: `oh-my-pi:${sessionId}`,
				transport: "redis-streams",
				description: "…",
				config: { stream: "s1", group: "g1", url: "redis://x" },
			},
			expiresAt: 5,
		},
		{
			member: "pi:01a102b8-f016-75ab-87eb-63551c257fda",
			channel: {
				name: "pi:…",
				transport: "redis-streams",
				description: "…",
				config: { stream: "s2", group: "g2", url: "redis://x" },
			},
			expiresAt: 9,
		},
		{
			member: "pi:01a102b9-f016-75ab-87eb-63551c257fdb",
			channel: {
				name: "pi:…",
				transport: "redis-streams",
				description: "…",
				config: { stream: "s3", group: "g3", url: "redis://x" },
			},
			expiresAt: 7,
		},
	];

	it("matches an exact member", () => {
		expect(resolveTarget(entries, `oh-my-pi:${sessionId}`)).toMatchObject({
			ok: true,
			entry: { member: `oh-my-pi:${sessionId}` },
		});
	});

	it("matches a prefix that selects exactly one session", () => {
		expect(resolveTarget(entries, "oh-my-pi")).toMatchObject({
			ok: true,
			entry: { member: `oh-my-pi:${sessionId}` },
		});
	});

	it("refuses to guess between several sessions and names them", () => {
		const resolution = resolveTarget(entries, "pi");
		expect(resolution.ok).toBe(false);
		expect(resolution).toMatchObject({
			reason: "ambiguous",
			candidates: ["pi:01a102b8-f016-75ab-87eb-63551c257fda", "pi:01a102b9-f016-75ab-87eb-63551c257fdb"],
		});
	});

	it("reports what is live when nothing matches", () => {
		expect(resolveTarget(entries, "codex")).toEqual({
			ok: false,
			reason: "not-found",
			candidates: [
				"oh-my-pi:01a102b6-9dac-75b6-80ca-21cbbf58e914",
				"pi:01a102b8-f016-75ab-87eb-63551c257fda",
				"pi:01a102b9-f016-75ab-87eb-63551c257fdb",
			],
		});
	});

	it("does not treat a partial session id as a prefix of another agent", () => {
		expect(resolveTarget(entries, "oh-my-pi:01a102b6").ok).toBe(true);
		expect(resolveTarget(entries, "oh-my-pi:zzz")).toMatchObject({ ok: false, reason: "not-found" });
	});
});

describe("publishEndpointOf", () => {
	const entry: RegistryEntry = {
		member: "pi:01a102b8-f016-75ab-87eb-63551c257fda",
		expiresAt: 5,
		channel: {
			name: "pi:01a102b8-f016-75ab-87eb-63551c257fda",
			transport: "redis-streams",
			description: "…",
			config: { stream: "ace:elsewhere:events", group: "ace:pi:…", url: "redis://other-broker:6379" },
		},
	};

	it("publishes where the entry says, not where this runtime happens to talk", () => {
		expect(publishEndpointOf(entry)).toEqual({
			transport: "redis-streams",
			url: "redis://other-broker:6379",
			stream: "ace:elsewhere:events",
			field: "message",
		});
	});

	it("honours a field the entry carries", () => {
		const withField: RegistryEntry = {
			...entry,
			channel: { ...entry.channel, config: { ...entry.channel.config, field: "ace" } },
		};

		expect(publishEndpointOf(withField).field).toBe("ace");
	});

	it("keeps the transport as advertised, so a caller can refuse one it cannot speak", () => {
		const kafkaEntry: RegistryEntry = { ...entry, channel: { ...entry.channel, transport: "kafka" } };

		expect(publishEndpointOf(kafkaEntry).transport).toBe("kafka");
	});
});
