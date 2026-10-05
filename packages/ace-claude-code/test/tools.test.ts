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
		readerFacts: async () => ({ peerNamed: true, selfReads: false }),
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
		inboxes: [],
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
		// The per-session channel sentence is an addition, not a rewording of the shared description.
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
			ctx({ config: resolved, subscriptions: [inbox, configured], inboxes: [inbox] }),
			"ace_channels",
			{},
		);
		expect(result.isError).toBeFalsy();
		const text = result.content[0].text;
		expect(text).toContain("ace:claude:inbox");
		// The inbox row shows the addressable channel and marks it as this session's own; the local label
		// ("session-inbox") belongs to `/ace list`, not to the model-facing view.
		expect(text).toContain(`channel=${SENDER} transport=redis-streams activation=default self=yes`);
		expect(text).not.toContain("session-inbox");
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
			channel: "outbox",
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

	it("delivers once when two names in one call resolve to the same channel", async () => {
		const messages: AceMessage[] = [];
		const target: PublishedTarget = {
			server: { name: "local", url: SERVER_URL, namespace: "ace" },
			channel: channelName("ace", "claude", "outbox"),
			sender: SENDER,
		};
		const surface: PublishSurface = {
			senders: [SENDER],
			serverNames: ["local"],
			// Two different input strings, one resolved (server, channel) pair: string de-duplication
			// cannot collapse them, so the drop has to happen after resolution.
			resolve: async () => target,
			send: async (_target, message) => {
				messages.push(message);
			},
			readerFacts: async () => ({ peerNamed: true, selfReads: false }),
		};

		const result = await executeTool(ctx({ publish: surface }), "ace_publish", {
			body: "hello",
			channel: ["outbox", "local:outbox"],
		});

		expect(result.isError).toBeFalsy();
		expect(messages).toHaveLength(1);
		expect(result.content[0].text).toContain("targets=2 delivered=1 failed=0 duplicates=1");
		// `of=` names the earlier *resolved* channel — the value the delivered row shows as its target —
		// not the earlier input string (`outbox`), which that row never displays.
		expect(result.content[0].text).toContain("target=local:outbox status=duplicate of=ace:claude:outbox");
	});

	it("carries the surface's two reader checks and the stream-key note into the rows", async () => {
		// Defects 1 and 6 at the host's edge: two fields named for the check they report, not one word
		// (`peer`/`self`/`none` read as verdicts on who reads), and a copied stream key named rather than
		// reported as an ordinary quiet channel.
		const surface: PublishSurface = {
			senders: [SENDER],
			serverNames: ["local"],
			resolve: async (name: string) => ({
				server: { name: "local", url: SERVER_URL, namespace: "ace" },
				channel: name,
				sender: SENDER,
			}),
			send: async () => {},
			readerFacts: async (target) =>
				target.channel === "self-read"
					? { peerNamed: false, selfReads: true }
					: target.channel.startsWith("ace:ch:")
						? { peerNamed: false, selfReads: false }
						: { peerNamed: true, selfReads: false },
		};

		const result = await executeTool(ctx({ publish: surface }), "ace_publish", {
			body: "hello",
			channel: ["peer-read", "self-read", "ace:ch:ace:noexcs:inbox"],
		});

		const text = result.content[0].text;
		expect(text).toContain("target=peer-read status=delivered peer_named=yes self_reads=no");
		expect(text).toContain("target=self-read status=delivered peer_named=no self_reads=yes");
		expect(text).toContain(
			"target=ace:ch:ace:noexcs:inbox status=delivered peer_named=no self_reads=no note=stream-key",
		);
	});

	it("honours an explicit activation", async () => {
		const { surface, messages } = fakeSurface();
		await executeTool(ctx({ publish: surface }), "ace_publish", {
			body: "hello",
			channel: "outbox",
			activation: "immediate",
		});
		expect(messages[0]?.activation).toBe("immediate");
	});

	it("answers a missing body, a bad activation and a prefixed two-segment name itself", async () => {
		const { surface, messages } = fakeSurface();
		const resolved = resolveAceConfig({ cwd: configDir(), env: {} });

		// Item 4: `body` is optional in the declared schema, so the host's validator no longer rejects the
		// missing key in its own wording (with the whole tool document echoed back) — the tool names it.
		const noBody = await executeTool(ctx({ publish: surface }), "ace_publish", { channel: "outbox" });
		expect(noBody.isError).toBe(true);
		expect(noBody.content[0].text).toBe(
			"ace_publish `body` must contain at least one non-whitespace character, received undefined",
		);

		// …and `activation` declares no enum now, so a value outside the four is refused here too.
		const badActivation = await executeTool(ctx({ publish: surface }), "ace_publish", {
			body: "hi",
			channel: "outbox",
			activation: "later",
		});
		expect(badActivation.isError).toBe(true);
		expect(badActivation.content[0].text).toBe(
			'ace_publish `activation` must be one of "immediate", "next_turn", "manual", "default", received "later"',
		);

		// Bug 3: `<server>:` plus a two-segment remainder is a pre-send usage error, not a `status=failed`
		// row beside a freshly minted id — resolution never runs, so nothing is sent.
		const ambiguous = await executeTool(ctx({ config: resolved, publish: surface }), "ace_publish", {
			body: "hi",
			channel: "local:ace:inbox",
		});
		expect(ambiguous.isError).toBe(true);
		expect(ambiguous.content[0].text).toContain('after the server prefix "local", "ace:inbox" is a two-segment name');
		expect(ambiguous.content[0].text).not.toContain("status=failed");
		expect(messages).toHaveLength(0);
	});

	it("reports an unresolvable target as the same field list, not a sentence", async () => {
		const { surface, messages } = fakeSurface();
		const result = await executeTool(ctx({ publish: surface }), "ace_publish", { body: "hello", channel: "nowhere" });
		expect(result.isError).toBe(true);
		// Defect 3: the all-failed text is the documented field list — `delivered=0` and a `status=failed` row per
		// input — not the `nothing published: "nowhere": …` prose that used to stand in for it.
		const text = result.content[0].text;
		const head = text.split("\n")[0] ?? "";
		expect(head).toContain("targets=1 delivered=0 failed=1 duplicates=0");
		expect(text).toContain("target=nowhere status=failed error=");
		expect(text).not.toMatch(/nothing published/i);
		// Bug 2: nothing was delivered, so no event was created — the header says `event=none` instead of
		// handing out an id and an empty `sender=`.
		expect(head).toContain("event=none");
		expect(head).not.toContain("id=");
		expect(head).not.toContain("sender=");
		expect(messages).toHaveLength(0);
	});

	it("reports a broker failure as a failure", async () => {
		const { surface } = fakeSurface(true);
		const result = await executeTool(ctx({ publish: surface }), "ace_publish", { body: "hello", channel: "outbox" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("broker down");
	});

	it("is an error when ACE is not running", async () => {
		const result = await executeTool(ctx({}), "ace_publish", { body: "hello", channel: "outbox" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/not running/);
	});

	it("rejects the old `target` parameter name", async () => {
		const { surface, messages } = fakeSurface();
		const result = await executeTool(ctx({ publish: surface }), "ace_publish", { body: "hello", target: "outbox" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("`channel`");
		expect(messages).toHaveLength(0);
	});

	it("fails bad input instead of coercing it into a valid-looking channel", async () => {
		const cases: Array<[string, Record<string, unknown>, RegExp]> = [
			["an empty channel", { body: "hello", channel: "" }, /`channel` must be a non-empty string.*received ""/],
			["a numeric channel", { body: "hello", channel: 5 }, /`channel` must be a non-empty string.*received 5/],
			[
				"an empty list",
				{ body: "hello", channel: [] },
				/`channel` must be a non-empty string.*received an empty list/,
			],
			["a list entry that is empty", { body: "hello", channel: ["outbox", ""] }, /entry 2 of 2.*received ""/],
			[
				"a non-string body",
				{ body: 12345, channel: "outbox" },
				/`body` must contain at least one non-whitespace character/,
			],
		];
		for (const [label, args, expected] of cases) {
			const { surface, messages } = fakeSurface();
			const result = await executeTool(ctx({ publish: surface }), "ace_publish", args);
			expect(result.isError, label).toBe(true);
			expect(result.content[0].text, label).toMatch(expected);
			expect(messages, label).toHaveLength(0);
		}
	});

	it("refuses a name with whitespace, a control character or an empty segment, naming it", async () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[
				{ body: "hello", channel: "out team" },
				'ace_publish `channel` "out team" contains interior whitespace or a control character, which a channel name cannot carry',
			],
			[
				{ body: "hello", channel: "ace:noexcs:probe\nws" },
				'ace_publish `channel` "ace:noexcs:probe\\nws" contains interior whitespace or a control character, which a channel name cannot carry',
			],
			[
				{ body: "hello", channel: "ace::foo" },
				'ace_publish `channel` "ace::foo" has an empty segment — ":" separates the segments, so every segment must be non-empty',
			],
		];
		for (const [args, expected] of cases) {
			const { surface, messages } = fakeSurface();
			const result = await executeTool(ctx({ publish: surface }), "ace_publish", args);
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toBe(expected);
			expect(messages).toHaveLength(0);
		}
	});

	it("trims a name before publishing it", async () => {
		const { surface, messages, target } = fakeSurface();
		const result = await executeTool(ctx({ publish: surface }), "ace_publish", {
			body: "hello",
			channel: " outbox ",
		});

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain(target.channel);
		expect(messages).toHaveLength(1);
	});
});

describe("undeclared arguments", () => {
	it("refuses a key `ace_publish` does not take, instead of ignoring it", async () => {
		const { surface, messages } = fakeSurface();
		const result = await executeTool(ctx({ publish: surface }), "ace_publish", {
			body: "hello",
			channel: "outbox",
			bogus: true,
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe(
			'ace_publish does not take "bogus"; it takes `body`, `channel`, `activation`',
		);
		expect(messages).toHaveLength(0);
	});

	it("refuses any key for a tool that takes no arguments", async () => {
		// The check runs before the runtime is consulted, so a bogus key is reported as such and not as
		// "ACE is not running".
		const result = await executeTool(ctx({}), "ace_channels", { foo: 1 });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe('ace_channels does not take "foo"; it takes no arguments');
	});

	it("refuses the keys the host-only tools do not take", async () => {
		const { runtime } = fakeRuntime();
		const pending = await executeTool(ctx({ runtime }), "ace_pending", { limit: 3 });
		expect(pending.content[0].text).toBe('ace_pending does not take "limit"; it takes no arguments');

		const activate = await executeTool(ctx({ runtime }), "ace_activate", {
			sender: "ci",
			id: "evt_9",
			force: true,
		});
		expect(activate.content[0].text).toBe('ace_activate does not take "force"; it takes `sender`, `id`');
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
			servers: { local: { url: SERVER_URL, namespace: "ace", subscribe: ["inbox"] } },
			defaultActivation: "next_turn",
		}),
	);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
