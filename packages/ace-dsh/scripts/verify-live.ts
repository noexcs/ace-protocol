/**
 * Live verification: two real sessions, one real Redis Streams broker, no model.
 *
 * The unit tests fake the broker; this script does not. It writes a real `.ace.json`, opens two sessions
 * through the same code path the plugin uses (real transports, real registry, real Redis), and checks the
 * five things that only a broker can answer: that the directory lists both channels, that an event
 * published by one session reaches the other's conversation, that `manual` retains instead of delivering
 * until it is activated, that a self-publish comes back marked as an echo, and that closing a session
 * withdraws its address and its stream.
 *
 * Needs a broker but no credentials and no model: `redis-server` on 6379, or `ACE_VERIFY_BROKER=redis://…`.
 * Every key it creates lives under a run-specific namespace and is deleted at the end.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "redis";
import type { AceDelivery, DshAgentPort, DshAgentStatus } from "../src/dsh.ts";
import { DshAgentEngine } from "../src/engine.ts";
import { AceSession } from "../src/session.ts";
import { ACE_TOOL_DESCRIPTORS, type AceToolDescriptor } from "../src/tools.ts";
import { channelStreamKey, directoryKey, resolveAceConfig } from "../vendor/ace-runtime/dist/index.js";

const BROKER = process.env.ACE_VERIFY_BROKER ?? "redis://127.0.0.1:6379";
const NAMESPACE = `aceverify-${process.pid}`;
const WAIT_MS = 10_000;

/** A session that records what it was handed instead of running a turn. */
class RecordingAgent implements DshAgentPort {
	status: DshAgentStatus = "running";
	readonly received: Array<{ kind: "followup" | "steer"; text: string }> = [];
	readonly sessionId: string;
	readonly cwd: string;

	constructor(sessionId: string, cwd: string) {
		this.sessionId = sessionId;
		this.cwd = cwd;
	}

	followup(message: unknown): void {
		this.received.push({ kind: "followup", text: textOf(message) });
	}

	steer(message: unknown): void {
		this.received.push({ kind: "steer", text: textOf(message) });
	}

	async whenIdle(): Promise<void> {}

	onRunError(): () => void {
		return () => {};
	}
}

function textOf(message: unknown): string {
	return typeof message === "object" && message !== null && "text" in message
		? String((message as { text: unknown }).text)
		: "";
}

function tool(name: string): AceToolDescriptor {
	const found = ACE_TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === name);
	if (found === undefined) throw new Error(`no such tool: ${name}`);
	return found;
}

/** Wait for a condition the broker settles asynchronously, or report that it never did. */
async function waitFor(what: string, condition: () => boolean): Promise<void> {
	const deadline = Date.now() + WAIT_MS;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out after ${WAIT_MS}ms waiting for ${what}`);
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
async function scenario(name: string, body: () => Promise<string>): Promise<void> {
	try {
		const detail = await body();
		results.push({ name, ok: true, detail });
		console.log(`  ok    ${name} — ${detail}`);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		results.push({ name, ok: false, detail });
		console.log(`  FAIL  ${name} — ${detail}`);
	}
}

const workspace = await mkdtemp(join(tmpdir(), "ace-dsh-live-"));
const control = createClient({ url: BROKER });
const sessions: AceSession[] = [];
const problems: string[] = [];

try {
	await control.connect();
	await control.ping();

	await writeFile(
		join(workspace, ".ace.json"),
		`${JSON.stringify(
			{
				username: "verify",
				servers: { local: { url: BROKER, namespace: NAMESPACE } },
			},
			null,
			"\t",
		)}\n`,
		"utf8",
	);
	const config = resolveAceConfig({ cwd: workspace });

	console.log(`ACE live verification · broker ${BROKER} · namespace ${NAMESPACE}`);
	console.log(`  config ${config.source}`);

	async function open(sessionId: string) {
		const agent = new RecordingAgent(sessionId, workspace);
		const engine = new DshAgentEngine({
			agent,
			buildMessage: (delivery: AceDelivery) => ({ text: delivery.text, summary: delivery.summary }),
		});
		const session = await AceSession.open({
			engine,
			config,
			sessionId,
			codingAgent: "dsh",
			cwd: workspace,
			onProblem: (message, error) => problems.push(error === undefined ? message : `${message}: ${error}`),
		});
		sessions.push(session);
		return { session, agent };
	}

	const alice = await open("s-live-a");
	const bob = await open("s-live-b");
	const aliceChannel = alice.session.senders[0] ?? "";
	const bobChannel = bob.session.senders[0] ?? "";

	await scenario("directory lists both live channels", async () => {
		const listed = (await alice.session.listPeers()).map(({ entry }) => entry.channel).sort();
		if (listed.length !== 2) throw new Error(`expected 2 entries, saw ${listed.length}: ${listed.join(", ")}`);
		if (!listed.includes(aliceChannel) || !listed.includes(bobChannel)) {
			throw new Error(`missing a channel: ${listed.join(", ")}`);
		}
		return `${listed.join(", ")}`;
	});

	await scenario("a published event reaches the peer's conversation", async () => {
		const text = await tool("ace_publish").run(
			{ body: "live: build failed on main", channel: bobChannel },
			alice.session,
		);
		if (!text.includes("stored=1")) throw new Error(`publish reported: ${text.split("\n")[0]}`);
		await waitFor("the peer to receive it", () => bob.agent.received.length > 0);
		const received = bob.agent.received[0];
		if (received?.text.includes("live: build failed on main") !== true) throw new Error("body did not arrive");
		if (!received.text.includes(`sender: ${aliceChannel}`)) throw new Error("sender was not the publisher's channel");
		return `bob received it as ${received.kind}`;
	});

	await scenario("a manual event is retained, not delivered, until activated", async () => {
		const before = bob.agent.received.length;
		await tool("ace_publish").run(
			{ body: "live: hold this one", activation: "manual", channel: bobChannel },
			alice.session,
		);
		await waitFor("the event to be retained", () => bob.session.runtime.pendingEvents.length > 0);
		if (bob.agent.received.length !== before) throw new Error("a manual event was delivered anyway");
		const pending = bob.session.runtime.pendingEvents[0];
		if (pending === undefined) throw new Error("nothing was retained");
		await bob.session.runtime.activatePendingEvent(pending.message.sender, pending.message.id);
		await waitFor("the activated event to arrive", () => bob.agent.received.length > before);
		if (bob.agent.received.at(-1)?.text.includes("live: hold this one") !== true) {
			throw new Error("the activated event is not the retained one");
		}
		return `retained as ${pending.message.id}, delivered on activation`;
	});

	await scenario("publishing to a channel this session reads comes back as a self-echo", async () => {
		const before = alice.agent.received.length;
		await tool("ace_publish").run({ body: "live: note to self", channel: aliceChannel }, alice.session);
		await waitFor("the echo to arrive", () => alice.agent.received.length > before);
		const echo = alice.agent.received.at(-1);
		if (echo?.text.includes("self: yes") !== true) throw new Error("the echo was not marked `self: yes`");
		return "marked self: yes";
	});

	await scenario("a non-conforming message is dropped, not injected", async () => {
		const before = bob.agent.received.length;
		await control.xAdd(channelStreamKey(NAMESPACE, bobChannel), "*", { message: '{"aceVersion":"0.1"}' });
		await new Promise((resolve) => setTimeout(resolve, 750));
		if (bob.agent.received.length !== before) throw new Error("an invalid message reached the agent");
		return "dropped without a delivery";
	});

	await scenario("closing a session withdraws its address and its stream", async () => {
		const streamKey = channelStreamKey(NAMESPACE, aliceChannel);
		await alice.session.stop();
		const members = await control.zRange(directoryKey(NAMESPACE), 0, -1);
		if (members.includes(aliceChannel)) throw new Error("the channel is still listed");
		if ((await control.exists(streamKey)) !== 0) throw new Error("the stream still exists");
		return "entry gone, stream gone";
	});

	await scenario("a session with no reachable broker stays down instead of half-live", async () => {
		const unreachable = await AceSession.open({
			engine: new DshAgentEngine({
				agent: new RecordingAgent("s-live-down", workspace),
				buildMessage: (delivery: AceDelivery) => ({ text: delivery.text }),
			}),
			config: {
				...config,
				servers: [{ name: "down", url: "redis://127.0.0.1:1", namespace: NAMESPACE }],
			},
			sessionId: "s-live-down",
			codingAgent: "dsh",
			cwd: workspace,
			onProblem: () => {},
		});
		try {
			if (unreachable.live) throw new Error("a session came up on an unreachable server");
			return "not live, nothing registered";
		} finally {
			await unreachable.stop();
		}
	});
} catch (error) {
	console.error(`fatal: ${error instanceof Error ? error.message : String(error)}`);
	results.push({ name: "setup", ok: false, detail: String(error) });
} finally {
	for (const session of sessions) await session.stop().catch(() => {});
	try {
		if (control.isOpen) {
			if (process.env.ACE_VERIFY_DEBUG === "1") {
				// Every session has been stopped by now, so the broker should know exactly one client: this script's
				// own. A higher count is a session client that was never closed.
				const clients: unknown = await control.clientList();
				const lines = (Array.isArray(clients) ? clients : String(clients).split("\n"))
					.map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
					.map((line) => line.replace(/\s+/g, " ").slice(0, 120))
					.filter((line) => line !== "");
				console.log(`  broker clients after teardown: ${lines.length}`);
				for (const line of lines) console.log(`    ${line}`);
			}
			// node-redis v6 yields one *array* of keys per scan step, so the delete takes the batch, not one key.
			for await (const keys of control.scanIterator({ MATCH: `${NAMESPACE}:*` })) {
				if (keys.length > 0) await control.del(keys);
			}
		}
	} catch (error) {
		console.error(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		// Outside the scan's own error path: a cleanup failure must not leave this socket open and the process
		// hanging, which is exactly what a leaked connection looks like from the outside.
		if (control.isOpen) await control.quit().catch(() => control.destroy());
	}
	await rm(workspace, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
if (process.env.ACE_VERIFY_DEBUG === "1") {
	// Anything still holding the event loop open is a leaked handle, and a plugin that leaks one is worth
	// knowing about before it is installed.
	console.log(`  active resources: ${process.getActiveResourcesInfo().join(", ")}`);
	const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
	for (const handle of handles) {
		const candidate = handle as {
			constructor?: { name?: string };
			_idleTimeout?: number;
			_onTimeout?: () => void;
			remoteAddress?: string;
			remotePort?: number;
			localPort?: number;
		};
		const name = candidate.constructor?.name ?? "?";
		if (name === "Timeout") {
			console.log(
				`    Timeout ${candidate._idleTimeout}ms :: ${(candidate._onTimeout?.toString() ?? "?").replace(/\s+/g, " ").slice(0, 140)}`,
			);
		} else {
			console.log(
				`    ${name} ${candidate.remoteAddress ?? "-"}:${candidate.remotePort ?? "-"} local=${candidate.localPort ?? "-"}`,
			);
		}
	}
}
console.log(
	`\n${results.length - failed.length}/${results.length} scenarios passed` +
		(problems.length === 0 ? "" : ` · ${problems.length} runtime problem(s):\n  ${problems.join("\n  ")}`),
);
process.exitCode = failed.length === 0 ? 0 : 1;
