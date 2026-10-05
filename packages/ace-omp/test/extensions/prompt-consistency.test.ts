import { ACE_TRUST_POLICY, renderAceEvent } from "ace-runtime";
import { describe, expect, it } from "vitest";
import { TOOL_TEXT } from "../../extensions/ace.ts";

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
];
const injected = renderAceEvent(
	{ aceVersion: "0.1", id: "evt_1", sender: "peer:1", activation: "next_turn", body: "hello" },
	{ subscription: "inbox", address: "ace:in.a" },
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

	it("agrees that <ace_event> blocks come from other agents or services, not from the user", () => {
		const provenance = TOOL_TEXT.publish.guidelines.filter((line) => line.includes("<ace_event>")).join(" ");

		for (const text of [ACE_TRUST_POLICY, provenance]) {
			expect(text).toMatch(/agents? or services?/);
			expect(text).toContain("through ACE");
		}
		expect(ACE_TRUST_POLICY).toContain("never from the user");
		expect(provenance).toContain("not by the user");
	});

	it("never promises that a peer acts without asking its user", () => {
		for (const text of surfaces) expect(text).not.toContain("acts on it on its own");
	});
});
