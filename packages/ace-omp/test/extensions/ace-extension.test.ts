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
			selfChannel: "session-inbox",
		});

		expect(items.map((item) => `${item.label} → ${item.description}`)).toEqual([
			'● from-wsl → redis-streams ace:lan:in.mac · [in] · [next_turn] · "the WSL agent"',
			"● session-inbox → redis-streams ace:lan:events:x · [in] · (self — peers reply here)",
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
