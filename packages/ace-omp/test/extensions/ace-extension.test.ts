import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import aceExtension, { aceCompletions, compactDescription, isTransportRecovery } from "../../extensions/ace.ts";
import {
	type AceTheme,
	agentsPanel,
	channelForMenuValue,
	channelMenuItems,
	channelPanel,
	helpPanel,
	pendingPanel,
	renderAcePanel,
	renderAcePanelLines,
	statsPanel,
} from "../../extensions/ace-manager.ts";
import { AceDeliveryObserver, type ChannelReport, renderAceEvent } from "../../vendor/ace-runtime/dist/index.js";

// The extension reads the host-global config from `$XDG_CONFIG_HOME/omp/ace.json` (falling back to
// `~/.omp/agent/ace.json`). Point it at an empty directory: a developer's own configuration must
// never decide what these tests see.
const configHome = mkdtempSync(join(tmpdir(), "ace-config-home-"));
const previousConfigHome = process.env.XDG_CONFIG_HOME;
beforeAll(() => {
	process.env.XDG_CONFIG_HOME = configHome;
});
afterAll(() => {
	if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = previousConfigHome;
	rmSync(configHome, { recursive: true, force: true });
});

// The process-global claims are the point of the duplicate-load guard, and every context in this file reports the
// same session id: without a reset, the first test that starts a main session would own this process's surfaces for
// the rest of the worker and every later instance would refuse. Each test therefore starts from a fresh process.
/** Start from a fresh process: the surface and runtime claims are process-global on purpose. */
function freshProcess(): void {
	Reflect.deleteProperty(globalThis, Symbol.for("ace-runtime.extension.surface-claimed"));
	Reflect.deleteProperty(globalThis, Symbol.for("ace-runtime.extension.runtime-claimed"));
}

beforeEach(freshProcess);

describe("argument completions", () => {
	it("offers the subcommands with their hints while the argument is empty", () => {
		expect(aceCompletions("")).toEqual([
			{ value: "list ", label: "list", description: "channels this session reads; publish to any channel name" },
			{ value: "pending ", label: "pending", description: "manual events retained for activation" },
			{
				value: "activate ",
				label: "activate",
				description: "inject one retained event: /ace activate <sender> <id>",
			},
			{
				value: "agents ",
				label: "agents",
				description: "other live sessions on the agent directory; optional coding-agent filter",
			},
			{ value: "stats ", label: "stats", description: "per-channel counters, spool windows, dead letters" },
			{ value: "help ", label: "help", description: "list these commands" },
		]);
		expect(aceCompletions("st")?.map((item) => item.label)).toEqual(["stats"]);
		expect(aceCompletions("a")?.map((item) => item.label)).toEqual(["activate", "agents"]);
	});

	it("completes the retained events for activate, and hints on a subcommand with no arguments", () => {
		const pending = [{ sender: "ci", id: "evt_1", body: "Build failed" }];

		expect(aceCompletions("activate ", pending)).toEqual([
			{ value: "activate ci evt_1", label: "ci/evt_1", description: "Build failed" },
		]);
		expect(aceCompletions("activate nope", pending)).toBeNull();
		// A subcommand that takes no argument answers with a hint rather than silence, and its value is the text as
		// it stands: the host replaces the whole argument text with the candidate's value, so accepting the hint
		// must leave the line the user typed untouched.
		expect(aceCompletions("list ", pending)).toEqual([
			{ value: "list ", label: "list", description: "list takes no arguments" },
		]);
		expect(aceCompletions("agents co", pending)).toEqual([
			{ value: "agents co", label: "agents", description: "optional coding-agent filter, e.g. oh-my-pi" },
		]);
		expect(aceCompletions("nope ", pending)).toBeNull();
	});

	it("keeps the whole id in the value — it is what activates the event — and shows its tail in the label", () => {
		const id = "evt_3f2a8b1c-4e5d-6789-abcd-ef0123456789";

		// Measured against omp 18.5.0: the host hands `getArgumentCompletions` the argument text and replaces
		// exactly that with the chosen value, so a value holding only a suffix would delete what was typed.
		expect(aceCompletions("activate ", [{ sender: "ci", id, body: "x" }])).toEqual([
			{ value: `activate ci ${id}`, label: "ci/…456789", description: "x" },
		]);
	});
});

/**
 * A theme that shows the panel text unchanged and records what each piece was coloured as — the panel
 * renderer is pure, so the exact strings and the exact colours are both assertable without a terminal.
 */
function testTheme(): { theme: AceTheme; calls: Array<{ color: string; text: string }> } {
	const calls: Array<{ color: string; text: string }> = [];
	return {
		calls,
		theme: {
			fg: (color: string, text: string) => {
				calls.push({ color, text });
				return text;
			},
			bold: (text: string) => text,
		},
	};
}

describe("manager rows", () => {
	it("names each channel's address and state", () => {
		const { theme } = testTheme();
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
			selfChannels: ["session-inbox"],
			theme,
		});

		// The name is the accent column `SelectList` lays out and truncates; the state tag leads the
		// description column, where it is never the part that gets cut (see `channelMenuItems`). The tag
		// carries its own leading space, which is what aligns the state column across rows.
		expect(items.map((item) => `${item.label} →${item.description}`)).toEqual([
			'from-wsl → ● connected [redis-streams] · ace:lan:in.mac · [next_turn] · "the WSL agent"',
			"session-inbox → ● connected [redis-streams] · ace:lan:events:x · self — peers reply here",
		]);
	});

	it("finds a row by the target it addresses, so an aliased channel still opens its details", () => {
		// The regression: a row's value is `in:<channel>`, while `name` may be a different local label. Looking the
		// row up by `name` made every aliased channel inert — enter produced no details and no message.
		const subscriptions = [
			{
				name: "from-wsl",
				channel: "ace:lan:in.mac",
				transport: "redis-streams",
				config: { stream: "ace:lan:in.mac" },
				options: {},
			},
		];

		expect(channelForMenuValue(subscriptions, "in:ace:lan:in.mac")?.name).toBe("from-wsl");
		// A value that names no channel of this session is `undefined`, never a neighbouring row.
		expect(channelForMenuValue(subscriptions, "in:from-wsl")).toBeUndefined();
		expect(channelForMenuValue(subscriptions, "out:ace:lan:in.mac")).toBeUndefined();
	});
});

describe("panels", () => {
	it("draws `/ace list` from the same report the printer gets, one row per channel", () => {
		const { theme, calls } = testTheme();
		const report: ChannelReport = {
			identity: "ace:ana:from-wsl",
			agentState: "running",
			source: "/work/.ace.json",
			shadowed: "/home/ana/.omp/agent/ace.json",
			subscriptions: [
				{
					name: "from-wsl",
					channel: "ace:ch:ace:ana:from-wsl",
					transport: "redis-streams",
					description: "the WSL agent",
					activation: "next_turn",
					config: { stream: "ace:ch:ace:ana:from-wsl" },
					options: {},
				},
				{
					name: "inbox",
					channel: "ace:ch:ace:ana:inbox",
					transport: "redis-streams",
					config: { stream: "ace:ch:ace:ana:inbox" },
					options: {},
				},
			],
			selfChannels: ["ace:ch:ace:ana:inbox"],
			// Same order and length as `subscriptions`: the report's contract, and what makes the prefix a
			// publish-ready target.
			servers: ["lan", "home"],
			unavailableServers: [{ name: "ghost", address: "ghost:6379" }],
			unavailableSubscriptions: [{ channel: "ace:ana:noop", server: "ghost" }],
			configRemoved: ["ace:ch:ace:ana:inbox"],
			pendingManual: 2,
			deadLetters: { count: 1, directory: "/work/.ace" },
		};
		const panel = channelPanel(report);

		expect(panel.title).toBe("ACE channels");
		expect(panel.context).toBe("ace:ana:from-wsl (agent running) — /work/.ace.json");
		expect(renderAcePanelLines(theme, panel.lines)).toEqual([
			"config: /work/.ace.json (project file shadows /home/ana/.omp/agent/ace.json)",
			"subscribe (2 channels):",
			'  lan:ace:ch:ace:ana:from-wsl ● connected [redis-streams] · [next_turn] · as "from-wsl" · "the WSL agent"',
			'  home:ace:ch:ace:ana:inbox ● connected [redis-streams] · as "inbox" · self — peers reply here · config-removed',
			"unavailable:",
			"  ghost ◌ inactive did not come up · ghost:6379",
			'  ace:ana:noop ◌ inactive server "ghost" did not come up',
			"manual: 2 pending, dead letters: 1 at /work/.ace",
		]);
		// The states are coloured, not just glyphs: `/mcp`'s own tags.
		expect(calls).toContainEqual({ color: "success", text: " ● connected" });
		expect(calls).toContainEqual({ color: "warning", text: " ◌ inactive" });
	});

	it("says what to do when there is nothing to read yet", () => {
		const { theme } = testTheme();
		const panel = channelPanel({
			identity: "ace:ana:from-wsl",
			agentState: "idle",
			subscriptions: [],
			pendingManual: 0,
			deadLetters: { count: 0 },
		});

		expect(renderAcePanelLines(theme, panel.lines)).toEqual([
			"subscribe:",
			'(none) add channels under a server\'s "subscribe" in .ace.json to read them.',
			"manual: 0 pending, dead letters: 0",
		]);
	});

	it("draws live agents with the lease each one has left", () => {
		const { theme, calls } = testTheme();
		const panel = agentsPanel({
			rows: [{ target: "ace:ana:from-wsl", renewsIn: 69, description: '"agent=codex | cwd=/work"' }],
			servers: ["lan"],
			mine: ["ace:ana:omp:…1325bb"],
		});

		expect(panel.title).toBe("ACE live agents (1)");
		expect(panel.context).toBe("servers: lan");
		expect(renderAcePanelLines(theme, panel.lines)).toEqual([
			'  ace:ana:from-wsl ● live renews in 1m 9s · "agent=codex | cwd=/work"',
			"this session: ace:ana:omp:…1325bb — not listed",
		]);
		expect(calls).toContainEqual({ color: "success", text: " ● live" });
	});

	it("keeps a filter visible in an empty agent listing", () => {
		const { theme } = testTheme();
		const panel = agentsPanel({ rows: [], servers: ["lan"], mine: [], filter: "codex" });

		expect(panel.title).toBe("ACE live agents");
		expect(panel.context).toBe('servers: lan · filter "codex"');
		expect(renderAcePanelLines(theme, panel.lines)).toEqual(['no live session matches agent filter "codex"']);
	});

	it("draws retained manual events, warning once the retention window is closing", () => {
		const { theme, calls } = testTheme();
		const panel = pendingPanel([
			{
				sender: "ci",
				idLabel: "…456789",
				sessionLabel: "58e914",
				ageSeconds: 300,
				subscription: "ci-results",
				expiring: false,
				body: "Build failed",
			},
			{ sender: "deploy", idLabel: "evt_2", ageSeconds: 86_400, subscription: "deploys", expiring: true, body: "x" },
		]);

		expect(panel.title).toBe("ACE pending manual events (2)");
		expect(panel.context).toBe("activate with: /ace activate <sender> <id>");
		expect(renderAcePanelLines(theme, panel.lines)).toEqual([
			'  ci ◌ pending id …456789 · session 58e914 · 5m ago · manual: ci-results · "Build failed"',
			'  deploy ◌ expires soon id evt_2 · 1d ago · manual: deploys · "x"',
		]);
		expect(calls).toContainEqual({ color: "warning", text: " ◌ expires soon" });
	});

	it("draws `/ace stats` with the transport as a state and one row per counter scope", () => {
		const { theme, calls } = testTheme();
		const panel = statsPanel({
			counters: { inbox: { received: 12, injected: 11 }, runtime: { dropped: 1 } },
			windows: [{ subscription: "ci-results", buffered: 3, path: "/work/.ace/spool/ci.jsonl" }],
			deadLetters: { count: 1, directory: "/work/.ace" },
			transport: "ok",
		});

		expect(panel.title).toBe("ACE stats");
		expect(panel.context).toBe("dead letters: 1 → /work/.ace");
		expect(renderAcePanelLines(theme, panel.lines)).toEqual([
			"  transport ● connected",
			"  inbox received=12 injected=11",
			"  runtime dropped=1",
			"spooling:",
			"  ci-results ◌ pending 3 buffered · /work/.ace/spool/ci.jsonl",
		]);
		expect(calls).toContainEqual({ color: "success", text: " ● connected" });
	});

	it("reports a down transport as inactive and an empty counter set as an explanation", () => {
		const { theme, calls } = testTheme();
		const panel = statsPanel({ counters: {}, windows: [], deadLetters: { count: 0 }, transport: "down" });

		expect(panel.context).toBe("dead letters: 0");
		expect(renderAcePanelLines(theme, panel.lines)).toEqual([
			"  transport ◌ inactive",
			"no counters yet — one line per channel appears here as events arrive, counting received, " +
				"injected, deduped, spooled, reclaimed and dropped",
		]);
		expect(calls).toContainEqual({ color: "warning", text: " ◌ inactive" });
	});

	it("lists every command as an accent row in `/ace help`", () => {
		const { theme } = testTheme();
		const panel = helpPanel([
			{ name: "list", description: "channels this session reads; publish to any channel name" },
			{ name: "stats", description: "per-channel counters, spool windows, dead letters" },
		]);

		expect(panel.title).toBe("ACE commands");
		expect(renderAcePanelLines(theme, panel.lines)).toEqual([
			"  /ace list channels this session reads; publish to any channel name",
			"  /ace stats per-channel counters, spool windows, dead letters",
		]);
	});

	it("renders the report a session receives: title, context, rows — and nothing to close", () => {
		const { theme } = testTheme();
		const text = renderAcePanel(
			theme,
			pendingPanel([
				{ sender: "ci", idLabel: "evt_1", ageSeconds: 60, subscription: "inbox", expiring: false, body: "x" },
			]),
		);

		expect(text.split("\n")).toEqual([
			"ACE pending manual events (1)",
			"activate with: /ace activate <sender> <id>",
			"",
			'  ci ◌ pending id evt_1 · 1m ago · manual: inbox · "x"',
		]);
		// A report in the record has nothing to close, so no key hint is part of it.
		expect(text).not.toContain("esc");
	});
});

/** A registered tool as these tests reach it: the handler directly, with arguments of any shape. */
interface RegisteredTool {
	name: string;
	description?: string;
	parameters?: { properties?: Record<string, unknown> };
	execute: (toolCallId: string, params: unknown) => Promise<unknown>;
}

/** The slice of `ExtensionAPI` the extension touches; nothing else is reached in these tests. */
function fakeExtensionApi() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	/** Every handler for an event, in registration order: what a second instance's load adds. */
	const allHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const tools: RegisteredTool[] = [];
	const commands: Array<{
		name: string;
		handler: (args: string, ctx: unknown) => Promise<void>;
		definition: { getArgumentCompletions?: unknown };
	}> = [];
	return {
		handlers,
		allHandlers,
		tools,
		commands,
		// The factory uses exactly these members; the cast stands in for the rest of ExtensionAPI, so the
		// recorded tool definitions keep the loose handler signature this file calls them with.
		api: {
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, handler);
				allHandlers.set(event, [...(allHandlers.get(event) ?? []), handler]);
				return () => {};
			},
			registerTool: (definition: RegisteredTool) => void tools.push(definition),
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
	/** Every footer status write, in order; `undefined` is the clear. */
	const statuses: Array<string | undefined> = [];
	return {
		notifications,
		statuses,
		ctx: {
			cwd,
			hasUI: true,
			ui: {
				notify: (message: string) => void notifications.push(message),
				setStatus: (_key: string, text: string | undefined) => void statuses.push(text),
			},
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

describe("the command surface", () => {
	/** The `/ace` command as the host holds it, so a test can call the handler the way the user does. */
	function aceCommand(commands: Array<{ name: string; handler: (args: string, ctx: unknown) => Promise<void> }>) {
		const command = commands.find((entry) => entry.name === "ace");
		if (command === undefined) throw new Error("the ace command was not registered");
		return command;
	}

	it("answers /ace help and /ace ? with the command list, runtime or not", async () => {
		await withScratchDirectory(async (dir) => {
			const { api, handlers, commands } = fakeExtensionApi();
			aceExtension(api);
			const { ctx, notifications } = fakeContext("main", dir);
			// No configuration in this directory: nothing runs, and help must still answer.
			await handlers.get("session_start")?.({}, ctx);
			notifications.length = 0;

			const command = aceCommand(commands);
			await command.handler("help", ctx);
			const help = notifications.join("\n");
			expect(help).toContain("[ace] commands:");
			expect(help).toContain("/ace — open the channel manager");
			expect(help).toContain("agents — other live sessions on the agent directory");

			await command.handler("?", ctx);
			expect(notifications.join("\n")).toContain("[ace] commands:");
		});
	});

	it("tells a missing configuration file from one that will not parse", async () => {
		// Nothing to fix anywhere: create a file.
		await withScratchDirectory(async (dir) => {
			const { api, handlers, commands } = fakeExtensionApi();
			aceExtension(api);
			const { ctx, notifications } = fakeContext("main", dir);
			await handlers.get("session_start")?.({}, ctx);
			notifications.length = 0;

			await aceCommand(commands).handler("list", ctx);
			expect(notifications.join("\n")).toContain(`[ace] not running: add .ace.json to ${dir} and restart Pi`);
		});

		// A file that is there but broken: "add one" would be wrong advice, so the error is repeated instead.
		await withScratchDirectory(async (dir) => {
			freshProcess();
			writeFileSync(join(dir, ".ace.json"), "{ not json }\n");
			const { api, handlers, commands } = fakeExtensionApi();
			aceExtension(api);
			const { ctx, notifications } = fakeContext("main", dir);
			await handlers.get("session_start")?.({}, ctx);
			notifications.length = 0;

			await aceCommand(commands).handler("list", ctx);
			const text = notifications.join("\n");
			expect(text).toContain("[ace] not running: config error:");
			expect(text).toContain(".ace.json");
			expect(text).not.toContain("restart Pi");
		});
	});

	it("clears the footer status on shutdown, and a subagent session never writes one", async () => {
		await withScratchDirectory(async (dir) => {
			const { api, handlers } = fakeExtensionApi();
			aceExtension(api);
			const main = fakeContext("main", dir);
			await handlers.get("session_start")?.({}, main.ctx);
			await handlers.get("session_shutdown")?.({}, main.ctx);
			// The session is gone, so the slot is cleared rather than left showing the last session's numbers.
			expect(main.statuses).toEqual([undefined]);

			const sub = fakeContext("sub", dir);
			await handlers.get("session_start")?.({}, sub.ctx);
			await handlers.get("session_shutdown")?.({}, sub.ctx);
			// One runtime, in the session the human talks to: a subagent never writes the main session's status.
			expect(sub.statuses).toEqual([]);
		});
	});
});

describe("human rows for a peer's registry description", () => {
	it("keeps the fields a person uses and drops the debugging ones, leaving anything else alone", () => {
		expect(
			compactDescription(
				"agent=codex | session=peer11 | cwd=/tmp/peer-x | host=build-02 | ip=192.168.2.11 | platform=darwin-arm64 | pid=90940",
			),
		).toBe("agent=codex | session=peer11 | cwd=/tmp/peer-x");
		// Not our blob: a foreign sender's own words are shown whole, never trimmed to nothing.
		expect(compactDescription("a human wrote this sentence")).toBe("a human wrote this sentence");
		expect(compactDescription("")).toBe("");
	});
});

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

describe("queued delivery release", () => {
	const message = {
		aceVersion: "0.1",
		id: "evt_001",
		sender: "build-service",
		activation: "next_turn",
		body: "Build failed for project foo.",
	} as const;

	it("releases a still-pending injection when the host says the run settled", async () => {
		// The primary trigger: `agent_settled` means no automatic retry, compaction or queued
		// continuation will run, so a queued wait whose text never surfaced must end here.
		const delivery = new AceDeliveryObserver();
		const { api, handlers } = fakeExtensionApi();
		aceExtension(api, { delivery });
		const { ctx } = fakeContext("main", "/tmp");

		const pending = delivery.observe(message);
		expect(delivery.pendingCount).toBe(1);

		handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

		await expect(pending).rejects.toThrow("the run settled without surfacing this text");
		expect(delivery.pendingCount).toBe(0);
		// Idempotent: the next run's settle signal finds nothing left to release.
		handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		expect(delivery.pendingCount).toBe(0);
	});

	it("releases a still-pending injection on session shutdown", async () => {
		// The backstop: a session can end mid-run. It must run before the reader stops, because the
		// transport's stop drains the delivery queue and an unreleased wait would make that drain hang.
		const delivery = new AceDeliveryObserver();
		const { api, handlers } = fakeExtensionApi();
		aceExtension(api, { delivery });
		const { ctx } = fakeContext("main", "/tmp");

		const pending = delivery.observe(message);

		await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);

		await expect(pending).rejects.toThrow("the run settled without surfacing this text");
		expect(delivery.pendingCount).toBe(0);
	});

	it("deletes a released waiter, so a delivered text is never released later", async () => {
		const delivery = new AceDeliveryObserver();
		const { api, handlers } = fakeExtensionApi();
		aceExtension(api, { delivery });
		const { ctx } = fakeContext("main", "/tmp");

		const surfaced = delivery.observe(message);
		delivery.accept({ message: { role: "user", content: renderAceEvent(message) } });
		await expect(surfaced).resolves.toBeUndefined();

		handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

		expect(delivery.pendingCount).toBe(0);
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

describe("tool arguments", () => {
	/** The registered handler named `name`, called the way the host calls it. */
	function tool(name: string, tools: RegisteredTool[]) {
		const found = tools.find((entry) => entry.name === name);
		if (found === undefined) throw new Error(`${name} was not registered`);
		return found;
	}

	it("refuses an argument a tool does not declare, instead of ignoring it", async () => {
		const { api, tools } = fakeExtensionApi();
		aceExtension(api);

		// The handler sees the raw argument object, so an undeclared key is visible here: the schemas leave
		// `additionalProperties` open for exactly this reason (oh-my-pi deletes unrecognized keys before the
		// tool runs when it is closed, which is the silent no-op this check replaced).
		await expect(
			tool("ace_publish", tools).execute("call_1", { body: "hi", channel: "outbox", bogus: true }),
		).rejects.toThrow('ace_publish does not take "bogus"; it takes `body`, `channel`, `activation`');
		await expect(tool("ace_channels", tools).execute("call_1", { foo: 1 })).rejects.toThrow(
			'ace_channels does not take "foo"; it takes no arguments',
		);
		await expect(tool("ace_agents", tools).execute("call_1", { bogus: true })).rejects.toThrow(
			'ace_agents does not take "bogus"; it takes `agent`, `limit`',
		);
	});

	it("refuses a value a coercing host could have handed through, naming it", async () => {
		const { api, tools } = fakeExtensionApi();
		aceExtension(api);

		// `body` and `channel` declare no type, so the host has nothing to convert and the raw value arrives:
		// the tool refuses it instead of a number becoming a channel name.
		await expect(tool("ace_publish", tools).execute("call_1", { body: "hi", channel: 42 })).rejects.toThrow(
			"ace_publish `channel` must be a non-empty string or an array of non-empty strings, received 42",
		);
		await expect(tool("ace_publish", tools).execute("call_1", { body: "hi", channel: "bad name" })).rejects.toThrow(
			'ace_publish `channel` "bad name" contains interior whitespace or a control character, which a channel name cannot carry',
		);
	});

	it("refuses a wrong-typed ace_agents argument instead of coercing it, naming the value", async () => {
		const { api, tools } = fakeExtensionApi();
		aceExtension(api);

		// `agent` and `limit` declare no type, like `ace_publish`'s `body`/`channel`, so the host has nothing to
		// convert: `agent: 5` used to arrive as the filter "5" (an empty directory) and `limit: true`/`limit: "5"`
		// as 1/5. The tool refuses each and names the value.
		await expect(tool("ace_agents", tools).execute("call_1", { agent: 5 })).rejects.toThrow(
			"ace_agents `agent` must be a string, received 5",
		);
		await expect(tool("ace_agents", tools).execute("call_1", { limit: true })).rejects.toThrow(
			"ace_agents `limit` must be an integer, received true",
		);
		await expect(tool("ace_agents", tools).execute("call_1", { limit: "5" })).rejects.toThrow(
			'ace_agents `limit` must be an integer, received "5"',
		);
		// A blank filter is no filter, not a usage error: the call passes validation and only then finds no
		// directory registered in this test session.
		await expect(tool("ace_agents", tools).execute("call_1", { agent: "" })).rejects.toThrow(/no agent directory/);
	});

	it("answers a missing body and a bad activation with its own sentence, not the host's", async () => {
		const { api, tools } = fakeExtensionApi();
		aceExtension(api);

		// Item 4: `body` is declared optional, so the host's JSON-schema validator no longer rejects the
		// missing key in its own wording with the whole tool document echoed back.
		await expect(tool("ace_publish", tools).execute("call_1", { channel: "outbox" })).rejects.toThrow(
			"ace_publish `body` must contain at least one non-whitespace character, received undefined",
		);
		// `activation` declares no enum, so a value outside the four reaches the tool and is refused here.
		await expect(
			tool("ace_publish", tools).execute("call_1", { body: "hi", channel: "outbox", activation: "later" }),
		).rejects.toThrow(
			'ace_publish `activation` must be one of "immediate", "next_turn", "manual", "default", received "later"',
		);
	});

	it("reports an all-failed publish as the same field list, not a sentence", async () => {
		const { api, tools } = fakeExtensionApi();
		aceExtension(api);

		// No directory is registered in this test session, so the only target fails at resolution — the same
		// shape an unreachable peer gives. Defect 3: the thrown text is the documented field list, with the
		// header's `stored=0` and a `status=failed` row per input, not a `nothing published: …` sentence.
		const message = await tool("ace_publish", tools)
			.execute("call_1", { body: "hi", channel: "outbox" })
			.then(
				() => undefined,
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);

		const head = message?.split("\n")[0] ?? "";
		expect(head).toContain("targets=1 stored=0 failed=1 duplicates=0");
		expect(message).toContain("target=outbox status=failed error=");
		expect(message).not.toContain("nothing published");
		// Bug 2: no event was created, so the header carries `event=none`, not an id and an empty `sender=`.
		expect(head).toContain("event=none");
		expect(head).not.toContain("id=");
		expect(head).not.toContain("sender=");
	});
});

describe("file-transfer tools", () => {
	/** The registered handler named `name`, called the way the host calls it. */
	function registeredTool(name: string, tools: RegisteredTool[]): RegisteredTool {
		const found = tools.find((entry) => entry.name === name);
		if (found === undefined) throw new Error(`${name} was not registered`);
		return found;
	}

	it("registers ace_store_file and ace_get_file with a description and a parameter schema", () => {
		const { api, tools } = fakeExtensionApi();
		aceExtension(api);

		const store = registeredTool("ace_store_file", tools);
		const get = registeredTool("ace_get_file", tools);
		expect(store.description).toContain("This is not sending");
		expect(Object.keys(store.parameters?.properties ?? {}).sort()).toEqual(["name", "path", "ttl"]);
		expect(Object.keys(get.parameters?.properties ?? {})).toEqual(["token"]);
	});

	it("validates arguments before the live-server check, then reports no directory", async () => {
		const { api, tools } = fakeExtensionApi();
		aceExtension(api);

		await expect(
			registeredTool("ace_store_file", tools).execute("call_1", { path: "a.bin", ttl: "P2D" }),
		).rejects.toThrow(/longer than the maximum ttl/);
		await expect(registeredTool("ace_get_file", tools).execute("call_1", { token: "abc" })).rejects.toThrow(
			/128-bit hex token/,
		);
		// Valid arguments, but this session registered no server: the transfer cannot run.
		await expect(registeredTool("ace_store_file", tools).execute("call_1", { path: "a.bin" })).rejects.toThrow(
			/no agent directory/,
		);
	});

	it("refuses an argument a transfer tool does not declare", async () => {
		const { api, tools } = fakeExtensionApi();
		aceExtension(api);

		await expect(
			registeredTool("ace_store_file", tools).execute("call_1", { path: "a.bin", channel: "x" }),
		).rejects.toThrow('ace_store_file does not take "channel"; it takes `path`, `ttl`, `name`');
		await expect(
			registeredTool("ace_get_file", tools).execute("call_1", { token: "a".repeat(32), server: "x" }),
		).rejects.toThrow('ace_get_file does not take "server"; it takes `token`');
	});
});

describe("host specifics", () => {
	it("gives ace_channels the config paragraph only, and ace_publish both", () => {
		const { api, tools } = fakeExtensionApi();
		aceExtension(api);

		const channels = tools.find((entry) => entry.name === "ace_channels");
		const publish = tools.find((entry) => entry.name === "ace_publish");
		if (channels === undefined || publish === undefined) throw new Error("the ACE tools were not registered");

		// Where `.ace.json` comes from is a fact about the configuration every tool reads, so it is here.
		expect(channels.description).toContain("$ACE_CONFIG");
		// The `manual` retention store has nothing to do with listing channels: it is the publish tool's,
		// where `manual` activation is explained, so it must not be injected into the channels description.
		expect(channels.description).not.toContain("/ace pending");
		expect(channels.description).not.toContain("manual-<subscription>.jsonl");

		// Publish carries both paragraphs, and the host paragraph is injected once, not per constant.
		expect(publish.description).toContain("$ACE_CONFIG");
		expect(publish.description).toContain("manual-<subscription>.jsonl");
		expect((publish.description ?? "").split("Host specifics:").length - 1).toBe(1);
	});
});

describe("transport recovery notices (audit C2)", () => {
	it("recognises the notices that mean the connection came back", () => {
		expect(isTransportRecovery("redis stream ace:in: reconnected")).toBe(true);
		expect(isTransportRecovery("redis stream ace:in: consumer group recreated")).toBe(true);
	});

	it("does not read ordinary notices as recoveries", () => {
		expect(isTransportRecovery("redis stream ace:in: reclaimed entry 9-0 (attempt 1)")).toBe(false);
		expect(isTransportRecovery("redis stream ace:in: dropping entry 9-0 after 3 delivery attempts")).toBe(false);
	});
});
