import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RegistryEntry, ResolvedAceConfig } from "ace-runtime";
import {
	buildPublishToolText,
	channelListingInput,
	describeDiscovered,
	formatChannelListing,
	formatChannelReport,
	formatSessionLabel,
	renderAceEvent,
} from "ace-runtime";
import { describe, expect, it } from "vitest";
import aceExtension, { aceCompletions } from "../../extensions/ace.ts";
import { channelMenuItems } from "../../extensions/ace-manager.ts";

const config: ResolvedAceConfig = {
	source: "/tmp/project/.ace.json",
	sender: "agent-a",
	subscribe: [
		{
			name: "inbox",
			transport: "redis-streams",
			description: "direct messages from peers",
			config: { stream: "ace:in.a", group: "agent-a" },
			options: {},
		},
	],
	publish: [
		{ name: "to-b", transport: "redis-streams", description: "agent-b", config: { stream: "ace:in.b" }, options: {} },
		{
			name: "all",
			transport: "redis-streams",
			description: "every agent",
			config: { stream: "ace:topic" },
			options: {},
		},
	],
	disabled: [],
	warnings: [],
	manual: {},
};

describe("ace_publish tool text", () => {
	it("names this agent, its session, its targets and its subscribed channels", () => {
		const { description } = buildPublishToolText(
			config,
			"01a102b8-f016-75ab-87eb-63551c257fda",
			"oh-my-pi:01a102b8-f016-75ab-87eb-63551c257fda",
		);

		expect(description).toContain('You are "oh-my-pi:01a102b8-f016-75ab-87eb-63551c257fda", session 257fda');
		expect(description).toContain('"to-b" (agent-b) → redis-streams ace:in.b');
		expect(description).toContain('"all" (every agent) → redis-streams ace:topic');
		expect(description).toContain('"inbox" (direct messages from peers) → redis-streams ace:in.a');
	});

	it("still describes the tool before a configuration is known", () => {
		const { description, promptGuidelines } = buildPublishToolText(undefined);

		expect(description).toContain("Publish an ACE 0.1 event");
		expect(description).not.toContain("Targets");
		expect(promptGuidelines.length).toBeGreaterThan(0);
	});

	it("says so when no channel is configured on one side", () => {
		const { description } = buildPublishToolText({ ...config, publish: [] });

		expect(description).toContain("Targets (pass the name as `target`; required, a list publishes to several):");
	});

	it("lists disabled channels without offering them as targets", () => {
		const { description } = buildPublishToolText({ ...config, disabled: ["to-c"] });

		expect(description).toContain("Disabled channels: to-c");
		expect(description).not.toContain('"to-c"');
	});

	it("uses whatever address key the transport kind names", () => {
		const { description } = buildPublishToolText({
			...config,
			publish: [
				{
					name: "bus",
					transport: "kafka",
					description: "the pipeline",
					config: { topic: "ace.events" },
					options: {},
				},
			],
		});

		expect(description).toContain('"bus" (the pipeline) → kafka ace.events');
	});

	it("names the identity events are stamped with, and admits when it is not known yet", () => {
		expect(buildPublishToolText(config, undefined, "oh-my-pi:abc").description).toContain(
			'You are "oh-my-pi:abc": every event you publish carries that sender',
		);
		expect(buildPublishToolText(config).description).toContain('You are "(unknown sender)"');
	});
});

describe("formatSessionLabel", () => {
	it("keeps the tail, which is what distinguishes concurrent sessions", () => {
		expect(formatSessionLabel("01a102b8-f016-75ab-87eb-63551c257fda")).toBe("257fda");
		expect(formatSessionLabel("01a102b8-f016-75ab-87eb-63551c257fdb")).toBe("257fdb");
	});

	it("leaves short ids alone", () => {
		expect(formatSessionLabel("abc")).toBe("abc");
	});
});

describe("renderAceEvent", () => {
	it("wraps the event and names the sender, its description and the channel it arrived on", () => {
		const message = {
			aceVersion: "0.1" as const,
			id: "evt_1",
			sender: "agent-a:01a102b8-f016-75ab-87eb-63551c257fda",
			sessionId: "01a102b8-f016-75ab-87eb-63551c257fda",
			senderDescription: "agent=oh-my-pi | session=257fda | cwd=/tmp/project",
			activation: "next_turn" as const,
			body: "Build failed.",
		};

		const rendered = renderAceEvent(message, { subscription: "from-wsl", address: "ace:lan:in.mac" });

		expect(rendered).toBe(
			"<ace_event>\nsender: agent-a:01a102b8-f016-75ab-87eb-63551c257fda\n" +
				"sender description: agent=oh-my-pi | session=257fda | cwd=/tmp/project\n" +
				"channel: ace:lan:in.mac\nid: evt_1\n\n" +
				"Build failed.\n</ace_event>",
		);
		expect(renderAceEvent(message, { subscription: "from-wsl" })).toContain("channel: from-wsl\n");
	});

	it("leaves out the description line when the sender sent none", () => {
		const rendered = renderAceEvent({
			aceVersion: "0.1",
			id: "evt_1",
			sender: "ci",
			activation: "next_turn",
			body: "Build failed.",
		});

		expect(rendered).toContain("sender: ci\nid: evt_1");
		expect(rendered).not.toContain("sender description:");
	});

	it("renders without a session when the message has none", () => {
		const rendered = renderAceEvent({
			aceVersion: "0.1",
			id: "evt_1",
			sender: "agent-a",
			activation: "next_turn",
			body: "Build failed.",
		});

		expect(rendered).toContain("sender: agent-a\nid: evt_1");
	});
});

describe("ace_agents rows", () => {
	it("shows a member's full self-description, however long", () => {
		const description = `agent=oh-my-pi | ${"field=value | ".repeat(20)}host=a-very-long-host-name`;
		const entry = {
			member: "oh-my-pi:01a103d7-6f71-750f-931d-7f0017352c04",
			expiresAt: Date.now() + 60_000,
			channel: { description },
		} as unknown as RegistryEntry;

		const row = describeDiscovered(entry);

		expect(row).toContain(description);
		expect(row).not.toContain("…");
	});
});

describe("channel report", () => {
	it("lists both directions with their addresses and the counters", () => {
		const report = formatChannelReport({
			identity: "oh-my-pi:01a103a6-c638-70c8-a87a-63113dfda2b2",
			agentState: "idle",
			source: "/tmp/project/.ace.json",
			subscriptions: [
				{
					name: "from-wsl",
					transport: "redis-streams",
					description: "the WSL agent",
					activation: "next_turn",
					config: { stream: "ace:lan:in.mac" },
					options: {},
				},
				{
					name: "session-inbox",
					transport: "redis-streams",
					config: { stream: "ace:lan:events:oh-my-pi:01a103a6-c638-70c8-a87a-63113dfda2b2" },
					options: {},
				},
			],
			publications: [
				{
					name: "to-wsl",
					transport: "redis-streams",
					description: "WSL agent inbox",
					config: { stream: "ace:lan:in.wsl" },
					options: {},
				},
			],
			derivedName: "session-inbox",
			disabled: ["stale"],
			pendingManual: 2,
			deadLetters: { count: 1, directory: "/tmp/project/.ace" },
		});

		expect(report).toBe(
			[
				"oh-my-pi:01a103a6-c638-70c8-a87a-63113dfda2b2 (agent idle) — /tmp/project/.ace.json",
				"subscribe:",
				'  from-wsl: redis-streams ace:lan:in.mac [next_turn] "the WSL agent"',
				"  session-inbox: redis-streams ace:lan:events:oh-my-pi:01a103a6-c638-70c8-a87a-63113dfda2b2 (registered for this session)",
				"publish:",
				'  to-wsl: redis-streams ace:lan:in.wsl "WSL agent inbox"',
				"disabled: stale",
				"manual: 2 pending, dead letters: 1 at /tmp/project/.ace",
			].join("\n"),
		);
	});

	it("says (none) for the halves a session does not have", () => {
		const bare = formatChannelReport({
			identity: "agent-a",
			agentState: "running",
			subscriptions: [],
			publications: [],
			disabled: [],
			pendingManual: 0,
			deadLetters: { count: 0 },
		});

		expect(bare).toBe(
			[
				"agent-a (agent running)",
				"subscribe:",
				"  (none)",
				"publish:",
				"  (none)",
				"disabled: (none)",
				"manual: 0 pending, dead letters: 0",
			].join("\n"),
		);
	});
});

describe("channel listing", () => {
	it("lists both directions, marks the derived inbox and names disabled channels", () => {
		const listing = formatChannelListing(
			[
				{
					name: "from-wsl",
					transport: "redis-streams",
					description: "the WSL agent",
					activation: "next_turn",
					config: { stream: "ace:lan:in.mac" },
					options: {},
				},
				{
					name: "session-inbox",
					transport: "redis-streams",
					config: { stream: "ace:lan:events:oh-my-pi:01a1" },
					options: {},
				},
			],
			[
				{
					name: "to-wsl",
					transport: "redis-streams",
					description: "WSL agent inbox",
					config: { stream: "ace:lan:in.wsl" },
					options: {},
				},
			],
			{ derivedName: "session-inbox", disabled: ["stale"] },
		);

		expect(listing).toBe(
			[
				"subscribe:",
				'  from-wsl · redis-streams · "the WSL agent" · [next_turn]',
				"  session-inbox · redis-streams · (registered for this session)",
				"publish:",
				'  to-wsl · redis-streams · "WSL agent inbox"',
				"disabled: stale",
			].join("\n"),
		);
	});

	it("says so when this session publishes nowhere", () => {
		expect(formatChannelListing([], [])).toBe("subscribe:\npublish:\n  (none)");
	});
});

describe("channel listing inputs", () => {
	const config = {
		source: "/tmp/.ace.json",
		subscribe: [{ name: "inbox", transport: "redis-streams", config: { stream: "ace:in.a" }, options: {} }],
		publish: [{ name: "out", transport: "redis-streams", config: { stream: "ace:in.b" }, options: {} }],
		disabled: ["stale"],
		warnings: [],
		manual: {},
	} as unknown as ResolvedAceConfig;

	it("adds the inbox the directory registered, and marks it derived", () => {
		const inbox = {
			name: "session-inbox",
			transport: "redis-streams",
			config: { stream: "ace:lan:events:x" },
			options: {},
		};
		const listing = channelListingInput(config, inbox);

		expect(listing.subscriptions.map((endpoint) => endpoint.name)).toEqual(["inbox", "session-inbox"]);
		expect(listing.derivedName).toBe("session-inbox");
		expect(listing.disabled).toEqual(["stale"]);
	});

	it("lists only the configured channels when this session is not registered", () => {
		const listing = channelListingInput(config);

		expect(listing.subscriptions.map((endpoint) => endpoint.name)).toEqual(["inbox"]);
		expect(listing.derivedName).toBeUndefined();
		expect(listing.publications.map((endpoint) => endpoint.name)).toEqual(["out"]);
	});
});

describe("argument completions", () => {
	it("offers the subcommands with their hints while the argument is empty", () => {
		expect(aceCompletions("")).toEqual([
			{ value: "list ", label: "list", description: "channels this session reads and can publish to" },
			{ value: "pending ", label: "pending", description: "manual events retained for activation" },
			{
				value: "activate ",
				label: "activate",
				description: "inject one retained event: /ace activate <sender> <id>",
			},
			{ value: "stats ", label: "stats", description: "per-channel counters, spool windows, dead letters" },
		]);
		expect(aceCompletions("st")?.map((item) => item.label)).toEqual(["stats"]);
	});

	it("completes the retained events for activate, and nothing else", () => {
		const pending = [{ sender: "ci", id: "evt_1", body: "Build failed" }];

		expect(aceCompletions("activate ", pending)).toEqual([
			{ value: "activate ci evt_1", label: "ci/evt_1", description: "Build failed" },
		]);
		expect(aceCompletions("activate nope", pending)).toBeNull();
		expect(aceCompletions("list ", pending)).toBeNull();
	});

	it("is registered on the ace command", () => {
		const { api, commands } = fakeExtensionApi();
		aceExtension(api);

		expect(typeof commands.find((entry) => entry.name === "ace")?.definition.getArgumentCompletions).toBe("function");
	});
});

describe("manager rows", () => {
	it("names each channel's direction, address and state", () => {
		const items = channelMenuItems({
			subscriptions: [
				{
					name: "from-wsl",
					transport: "redis-streams",
					description: "the WSL agent",
					activation: "next_turn",
					config: { stream: "ace:lan:in.mac" },
					options: {},
				},
				{
					name: "session-inbox",
					transport: "redis-streams",
					config: { stream: "ace:lan:events:x" },
					options: {},
				},
			],
			publications: [
				{ name: "to-wsl", transport: "redis-streams", config: { stream: "ace:lan:in.wsl" }, options: {} },
			],
			derivedName: "session-inbox",
			disabled: ["stale"],
		});

		expect(items.map((item) => `${item.label} → ${item.description}`)).toEqual([
			'● from-wsl → redis-streams ace:lan:in.mac · [in] · [next_turn] · "the WSL agent"',
			"● session-inbox → redis-streams ace:lan:events:x · [in] · (registered for this session)",
			"● to-wsl → redis-streams ace:lan:in.wsl · [out]",
			"⦸ stale → disabled in .ace.json",
		]);
	});
});

/** The slice of `ExtensionAPI` the extension touches; nothing else is reached in these tests. */
function fakeExtensionApi() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const tools: string[] = [];
	const commands: Array<{
		name: string;
		handler: (args: string, ctx: unknown) => Promise<void>;
		definition: { getArgumentCompletions?: unknown };
	}> = [];
	return {
		handlers,
		tools,
		commands,
		// The factory uses exactly these members; the cast stands in for the rest of ExtensionAPI.
		api: {
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, handler);
				return () => {};
			},
			registerTool: (definition: { name: string }) => void tools.push(definition.name),
			registerCommand: (
				name: string,
				definition: { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: unknown },
			) => void commands.push({ name, handler: definition.handler, definition }),
			sendUserMessage: () => {},
		} as unknown as ExtensionAPI,
	};
}

/** A session context; only the fields the extension reads are present. */
function fakeContext(kind: "main" | "sub", cwd: string) {
	const notifications: string[] = [];
	return {
		notifications,
		ctx: {
			cwd,
			hasUI: true,
			ui: { notify: (message: string) => void notifications.push(message), setStatus: () => {} },
			sessionManager: { getSessionId: () => "01a102b6-9dac-75b6-80ca-21cbbf58e914" },
			isIdle: () => true,
			agent: { kind },
		},
	};
}

function withScratchDirectory(body: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "ace-extension-"));
	return body(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("subagent sessions", () => {
	it("starts nothing in a subagent session and says so for /ace", async () => {
		await withScratchDirectory(async (dir) => {
			const { api, handlers, tools, commands } = fakeExtensionApi();
			aceExtension(api);
			const registered = [...tools];
			const { ctx, notifications } = fakeContext("sub", dir);

			await handlers.get("session_start")?.({}, ctx);

			// A second runtime would join the same consumer group and steal the main session's events.
			expect(notifications).toEqual([]);
			expect(tools).toEqual(registered);

			await handlers.get("session_shutdown")?.({}, ctx);
			expect(notifications).toEqual([]);

			const command = commands.find((entry) => entry.name === "ace");
			await command?.handler("", ctx);
			expect(notifications.join("\n")).toContain("subagent");
		});
	});

	it("starts in the main session, reporting a missing configuration", async () => {
		await withScratchDirectory(async (dir) => {
			const { api, handlers } = fakeExtensionApi();
			aceExtension(api);
			const { ctx, notifications } = fakeContext("main", dir);

			await handlers.get("session_start")?.({}, ctx);

			expect(notifications.join("\n")).toContain("not started");
		});
	});
});

describe("system prompt policy", () => {
	it("stays out of the prompt until ACE runs, and never touches a subagent session", async () => {
		await withScratchDirectory(async (dir) => {
			const { api, handlers } = fakeExtensionApi();
			aceExtension(api);
			const handler = handlers.get("before_agent_start");

			// No configuration in this directory: ACE never started, so the host keeps its own prompt.
			const main = fakeContext("main", dir).ctx;
			await handlers.get("session_start")?.({}, main);
			expect(handler?.({ systemPrompt: "BASE" }, main)).toBeUndefined();

			// Subagent sessions run no ACE runtime of their own.
			expect(handler?.({ systemPrompt: "BASE" }, fakeContext("sub", dir).ctx)).toBeUndefined();
		});
	});
});
