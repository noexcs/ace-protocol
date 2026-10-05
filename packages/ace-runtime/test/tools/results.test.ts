import { describe, expect, it } from "vitest";
import { hasKnownReader } from "../../src/runtime/agent-registry.ts";
import { deliveredChannel } from "../../src/tools/results.ts";

describe("deliveredChannel", () => {
	it("names the channel, and says when nothing is known to read it", () => {
		expect(deliveredChannel("ace:ana:peer")).toBe('channel "ace:ana:peer"');
		expect(deliveredChannel("ace:ana:peer", true)).toBe('channel "ace:ana:peer" (no known reader)');
	});
});

describe("hasKnownReader", () => {
	const live = [{ channel: "ace:ana:peer", description: "agent=ci", expiresAt: 0 }];

	it("counts a live directory entry and a channel this session itself reads", () => {
		expect(hasKnownReader({ channel: "ace:ana:peer", live, subscriptions: [] })).toBe(true);
		expect(hasKnownReader({ channel: "ace:ana:inbox", live: [], subscriptions: ["ace:ana:inbox"] })).toBe(true);
	});

	it("reports nothing known for a name neither the directory nor this session holds", () => {
		expect(hasKnownReader({ channel: "ace:ana:typo", live, subscriptions: ["ace:ana:inbox"] })).toBe(false);
	});
});
