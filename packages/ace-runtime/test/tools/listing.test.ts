import { describe, expect, it } from "vitest";
import type { EndpointConfig } from "../../src/runtime/endpoint-config.ts";
import {
	channelListingInput,
	compareDiscoveredSessions,
	describeDiscovered,
	formatChannelListing,
	formatChannelReport,
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
		expect(rows[1]).toBe("channel=ace:ana:from-wsl activation=next_turn self=no note=the WSL agent");
		// The session's own channel is what a peer replies to, so the row says so; an endpoint without an
		// activation of its own reports `default` rather than dropping the key.
		expect(rows[2]).toBe("channel=ace:ana:oh-my-pi:01a10a activation=default self=yes note=this session's inbox");
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
			"channel=ace:ana:chatty activation=default self=no note=reads slowly: batch of 3, spaces and all",
		);
	});

	it("ends the row at `note=` when there is no note", () => {
		const bare = endpoint({ name: "ace:ana:quiet", channel: "ace:ana:quiet" });

		expect(formatChannelListing([bare]).split("\n")[1]).toBe(
			"channel=ace:ana:quiet activation=default self=no note=",
		);
	});

	it("marks a removed channel in the note, joining with the configured description", () => {
		// `subscribed` is still read but the current config no longer lists it; the note is a comma-joined
		// list in a fixed order (description first, then `config-removed`).
		const rows = formatChannelListing([subscribed], {
			configRemoved: ["ace:ana:from-wsl"],
		}).split("\n");

		expect(rows[1]).toBe("channel=ace:ana:from-wsl activation=next_turn self=no note=the WSL agent, config-removed");
	});

	it("marks a removed channel with no description as just `config-removed`", () => {
		const bare = endpoint({ name: "ace:ana:gone", channel: "ace:ana:gone" });

		expect(formatChannelListing([bare], { configRemoved: ["ace:ana:gone"] }).split("\n")[1]).toBe(
			"channel=ace:ana:gone activation=default self=no note=config-removed",
		);
	});

	it("leaves a channel still in the config unmarked", () => {
		const rows = formatChannelListing([subscribed], { configRemoved: ["ace:ana:elsewhere"] }).split("\n");

		expect(rows[1]).toBe("channel=ace:ana:from-wsl activation=next_turn self=no note=the WSL agent");
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
		expect(rows[1]).toBe("channel=ace:ana:from-wsl activation=next_turn self=no note=the WSL agent");
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

describe("formatChannelReport", () => {
	const base = {
		identity: "ana",
		agentState: "running",
		source: "/work/.ace.json",
		pendingManual: 0,
		deadLetters: { count: 0 },
	};

	it("prints the header, one transport-only line per subscription, and the counters", () => {
		// The stream key (`ace:ch:…`) is deliberately absent: it is the width hog, and the manager's detail
		// view has the full address. `at <dir>` is absent at zero dead letters.
		expect(formatChannelReport({ ...base, subscriptions: [subscribed] })).toBe(
			[
				"ana (agent running) — /work/.ace.json",
				"subscribe:",
				'  ace:ana:from-wsl: redis-streams [next_turn] "the WSL agent"',
				"manual: 0 pending, dead letters: 0",
			].join("\n"),
		);
	});

	it("prefixes every line with its server when more than one server is configured", () => {
		const second = endpoint({ name: "ace:ana:ci-ok", channel: "ace:ana:ci-ok", description: "ci failures" });

		const rows = formatChannelReport({
			...base,
			subscriptions: [subscribed, second],
			servers: ["local", "lan"],
		}).split("\n");

		// The name is the publish-ready target, exactly the prefixed form `ace_channels` reports.
		expect(rows[2]).toBe('  local:ace:ana:from-wsl: redis-streams [next_turn] "the WSL agent"');
		expect(rows[3]).toBe('  lan:ace:ana:ci-ok: redis-streams "ci failures"');
	});

	it("says how to add a subscription when there is none", () => {
		expect(formatChannelReport({ ...base, agentState: "idle", subscriptions: [] })).toBe(
			[
				"ana (agent idle) — /work/.ace.json",
				"subscribe:",
				"  (none)",
				'  add channels under a server\'s "subscribe" in .ace.json to read them.',
				"manual: 0 pending, dead letters: 0",
			].join("\n"),
		);
	});

	it("adds the config line, the unavailable pair and the dead-letter directory only when each applies", () => {
		const rows = formatChannelReport({
			...base,
			agentState: "idle",
			subscriptions: [],
			shadowed: "/home/u/.config/ace.json",
			unavailableServers: [{ name: "ghost", address: "ghost:6379" }],
			unavailableSubscriptions: [{ channel: "ace:ana:noop", server: "ghost" }],
			pendingManual: 3,
			deadLetters: { count: 2, directory: "/work/.ace" },
		}).split("\n");

		expect(rows[1]).toBe("config: /work/.ace.json (project file shadows /home/u/.config/ace.json)");
		// Cause first, then the subscription it dropped — the wording `formatChannelListing` uses, verbatim.
		expect(rows[5]).toBe('unavailable: server "ghost" did not come up (ghost:6379 is not reachable)');
		expect(rows[6]).toBe('unavailable: ace:ana:noop (server "ghost" did not come up)');
		expect(rows[7]).toBe("manual: 3 pending, dead letters: 2 at /work/.ace");
	});

	it("drops only `at <dir>` when there are no dead letters", () => {
		expect(
			formatChannelReport({
				...base,
				subscriptions: [],
				deadLetters: { count: 0, directory: "/work/.ace" },
			}),
		).toContain("manual: 0 pending, dead letters: 0");
	});

	it("marks a channel still read although the current config no longer lists it", () => {
		const rows = formatChannelReport({
			...base,
			subscriptions: [subscribed],
			configRemoved: ["ace:ana:from-wsl"],
		}).split("\n");

		expect(rows[2]).toBe('  ace:ana:from-wsl: redis-streams [next_turn] "the WSL agent" (config-removed)');
	});

	it("shortens a self channel's full session id with an explicit ellipsis, and only that", () => {
		// The inbox is named by its sender, so its tail is a full session id a person never types. The `…`
		// marks the omitted middle, so the row cannot be mistaken for a usable target; the manager's
		// `address:` line still carries the full name inside the derived stream key.
		const longInbox = endpoint({
			name: "session-inbox",
			channel: "ace:noexcs:oh-my-pi:0199c8ab-1234-7def-8abc-0123456789ab",
		});

		expect(
			formatChannelReport({
				...base,
				subscriptions: [longInbox],
				selfChannels: [longInbox.channel as string],
			}).split("\n")[2],
		).toBe('  ace:noexcs:oh-my-pi:…6789ab: redis-streams (as "session-inbox") (self — peers reply here)');
	});

	it("leaves a short self tail and a four-segment subscription name verbatim", () => {
		// `01a10a` is already the tail a label would produce; `nightly` is a local name, not a session id —
		// shortening either would invent a target that does not exist.
		const shortInbox = endpoint({ name: "session-inbox", channel: "ace:ana:oh-my-pi:01a10a" });
		const nightly = endpoint({ name: "ace:ana:build:nightly", channel: "ace:ana:build:nightly" });

		const rows = formatChannelReport({
			...base,
			subscriptions: [shortInbox, nightly],
			selfChannels: [shortInbox.channel as string],
		}).split("\n");

		expect(rows[2]).toBe('  ace:ana:oh-my-pi:01a10a: redis-streams (as "session-inbox") (self — peers reply here)');
		expect(rows[3]).toBe("  ace:ana:build:nightly: redis-streams");
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
