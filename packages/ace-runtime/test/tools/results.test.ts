import { describe, expect, it } from "vitest";
import { hasKnownSubscriber } from "../../src/runtime/agent-registry.ts";
import { deliveredChannel, formatPublishResult, TOOL_ERROR_TEXT } from "../../src/tools/results.ts";

describe("targetNotFound", () => {
	it("names the live channels the directory actually listed, never a placeholder", () => {
		const message = TOOL_ERROR_TEXT.targetNotFound("definitely-not-a-channel", [
			{ server: "local", channels: ["ace:tester:peer"] },
			{ server: "second", channels: [] },
		]);

		expect(message).toBe(
			'no live channel matches "definitely-not-a-channel" (live session channels: local:ace:tester:peer — a channel is a valid target with no registered reader, so a service channel never appears here; no live channel on second)',
		);
		expect(message).not.toContain("<channel>");
	});

	it("says no server has a live channel instead of printing a placeholder list", () => {
		const message = TOOL_ERROR_TEXT.targetNotFound("definitely-not-a-channel", [
			{ server: "local", channels: [] },
			{ server: "second", channels: [] },
		]);

		expect(message).toBe('no live channel matches "definitely-not-a-channel" (no live channel on local, second)');
		expect(message).not.toContain("<channel>");
	});

	it("caps the named channels and counts the rest", () => {
		const channels = Array.from({ length: 7 }, (_, index) => `ace:tester:peer-${index}`);
		const message = TOOL_ERROR_TEXT.targetNotFound("typo", [{ server: "local", channels }]);

		expect(message).toContain("+2 more");
		expect(message).not.toContain("peer-5");
		expect(message).not.toContain("<channel>");
	});
});

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
