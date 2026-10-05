import type { AceMessage } from "ace-runtime";
import { renderAceEvent } from "ace-runtime";
import { describe, expect, it } from "vitest";
import { ChannelObserver } from "../src/observer.ts";

/**
 * The dispatcher passes `{ subscription, address? }` as the injection context, and
 * `renderAceEvent` renders that as a `stream:` header line. The engine observes with the exact
 * text it pushes, so these fixtures render *with* context — the text the hook will actually see.
 */
const message: AceMessage = {
	aceVersion: "0.1",
	id: "evt_1",
	sender: "ci",
	activation: "next_turn",
	body: "build failed",
};
const context = { subscription: "inbox" } as const;
const rendered = renderAceEvent(message, context);
const other: AceMessage = {
	aceVersion: "0.1",
	id: "evt_2",
	sender: "ci",
	activation: "next_turn",
	body: "deploy done",
};
const otherRendered = renderAceEvent(other, context);

/** Flush microtasks so an already-resolving promise settles; used to assert a promise is still pending. */
async function tick(): Promise<void> {
	for (let i = 0; i < 3; i += 1) await Promise.resolve();
}

/** Wrap the way Claude Code wraps channel content: our rendered block inside a `<channel>` tag. */
function hostWraps(...blocks: string[]): string {
	return blocks
		.map((block) => `<channel source="plugin:ace-claude-code:ace" ace="event">\n${block}\n</channel>`)
		.join("\n");
}

function observation(prompt: string) {
	return { t: new Date().toISOString(), blocks: [], prompt };
}

describe("ChannelObserver", () => {
	it("resolves once the host-wrapped prompt carries the rendered event as a substring", async () => {
		const observer = new ChannelObserver();
		const observed = observer.observe(message, rendered);
		// The prompt is NOT the rendered text: the host wraps it in its own <channel> tag.
		observer.feed(observation(hostWraps(rendered)));
		await expect(observed).resolves.toBeUndefined();
	});

	it("resolves each pending event when a batched prompt carries several", async () => {
		const observer = new ChannelObserver();
		const first = observer.observe(message, rendered);
		const second = observer.observe(other, otherRendered);
		// One prompt, two events — the host's "delivered together on the next turn" case.
		observer.feed(observation(hostWraps(rendered, otherRendered)));
		await expect(first).resolves.toBeUndefined();
		await expect(second).resolves.toBeUndefined();
	});

	it("does not resolve for a prompt that does not carry the event", async () => {
		const observer = new ChannelObserver();
		let resolved = false;
		void observer.observe(message, rendered).then(() => {
			resolved = true;
		});
		observer.feed(observation("just a user prompt, no ace event"));
		await tick();
		expect(resolved).toBe(false);
	});

	it("releases a pending event so a later, matching prompt no longer resolves it", async () => {
		const observer = new ChannelObserver();
		const held = observer.observe(message, rendered);
		// The engine releases on push failure / timeout, passing the exact rendered text.
		observer.release(message, rendered);
		let resolved = false;
		void held.then(() => {
			resolved = true;
		});
		observer.feed(observation(hostWraps(rendered)));
		await tick();
		expect(resolved).toBe(false);
	});

	it("observes and releases by the context-free render when no text is supplied", async () => {
		const observer = new ChannelObserver();
		const observed = observer.observe(message); // no rendered text, no context
		const bare = renderAceEvent(message);
		expect(bare).not.toBe(rendered); // the context render carries the extra `stream:` line
		observer.feed(observation(hostWraps(bare)));
		await expect(observed).resolves.toBeUndefined();
	});
});

describe("ChannelObserver and the </ace_event>-in-body edge", () => {
	it("still resolves when the body contains a literal </ace_event>", async () => {
		// A body containing the closing tag truncates `extractAceEvents`'s non-greedy match, so an
		// exact-block matcher would miss it. Substring matching against the raw prompt does not: the
		// full rendered event is still a contiguous run inside what the host wrapped.
		const tricky: AceMessage = {
			aceVersion: "0.1",
			id: "evt_x",
			sender: "ci",
			activation: "next_turn",
			body: "close with </ace_event> here",
		};
		const observer = new ChannelObserver();
		const renderedTricky = renderAceEvent(tricky, context);
		const observed = observer.observe(tricky, renderedTricky);
		observer.feed(observation(hostWraps(renderedTricky)));
		await expect(observed).resolves.toBeUndefined();
	});
});
