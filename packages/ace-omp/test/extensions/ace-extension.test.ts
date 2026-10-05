import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import aceExtension, { aceCompletions } from "../../extensions/ace.ts";
import { channelMenuItems } from "../../extensions/ace-manager.ts";

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
});

describe("manager rows", () => {
	it("names each channel's address and state", () => {
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
		});

		expect(items.map((item) => `${item.label} → ${item.description}`)).toEqual([
			'● from-wsl → redis-streams ace:lan:in.mac · [in] · [next_turn] · "the WSL agent"',
			"● session-inbox → redis-streams ace:lan:events:x · [in] · (self — peers reply here)",
		]);
	});
});

/** A registered tool as these tests reach it: the handler directly, with arguments of any shape. */
interface RegisteredTool {
	name: string;
	execute: (toolCallId: string, params: unknown) => Promise<unknown>;
}

/** The slice of `ExtensionAPI` the extension touches; nothing else is reached in these tests. */
function fakeExtensionApi() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const tools: RegisteredTool[] = [];
	const commands: Array<{
		name: string;
		handler: (args: string, ctx: unknown) => Promise<void>;
		definition: { getArgumentCompletions?: unknown };
	}> = [];
	return {
		handlers,
		tools,
		commands,
		// The factory uses exactly these members; the cast stands in for the rest of ExtensionAPI, so the
		// recorded tool definitions keep the loose handler signature this file calls them with.
		api: {
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				handlers.set(event, handler);
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
		// header's `delivered=0` and a `status=failed` row per input, not a `nothing published: …` sentence.
		const message = await tool("ace_publish", tools)
			.execute("call_1", { body: "hi", channel: "outbox" })
			.then(
				() => undefined,
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);

		const head = message?.split("\n")[0] ?? "";
		expect(head).toContain("targets=1 delivered=0 failed=1 duplicates=0");
		expect(message).toContain("target=outbox status=failed error=");
		expect(message).not.toContain("nothing published");
		// Bug 2: no event was created, so the header carries `event=none`, not an id and an empty `sender=`.
		expect(head).toContain("event=none");
		expect(head).not.toContain("id=");
		expect(head).not.toContain("sender=");
	});
});
