import { describe, expect, it } from "vitest";
import { SeenMessageIds } from "../../src/runtime/seen-message-ids.ts";

describe("SeenMessageIds", () => {
	it("knows nothing until an identity is remembered", () => {
		const seen = new SeenMessageIds(10);

		expect(seen.has("agent-a", "evt_1")).toBe(false);
		seen.remember("agent-a", "evt_1");
		expect(seen.has("agent-a", "evt_1")).toBe(true);
	});

	it("treats the same id from different senders as different messages (RFC §5.2)", () => {
		const seen = new SeenMessageIds(10);

		seen.remember("agent-a", "evt_1");

		expect(seen.has("agent-b", "evt_1")).toBe(false);
	});

	it("evicts the oldest identity once the window is full", () => {
		const seen = new SeenMessageIds(2);

		seen.remember("a", "1");
		seen.remember("a", "2");
		seen.remember("a", "3");

		expect(seen.size).toBe(2);
		expect(seen.has("a", "1")).toBe(false);
		expect(seen.has("a", "3")).toBe(true);
	});

	it("rejects a nonsensical capacity", () => {
		expect(() => new SeenMessageIds(0)).toThrow(/positive integer/);
	});
});
