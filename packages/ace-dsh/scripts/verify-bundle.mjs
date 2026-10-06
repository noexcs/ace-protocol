#!/usr/bin/env node
/**
 * Verify the **installed artifact**: `lib/index.js` as the bundle built it, driven through the host's own
 * `defineTool`, over a real broker.
 *
 * `verify-live.ts` proves the source; this proves the thing that actually gets installed. It catches what a
 * source-level test cannot: a bundle that dropped a `redis` dependency, an `@deepseek-ai/*` import that
 * stopped resolving, a tool schema the host's compiler rejects, or a teardown that only works in TypeScript.
 *
 * Needs a broker and no model: `redis-server` on 6379, or `ACE_VERIFY_BROKER=redis://…`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "redis";

const BROKER = process.env.ACE_VERIFY_BROKER ?? "redis://127.0.0.1:6379";
const NAMESPACE = `acebundle-${process.pid}`;
const CODING_AGENT = "dsh";
const WAIT_MS = 10_000;

const plugin = await import("../lib/index.js");
if (plugin.name !== "ace-dsh" || typeof plugin.apply !== "function") {
	throw new Error(`unexpected plugin exports: ${Object.keys(plugin).join(", ")}`);
}

const results = [];
async function scenario(name, body) {
	try {
		results.push({ name, ok: true, detail: await body() });
		console.log(`  ok    ${name} — ${results.at(-1).detail}`);
	} catch (error) {
		results.push({ name, ok: false, detail: String(error) });
		console.log(`  FAIL  ${name} — ${String(error)}`);
	}
}

async function waitFor(what, condition) {
	const deadline = Date.now() + WAIT_MS;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out after ${WAIT_MS}ms waiting for ${what}`);
}

/** A stub host: it records what the plugin registers and lets the test fire the lifecycle events. */
function stubHost() {
	const recorded = {
		tools: [],
		commands: [],
		sections: [],
		events: new Map(),
		effects: [],
		routes: [],
		/** Every `ctx.inject(deps, …)`: the optional services the plugin waited for instead of reading once. */
		injected: [],
	};
	const scoped = {
		tools: {
			register: (definition) => {
				recorded.tools.push(definition);
				return () => {};
			},
		},
		commands: {
			register: (definition) => {
				recorded.commands.push(definition);
				return () => {};
			},
		},
		systemPrompt: {
			section: (section) => {
				recorded.sections.push(section);
				return () => {};
			},
		},
		on: (event, handler) => {
			recorded.events.set(event, [...(recorded.events.get(event) ?? []), handler]);
			return () => {};
		},
	};
	const ctx = {
		logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
		tools: scoped.tools,
		commands: scoped.commands,
		systemPrompt: scoped.systemPrompt,
		agents: { list: () => [] },
		// Cordis runs an effect's initializer immediately; the route the browser half reads is registered
		// inside one, so a stub that only stored the callback would hide the route entirely.
		effect: (callback, label) => {
			recorded.effects.push({ label: label ?? "", disposer: callback() });
			return () => {};
		},
		on: scoped.on,
		// Cordis: run the callback once its services exist. The plugin registers the chip's route this way, so a
		// stub that only answered `get()` would hide whether the plugin ever waited for Connection at all.
		inject: (deps, callback) => {
			recorded.injected.push([...deps]);
			return callback(ctx);
		},
		/** The exact Fetch-route registry the chip's data comes from. */
		get: (name) => {
			if (name === "connection") {
				return {
					fetch: {
						register: (route) => {
							recorded.routes.push(route);
							return () => {};
						},
					},
				};
			}
			return undefined;
		},
	};
	return { ctx, recorded, scoped };
}

/** A live agent that records what it was handed instead of running a turn. */
function fakeAgent(sessionId, cwd, scoped) {
	return {
		sessionId,
		received: [],
		agent: {
			status: "running",
			session: { id: sessionId, header: { cwd } },
			ctx: scoped,
			followup: (message) => {},
			steer: (message) => {},
			whenIdle: async () => {},
		},
	};
}

const workspace = await mkdtemp(join(tmpdir(), "ace-dsh-bundle-"));
const control = createClient({ url: BROKER });
const hosts = [];

try {
	await control.connect();
	await control.ping();
	await writeFile(
		join(workspace, ".ace.json"),
		`${JSON.stringify({ username: "verify", servers: { local: { url: BROKER, namespace: NAMESPACE } } })}\n`,
		"utf8",
	);

	console.log(`ACE bundled-artifact verification · ${plugin.name} · broker ${BROKER} · namespace ${NAMESPACE}`);

	/** Bring one session up through the bundled plugin, exactly as the host would. */
	async function open(sessionId, options) {
		const host = stubHost(options);
		hosts.push(host);
		plugin.apply(host.ctx);
		const cwd = workspace;
		const session = { sessionId, received: [], agent: null };
		const agent = fakeAgent(sessionId, cwd, host.scoped);
		// The plugin mints a real host `UserMessage` here, not a test double: its text lives in `content`, and
		// its provenance in `source` — which is the part of this path a source-level test cannot reach.
		const record = (kind) => (message) => {
			session.received.push({
				kind,
				text: (message?.content ?? []).map((block) => block.text ?? "").join(""),
				source: message?.source,
				frozen: Object.isFrozen(message ?? {}),
			});
		};
		agent.agent.followup = record("followup");
		agent.agent.steer = record("steer");
		session.agent = agent.agent;
		for (const handler of host.recorded.events.get("agent/created") ?? []) {
			await handler({ agent: agent.agent });
		}
		return { host, session, channel: `${NAMESPACE}:verify:${CODING_AGENT}:${sessionId}` };
	}

	const alice = await open("s-a");
	const bob = await open("s-b");

	await scenario("the bundled entry registers the four tools, the command and the trust policy", async () => {
		const names = alice.host.recorded.tools.map((tool) => tool.name);
		if (names.join(",") !== "ace_publish,ace_agents,ace_store_file,ace_get_file,ace_pending,ace_activate") {
			throw new Error(`tools: ${names.join(", ")}`);
		}
		if (alice.host.recorded.commands.length !== 1) throw new Error("the /ace command is not registered");
		if (alice.host.recorded.sections.length !== 1) throw new Error("the trust policy is not registered");
		return `${names.length} tools, /${alice.host.recorded.commands[0].name}, policy ${alice.host.recorded.sections[0].name}`;
	});

	
	
	
	
	await scenario("the chip's status route reports the live channel over the real registration", async () => {
		const route = alice.host.recorded.routes[0];
		if (route === undefined) throw new Error("no status route was registered");
		if (route.path !== "/api/ace.status") throw new Error(`route path: ${route.path}`);
		const response = await route.fetch(
			new Request(`http://127.0.0.1/api/ace.status?session=${encodeURIComponent("s-a")}`),
		);
		const status = await response.json();
		// This is the browser half's whole data source: the same channel the directory holds, for this session.
		if (status.live !== true) throw new Error(`live=${String(status.live)} (${JSON.stringify(status)})`);
		if (!Array.isArray(status.channels) || status.channels[0] !== alice.channel) {
			throw new Error(`channels: ${JSON.stringify(status.channels)}`);
		}
		const other = await (
			await route.fetch(new Request("http://127.0.0.1/api/ace.status?session=s-zzz"))
		).json();
		if (other.live !== false || other.channels.length !== 0) throw new Error("an unknown session reported live");
		return `${alice.channel} live, unknown session off`;
	});

	await scenario("the listing answers 'who else', not 'who am I'", async () => {
		const agents = alice.host.recorded.tools.find((tool) => tool.name === "ace_agents");
		if (agents === undefined) throw new Error("ace_agents is not registered");
		const text = String(
			await agents.execute({}, {
				signal: AbortSignal.timeout(WAIT_MS),
				agent: alice.session.agent,
				callId: "call-agents",
				name: "ace_agents",
				arguments: {},
				deferContext: () => {},
				concludeTurn: () => {},
			}),
		);
		// This is the check that caught a real defect: the listing used to include the caller's own channel,
		// which turns "publish to a peer" into "publish to yourself".
		if (text.includes(alice.channel)) throw new Error(`the caller's own channel is listed: ${text.split("\n")[1]}`);
		if (!text.includes(bob.channel)) throw new Error("the peer is missing from the listing");
		return "own channel excluded, peer listed";
	});

	await scenario("the bundled transports reach a real broker and register both channels", async () => {
		await waitFor("both channels in the directory", async () => {
			const members = await control.zRange(`${NAMESPACE}:agents`, 0, -1);
			return members.includes(alice.channel) && members.includes(bob.channel);
		});
		const members = await control.zRange(`${NAMESPACE}:agents`, 0, -1);
		return members.join(", ");
	});

	await scenario("a tool call through the host's own definition reaches the peer", async () => {
		const publish = alice.host.recorded.tools.find((tool) => tool.name === "ace_publish");
		if (publish === undefined) throw new Error("ace_publish is not registered");
		const exec = (args) => ({
			signal: AbortSignal.timeout(WAIT_MS),
			agent: alice.session.agent,
			callId: "call-1",
			name: "ace_publish",
			arguments: args,
			deferContext: () => {},
			concludeTurn: () => {},
		});
		// Both shapes ACE accepts, through the host's validator: one channel name, and a list of them.
		const text = await publish.execute(
			{ body: "bundle: build failed on main", channel: bob.channel },
			exec({ body: "bundle: build failed on main", channel: bob.channel }),
		);
		if (String(text).includes("stored=1") !== true) throw new Error(`publish said: ${String(text).split("\n")[0]}`);
		const listed = await publish.execute(
			{ body: "bundle: fan-out", channel: [bob.channel] },
			exec({ body: "bundle: fan-out", channel: [bob.channel] }),
		);
		if (String(listed).includes("stored=1") !== true) {
			throw new Error(`list publish said: ${String(listed).split("\n")[0]}`);
		}
		await waitFor("the peer to receive both", () => bob.session.received.length >= 2);
		const received = bob.session.received[0];
		if (received.text.includes("bundle: build failed on main") !== true) throw new Error("the body did not arrive");
		if (received.text.includes("<ace_event>") !== true) throw new Error("the event block was not rendered");
		// The provenance the host records: this is the plugin's own source variant, merged into the host's map.
		if (received.source?.kind !== "ace-event") throw new Error(`source kind: ${String(received.source?.kind)}`);
		if (received.source?.sender !== alice.channel) throw new Error(`source sender: ${String(received.source?.sender)}`);
		if (received.frozen !== true) throw new Error("the host did not freeze the message it was handed");
		return `bob received both as ${received.kind}, source ace-event from ${received.source.sender}`;
	});

	await scenario("agent/disposed withdraws the address and drops the stream", async () => {
		for (const host of hosts) {
			for (const handler of host.recorded.events.get("agent/disposed") ?? []) {
				await handler({ agent: host === alice.host ? alice.session.agent : bob.session.agent });
			}
		}
		const members = await control.zRange(`${NAMESPACE}:agents`, 0, -1);
		if (members.includes(alice.channel) || members.includes(bob.channel)) throw new Error(`still listed: ${members.join(", ")}`);
		const streams = await control.exists(`${NAMESPACE}:ch:${alice.channel}`, `${NAMESPACE}:ch:${bob.channel}`);
		if (streams !== 0) throw new Error("a stream outlived its session");
		return "directory empty, streams gone";
	});
} catch (error) {
	console.error(`fatal: ${error instanceof Error ? error.message : String(error)}`);
	results.push({ name: "setup", ok: false, detail: String(error) });
} finally {
	try {
		for await (const keys of control.scanIterator({ MATCH: `${NAMESPACE}:*` })) {
			if (keys.length > 0) await control.del(keys);
		}
	} catch (error) {
		console.error(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		if (control.isOpen) await control.quit().catch(() => control.destroy());
	}
	await rm(workspace, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
// Explicit: a handle the host or the broker leaves behind must not hang a verification run.
process.exit(failed.length === 0 ? 0 : 1);
