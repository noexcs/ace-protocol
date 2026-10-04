import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AceMessage, PendingAceEvent } from "ace-runtime";
import { resolveAceConfig } from "ace-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AceRuntimeSurface, buildToolDefinitions, executeTool, type ToolContext } from "../src/tools.ts";

/** A publisher that records what it is given and can be told to fail. */
function fakePublisher(fail = false) {
	const messages: AceMessage[] = [];
	return {
		messages,
		publish: async (message: AceMessage) => {
			if (fail) throw new Error("broker down");
			messages.push(message);
		},
		close: async () => {},
	};
}

/** A runtime stand-in exposing only what the tools read; returns the handle plus a record of activations. */
function fakeRuntime(pending: PendingAceEvent[] = []) {
	const activated: Array<{ sender: string; id: string }> = [];
	const runtime: AceRuntimeSurface = {
		pendingEvents: pending,
		async activatePendingEvent(sender: string, id: string) {
			activated.push({ sender, id });
		},
	};
	return { runtime, activated };
}

function ctx(partial: Partial<ToolContext>): ToolContext {
	return {
		config: undefined,
		sender: undefined,
		sessionId: "sess-1",
		codingAgent: "claude-code",
		publishers: {},
		runtime: undefined,
		...partial,
	};
}

describe("buildToolDefinitions", () => {
	it("lists exactly the four ACE tools", () => {
		expect(
			buildToolDefinitions()
				.map((t) => t.name)
				.sort(),
		).toEqual(["ace_activate", "ace_channels", "ace_pending", "ace_publish"]);
	});

	it("names this session's directory member in the ace_publish description, when registered", () => {
		const without = buildToolDefinitions().find((tool) => tool.name === "ace_publish");
		expect(without?.description).not.toContain("claude-code:sess-1");
		const withMember = buildToolDefinitions("claude-code:sess-1").find((tool) => tool.name === "ace_publish");
		expect(withMember?.description).toContain("claude-code:sess-1");
		expect(withMember?.description).toContain("direct event");
		// The member line is an addition, not a rewording of the shared description.
		expect(withMember?.description).toContain(without?.description ?? "(missing)");
	});
});

describe("ace_channels", () => {
	it("reports the resolved channels, not the broker settings", async () => {
		const resolved = resolveAceConfig({ cwd: configDir(), env: {} });
		const result = await executeTool(ctx({ config: resolved, sender: "claude-code:sess-1" }), "ace_channels", {});
		expect(result.isError).toBeFalsy();
		const text = result.content[0].text;
		expect(text).toContain("subscribe inbox");
		expect(text).toContain("publish outbox");
		// The derived session-inbox appears only when the session is registered in the directory.
		expect(text).not.toContain("session-inbox");
		// Broker addresses are intentionally left out of the model-facing view.
		expect(text).not.toContain("127.0.0.1");
	});

	it("lists the derived session-inbox alongside the member address when registered", async () => {
		const resolved = resolveAceConfig({ cwd: configDir(), env: {} });
		const result = await executeTool(
			ctx({ config: resolved, sender: "claude-code:sess-1", member: "claude-code:sess-1" }),
			"ace_channels",
			{},
		);
		expect(result.isError).toBeFalsy();
		const text = result.content[0].text;
		expect(text).toContain("subscribe session-inbox");
		expect(text).toContain('"claude-code:sess-1"');
	});

	it("is an error when ACE is not running", async () => {
		const result = await executeTool(ctx({}), "ace_channels", {});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/not running/);
	});
});

describe("ace_publish", () => {
	it("publishes a valid ACE message to a configured target", async () => {
		const publisher = fakePublisher();
		const result = await executeTool(
			ctx({ sender: "claude-code:sess-1", sessionId: "sess-1", publishers: { outbox: publisher } }),
			"ace_publish",
			{ body: "hello", target: "outbox" },
		);
		expect(result.isError).toBeFalsy();
		expect(publisher.messages).toHaveLength(1);
		const sent = publisher.messages[0];
		expect(sent.aceVersion).toBe("0.1");
		expect(sent.sender).toBe("claude-code:sess-1");
		expect(sent.sessionId).toBe("sess-1");
		expect(sent.activation).toBe("next_turn");
		expect(sent.body).toBe("hello");
	});

	it("honours an explicit activation", async () => {
		const publisher = fakePublisher();
		await executeTool(ctx({ sender: "claude-code:sess-1", publishers: { outbox: publisher } }), "ace_publish", {
			body: "hello",
			target: "outbox",
			activation: "immediate",
		});
		expect(publisher.messages[0].activation).toBe("immediate");
	});

	it("reports an unknown target as a failure", async () => {
		const publisher = fakePublisher();
		const result = await executeTool(
			ctx({ sender: "claude-code:sess-1", publishers: { outbox: publisher } }),
			"ace_publish",
			{ body: "hello", target: "nowhere" },
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/not a configured publish channel/);
	});

	it("is an error without a sender", async () => {
		const result = await executeTool(ctx({ publishers: { outbox: fakePublisher() } }), "ace_publish", {
			body: "hello",
			target: "outbox",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/no `sender`/);
	});
});

function aceMessage(overrides: Partial<AceMessage> = {}): PendingAceEvent {
	return {
		message: { aceVersion: "0.1", id: "evt_9", sender: "ci", activation: "manual", body: "hold me", ...overrides },
		subscriptionName: "inbox",
		storedAt: 0,
	};
}

describe("ace_pending / ace_activate", () => {
	it("lists pending manual events", async () => {
		const { runtime } = fakeRuntime([aceMessage()]);
		const result = await executeTool(ctx({ runtime }), "ace_pending", {});
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("ci/evt_9");
	});

	it("activates a pending event by (sender, id)", async () => {
		const { runtime, activated } = fakeRuntime();
		const result = await executeTool(ctx({ runtime }), "ace_activate", {
			sender: "ci",
			id: "evt_9",
		});
		expect(result.isError).toBeFalsy();
		expect(activated).toEqual([{ sender: "ci", id: "evt_9" }]);
	});
});

// A configuration directory holding the example `.ace.json`, so the tools are exercised against the
// real resolver — no broker, because resolving only reads the file.
let dir: string;
function configDir() {
	return dir;
}
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "ace-tools-"));
	writeFileSync(join(dir, ".ace.json"), JSON.stringify(exampleConfig()));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function exampleConfig() {
	return {
		defaultActivation: "next_turn",
		subscribe: [
			{
				name: "inbox",
				transport: "redis-streams",
				description: "Events other agents or services publish to this session",
				activation: "default",
				config: {
					stream: "ace:inbox:claude-code",
					group: "claude-code",
					url: "redis://127.0.0.1:6379",
					field: "message",
				},
			},
		],
		publish: [
			{
				name: "outbox",
				transport: "redis-streams",
				description: "Where the ace_publish tool sends this session's events",
				config: { stream: "ace:outbox:claude-code", url: "redis://127.0.0.1:6379", field: "message" },
			},
		],
	};
}
