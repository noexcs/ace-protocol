import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `redis` package is mocked here on purpose: the interesting state — a client whose bounded
 * reconnect budget is spent — cannot be produced on demand with a real socket. Everything below the
 * mock is the real adapter.
 */
const hoisted = vi.hoisted(() => ({ created: [] as Array<Record<string, unknown>> }));

vi.mock("redis", () => ({
	createClient: () => {
		const handlers = new Map<string, Array<(error: unknown) => void>>();
		const onceHandlers = new Map<string, Array<() => void>>();
		const client = {
			isOpen: false,
			isReady: false,
			destroyed: false,
			destroyCalls: 0,
			/** Stand in for the connection a dead socket had already scheduled completing later. */
			revive() {
				client.isOpen = true;
				client.isReady = true;
				for (const handler of onceHandlers.get("ready") ?? []) handler();
			},
			once(event: string, handler: () => void) {
				const list = onceHandlers.get(event) ?? [];
				list.push(handler);
				onceHandlers.set(event, list);
				return client;
			},
			on(event: string, handler: (error: unknown) => void) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
				return client;
			},
			async connect() {
				client.isOpen = true;
				client.isReady = true;
			},
			destroy() {
				client.isOpen = false;
				client.isReady = false;
				client.destroyed = true;
				client.destroyCalls += 1;
			},
			async quit() {
				client.isOpen = false;
				client.isReady = false;
			},
			async xGroupCreate() {},
			async xReadGroup() {
				return [];
			},
			async xAutoClaim() {
				return { messages: [] };
			},
			async xAck() {},
		};
		hoisted.created.push(client as unknown as Record<string, unknown>);
		return client;
	},
}));

const { createRedisStreamsClient } = await import("../../src/transport/redis-streams-node-client.ts");

type Fake = { isOpen: boolean; isReady: boolean; destroyed: boolean; xReadGroup: () => Promise<unknown> };

describe("RedisStreamsClient recovery from a spent reconnect budget (audit B')", () => {
	beforeEach(() => {
		hoisted.created.length = 0;
	});

	it("replaces an unusable client instead of commanding a corpse", async () => {
		const client = createRedisStreamsClient("redis://127.0.0.1:1", "message", () => {});
		await client.connect();
		expect(hoisted.created).toHaveLength(1);
		const first = hoisted.created[0] as unknown as Fake;

		// What node-redis leaves behind once `reconnectStrategy` gives up: closed, not ready.
		first.isOpen = false;
		first.isReady = false;

		await expect(client.read("s", "g", "c", 1, 10)).resolves.toEqual([]);
		expect(hoisted.created).toHaveLength(2);
		expect(first.destroyed).toBe(true);
	});

	it("retires the replaced client again when its in-flight connection completes", async () => {
		const client = createRedisStreamsClient("redis://127.0.0.1:1", "message", () => {});
		await client.connect();
		const first = hoisted.created[0] as unknown as Fake & { destroyCalls: number; revive: () => void };

		first.isOpen = false;
		first.isReady = false;
		await client.read("s", "g", "c", 1, 10); // replaces it once
		expect(first.destroyCalls).toBe(1);

		// The socket the client had already scheduled finishes connecting: node-redis assigns it to
		// the retired client, which would now sit there open with nobody referencing it.
		first.revive();
		expect(first.destroyCalls).toBe(2);
	});

	it("treats a read that never answers as a dead connection", async () => {
		const client = createRedisStreamsClient("redis://127.0.0.1:1", "message", () => {}, {}, { watchdogSlackMs: 5 });
		await client.connect();
		const first = hoisted.created[0] as unknown as Fake;
		first.xReadGroup = () => new Promise(() => {});

		// The socket completes the handshake and then answers nothing: without a watchdog the read (and the
		// loop behind it) waits forever while the session looks healthy.
		await expect(client.read("s", "g", "c", 1, 1)).rejects.toThrow(/did not return within/);

		expect(hoisted.created).toHaveLength(2);
		expect(first.destroyed).toBe(true);
	});

	it("retries a command once on a fresh client when the socket dies mid-command", async () => {
		const client = createRedisStreamsClient("redis://127.0.0.1:1", "message", () => {});
		await client.connect();
		const first = hoisted.created[0] as unknown as Fake;
		first.xReadGroup = async () => {
			first.isOpen = false;
			first.isReady = false;
			throw new Error("Socket closed unexpectedly");
		};

		await expect(client.read("s", "g", "c", 1, 10)).resolves.toEqual([]);
		expect(hoisted.created).toHaveLength(2);
		expect(first.destroyed).toBe(true);
	});
});
