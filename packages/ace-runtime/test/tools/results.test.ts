import { describe, expect, it } from "vitest";
import { hasKnownSubscriber } from "../../src/runtime/agent-registry.ts";
import { deliveredChannel, formatPublishResult } from "../../src/tools/results.ts";

describe("deliveredChannel", () => {
	it("names the channel, and says when no subscriber is known", () => {
		expect(deliveredChannel("ace:ana:peer")).toBe('channel "ace:ana:peer"');
		expect(deliveredChannel("ace:ana:peer", true)).toBe('channel "ace:ana:peer" (no known subscriber)');
	});
});

describe("formatPublishResult", () => {
	const base = { id: "evt_1", sender: "ace:ana:ci", activation: "next_turn", failures: [] };

	it("reports a delivery to a known subscriber without a warning", () => {
		expect(formatPublishResult({ ...base, delivered: [deliveredChannel("ace:ana:peer")] })).toBe(
			'Published id=evt_1 from ace:ana:ci to 1 target(s): channel "ace:ana:peer" (activation: next_turn).',
		);
	});

	it("spells out what a channel with no known subscriber means", () => {
		const text = formatPublishResult({
			...base,
			delivered: [deliveredChannel("ace:ana:typo", true)],
			unknownSubscribers: ["ace:ana:typo"],
		});

		expect(text).toContain('channel "ace:ana:typo" (no known subscriber)');
		expect(text).toContain(
			'No subscriber is known for "ace:ana:typo": the event is stored on the channel and will be read if one subscribes later.',
		);
	});
});

describe("hasKnownSubscriber", () => {
	const live = [{ channel: "ace:ana:peer", description: "agent=ci", expiresAt: 0 }];

	it("counts a live directory entry and a channel this session itself reads", () => {
		expect(hasKnownSubscriber({ channel: "ace:ana:peer", live, subscriptions: [] })).toBe(true);
		expect(hasKnownSubscriber({ channel: "ace:ana:inbox", live: [], subscriptions: ["ace:ana:inbox"] })).toBe(true);
	});

	it("reports no subscriber known for a name neither the directory nor this session holds", () => {
		expect(hasKnownSubscriber({ channel: "ace:ana:typo", live, subscriptions: ["ace:ana:inbox"] })).toBe(false);
	});
});
