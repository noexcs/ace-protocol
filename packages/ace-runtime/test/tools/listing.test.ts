import { describe, expect, it } from "vitest";
import type { EndpointConfig } from "../../src/runtime/endpoint-config.ts";
import { channelListingInput, formatChannelListing } from "../../src/tools/listing.ts";

const endpoint = (over: Partial<EndpointConfig> & { name: string }): EndpointConfig => ({
	transport: "redis-streams",
	config: { stream: `ace:ch:${over.channel ?? over.name}` },
	options: {},
	...over,
});

describe("formatChannelListing", () => {
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

	it("leads with the channel a peer publishes to, and notes a differing local label", () => {
		const text = formatChannelListing([subscribed, inbox], { derivedName: "ace:ana:oh-my-pi:01a10a" });

		expect(text).toContain('ace:ana:from-wsl · redis-streams · "the WSL agent" · [next_turn]');
		// The inbox is the case that used to be unaddressable: the row must show the channel, not the label.
		expect(text).toContain(
			'ace:ana:oh-my-pi:01a10a · (as "session-inbox") · redis-streams · "this session\'s inbox" · (registered for this session)',
		);
	});

	it("says (none) when this session reads nothing", () => {
		expect(formatChannelListing([])).toContain("(none)");
	});
});

describe("channelListingInput", () => {
	it("marks the inbox by the channel it reads", () => {
		const inbox = endpoint({ name: "session-inbox", channel: "ace:ana:oh-my-pi:01a10a" });

		expect(channelListingInput([], inbox).derivedName).toBe("ace:ana:oh-my-pi:01a10a");
	});
});
