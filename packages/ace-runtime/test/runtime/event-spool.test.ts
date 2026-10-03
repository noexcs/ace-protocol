import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AceMessage } from "../../src/protocol/ace-message.ts";
import { EventSpool } from "../../src/runtime/event-spool.ts";

const directories: string[] = [];

function temporaryDirectory(): string {
	const dir = mkdtempSync(join(tmpdir(), "ace-spool-"));
	directories.push(dir);
	return dir;
}

afterEach(() => {
	while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true });
});

function message(id: string, body = `body ${id}`): AceMessage {
	return { aceVersion: "0.1", id, sender: "ci", activation: "next_turn", body };
}

/** Deterministic clock and timer, so a window closes exactly when the test says so. */
function fakeTime() {
	let now = 1_000;
	const scheduled: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
	return {
		now: () => now,
		setTimer: (callback: () => void, ms: number) => {
			const entry = { at: now + ms, callback, cancelled: false };
			scheduled.push(entry);
			return {
				cancel: () => {
					entry.cancelled = true;
				},
			};
		},
		async advance(ms: number) {
			now += ms;
			for (const entry of scheduled.splice(0)) {
				if (!entry.cancelled && entry.at <= now) entry.callback();
			}
			// Let the flush's async work settle.
			for (let i = 0; i < 20; i += 1) await Promise.resolve();
		},
	};
}

function setup(options: { afterEvents?: number; windowMs?: number; dir?: string; maxFiles?: number }) {
	const dir = options.dir ?? temporaryDirectory();
	const time = fakeTime();
	const batches: Array<{ subscription: string; path: string; events: readonly AceMessage[] }> = [];
	const errors: unknown[] = [];
	const spool = new EventSpool({
		dir,
		rules: () => ({ afterEvents: options.afterEvents ?? 2, windowMs: options.windowMs ?? 1_000 }),
		onBatch: (batch) => {
			batches.push(batch);
		},
		onError: (error) => errors.push(error),
		...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
		now: time.now,
		setTimer: time.setTimer,
	});
	return { spool, time, batches, errors, dir };
}

describe("EventSpool", () => {
	it("passes the first events of a window straight through", async () => {
		const { spool, time } = setup({ afterEvents: 2, windowMs: 1_000 });

		expect(await spool.offer("inbox", message("e1"))).toEqual({ spooled: false });
		expect(await spool.offer("inbox", message("e2"))).toEqual({ spooled: false });
		expect(spool.openWindows()).toEqual([]);
		await time.advance(2_000);
	});

	it("spills the overflow to a file and resolves only after the window closes", async () => {
		const { spool, time, batches } = setup({ afterEvents: 1, windowMs: 500 });

		expect(await spool.offer("inbox", message("e1"))).toEqual({ spooled: false });
		let settled = false;
		const pending = spool.offer("inbox", message("e2")).then((outcome) => {
			settled = true;
			return outcome;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(spool.openWindows()).toEqual([expect.objectContaining({ subscription: "inbox", buffered: 1 })]);

		await time.advance(500);
		expect(await pending).toEqual({ spooled: true, path: expect.stringContaining("inbox") });
		expect(batches).toHaveLength(1);
		expect(batches[0]?.events.map((entry) => entry.id)).toEqual(["e2"]);
	});

	it("writes every spooled event as one JSON line before resolving", async () => {
		const { spool, time } = setup({ afterEvents: 1, windowMs: 100 });

		await spool.offer("inbox", message("e1"));
		const pending = spool.offer("inbox", message("e2"));
		await time.advance(100);
		const outcome = await pending;

		const lines = readFileSync(outcome.path as string, "utf8")
			.trim()
			.split("\n");
		expect(lines.map((line) => JSON.parse(line).id)).toEqual(["e2"]);
	});

	it("never spools a subscription without a rule", async () => {
		const time = fakeTime();
		const spool = new EventSpool({
			dir: temporaryDirectory(),
			rules: () => undefined,
			onBatch: () => {},
			now: time.now,
			setTimer: time.setTimer,
		});

		expect(await spool.offer("quiet", message("e1"))).toEqual({ spooled: false });
	});

	it("rejects the waiters when the batch cannot be summarised", async () => {
		const time = fakeTime();
		const errors: unknown[] = [];
		const spool = new EventSpool({
			dir: temporaryDirectory(),
			rules: () => ({ afterEvents: 1, windowMs: 50 }),
			onBatch: () => {
				throw new Error("summary failed");
			},
			onError: (error) => errors.push(error),
			now: time.now,
			setTimer: time.setTimer,
		});

		await spool.offer("inbox", message("e1"));
		const pending = spool.offer("inbox", message("e2"));
		await time.advance(50);

		await expect(pending).rejects.toThrow("summary failed");
		expect(errors).toHaveLength(1);
	});

	it("persists and reloads manual events", async () => {
		const { spool } = setup({});

		spool.appendManual("inbox", message("m1"));
		spool.appendManual("inbox", message("m2"));

		expect(spool.loadManual("inbox").map((entry) => entry.id)).toEqual(["m1", "m2"]);
		expect(spool.loadManual("other")).toEqual([]);
	});

	// Count-based pruning: the age rule compares file mtimes, which a fake clock cannot move.
	it("keeps only the newest spool files for one subscription", async () => {
		const { spool, time, dir } = setup({ afterEvents: 1, windowMs: 10, maxFiles: 1 });

		await spool.offer("inbox", message("e1"));
		const first = spool.offer("inbox", message("e2"));
		await time.advance(10);
		await first;
		await time.advance(100_000);

		await spool.offer("inbox", message("e3"));
		const second = spool.offer("inbox", message("e4"));
		await time.advance(10);
		await second;

		expect(readdirSync(dir).filter((entry) => entry.startsWith("inbox."))).toHaveLength(1);
	});
});
