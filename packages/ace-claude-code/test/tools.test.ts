import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AceMessage, EndpointConfig, PendingAceEvent } from "ace-runtime";
import { channelName, resolveAceConfig, subscriptionEndpoint } from "ace-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type AceRuntimeSurface,
	buildToolDefinitions,
	executeTool,
	type PublishedTarget,
	type PublishSurface,
	type ToolContext,
} from "../src/tools.ts";

const SENDER = "ace:claude:claude-code:sess-1";
const SERVER_URL = "redis://127.0.0.1:6379";

/** A publish surface that records what it is given and can be told to fail. */
function fakeSurface(fail = false) {
	const messages: AceMessage[] = [];
	const target: PublishedTarget = {
		server: { name: "local", url: SERVER_URL, namespace: "ace" },
		channel: channelName("ace", "claude", "outbox"),
		sender: SENDER,
	};
	const surface: PublishSurface = {
		senders: [SENDER],
		serverNames: ["local"],
		resolve: async (name: string) => {
			if (name !== "outbox") throw new Error(`"${name}": target not found`);
			return target;
		},
		send: async (_target, message) => {
			if (fail) throw new Error("broker down");
			messages.push(message);
		},
	};
	return { surface, messages, target };
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
		subscriptions: [],
		sessionId: "sess-1",
		codingAgent: "claude-code",
		cwd: "/work",
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

	it("names this session's directory channel in the ace_publish description, when registered", () => {
		const without = buildToolDefinitions().find((tool) => tool.name === "ace_publish");
		expect(without?.description).not.toContain(SENDER);
		const withSender = buildToolDefinitions([SENDER]).find((tool) => tool.name === "ace_publish");
		expect(withSender?.description).toContain(SENDER);
		expect(withSender?.description).toContain("direct event");
		// The channel line is an addition, not a rewording of the shared description.
		expect(withSender?.description).toContain(without?.description ?? "(missing)");
	});
});

describe("ace_channels", () => {
	it("lists the configured channel and the derived inbox, without broker settings", async () => {
		const resolved = resolveAceConfig({ cwd: configDir(), env: {} });
		const server = resolved.servers[0];
		if (server === undefined) throw new Error("test config has no server");
		const configured: EndpointConfig = subscriptionEndpoint({
			channel: resolved.subscriptions[0]?.channel ?? "",
			name: resolved.subscriptions[0]?.name ?? "",
			url: server.url,
			namespace: server.namespace,
			sender: SENDER,
		});
		const inbox: EndpointConfig = subscriptionEndpoint({
			channel: SENDER,
			name: "session-inbox",
			url: server.url,
			namespace: server.namespace,
			sender: SENDER,
		});
		const result = await executeTool(
			ctx({ config: resolved, subscriptions: [inbox, configured], inbox }),
			"ace_channels",
			{},
		);
		expect(result.isError).toBeFalsy();
		const text = result.content[0].text;
		expect(text).toContain("ace:claude:inbox");
		expect(text).toContain("session-inbox");
		// Broker addresses are intentionally left out of the model-facing view.
		expect(text).not.toContain("127.0.0.1");
	});

	it("does not list the derived inbox when the session registered no channel", async () => {
		const resolved = resolveAceConfig({ cwd: configDir(), env: {} });
		const server = resolved.servers[0];
		if (server === undefined) throw new Error("test config has no server");
		const configured = subscriptionEndpoint({
			channel: resolved.subscriptions[0]?.channel ?? "",
			name: resolved.subscriptions[0]?.name ?? "",
			url: server.url,
			namespace: server.namespace,
			sender: SENDER,
		});
		const result = await executeTool(ctx({ config: resolved, subscriptions: [configured] }), "ace_channels", {});
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).not.toContain("session-inbox");
	});

	it("is an error when ACE is not running", async () => {
		const result = await executeTool(ctx({}), "ace_channels", {});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/not running/);
	});
});

describe("ace_publish", () => {
	it("publishes a valid ACE message to a channel name", async () => {
		const { surface, messages, target } = fakeSurface();
		const result = await executeTool(ctx({ publish: surface }), "ace_publish", {
			body: "hello",
			target: "outbox",
		});
		expect(result.isError).toBeFalsy();
		expect(messages).toHaveLength(1);
		const sent = messages[0];
		expect(sent.aceVersion).toBe("0.1");
		expect(sent.sender).toBe(target.sender);
		expect(sent.sessionId).toBe("sess-1");
		expect(sent.activation).toBe("next_turn");
		expect(sent.body).toBe("hello");
		expect(result.content[0].text).toContain(target.channel);
	});

	it("honours an explicit activation", async () => {
		const { surface, messages } = fakeSurface();
		await executeTool(ctx({ publish: surface }), "ace_publish", {
			body: "hello",
			target: "outbox",
			activation: "immediate",
		});
		expect(messages[0]?.activation).toBe("immediate");
	});

	it("reports an unresolvable target as a failure and publishes nothing", async () => {
		const { surface, messages } = fakeSurface();
		const result = await executeTool(ctx({ publish: surface }), "ace_publish", { body: "hello", target: "nowhere" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/nothing published/i);
		expect(messages).toHaveLength(0);
	});

	it("reports a broker failure as a failure", async () => {
		const { surface } = fakeSurface(true);
		const result = await executeTool(ctx({ publish: surface }), "ace_publish", { body: "hello", target: "outbox" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("broker down");
	});

	it("is an error when ACE is not running", async () => {
		const result = await executeTool(ctx({}), "ace_publish", { body: "hello", target: "outbox" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/not running/);
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

// A configuration directory holding a new-contract `.ace.json`, so the tools are exercised against
// the real resolver — no broker, because resolving only reads the file.
let dir: string;
function configDir() {
	return dir;
}
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "ace-tools-"));
	writeFileSync(
		join(dir, ".ace.json"),
		JSON.stringify({
			username: "claude",
			servers: { local: { url: SERVER_URL, namespace: "ace" } },
			subscribe: ["inbox"],
			defaultActivation: "next_turn",
		}),
	);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
