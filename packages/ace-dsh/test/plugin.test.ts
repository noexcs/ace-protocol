/**
 * The plugin entry itself: what `apply()` registers, on which lifecycle events, and with which message.
 *
 * The other test files cover the parts that do the work; this one covers the binding, which is the only
 * code that touches the host. It runs against a stub host context — a real Cordis host is not available
 * here — but through the host's *own* `defineTool` and `createUserMessage`, so a schema or a message
 * source this plugin declares wrong fails here rather than in a profile.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { AceDelivery } from "../src/dsh.ts";
import { apply } from "../src/index.ts";
import { HOST_TOOL_NAMES } from "../src/tools.ts";
import { ACE_TOOL_NAMES, ACE_TRUST_POLICY } from "../vendor/ace-runtime/dist/index.js";

const workspaces: string[] = [];

// No test in this file may reach the machine's real broker. Every case here resolves configuration through the
// same process environment the host reads, so the host-global candidate is pinned to an empty directory for the
// whole file; a case that wants a global configuration sets its own with `withGlobalHome`. Without this pin a
// developer's real `$DSH_HOME/ace.json` decides what the tests do — which is exactly what happened once: a case
// that expected "no configuration anywhere" registered a live channel on the local Redis instead.
const isolatedHome = await mkdtemp(join(tmpdir(), "ace-dsh-testhome-"));
process.env.DSH_HOME = isolatedHome;

afterEach(async () => {
	for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true });
});

afterAll(async () => {
	await rm(isolatedHome, { recursive: true, force: true });
});

/** One recorded registration, so an assertion can name what `apply()` did rather than what it logged. */
interface Recorded {
	tools: Array<{ name: string; description: string; parameters: unknown }>;
	commands: Array<{ name: string; description: string }>;
	sections: Array<{ name: string; order: number; text: unknown }>;
	events: Map<string, Array<(payload: unknown) => unknown>>;
	/** Effects as Cordis runs them: the initializer ran, and its returned disposer is kept under its label. */
	effects: Array<{ label: string; callback: () => unknown; disposer: unknown }>;
	/** Every `ctx.inject(deps, …)` the plugin made: the services it waited for. */
	injected: string[][];
	/** Exact Fetch routes the host half registered on Connection. */
	routes: Array<{
		path: string;
		methods: readonly string[];
		requestBody: string;
		fetch: (request: Request) => Promise<Response>;
	}>;
}

/** A stub host: only what this plugin calls, and every call recorded. */
function stubHost(recorded: Recorded, options: { connection?: boolean } = {}) {
	const scoped = {
		tools: {
			register: (definition: { name: string; description: string; parameters: unknown }) => {
				recorded.tools.push(definition);
				return () => {};
			},
		},
		commands: {
			register: (definition: { name: string; description: string }) => {
				recorded.commands.push(definition);
				return () => {};
			},
		},
		systemPrompt: {
			section: (section: { name: string; order: number; text: unknown }) => {
				recorded.sections.push(section);
				return () => {};
			},
		},
		on: (event: string, handler: (payload: unknown) => unknown) => {
			const handlers = recorded.events.get(event) ?? [];
			handlers.push(handler);
			recorded.events.set(event, handlers);
			return () => {};
		},
	};
	const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
	/** The slice of Connection the browser half's route registers on. */
	const connection = {
		fetch: {
			register: (route: Recorded["routes"][number]) => {
				recorded.routes.push(route);
				return () => {};
			},
		},
	};
	/** Connection is optional in this plugin; a profile without it must still load. */
	const get = (name: string): unknown =>
		name === "connection" && options.connection !== false ? connection : undefined;
	// Cordis runs the initializer immediately and treats its return value as the disposer; the stub does the
	// same, because a plugin that registers inside `effect` is only correct if that is true.
	const effect = (callback: () => unknown, label?: string) => {
		const disposer = callback();
		recorded.effects.push({ label: label ?? "", callback, disposer });
		return () => {};
	};

	return {
		logger,
		tools: scoped.tools,
		commands: scoped.commands,
		systemPrompt: scoped.systemPrompt,
		agents: { list: () => [] as unknown[] },
		effect,
		on: (event: string, handler: (payload: unknown) => unknown) => scoped.on(event, handler),
		get,
		/**
		 * `ctx.inject(deps, callback)` as Cordis runs it: the callback receives a context scoped to the resolved
		 * services, and runs once they exist.
		 *
		 * The plugin waits for Connection this way instead of reading it once at load, because a concurrent
		 * loader can compose the route's row after this plugin's — and a read-once `get()` then silently skips
		 * the registration, which is exactly how the chip came to report "off" on a registered session.
		 */
		inject: (deps: string[], callback: (scoped: unknown) => unknown) => {
			recorded.injected.push([...deps]);
			callback({ get, effect });
			return { dispose: () => {} };
		},
		/** The host's per-agent context, which is where the tools, command and policy actually land. */
		scoped,
	};
}

/** A workspace with a `.ace.json` pointing at a broker nothing is listening on. */
async function configuredWorkspace(): Promise<string> {
	const workspace = await mkdtemp(join(tmpdir(), "ace-dsh-plugin-"));
	workspaces.push(workspace);
	await writeFile(
		join(workspace, ".ace.json"),
		`${JSON.stringify({ username: "tester", servers: { local: { url: "redis://127.0.0.1:1" } } })}\n`,
		"utf8",
	);
	return workspace;
}

/** A `$DSH_HOME` holding the host-global configuration, so any working directory participates. */
async function configuredGlobalHome(): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "ace-dsh-home-"));
	workspaces.push(home);
	await writeFile(
		join(home, "ace.json"),
		`${JSON.stringify({ username: "tester", servers: { local: { url: "redis://127.0.0.1:1" } } })}\n`,
		"utf8",
	);
	return home;
}

/** Run `body` with `$DSH_HOME` pointing at `home`, restoring the previous value afterwards. */
async function withGlobalHome<T>(home: string, body: () => Promise<T> | T): Promise<T> {
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		return await body();
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	}
}

/**
 * Run `body` with `$DSH_HOME` pointing at an empty directory.
 *
 * The plugin reads the host-global candidate from the process environment, exactly as the host does, so a test
 * that wants "no configuration anywhere" has to control that candidate — otherwise the machine running the
 * tests decides the outcome, which is what happened the day a real `~/.dsh/ace.json` appeared.
 */
async function withoutGlobalConfig<T>(body: () => Promise<T> | T): Promise<T> {
	const empty = await mkdtemp(join(tmpdir(), "ace-dsh-nohome-"));
	workspaces.push(empty);
	return withGlobalHome(empty, body);
}

/** A live agent as the host presents it, bound to the stub's scoped context. */
function agentFor(sessionId: string, cwd: string, scoped: unknown) {
	return {
		status: "idle" as const,
		session: { id: sessionId, header: { cwd } },
		ctx: scoped,
		followup: () => {},
		steer: () => {},
		whenIdle: async () => {},
	};
}

function newRecorded(): Recorded {
	return { tools: [], commands: [], sections: [], events: new Map(), effects: [], routes: [], injected: [] };
}
describe("the ace-dsh plugin entry", () => {
	it("declares the services it needs and registers lifecycle handlers plus a disposer", () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);

		apply(host as unknown as Context);

		expect(recorded.events.has("agent/created")).toBe(true);
		expect(recorded.events.has("agent/disposed")).toBe(true);
		// Two effects, both owned by the plugin's own fiber: the status route the browser half reads, and the
		// teardown that takes the sessions with it (nothing else reports an HMR reload).
		expect(recorded.effects.map((effect) => effect.label)).toEqual(["ace-dsh: status route", "ace-dsh: sessions"]);
		// Per-session surfaces stay empty until a session has a configuration — no ACE tools and no trust
		// policy for a session that is not an ACE participant.
		expect(recorded.tools).toEqual([]);
		expect(recorded.sections).toEqual([]);
		// The command is the exception, and deliberately: it is registered globally so the client's command
		// catalog sees it, and it reports "not running in this session" when there is nothing to report on.
		expect(recorded.commands.map((command) => command.name)).toEqual(["ace"]);
	});

	it("gives a configured session the four tools, the command and the trust policy", async () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);
		apply(host as unknown as Context);
		const cwd = await configuredWorkspace();

		const created = recorded.events.get("agent/created") ?? [];
		await created[0]?.({ agent: agentFor("s-1", cwd, host.scoped) });

		expect(recorded.tools.map((tool) => tool.name)).toEqual([
			ACE_TOOL_NAMES.publish,
			ACE_TOOL_NAMES.agents,
			ACE_TOOL_NAMES.storeFile,
			ACE_TOOL_NAMES.getFile,
			HOST_TOOL_NAMES.pending,
			HOST_TOOL_NAMES.activate,
		]);
		// Every one of them compiled through the host's own schema compiler, and carries real text. (What each
		// one *declares* is asserted on the descriptors themselves in tools.test.ts — what the host hands back
		// here is the host's own normalized shape.)
		for (const tool of recorded.tools) {
			expect(tool.description.length, tool.name).toBeGreaterThan(200);
		}
		expect(recorded.commands.map((command) => command.name)).toEqual(["ace"]);
		expect(recorded.sections.map((section) => section.name)).toEqual(["ace-dsh:trust"]);
		expect(recorded.sections[0]?.text).toBe(ACE_TRUST_POLICY);
	});

	it("leaves a session alone when neither its directory nor the host has a configuration", async () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);
		apply(host as unknown as Context);
		const bare = await mkdtemp(join(tmpdir(), "ace-dsh-bare-"));
		workspaces.push(bare);

		const created = recorded.events.get("agent/created") ?? [];
		await withoutGlobalConfig(() => created[0]?.({ agent: agentFor("s-bare", bare, host.scoped) }));

		// No tools and no policy — and no broker connection either. The global `/ace` command is still
		// registered; invoked here it answers that ACE is not running.
		expect(recorded.tools).toEqual([]);
		expect(recorded.sections).toEqual([]);
	});

	it("registers a session from the host-global configuration when its own directory has none", async () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);
		apply(host as unknown as Context);
		const bare = await mkdtemp(join(tmpdir(), "ace-dsh-anywhere-"));
		workspaces.push(bare);

		// The whole point of $DSH_HOME/ace.json: a session started anywhere participates, with no project file.
		const created = recorded.events.get("agent/created") ?? [];
		const globalHome = await configuredGlobalHome();
		await withGlobalHome(globalHome, () => created[0]?.({ agent: agentFor("s-anywhere", bare, host.scoped) }));

		expect(recorded.tools.map((tool) => tool.name)).toEqual([
			ACE_TOOL_NAMES.publish,
			ACE_TOOL_NAMES.agents,
			ACE_TOOL_NAMES.storeFile,
			ACE_TOOL_NAMES.getFile,
			HOST_TOOL_NAMES.pending,
			HOST_TOOL_NAMES.activate,
		]);
		expect(recorded.sections.map((section) => section.name)).toEqual(["ace-dsh:trust"]);
	});

	it("accepts a single channel name and a list, as the tool's own contract does", async () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);
		apply(host as unknown as Context);
		const cwd = await configuredWorkspace();
		await (recorded.events.get("agent/created") ?? [])[0]?.({ agent: agentFor("s-1", cwd, host.scoped) });

		const publish = recorded.tools.find((tool) => tool.name === ACE_TOOL_NAMES.publish) as
			| { execute: (args: unknown, exec: unknown) => Promise<unknown> }
			| undefined;
		expect(publish).toBeDefined();

		// The broker is unreachable, so both calls fail — with ACE's own "no directory" text. What matters is
		// that neither is rejected by the *host's* argument validator: `channel` takes one name or a list, and
		// a parameter declared as `array` alone would refuse the common single-target call.
		const exec = { signal: new AbortController().signal, agent: undefined, callId: "c", name: "ace_publish" };
		for (const channel of ["ace:tester:peer", ["ace:tester:peer"]]) {
			const failure = await publish?.execute({ body: "x", channel }, exec).catch((error: unknown) => error);
			expect(String(failure)).not.toContain("must be an array");
			expect(String(failure)).not.toContain("invalid arguments");
		}
	});

	it("tears a session down on agent/disposed without throwing", async () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);
		apply(host as unknown as Context);
		const cwd = await configuredWorkspace();
		const agent = agentFor("s-1", cwd, host.scoped);

		await (recorded.events.get("agent/created") ?? [])[0]?.({ agent });
		await expect((recorded.events.get("agent/disposed") ?? [])[0]?.({ agent })).resolves.toBeUndefined();
		// The plugin's own disposer then runs against an empty set, which must also be a no-op.
		const sessions = recorded.effects.find((effect) => effect.label === "ace-dsh: sessions");
		await expect((sessions?.disposer as () => Promise<void>)?.()).resolves.toBeUndefined();
	});

	it("mints a user message the host accepts, labelled as an ACE event", () => {
		const delivery: AceDelivery = {
			text: "<ace_event>\n<ace_body>\nhi\n</ace_event>",
			summary: "ACE event from ace:peer:dsh:p1",
			sender: "ace:peer:dsh:p1",
			eventId: "evt-1",
			channel: "ace:tester:dsh:s-1",
			activation: "next_turn",
		};

		// The same call `apply()` makes for every delivery: the source variant is this plugin's own, merged
		// into the host's `MessageSourceMap`, so an event in the record names its channel and event id.
		const message = createUserMessage({
			content: [{ type: "text", text: delivery.text }],
			source: {
				kind: "ace-event",
				sender: delivery.sender,
				eventId: delivery.eventId,
				channel: delivery.channel,
				activation: delivery.activation,
				form: "notice",
				summary: boundContextSummary(delivery.summary),
			},
		});

		expect(message.role).toBe("user");
		expect(message.id).toBeTruthy();
		expect(message.source.kind).toBe("ace-event");
		expect(message.source.sender).toBe("ace:peer:dsh:p1");
		expect(message.content).toEqual([{ type: "text", text: delivery.text }]);
		// The host freezes what it publishes; a mutation attempt is not the way to find out.
		expect(Object.isFrozen(message)).toBe(true);
	});
});

describe("the browser half's status route", () => {
	it("is one exact GET/HEAD Fetch route on Connection, answered per session", async () => {
		const recorded = newRecorded();
		const host = stubHost(recorded);
		apply(host as unknown as Context);
		const cwd = await configuredWorkspace();
		await (recorded.events.get("agent/created") ?? [])[0]?.({ agent: agentFor("s-1", cwd, host.scoped) });

		// It *waited* for Connection instead of reading it once: the regression this covers is a route that was
		// never registered because the service had not been composed yet when the plugin loaded.
		expect(recorded.injected).toEqual([["connection"]]);
		expect(recorded.routes.map((route) => route.path)).toEqual(["/api/ace.status"]);
		const route = recorded.routes[0];
		expect(route?.methods).toEqual(["GET", "HEAD"]);
		expect(route?.requestBody).toBe("buffered");

		// A session this plugin never opened reads as not live, and carries no other session's data.
		const unknown = await route?.fetch(new Request("http://127.0.0.1/api/ace.status?session=nope"));
		expect(await unknown?.json()).toEqual({ session: "nope", live: false, channels: [], servers: [] });

		// A configured session whose broker is unreachable is reported as not live — never as registered.
		const mine = await route?.fetch(new Request("http://127.0.0.1/api/ace.status?session=s-1"));
		expect(await mine?.json()).toMatchObject({ session: "s-1", live: false, channels: [] });

		// HEAD answers with the status and no body: the bridge does not synthesize that, the route owns it.
		const head = await route?.fetch(new Request("http://127.0.0.1/api/ace.status?session=s-1", { method: "HEAD" }));
		expect(head?.status).toBe(200);
		expect(await head?.text()).toBe("");
	});

	it("waits for Connection and registers no route when the profile has none", () => {
		const recorded = newRecorded();
		// A headless or SDK profile: the service never appears, and the plugin must still load.
		const host = stubHost(recorded, { connection: false });

		apply(host as unknown as Context);

		// It asked for the service rather than assuming it, and registered nothing when it never came.
		expect(recorded.injected).toEqual([["connection"]]);
		expect(recorded.routes).toEqual([]);
	});
});
