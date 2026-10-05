/**
 * Smoke test for the ACE Claude Code plugin.
 *
 * It runs the parts of the contract that are checkable without a signed-in session, and names
 * precisely what still needs a live Redis broker or the host channel — each gated, and skipped with
 * a reason when the dependency is absent:
 *
 *   1. The MCP server starts over stdio and answers the MCP handshake as a channel (the
 *      `claude/channel` capability), exposes the four ACE tools, and delivers its instructions —
 *      driven through the real `@modelcontextprotocol/sdk` Client, exactly the surface Claude Code
 *      uses to talk to it.
 *   2. The tools report inert with no `.ace.json`. With one present *and its broker reachable*, the
 *      runtime starts and they list the resolved channels. That half needs a live broker (the
 *      runtime's `start()` awaits the subscribe transport's `connect()`), so it skips when none is up.
 *   3. The `UserPromptSubmit` hook observes a `<ace_event>` block and appends it to the
 *      acknowledgement trail the server polls — the piece that makes "observed in the conversation"
 *      ack possible.
 *   4. The plugin manifest passes `claude plugin validate`.
 *   5. A full "publish an ACE event and watch it become a turn in a live session" run needs the host
 *      channel: Anthropic auth plus a `--channels`-capable Claude Code that will load this channel.
 *      That is gated and, when the flag is unavailable, this script prints the exact command instead.
 *
 * It never starts a Claude Code session, so it is safe to run anywhere the binary is present.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { channelStreamKey, directoryEntryKey, directoryKey, senderName } from "ace-runtime";
import { createClient } from "redis";
import * as z from "zod/v4";
import { ackFilePath, readNewTrail } from "../src/ack.ts";

const root = join(import.meta.dirname, "..");

let failures = 0;
const ok = (name: string) => console.log(`  ok    ${name}`);
const fail = (name: string, detail: string) => {
	failures += 1;
	console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
};
const section = (title: string) => console.log(`\n${title}`);

async function withClient(env: Record<string, string>, check: (client: Client) => Promise<void>): Promise<void> {
	const transport = new StdioClientTransport({
		command: "bun",
		args: ["run", "src/server.ts"],
		cwd: root,
		env,
	});
	const client = new Client({ name: "ace-smoke", version: "0.0.0" });
	try {
		await client.connect(transport);
		await check(client);
	} finally {
		await client.close().catch(() => {});
	}
}

function aceEventBlock(): string {
	return ["<ace_event>", "sender: ci", "channel: inbox", "id: evt_smoke", "Build failed on main", "</ace_event>"].join(
		"\n",
	);
}

/**
 * The resolved-channels half of check 2 needs a live broker: the runtime's `start()` awaits the
 * subscribe transport's `connect()`, which throws once its bounded reconnect budget is spent. A
 * broker-less run would start the server, but `ace_channels` would report not running and the check
 * would fail — so probe the configured broker first and skip (not fail) when it is absent. The probe is
 * a plain TCP connect, so a non-Redis listener on the port counts as reachable; that still produces no
 * false pass — the real check then FAILS once the transport's bounded reconnect budget is spent.
 */
async function brokerReachable(configText: string, timeoutMs = 500): Promise<boolean> {
	let url: string | undefined;
	try {
		const config = JSON.parse(configText) as { servers?: Record<string, { url?: string }> };
		url = Object.values(config.servers ?? {})[0]?.url;
	} catch {
		return false;
	}
	if (url === undefined) return false;
	const target = new URL(url);
	const port = Number(target.port) || 6379;
	return await new Promise<boolean>((resolve) => {
		const socket = tcpConnect({ host: target.hostname, port });
		let settled = false;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(ok);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		socket.setTimeout(timeoutMs, () => finish(false));
	});
}

async function main(): Promise<void> {
	console.log("ACE Claude Code plugin — smoke test");

	// The broker-less paths need no .ace.json; the happy path reuses the shipped example so the smoke
	// and the README point at the same configuration.
	const workDir = mkdtempSync(join(tmpdir(), "ace-smoke-"));
	const exampleConfig = readFileSync(join(root, "example/.ace.json"), "utf8");

	section("1. MCP server: handshake, channel capability, tools, instructions");
	await withClient({ CLAUDE_PROJECT_DIR: workDir }, async (client) => {
		const version = client.getServerVersion();
		if (version?.name === "ace") ok("server answers the handshake as `ace`");
		else fail("server name", `got ${version?.name ?? "(none)"}`);

		const caps = client.getServerCapabilities();
		if (caps?.experimental?.["claude/channel"] !== undefined) ok("declares the `claude/channel` capability");
		else fail("channel capability", `capabilities: ${JSON.stringify(caps)}`);

		const { tools } = await client.listTools();
		const names = tools.map((tool) => tool.name).sort();
		if (JSON.stringify(names) === JSON.stringify(["ace_activate", "ace_channels", "ace_pending", "ace_publish"])) {
			ok("exposes the four ACE tools");
		} else {
			fail("tool list", `got ${JSON.stringify(names)}`);
		}

		const instructions = client.getInstructions() ?? "";
		if (instructions.includes('<channel source="plugin:ace-claude-code:ace" ace="event">')) {
			ok("instructions name the channel wrapper the model will see");
		} else {
			fail("instructions", 'missing the `<channel source=... ace="event">` block');
		}
	});

	section("2. Tools: inert without .ace.json; resolved channels with one (broker-gated)");
	// The server's startup pass runs once, at spawn: with no `.ace.json` the tools are inert, and with
	// one present — *and its broker reachable* — the runtime starts asynchronously right after the MCP
	// connect, so each sub-check spawns a fresh server over the state it wants and polls the tools until
	// they report live (or fails, bounded).
	const channelsText = async (client: Client): Promise<string> => {
		const result = (await client.callTool({ name: "ace_channels", arguments: {} })) as {
			content: Array<{ text: string }>;
		};
		return result.content.map((part) => part.text).join("\n");
	};
	// The server populates its tool context only once its (async) startup pass resolves; that races the
	// client's first tool call. Poll the real condition — the tools report live channels — instead of
	// sleeping a guessed amount. Bounded so a genuinely broken start still fails the check.
	const pollLive = async (client: Client): Promise<string> => {
		let text = "";
		for (let attempt = 0; attempt < 25; attempt++) {
			text = await channelsText(client);
			if (!/not running/i.test(text)) break;
			await sleep(80);
		}
		return text;
	};
	const waitForLiveChannels = async (env: Record<string, string>): Promise<string> => {
		const { promise, resolve } = Promise.withResolvers<string>();
		void withClient(env, (client) => pollLive(client).then(resolve));
		return promise;
	};
	await withClient({ CLAUDE_PROJECT_DIR: workDir }, async (client) => {
		const text = await channelsText(client);
		if (/not running/i.test(text)) ok("ace_channels reports inert when there is no .ace.json");
		else fail("ace_channels (inert)", `got: ${text}`);
	});
	const configuredDir = mkdtempSync(join(tmpdir(), "ace-smoke-cfg-"));
	writeFileSync(join(configuredDir, ".ace.json"), exampleConfig);
	if (await brokerReachable(exampleConfig)) {
		const text = await waitForLiveChannels({ CLAUDE_PROJECT_DIR: configuredDir });
		if (text.includes("ace:claude:inbox")) {
			ok("ace_channels lists the resolved channel names");
		} else {
			fail("ace_channels (resolved)", `got: ${text}`);
		}
	} else {
		console.log("  SKIP  no broker is reachable at the example config's Redis URL; the resolved-channels");
		console.log("        check needs one (the runtime's start() awaits the subscribe transport's connect()).");
		console.log("        Start Redis on that URL and re-run, or run it alongside ace-runtime's live verify.");
	}

	section("3. UserPromptSubmit hook: observes an <ace_event> block into the ack trail");
	await (async () => {
		const prompt = `go ahead\n<channel source="plugin:ace-claude-code:ace" ace="event">\n${aceEventBlock()}\n</channel>`;
		const hook = spawn("bun", [join(root, "src/hook-observe.ts")], { cwd: root });
		hook.stdin.write(JSON.stringify({ prompt, cwd: workDir }));
		hook.stdin.end();
		const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number>();
		hook.on("exit", (c) => resolveExit(c ?? 1));
		const code = await exited;
		const trail = await readNewTrail(workDir, 0);
		const trailText = trail.observations.map((o) => o.blocks.join(" ")).join("\n");
		if (code === 0 && trail.observations.length === 1 && trailText.includes("Build failed on main")) {
			ok("hook ran, wrote the block to the ack trail, and exited 0");
		} else {
			fail(
				"hook ack trail",
				`exit=${code} observations=${trail.observations.length} trail=${trailText || "(empty)"} file=${ackFilePath(workDir)}`,
			);
		}
	})();

	section("4. Manifest: claude plugin validate");
	await (async () => {
		const claude = resolveClaude();
		if (!claude) {
			// Do not return: section 4b below needs only the broker, and an early return would make the
			// directory coverage disappear silently on any machine without the binary.
			console.log("  SKIP  no `claude` binary on PATH");
		} else {
			const output = runCommand(claude, ["plugin", "validate", root]);
			if (output.ok) ok("manifest validation passed");
			else fail("manifest validation", output.text.split("\n").pop() ?? "");
		}
		section("4b. Agent directory (broker-gated): register, direct delivery, shutdown cleanup");
		// The live half of the directory contract: the session registers the channel named by its
		// sender in the agent directory, a peer delivers one event to that channel's stream, and the
		// shutdown removes the entry and its stream. Gated on the broker; every step is bounded, so a
		// slow broker fails the check instead of hanging the run.
		const liveRedis = "redis://127.0.0.1:6379";
		// A per-run namespace: two concurrent runs against one broker must not share keys, or one run's
		// shutdown cleanup drops the stream out from under the other's reader. A namespace may not
		// contain colons (it is the first name segment), so the run tag is a bare hex suffix.
		const namespace = `acesmoke${Math.random().toString(16).slice(2)}`;
		const registryConfigText = JSON.stringify({
			username: "smoke",
			servers: { local: { url: liveRedis, namespace } },
			subscribe: [],
			defaultActivation: "next_turn",
		});
		if (!(await brokerReachable(registryConfigText))) {
			console.log("  SKIP  no broker reachable for the registry smoke; the registration, direct-delivery and");
			console.log("        shutdown-cleanup checks need one (start Redis and re-run).");
		} else {
			// A channel name is the address: the session registers the channel named by its sender, and
			// everything else — stream key, group, directory keys — is derived from that name.
			const sender = senderName({
				namespace,
				username: "smoke",
				codingAgent: "claude-code",
				sessionId: "smoke-1",
			});
			const channelStream = channelStreamKey(namespace, sender);
			const directoryMembers = directoryKey(namespace);
			const directoryEntries = directoryEntryKey(namespace);
			const registryDir = mkdtempSync(join(tmpdir(), "ace-smoke-reg-"));
			try {
				writeFileSync(join(registryDir, ".ace.json"), registryConfigText);
				const peer = createClient({ url: liveRedis });
				await peer.connect();
				await withClient({ CLAUDE_PROJECT_DIR: registryDir, CLAUDE_CODE_SESSION_ID: "smoke-1" }, async (client) => {
					// The channel push arrives as an MCP notification; the host is what turns it into a
					// turn, so the smoke collects it and stands in for the host's observation step.
					const channelEvents: string[] = [];
					client.setNotificationHandler(
						z.object({ method: z.literal("notifications/claude/channel"), params: z.looseObject({}) }),
						(notification) => {
							const content = (notification.params as { content?: unknown } | undefined)?.content;
							if (typeof content === "string") channelEvents.push(content);
						},
					);
					// The registration happens in the server's async startup pass, after the MCP connect;
					// poll the observable fact instead of sleeping a guessed amount.
					let registered = false;
					for (let attempt = 0; attempt < 100 && !registered; attempt++) {
						const result = (await client.callTool({ name: "ace_channels", arguments: {} })) as {
							content: Array<{ text: string }>;
						};
						const text = result.content.map((part) => part.text).join("\n");
						// The tool listing carries labels, not addresses (by design); the sender name is
						// asserted against the channel instructions below.
						registered = text.includes("session-inbox");
						if (!registered) await sleep(100);
					}
					if (!registered) {
						fail("directory registration", "ace_channels never listed the derived session-inbox for the sender");
						return;
					}
					ok("ace_channels lists the derived session-inbox named by the sender");
					const instructions = client.getInstructions() ?? "";
					if (instructions.includes(`"${sender}"`)) ok("channel instructions name the channel for direct events");
					else fail("channel instructions (channel)", "the channel name is not in the instructions");

					// Directory state, straight from Redis: the presence ZSet, and the entry hash whose
					// value is the channel's self-description.
					const zscore = await peer.zScore(directoryMembers, sender);
					const entryRaw = await peer.hGet(directoryEntries, sender);
					if (
						zscore !== null &&
						zscore > Date.now() &&
						typeof entryRaw === "string" &&
						entryRaw.includes("direct messages addressed to me")
					) {
						ok(`directory holds the channel (zset score, ${directoryEntries} hash)`);
					} else {
						fail("directory entry", `zscore=${String(zscore)} entry=${entryRaw ?? "(none)"}`);
					}
					const memberGroupInfo = await peer.xInfoGroups(channelStream).catch(() => undefined);
					const groupCount = memberGroupInfo?.find((g) => g.name === sender)?.consumers ?? -1;
					if (groupCount >= 0) ok(`consumer group ${sender} exists on ${channelStream}`);
					else fail("consumer group", `${sender} was not created on ${channelStream}`);

					// Direct delivery: a peer publishes to the channel named by this session's sender; the
					// runtime must deliver it through the derived session-inbox subscription. The block
					// the server pushes is exactly what the engine keyed the observation on, so the smoke
					// captures it from the notification rather than re-deriving the render.
					const peerMessage = {
						aceVersion: "0.1",
						id: "evt_smoke_direct",
						sender: "smoke-peer",
						sessionId: "smoke-peer-sess",
						activation: "next_turn",
						body: "direct delivery check",
					};
					await peer.xAdd(channelStream, "*", { message: JSON.stringify(peerMessage) });
					let rendered: string | undefined;
					for (let attempt = 0; attempt < 150 && rendered === undefined; attempt++) {
						const hit = channelEvents.find((text) => text.includes("id: evt_smoke_direct"));
						rendered = hit;
						if (rendered === undefined) await sleep(100);
					}
					if (rendered === undefined) {
						fail("direct delivery", "the channel stream produced no channel notification");
						return;
					}
					ok("direct event from the sender's channel stream became a channel notification");
					// First the entry must show up in the group's PEL (delivered, awaiting the
					// observation), so a fast ack poll cannot be fooled by an entry that was never read.
					let delivered = false;
					for (let attempt = 0; attempt < 150 && !delivered; attempt++) {
						delivered = ((await peer.xPending(channelStream, sender).catch(() => null))?.pending ?? 0) >= 1;
						if (!delivered) await sleep(100);
					}
					// The host's observation step, simulated: the hook would have seen the block in the
					// self-started prompt and appended it to the trail; the poller then feeds the observer,
					// and only then does the runtime ack the broker.
					mkdirSync(join(registryDir, ".ace"), { recursive: true });
					appendFileSync(
						ackFilePath(registryDir),
						`${JSON.stringify({ t: new Date().toISOString(), blocks: [rendered], prompt: rendered })}\n`,
					);
					let acked = false;
					for (let attempt = 0; attempt < 150 && !acked; attempt++) {
						acked = (await peer.xPending(channelStream, sender).catch(() => null))?.pending === 0;
						if (!acked) await sleep(100);
					}
					if (!delivered) fail("direct delivery (PEL)", "the entry never entered the group's pending list");
					if (acked) ok("entry left the PEL once the observation landed (broker acknowledged)");
					else fail("ack after observation", "the entry was still pending after 15s");
				});
				// `client.close()` sent SIGTERM (the SDK ends stdin, then signals): the shutdown order is
				// stop -> unregister -> close, so the entry and the stream must both be gone from Redis.
				let gone = false;
				for (let attempt = 0; attempt < 100 && !gone; attempt++) {
					const score = await peer.zScore(directoryMembers, sender);
					const entryLeft = await peer.hExists(directoryEntries, sender);
					const streamLeft = await peer.exists(channelStream);
					gone = score === null && entryLeft === 0 && streamLeft === 0;
					if (!gone) await sleep(100);
				}
				if (gone) ok("shutdown removed the directory entry and dropped the channel's stream");
				else
					fail(
						"shutdown cleanup",
						`zscore=${String(await peer.zScore(directoryMembers, sender))} entry=${String(
							await peer.hExists(directoryEntries, sender),
						)} stream=${String(await peer.exists(channelStream))}`,
					);
				await peer.quit();
			} finally {
				// Clean up even when an assertion or the client threw: a leaked temp workspace is
				// invisible, a leaked directory entry is not.
				rmSync(registryDir, { recursive: true, force: true });
			}
		}
	})();

	section("5. Live channel (gated)");
	const claude = resolveClaude();
	if (!claude) {
		console.log("  SKIP  no `claude` binary on PATH — nothing further to run");
	} else {
		const help = runCommand(claude, ["--help"]);
		// These flags are hidden from `--help` on builds that support them, so a missing string proves
		// nothing. Probe by parsing instead: a rejected flag fails with an unknown-option error before
		// anything else runs, while anything else (including "not logged in") means the flag parsed.
		const probe = runCommand(claude, [
			"--dangerously-load-development-channels",
			"plugin:probe@probe",
			"-p",
			"probe",
		]);
		const advertised = help.ok && /--dangerously-load-development-channels/.test(help.text);
		const rejected = /unknown option|unexpected argument|unknown flag|invalid option/i.test(probe.text);
		const canLoadChannels = advertised || !rejected;
		if (!canLoadChannels) {
			console.log(
				"  SKIP  this Claude Code does not accept `--dangerously-load-development-channels` (the flag was rejected).",
			);
			console.log("        A full run needs Anthropic auth (claude.ai or a Console API key) and, for this");
			console.log("        channel, the development flag (a `--plugin-dir` load registers as `<name>@inline`):");
			console.log("        From the session directory, run:");
			console.log(
				`          claude --dangerously-load-development-channels plugin:ace-claude-code@inline --plugin-dir ${root}`,
			);
			console.log("        then publish an ACE event to a subscribed channel's stream (or send this session a");
			console.log(
				'        direct event at the channel named by its sender) and watch it arrive as a <channel ... ace="event"> block that starts a turn.',
			);
		} else {
			console.log(
				"  OK    the host can load custom channels; run the command printed in the README for the live check.",
			);
		}
	}

	console.log("");
	if (failures > 0) {
		console.log(`${failures} check(s) failed.`);
		process.exitCode = 1;
	} else {
		console.log("All runnable checks passed.");
	}
	for (const dir of [workDir, configuredDir]) rmSync(dir, { recursive: true, force: true });
}

function resolveClaude(): string | undefined {
	const fromEnv = process.env.CLAUDE_BIN;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	// `which` is the portable way to find a PATH binary across shells.
	const probe = spawnSync("which", ["claude"]);
	if (probe.status === 0) {
		const path = probe.stdout.toString().trim();
		if (path && existsSync(path)) return path;
	}
	return undefined;
}

function runCommand(command: string, args: string[]): { ok: boolean; text: string } {
	const child = spawnSync(command, args, { encoding: "utf8" });
	const text = `${child.stdout ?? ""}${child.stderr ?? ""}`.trim();
	return { ok: child.status === 0, text };
}

main().catch((error) => {
	console.error(`smoke failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	process.exitCode = 1;
});
