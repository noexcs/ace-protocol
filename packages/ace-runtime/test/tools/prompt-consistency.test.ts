import { describe, expect, it } from "vitest";
import { ACE_TRUST_POLICY, renderAceEvent } from "../../src/agent/event-rendering.ts";
import type { ResolvedAceConfig, ResolvedServer } from "../../src/runtime/ace-config.ts";
import { buildPublishToolText, RESULT_LINE_GRAMMAR, TOOL_TEXT } from "../../src/tools/spec.ts";

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

/** The session shape a host assembles the publish description from — one live server, one subscription. */
const publishServer: ResolvedServer = { name: "local", url: "redis://127.0.0.1:6379", namespace: "ace" };
const publishConfig: ResolvedAceConfig = {
	username: "ana",
	servers: [publishServer],
	subscriptions: [{ server: publishServer, channel: "ace:ana:in.a", name: "ace:ana:in.a" }],
	manual: {},
	warnings: [],
	source: "/tmp/.ace.json",
};
const publishHostSpecifics =
	"The config file is resolved from `$ACE_CONFIG`, then the project `.ace.json`, then this host's " +
	"global file — the first that exists wins. A `manual` event here is held in an in-memory pending " +
	"store for this host's user to inspect and activate with `/ace pending` and `/ace activate <sender> <id>`.";

/**
 * The description a host actually shows is not the static intro alone: `buildPublishToolText` appends the
 * session's own lines. 0.2.14 shipped both halves stating the same rules again — the storage-not-delivery
 * rule and the `<ace_event>`-block/reply rule — so a model read each of them twice. Each fact now has one
 * owner, and this counts the canonical sentences in the assembled text: a later edit that pastes a rule
 * back into both halves fails here.
 */
describe("assembled publish description", () => {
	const canonical = [
		"The guarantee is storage, not delivery",
		"receives what is published after it starts",
		"one `<ace_event>` block",
		"Reply to the block's `sender:` channel",
	];

	it("states each canonical sentence exactly once", () => {
		const { description } = buildPublishToolText(
			publishConfig,
			"01a102b6-9dac-75b6-80ca-21cbbf58e914",
			"ace:ana:oh-my-pi:01a102b6-9dac-75b6-80ca-21cbbf58e914",
			publishHostSpecifics,
		);

		// Guard the fixture itself: without the session-specific lines this would prove nothing.
		expect(description).toContain('You are "ace:ana:oh-my-pi:01a102b6-9dac-75b6-80ca-21cbbf58e914"');
		expect(description).toContain("Servers this session is on:");
		expect(description.split("Host specifics:").length - 1).toBe(1);

		for (const sentence of canonical) {
			expect(description.split(sentence).length - 1, sentence).toBe(1);
		}
	});
});
