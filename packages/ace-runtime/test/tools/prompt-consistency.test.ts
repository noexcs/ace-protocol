import { describe, expect, it } from "vitest";
import { ACE_TRUST_POLICY, renderAceEvent } from "../../src/agent/event-rendering.ts";
import { RESULT_LINE_GRAMMAR, TOOL_TEXT } from "../../src/tools/spec.ts";

/**
 * Four surfaces teach a model about ACE: the system-prompt policy, the three tool texts, and the injected
 * event header. They have to agree with each other — and stop teaching what the protocol dropped.
 */
const toolText = [
	TOOL_TEXT.publish.intro,
	...TOOL_TEXT.publish.guidelines,
	...Object.values(TOOL_TEXT.publish.params),
	TOOL_TEXT.agents.description,
	...TOOL_TEXT.agents.guidelines,
	...Object.values(TOOL_TEXT.agents.params),
	TOOL_TEXT.channels.description,
	...TOOL_TEXT.channels.guidelines,
	TOOL_TEXT.storeFile.description,
	...TOOL_TEXT.storeFile.guidelines,
	...Object.values(TOOL_TEXT.storeFile.params),
	TOOL_TEXT.getFile.description,
	...TOOL_TEXT.getFile.guidelines,
	...Object.values(TOOL_TEXT.getFile.params),
];
const injected = renderAceEvent(
	{ aceVersion: "0.1", id: "evt_1", sender: "peer:1", activation: "next_turn", body: "hello" },
	{ subscription: "inbox", channel: "ace:in.a", activation: "next_turn", receivedAt: 1_791_210_494_306 },
);
const surfaces = [ACE_TRUST_POLICY, injected, ...toolText];

describe("model-facing text", () => {
	it("teaches nothing that was removed", () => {
		const removed = [
			"allowedSenders",
			"ace_trust",
			"EXTERNAL_DATA_NOTICE",
			"spool:",
			"status bar",
			"ACE_LOG",
			"--extension",
		];

		for (const text of surfaces) {
			for (const term of removed) expect(text).not.toContain(term);
		}
	});

	it("states event provenance only in the receiving-side policy, not in the tool text", () => {
		// Receiving-side rules live in ACE_TRUST_POLICY; the tool descriptions are the sending side. The
		// sending side may point at the policy but must not restate its facts.
		expect(ACE_TRUST_POLICY).toMatch(/agents? or services?/);
		expect(ACE_TRUST_POLICY).toContain("through ACE");
		expect(ACE_TRUST_POLICY).toContain("never from the user");
		const restated = toolText.filter((text) => /agents? or services?/.test(text) && /through ACE/.test(text));
		expect(restated).toEqual([]);
	});

	it("never promises that a peer acts without asking its user", () => {
		for (const text of surfaces) expect(text).not.toContain("acts on it on its own");
	});

	it("shares the result-line grammar between ace_store_file and ace_get_file, verbatim", () => {
		// A reader of ace_get_file alone must not need ace_store_file to learn the line syntax, so the
		// block is included unchanged in both descriptions; this pins that it cannot drift in one only.
		expect(TOOL_TEXT.storeFile.description).toContain(RESULT_LINE_GRAMMAR);
		expect(TOOL_TEXT.getFile.description).toContain(RESULT_LINE_GRAMMAR);
	});
});
