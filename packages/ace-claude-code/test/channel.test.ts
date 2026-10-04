import { renderAceEvent } from "ace-runtime";
import { describe, expect, it } from "vitest";
import { buildChannelNotification, CHANNEL_NOTIFICATION_METHOD } from "../src/channel.ts";

const message = {
	aceVersion: "0.1" as const,
	id: "evt_1",
	sender: "ci",
	activation: "next_turn" as const,
	body: "build failed",
};

/**
 * The mapping under test: the rendered `<ace_event>` block becomes the `content` of a
 * `notifications/claude/channel` notification. The host wraps that `content` verbatim in its own
 * `<channel source="…">` tag — the nesting the plugin cannot control — so the block stays a
 * substring of what the model sees.
 */
describe("buildChannelNotification", () => {
	it("targets the channel notification method", () => {
		expect(buildChannelNotification("x").method).toBe(CHANNEL_NOTIFICATION_METHOD);
		expect(CHANNEL_NOTIFICATION_METHOD).toBe("notifications/claude/channel");
	});

	it("carries the rendered ACE block as content, marked as an ACE event in meta", () => {
		const rendered = renderAceEvent(message);
		const notification = buildChannelNotification(rendered);
		expect(notification.params.content).toBe(rendered);
		expect(notification.params.meta).toEqual({ ace: "event" });
	});

	it("keeps the `<ace_event>` block intact inside the content the host will wrap", () => {
		const notification = buildChannelNotification(renderAceEvent(message));
		// The host wraps `content` in <channel source="…">…</channel>; the block must survive that
		// wrapping for the model to recognise it, and for the ack hook to match it later.
		const wrapped = `<channel source="plugin:ace-claude-code:ace" ace="event">\n${notification.params.content}\n</channel>`;
		expect(wrapped).toContain("<ace_event>");
		expect(wrapped).toContain("</ace_event>");
	});

	it("forwards whatever content it is given verbatim", () => {
		expect(buildChannelNotification("plain text").params.content).toBe("plain text");
	});
});
