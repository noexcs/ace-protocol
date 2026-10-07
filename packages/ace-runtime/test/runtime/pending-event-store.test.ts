import { describe, expect, it } from "vitest";
import type { AceMessage } from "../../src/protocol/ace-message.ts";
import { PendingEventStore } from "../../src/runtime/pending-event-store.ts";

function message(id: string): AceMessage {
	return { aceVersion: "0.1", id, sender: "ci", activation: "manual", body: `body ${id}` };
}

describe("PendingEventStore", () => {
	it("keeps events until they are taken by (sender, id)", () => {
		const store = new PendingEventStore();

		store.store(message("e1"), "inbox");
		store.store(message("e2"), "inbox");

		expect(store.list().map((event) => event.message.id)).toEqual(["e1", "e2"]);
		expect(store.take("ci", "e1")?.message.id).toBe("e1");
		expect(store.take("ci", "missing")).toBeUndefined();
		expect(store.list().map((event) => event.message.id)).toEqual(["e2"]);
	});

	it("evicts the oldest event once the cap is reached", () => {
		const evicted: string[] = [];
		const store = new PendingEventStore({
			max: 2,
			onEvict: (event, reason) => evicted.push(`${event.message.id}:${reason}`),
		});

		store.store(message("e1"), "inbox");
		store.store(message("e2"), "inbox");
		store.store(message("e3"), "inbox");

		expect(store.list().map((event) => event.message.id)).toEqual(["e2", "e3"]);
		expect(evicted).toEqual(["e1:capacity"]);
	});

	it("drops events that outlived the retention window", () => {
		let now = 1_000;
		const evicted: string[] = [];
		const store = new PendingEventStore({
			ttlMs: 100,
			now: () => now,
			onEvict: (event, reason) => evicted.push(`${event.message.id}:${reason}`),
		});

		store.store(message("e1"), "inbox");
		now += 101;

		expect(store.list()).toEqual([]);
		expect(evicted).toEqual(["e1:expired"]);
	});

	it("persists every stored event", () => {
		const persisted: string[] = [];
		const store = new PendingEventStore({ persist: (event) => persisted.push(event.message.id) });

		store.store(message("e1"), "inbox");

		expect(persisted).toEqual(["e1"]);
	});

	it("restores events from an earlier session under the current caps", () => {
		const store = new PendingEventStore({ max: 2 });

		expect(
			store.restore("inbox", [
				{ message: message("e1"), storedAt: Date.now() },
				{ message: message("e2"), storedAt: Date.now() },
				{ message: message("e3"), storedAt: Date.now() },
			]),
		).toBe(3);

		expect(store.list().map((event) => event.message.id)).toEqual(["e2", "e3"]);
	});
});

describe("restoring retained events (finding D)", () => {
	it("keeps the record's own clock and drops one that is already past the TTL", () => {
		let now = 1_000_000;
		const store = new PendingEventStore({ ttlMs: 1_000, now: () => now });
		const fresh = now - 500;
		const stale = now - 5_000;

		expect(
			store.restore("inbox", [
				{ message: message("old"), storedAt: stale },
				{ message: message("new"), storedAt: fresh },
			]),
		).toBe(1);

		// A record that lapsed while nobody was running is not revived by the restart: it keeps its own
		// clock, so it expires on the original schedule rather than getting a fresh window.
		expect(store.list().map((event) => event.message.id)).toEqual(["new"]);
		now += 600;
		expect(store.list()).toEqual([]);
	});
});

describe("PendingEventStore capacity bounds (audit C3)", () => {
	it("treats a negative capacity as zero instead of looping forever", () => {
		// `evictOverCapacity` loops while `size > max`; a negative bound never satisfies that, so this
		// call used to spin the event loop until the process was killed.
		const store = new PendingEventStore({ max: -1 });
		store.store(message("evt_1"), "inbox");

		expect(store.size).toBe(0);
	});
});
