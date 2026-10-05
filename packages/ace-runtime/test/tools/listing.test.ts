import { describe, expect, it } from "vitest";
import type { EndpointConfig } from "../../src/runtime/endpoint-config.ts";
import {
	channelListingInput,
	compareDiscoveredSessions,
	describeDiscovered,
	formatChannelListing,
	serverAddress,
} from "../../src/tools/listing.ts";

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

describe("describeDiscovered", () => {
	const entry = {
		channel: "ace:ana:oh-my-pi:01a1",
		description: "agent=oh-my-pi | cwd=/tmp/x",
		expiresAt: Date.now() + 86_900,
	};

	it("renders one session as fields, quoting the self-description", () => {
		const row = describeDiscovered(entry);

		expect(row).toContain("channel=ace:ana:oh-my-pi:01a1 ");
		expect(row).toMatch(/renews_in=PT(?:\d+H)?(?:\d+M)?\d+S/);
		expect(row).not.toMatch(/renews_in=\d+s\b/);
		expect(row).toContain(" self=no ");
		expect(row).toContain('description="agent=oh-my-pi | cwd=/tmp/x"');
	});

	it("folds the server prefix into the channel — the publish-ready target", () => {
		const row = describeDiscovered(entry, { server: "local", self: true });

		expect(row).toContain("channel=local:ace:ana:oh-my-pi:01a1 ");
		expect(row).toContain(" self=yes ");
	});
});

describe("formatChannelListing", () => {
	it("emits the machine header then one flush-left row per channel, same keys in the same order", () => {
		const rows = formatChannelListing([subscribed, inbox], { selfChannels: ["ace:ana:oh-my-pi:01a10a"] }).split("\n");

		// The header counts the channel rows, the `self=yes` rows, and the non-row `unavailable:` lines
		// (none here), so it stays true when unavailable lines are present. It is the same convention as
		// `ace 0.1 agents count=N`; the legend that used to precede these rows is in the tool description.
		expect(rows[0]).toBe("ace 0.1 channels count=2 self=1 unavailable=0");
		expect(rows[1]).toBe(
			"channel=ace:ana:from-wsl transport=redis-streams activation=next_turn self=no note=the WSL agent",
		);
		// The session's own channel is what a peer replies to, so the row says so; an endpoint without an
		// activation of its own reports `default` rather than dropping the key.
		expect(rows[2]).toBe(
			"channel=ace:ana:oh-my-pi:01a10a transport=redis-streams activation=default self=yes note=this session's inbox",
		);
	});

	it("marks every own channel when the session is live on two servers", () => {
		const aceInbox = endpoint({
			name: "session-inbox",
			channel: "ace:ana:oh-my-pi:01a10a",
			description: "inbox",
		});
		const ace2Inbox = endpoint({
			name: "second:session-inbox",
			channel: "ace2:ana:oh-my-pi:01a10a",
			description: "inbox",
		});

		const rows = formatChannelListing([aceInbox, ace2Inbox], {
			selfChannels: ["ace:ana:oh-my-pi:01a10a", "ace2:ana:oh-my-pi:01a10a"],
		}).split("\n");

		expect(rows[0]).toBe("ace 0.1 channels count=2 self=2 unavailable=0");
		// Both inboxes are this session's own channel — one per server, different namespaces — so both
		// carry `self=yes`; before the fix the second mirror was `self=no` because only one name was held.
		expect(rows[1]).toContain("channel=ace:ana:oh-my-pi:01a10a");
		expect(rows[1]).toContain("self=yes");
		expect(rows[2]).toContain("channel=ace2:ana:oh-my-pi:01a10a");
		expect(rows[2]).toContain("self=yes");
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
			"channel=ace:ana:quiet transport=redis-streams activation=default self=no note=",
		);
	});

	it("says nothing but a zero-count header when this session reads nothing", () => {
		// A `(none)` sentence would be a non-row line inside a row list; the header's `count=0` says it.
		expect(formatChannelListing([])).toBe("ace 0.1 channels count=0 self=0 unavailable=0");
	});

	it("names each subscription whose server did not come up instead of dropping it silently", () => {
		const rows = formatChannelListing([subscribed], {
			unavailable: [{ channel: "ghost:noexcs:noop", server: "ghost" }],
		}).split("\n");

		// The header counts the trailing line too, so `count=1` is never silently contradicted by it.
		expect(rows[0]).toBe("ace 0.1 channels count=1 self=0 unavailable=1");
		// The channel rows keep their exact format…
		expect(rows[1]).toBe(
			"channel=ace:ana:from-wsl transport=redis-streams activation=next_turn self=no note=the WSL agent",
		);
		// …and the dropped subscription is a line after them, one per dropped name.
		expect(rows[2]).toBe('unavailable: ghost:noexcs:noop (server "ghost" did not come up)');
	});

	it("names a configured server that never came up even when it carries no subscription", () => {
		const rows = formatChannelListing([], {
			deadServers: [{ server: "ghost", address: "ghost:6379" }],
		}).split("\n");

		// Nothing is read, so there are no channel rows — but the unreachable server is still not invisible,
		// and the header says one non-row line follows instead of a channel.
		expect(rows[0]).toBe("ace 0.1 channels count=0 self=0 unavailable=1");
		expect(rows[1]).toBe('unavailable: server "ghost" did not come up (ghost:6379 is not reachable)');
	});

	it("lists the dead server and each subscription it dropped, one line per problem", () => {
		const rows = formatChannelListing([subscribed], {
			unavailable: [{ channel: "ghost:noexcs:noop", server: "ghost" }],
			deadServers: [{ server: "ghost", address: "ghost:6379" }],
		}).split("\n");

		expect(rows[0]).toBe("ace 0.1 channels count=1 self=0 unavailable=2");
		expect(rows[2]).toBe('unavailable: server "ghost" did not come up (ghost:6379 is not reachable)');
		expect(rows[3]).toBe('unavailable: ghost:noexcs:noop (server "ghost" did not come up)');
	});
});

describe("compareDiscoveredSessions", () => {
	it("orders by channel name, then by server name, so two calls agree", () => {
		// Defect 5: the merged directory had no stable order of its own, and `renews_in` counts down every
		// second, so it cannot be the sort key.
		const rows = [
			{ server: "second", entry: { channel: "ace:z", description: "", expiresAt: 1_000 } },
			{ server: "local", entry: { channel: "ace:a", description: "", expiresAt: 999_999 } },
			{ server: "second", entry: { channel: "ace:a", description: "", expiresAt: 5 } },
		].sort(compareDiscoveredSessions);

		expect(rows.map((row) => `${row.server}:${row.entry.channel}`)).toEqual([
			"local:ace:a",
			"second:ace:a",
			"second:ace:z",
		]);
	});
});

describe("serverAddress", () => {
	it("drops the scheme, credentials and database so the reason names only where to dial", () => {
		expect(serverAddress("redis://user:secret@ghost:6379/0")).toBe("ghost:6379");
		expect(serverAddress("redis://ghost:6379")).toBe("ghost:6379");
		// Not a URL: show what configuration had, rather than hide the server behind "(no address)".
		expect(serverAddress("ghost:6379")).toBe("ghost:6379");
	});
});

describe("channelListingInput", () => {
	it("marks the inbox by the channel it reads", () => {
		expect(channelListingInput([], [inbox]).selfChannels).toEqual(["ace:ana:oh-my-pi:01a10a"]);
	});

	it("marks every inbox when the session is live on several servers", () => {
		const secondInbox = endpoint({
			name: "second:session-inbox",
			channel: "ace2:ana:oh-my-pi:01a10a",
			description: "this session's inbox",
		});

		const listing = channelListingInput([], [inbox, secondInbox]);
		expect(listing.selfChannels).toEqual(["ace:ana:oh-my-pi:01a10a", "ace2:ana:oh-my-pi:01a10a"]);
		expect(listing.subscriptions).toEqual([inbox, secondInbox]);
	});

	it("does not duplicate an inbox already among the subscriptions", () => {
		const listing = channelListingInput([inbox], [inbox]);

		expect(listing.subscriptions).toEqual([inbox]);
		expect(listing.selfChannels).toEqual(["ace:ana:oh-my-pi:01a10a"]);
	});
});
