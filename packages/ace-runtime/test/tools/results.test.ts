import { describe, expect, it } from "vitest";
import { readerFactsOf } from "../../src/runtime/agent-registry.ts";
import {
	deliveredChannel,
	duplicateTarget,
	failedTarget,
	formatDiscoveredSessions,
	formatPublishResult,
	NO_LIVE_SESSIONS,
	TOOL_ERROR_TEXT,
} from "../../src/tools/results.ts";

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
	it("builds a stored row carrying both reader checks", () => {
		expect(deliveredChannel("ace:ana:peer", { peerNamed: true, selfReads: false })).toEqual({
			target: "ace:ana:peer",
			status: "stored",
			peerNamed: true,
			selfReads: false,
		});
		expect(deliveredChannel("ace:ana:inbox", { peerNamed: false, selfReads: true })).toEqual({
			target: "ace:ana:inbox",
			status: "stored",
			peerNamed: false,
			selfReads: true,
		});
		expect(deliveredChannel("ace:ana:typo", { peerNamed: false, selfReads: false })).toEqual({
			target: "ace:ana:typo",
			status: "stored",
			peerNamed: false,
			selfReads: false,
		});
	});

	it("names a stream-key target without refusing it", () => {
		expect(
			deliveredChannel("ace:ch:ace:noexcs:inbox", { peerNamed: false, selfReads: false }, { streamKey: true }),
		).toEqual({
			target: "ace:ch:ace:noexcs:inbox",
			status: "stored",
			peerNamed: false,
			selfReads: false,
			note: "stream-key",
		});
	});

	it("names a target the runtime completed from a short name", () => {
		expect(
			deliveredChannel(
				"ace:noexcs:noexcs:inbox",
				{ peerNamed: false, selfReads: false },
				{ completedShortName: true },
			),
		).toEqual({
			target: "ace:noexcs:noexcs:inbox",
			status: "stored",
			peerNamed: false,
			selfReads: false,
			note: "completed-short-name",
		});
	});

	it("joins both notes into one comma-separated field, completed-short-name first", () => {
		expect(
			deliveredChannel(
				"ace:ch:ace:noexcs:inbox",
				{ peerNamed: false, selfReads: false },
				{ streamKey: true, completedShortName: true },
			),
		).toEqual({
			target: "ace:ch:ace:noexcs:inbox",
			status: "stored",
			peerNamed: false,
			selfReads: false,
			note: "completed-short-name,stream-key",
		});
	});
});

describe("formatPublishResult", () => {
	const base = { id: "evt_1", sender: "ace:ana:ci", activation: "next_turn" };

	it("renders a header then a field row, with the counts", () => {
		expect(
			formatPublishResult({
				...base,
				rows: [deliveredChannel("ace:ana:peer", { peerNamed: true, selfReads: false })],
			}),
		).toBe(
			"ace 0.1 publish id=evt_1 sender=ace:ana:ci activation=next_turn targets=1 stored=1 failed=0 duplicates=0\n" +
				"target=ace:ana:peer status=stored peer_named=yes self_reads=no",
		);
	});

	it("carries each of the two reader checks in its row, never a verdict word", () => {
		const text = formatPublishResult({
			...base,
			rows: [
				deliveredChannel("ace:ana:peer", { peerNamed: true, selfReads: false }),
				deliveredChannel("ace:ana:inbox", { peerNamed: false, selfReads: true }),
				deliveredChannel("ace:ana:typo", { peerNamed: false, selfReads: false }),
			],
		});

		expect(text).toContain("target=ace:ana:peer status=stored peer_named=yes self_reads=no");
		expect(text).toContain("target=ace:ana:inbox status=stored peer_named=no self_reads=yes");
		expect(text).toContain("target=ace:ana:typo status=stored peer_named=no self_reads=no");
		expect(text).not.toContain("readers=");
	});

	it("names a stream-key target in the row without refusing it", () => {
		const text = formatPublishResult({
			...base,
			rows: [
				deliveredChannel("ace:ch:ace:noexcs:inbox", { peerNamed: false, selfReads: false }, { streamKey: true }),
			],
		});

		expect(text).toContain(
			"target=ace:ch:ace:noexcs:inbox status=stored peer_named=no self_reads=no note=stream-key",
		);
	});

	it("names a completed short name and both notes in one field", () => {
		const text = formatPublishResult({
			...base,
			rows: [
				deliveredChannel(
					"ace:noexcs:noexcs:inbox",
					{ peerNamed: false, selfReads: false },
					{
						completedShortName: true,
					},
				),
				deliveredChannel(
					"ace:ch:ace:noexcs:inbox",
					{ peerNamed: false, selfReads: false },
					{ streamKey: true, completedShortName: true },
				),
			],
		});

		expect(text).toContain(
			"target=ace:noexcs:noexcs:inbox status=stored peer_named=no self_reads=no note=completed-short-name",
		);
		expect(text).toContain(
			"target=ace:ch:ace:noexcs:inbox status=stored peer_named=no self_reads=no note=completed-short-name,stream-key",
		);
	});

	it("marks every stored row awaiting_activation=yes on a manual publish", () => {
		const text = formatPublishResult({
			id: "evt_1",
			sender: "ace:ana:ci",
			activation: "manual",
			rows: [
				deliveredChannel("ace:ana:peer", { peerNamed: true, selfReads: false }),
				deliveredChannel("ace:ch:ace:noexcs:inbox", { peerNamed: false, selfReads: false }, { streamKey: true }),
			],
		});

		expect(text.split("\n")[0]).toBe(
			"ace 0.1 publish id=evt_1 sender=ace:ana:ci activation=manual targets=2 stored=2 failed=0 duplicates=0",
		);
		expect(text).toContain("target=ace:ana:peer status=stored peer_named=yes self_reads=no awaiting_activation=yes");
		expect(text).toContain(
			"target=ace:ch:ace:noexcs:inbox status=stored peer_named=no self_reads=no awaiting_activation=yes note=stream-key",
		);
	});

	it("leaves awaiting_activation off a non-manual stored row", () => {
		const text = formatPublishResult({
			...base,
			activation: "immediate",
			rows: [deliveredChannel("ace:ana:peer", { peerNamed: true, selfReads: false })],
		});

		expect(text).not.toContain("awaiting_activation");
	});

	it("counts a mixed list and renders the failure as its own row", () => {
		const text = formatPublishResult({
			...base,
			rows: [
				deliveredChannel("ace:ana:peer", { peerNamed: true, selfReads: false }),
				failedTarget("typo", 'no live channel matches "typo"'),
			],
		});

		expect(text.split("\n")[0]).toBe(
			"ace 0.1 publish id=evt_1 sender=ace:ana:ci activation=next_turn targets=2 stored=1 failed=1 duplicates=0",
		);
		expect(text).toContain('target=typo status=failed error="no live channel matches \\"typo\\""');
	});

	it("reports a duplicate input as its own row and counts it", () => {
		const text = formatPublishResult({
			...base,
			rows: [
				deliveredChannel("ace:ana:peer", { peerNamed: true, selfReads: false }),
				duplicateTarget("local:peer", "ace:ana:peer"),
			],
		});

		expect(text.split("\n")[0]).toBe(
			"ace 0.1 publish id=evt_1 sender=ace:ana:ci activation=next_turn targets=2 stored=1 failed=0 duplicates=1",
		);
		expect(text).toContain("target=local:peer status=duplicate of=ace:ana:peer");
	});

	it("always emits duplicates=, so targets = stored + duplicates + failed in every result", () => {
		const noRows = formatPublishResult({ ...base, rows: [] });
		expect(noRows).toBe("ace 0.1 publish event=none activation=next_turn targets=0 stored=0 failed=0 duplicates=0");

		const one = formatPublishResult({
			...base,
			rows: [deliveredChannel("ace:ana:peer", { peerNamed: true, selfReads: false })],
		});
		expect(one.split("\n")[0]).toContain("targets=1 stored=1 failed=0 duplicates=0");
	});

	it("counts an exact repeat as an input: two rows, not one collapsed target", () => {
		const text = formatPublishResult({
			...base,
			rows: [
				deliveredChannel("ace:ana:peer", { peerNamed: true, selfReads: false }),
				duplicateTarget("ace:ana:peer", "ace:ana:peer"),
			],
		});

		expect(text.split("\n")[0]).toBe(
			"ace 0.1 publish id=evt_1 sender=ace:ana:ci activation=next_turn targets=2 stored=1 failed=0 duplicates=1",
		);
		expect(text.split("\n")[2]).toBe("target=ace:ana:peer status=duplicate of=ace:ana:peer");
	});
});

describe("all-failed publish result", () => {
	it("is the same field list, not a prose sentence", () => {
		const text = formatPublishResult({
			id: "evt_1",
			sender: "ace:ana:ci",
			activation: "next_turn",
			rows: [failedTarget("x", 'no live channel matches "x"'), failedTarget("y", 'server "ghost" did not come up')],
		});
		const lines = text.split("\n");

		expect(lines[0]).toBe("ace 0.1 publish event=none activation=next_turn targets=2 stored=0 failed=2 duplicates=0");
		expect(lines[1]).toBe('target=x status=failed error="no live channel matches \\"x\\""');
		expect(lines[2]).toBe('target=y status=failed error="server \\"ghost\\" did not come up"');
		expect(text).not.toContain("nothing published");
	});

	it("hands out no id and no sender, because no event was created", () => {
		const failed = formatPublishResult({
			id: "evt_1",
			sender: "ace:ana:ci",
			activation: "next_turn",
			rows: [failedTarget("x", "no live channel matches"), failedTarget("y", "no configured server owns it")],
		});
		const head = failed.split("\n")[0] ?? "";
		expect(head).toBe("ace 0.1 publish event=none activation=next_turn targets=2 stored=0 failed=2 duplicates=0");
		expect(head).not.toContain("id=");
		expect(head).not.toContain("sender=");
		expect(head).toContain("event=none");

		const partly = formatPublishResult({
			id: "evt_1",
			sender: "ace:ana:ci",
			activation: "next_turn",
			rows: [
				failedTarget("x", "no live channel matches"),
				deliveredChannel("ace:ana:peer", { peerNamed: true, selfReads: false }),
			],
		});
		expect(partly.split("\n")[0]).toBe(
			"ace 0.1 publish id=evt_1 sender=ace:ana:ci activation=next_turn targets=2 stored=1 failed=1 duplicates=0",
		);
	});
});

describe("formatDiscoveredSessions", () => {
	it("returns the machine header with count=0, the servers and the filter, then the sentence", () => {
		expect(formatDiscoveredSessions([], { filter: "pi", servers: ["local"] })).toBe(
			'ace 0.1 agents count=0 servers=local filter=pi\nNo live session matches the agent filter "pi".',
		);
	});

	it("lists the searched servers in the given (config) order, even with no rows", () => {
		expect(formatDiscoveredSessions([], { servers: ["local", "second"] })).toBe(
			`ace 0.1 agents count=0 servers=local,second\n${NO_LIVE_SESSIONS}`,
		);
		expect(formatDiscoveredSessions(["row"], { servers: ["local", "second"] })).toBe(
			"ace 0.1 agents count=1 servers=local,second\nrow",
		);
	});

	it("keeps the header on the no-sessions sentence when no filter was given", () => {
		expect(formatDiscoveredSessions([], { servers: ["local"] })).toBe(
			`ace 0.1 agents count=0 servers=local\n${NO_LIVE_SESSIONS}`,
		);
		expect(formatDiscoveredSessions([], { filter: "", servers: ["local"] })).toBe(
			`ace 0.1 agents count=0 servers=local\n${NO_LIVE_SESSIONS}`,
		);
	});

	it("treats a blank filter as no filter, so it never reads as an empty directory", () => {
		expect(formatDiscoveredSessions([], { filter: "   ", servers: ["local"] })).toBe(
			`ace 0.1 agents count=0 servers=local\n${NO_LIVE_SESSIONS}`,
		);
		expect(formatDiscoveredSessions(["row"], { filter: "", servers: ["local"] })).toBe(
			"ace 0.1 agents count=1 servers=local\nrow",
		);
		expect(formatDiscoveredSessions(["row"], { filter: "  ", servers: ["local"] })).toBe(
			"ace 0.1 agents count=1 servers=local\nrow",
		);
	});

	it("trims a given filter, so the header carries the effective value", () => {
		expect(formatDiscoveredSessions([], { filter: " pi ", servers: ["local"] })).toBe(
			'ace 0.1 agents count=0 servers=local filter=pi\nNo live session matches the agent filter "pi".',
		);
	});

	it("quotes a filter that would break the one-line header shape", () => {
		expect(formatDiscoveredSessions([], { filter: "oh my pi", servers: ["local"] })).toBe(
			'ace 0.1 agents count=0 servers=local filter="oh my pi"\nNo live session matches the agent filter "oh my pi".',
		);
	});

	it("returns the rows under a count header when there are matches", () => {
		expect(formatDiscoveredSessions(["row"], { filter: "pi", servers: ["local"] })).toBe(
			"ace 0.1 agents count=1 servers=local filter=pi\nrow",
		);
	});
});

describe("readerFactsOf", () => {
	const live = [{ channel: "ace:ana:peer", description: "agent=ci", expiresAt: 0 }];

	it("reports peerNamed when a live directory entry names the channel", () => {
		expect(readerFactsOf({ channel: "ace:ana:peer", live, subscriptions: [] })).toEqual({
			peerNamed: true,
			selfReads: false,
		});
	});

	it("reports selfReads, without claiming peerNamed, when only this session's own subscription reads it", () => {
		expect(readerFactsOf({ channel: "ace:ana:inbox", live, subscriptions: ["ace:ana:inbox"] })).toEqual({
			peerNamed: false,
			selfReads: true,
		});
	});

	it("keeps the two checks independent when both name the channel", () => {
		expect(readerFactsOf({ channel: "ace:ana:peer", live, subscriptions: ["ace:ana:peer"] })).toEqual({
			peerNamed: true,
			selfReads: true,
		});
	});

	it("does not call this session's own directory entry peerNamed", () => {
		const own = ["ace:ana:me"];
		const withSelf = [{ channel: "ace:ana:me", description: "", expiresAt: 0 }];

		expect(readerFactsOf({ channel: "ace:ana:me", live: withSelf, subscriptions: ["ace:ana:me"], own })).toEqual({
			peerNamed: false,
			selfReads: true,
		});
		expect(readerFactsOf({ channel: "ace:ana:peer", live, subscriptions: [], own })).toEqual({
			peerNamed: true,
			selfReads: false,
		});
	});

	it("reports neither check for a name neither the directory nor this session holds", () => {
		expect(readerFactsOf({ channel: "ace:ana:typo", live, subscriptions: ["ace:ana:inbox"] })).toEqual({
			peerNamed: false,
			selfReads: false,
		});
	});
});
