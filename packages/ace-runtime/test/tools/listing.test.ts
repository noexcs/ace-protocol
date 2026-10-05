import { describe, expect, it } from "vitest";
import type { EndpointConfig } from "../../src/runtime/endpoint-config.ts";
import { channelListingInput, formatChannelListing } from "../../src/tools/listing.ts";

const endpoint = (over: Partial<EndpointConfig> & { name: string }): EndpointConfig => ({
	transport: "redis-streams",
	config: { stream: `ace:ch:${over.channel ?? over.name}` },
	options: {},
	...over,
});

const inbox = endpoint({
	name: "session-inbox",
	channel: "ace:ana:oh-my-pi:01a10a",
	description: "this session's inbox",
});
const subscribed = endpoint({
	name: "ace:ana:from-wsl",
	channel: "ace:ana:from-wsl",
	activation: "next_turn",
	description: "the WSL agent",
});

describe("formatChannelListing", () => {
	it("emits one row per channel with the same keys in the same order", () => {
		const rows = formatChannelListing([subscribed, inbox], { selfChannel: "ace:ana:oh-my-pi:01a10a" }).split("\n");

		expect(rows[0]).toBe(
			"subscribe: one row per channel; `self=yes` is this session's own channel (peers publish there to reach it); `note` runs to the end of the line",
		);
		expect(rows[1]).toBe(
			"  channel=ace:ana:from-wsl transport=redis-streams activation=next_turn self=no note=the WSL agent",
		);
		// The session's own channel is what a peer replies to, so the row says so; an endpoint without an
		// activation of its own reports `default` rather than dropping the key.
		expect(rows[2]).toBe(
			"  channel=ace:ana:oh-my-pi:01a10a transport=redis-streams activation=default self=yes note=this session's inbox",
		);
	});

	it("leaves the note unquoted as the tail of the row", () => {
		const chatty = endpoint({
			name: "ace:ana:chatty",
			channel: "ace:ana:chatty",
			description: "reads slowly: batch of 3, spaces and all",
		});

		expect(formatChannelListing([chatty])).toContain(
			"channel=ace:ana:chatty transport=redis-streams activation=default self=no note=reads slowly: batch of 3, spaces and all",
		);
	});

	it("ends the row at `note=` when there is no note", () => {
		const bare = endpoint({ name: "ace:ana:quiet", channel: "ace:ana:quiet" });

		expect(formatChannelListing([bare]).split("\n")[1]).toBe(
			"  channel=ace:ana:quiet transport=redis-streams activation=default self=no note=",
		);
	});

	it("says (none) when this session reads nothing", () => {
		expect(formatChannelListing([])).toContain("(none)");
	});

	it("names each subscription whose server did not come up instead of dropping it silently", () => {
		const rows = formatChannelListing([subscribed], {
			unavailable: [{ channel: "ghost:noexcs:noop", server: "ghost" }],
		}).split("\n");

		// The channel rows keep their exact format…
		expect(rows[1]).toBe(
			"  channel=ace:ana:from-wsl transport=redis-streams activation=next_turn self=no note=the WSL agent",
		);
		// …and the dropped subscription is a line after them, one per dropped name.
		expect(rows[2]).toBe('  unavailable: ghost:noexcs:noop (server "ghost" did not come up)');
	});
});

describe("channelListingInput", () => {
	it("marks the inbox by the channel it reads", () => {
		expect(channelListingInput([], inbox).selfChannel).toBe("ace:ana:oh-my-pi:01a10a");
	});
});
