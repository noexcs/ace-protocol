import { describe, expect, it } from "vitest";
import {
	AgentRegistry,
	type AgentRegistryStore,
	REGISTRY_CHANNEL_NOTE,
	type RegistryEntry,
	resolveTarget,
} from "../../src/runtime/agent-registry.ts";
import { channelStreamKey, NAMESPACE_DEFAULT } from "../../src/runtime/naming.ts";

/** In-memory stand-in for the Redis store; records what the registry asked for. */
class FakeStore implements AgentRegistryStore {
	readonly ensured: Array<{ stream: string; group: string }> = [];
	readonly entries = new Map<string, { description: string; expiresAt: number }>();
	readonly dropped: string[] = [];
	closed = false;

	async ensureStream(stream: string, group: string): Promise<void> {
		this.ensured.push({ stream, group });
	}

	async put(channel: string, description: string, expiresAt: number): Promise<void> {
		this.entries.set(channel, { description, expiresAt });
	}

	async refresh(channel: string, expiresAt: number): Promise<void> {
		const entry = this.entries.get(channel);
		if (!entry) throw new Error(`unknown channel ${channel}`);
		entry.expiresAt = expiresAt;
	}

	async remove(channel: string): Promise<void> {
		this.entries.delete(channel);
	}

	async dropStream(stream: string): Promise<void> {
		this.dropped.push(stream);
	}

	async list(now: number): Promise<RegistryEntry[]> {
		return [...this.entries]
			.filter(([, entry]) => entry.expiresAt > now)
			.map(([channel, entry]) => ({ channel, description: entry.description, expiresAt: entry.expiresAt }));
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

function setup(options: { namespace?: string; refreshMs?: number; onError?: (error: unknown) => void } = {}) {
	const store = new FakeStore();
	const timer = new ManualTimer();
	let now = 1_000;
	const registry = new AgentRegistry({
		store,
		ttlMs: 90_000,
		refreshMs: options.refreshMs ?? 30_000,
		now: () => now,
		setTimer: timer.setTimer,
		...(options.namespace === undefined ? {} : { namespace: options.namespace }),
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
/** The sender name *is* the channel name; the host computes it (it owns `username` and the namespace). */
const sender = `${NAMESPACE_DEFAULT}:noexcs:oh-my-pi:${sessionId}`;
const stream = channelStreamKey(NAMESPACE_DEFAULT, sender);
const registration = {
	sender,
	codingAgent: "oh-my-pi",
	sessionId,
	cwd: "/Users/noexcs/Projects/ace-protocol",
};

describe("AgentRegistry", () => {
	it("creates the channel's stream before publishing the entry", async () => {
		const { store, registry } = setup();

		const registered = await registry.register(registration);

		expect(store.ensured).toEqual([{ stream, group: sender }]);
		expect(registered).toEqual({ channel: sender, stream, group: sender });
	});

	it("stores what the channel says about itself, and nothing the name already carries", async () => {
		const { store, registry } = setup();

		await registry.register(registration);

		const stored = store.entries.get(sender);
		expect(stored?.expiresAt).toBe(1_000 + 90_000);
		expect(stored?.description).toContain(
			`${REGISTRY_CHANNEL_NOTE} | agent=oh-my-pi | session=${sessionId.slice(-6)} | cwd=/Users/noexcs/Projects/ace-protocol | host=`,
		);
		expect(stored?.description).toContain("platform=");
		expect(stored?.description).toContain(`pid=${process.pid}`);
	});

	it("extends the expiry on every heartbeat", async () => {
		const { store, timer, registry, advance } = setup();
		await registry.register(registration);

		advance(30_000);
		await timer.fire();

		expect(store.entries.get(sender)?.expiresAt).toBe(31_000 + 90_000);
	});

	it("reports a heartbeat that cannot extend the entry", async () => {
		const errors: unknown[] = [];
		const { store, timer, registry } = setup({ refreshMs: 1, onError: (error) => errors.push(error) });
		await registry.register(registration);
		store.entries.clear();

		await timer.fire();

		expect(errors).toHaveLength(1);
	});

	it("removes the entry and the channel's stream on a clean shutdown", async () => {
		const { store, timer, registry } = setup();
		await registry.register(registration);

		await registry.unregister();

		expect(store.entries.size).toBe(0);
		expect(store.dropped).toEqual([stream]);
		expect(timer.armed).toBe(0);
	});

	it("stops being discoverable once the registration expires", async () => {
		const { registry, advance } = setup();
		await registry.register(registration);
		expect(await registry.list()).toHaveLength(1);

		advance(90_001);

		expect(await registry.list()).toEqual([]);
	});

	it("honours a namespace the server asked for", async () => {
		const { store, registry } = setup({ namespace: "lan" });

		await registry.register(registration);

		expect(store.ensured[0]?.stream).toBe(`lan:ch:${sender}`);
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
		{ channel: `ace:noexcs:oh-my-pi:${sessionId}`, description: "…", expiresAt: 5 },
		{ channel: "ace:noexcs:pi:01a102b8-f016-75ab-87eb-63551c257fda", description: "…", expiresAt: 9 },
		{ channel: "ace:noexcs:pi:01a102b9-f016-75ab-87eb-63551c257fdb", description: "…", expiresAt: 7 },
	];

	it("matches an exact channel", () => {
		expect(resolveTarget(entries, `ace:noexcs:oh-my-pi:${sessionId}`)).toMatchObject({
			ok: true,
			entry: { channel: `ace:noexcs:oh-my-pi:${sessionId}` },
		});
	});

	it("matches a prefix that selects exactly one channel", () => {
		expect(resolveTarget(entries, "ace:noexcs:oh-my-pi")).toMatchObject({
			ok: true,
			entry: { channel: `ace:noexcs:oh-my-pi:${sessionId}` },
		});
	});

	it("refuses to guess between several channels and names them", () => {
		const resolution = resolveTarget(entries, "ace:noexcs:pi");

		expect(resolution).toMatchObject({
			ok: false,
			reason: "ambiguous",
			candidates: [
				"ace:noexcs:pi:01a102b8-f016-75ab-87eb-63551c257fda",
				"ace:noexcs:pi:01a102b9-f016-75ab-87eb-63551c257fdb",
			],
		});
	});

	it("reports what is live when nothing matches", () => {
		expect(resolveTarget(entries, "ace:noexcs:codex")).toEqual({
			ok: false,
			reason: "not-found",
			candidates: [
				`ace:noexcs:oh-my-pi:${sessionId}`,
				"ace:noexcs:pi:01a102b8-f016-75ab-87eb-63551c257fda",
				"ace:noexcs:pi:01a102b9-f016-75ab-87eb-63551c257fdb",
			],
		});
	});

	it("does not treat a partial session id as a prefix of another agent", () => {
		expect(resolveTarget(entries, `ace:noexcs:oh-my-pi:01a102b6`).ok).toBe(true);
		expect(resolveTarget(entries, "ace:noexcs:oh-my-pi:zzz")).toMatchObject({ ok: false, reason: "not-found" });
	});
});
