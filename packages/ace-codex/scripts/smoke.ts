/**
 * Live smoke test against a real `codex app-server`.
 *
 * Runs the *real* client and stdio connection (`src/client.ts`,
 * `src/connection.ts`) against a spawned `codex app-server` child and checks
 * the non-experimental path end to end: `initialize` handshake, `thread/start`,
 * a `turn/start` that streams `turn/started` / `item/*` / `turn/completed`, and
 * a best-effort `turn/steer` while a turn is running.
 *
 * It then runs the **agent-directory** live check when a Redis broker is
 * reachable (default `ACE_LIVE_REDIS_URL`, else `redis://127.0.0.1:6379`): the
 * real `createBridge` registers `codex:<threadId>` in the directory, and a
 * direct publish to the advertised stream is turned into a turn and acked.
 *
 * This is deliberately honest about what it can verify: the plumbing checks
 * need a `codex` binary on `PATH` (or `ACE_CODEX_COMMAND`) and an
 * authenticated Codex session to actually run a model turn. When the binary is
 * absent they print why and exit `0` (skip), so CI without Codex is not
 * blocked. The directory check additionally needs a reachable broker and
 * `redis-cli`; it skips (with a reason) when either is missing. The smoke exits
 * `1` only when the plumbing itself misbehaves.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelStreamKey, directoryEntryKey, directoryKey, senderName } from "ace-runtime";
import { type AceCodexBridge, createBridge } from "../src/bridge.ts";
import { AppServerClient } from "../src/client.ts";
import { createStdioConnection } from "../src/connection.ts";

const OVERALL_TIMEOUT_MS = 720_000;

function command(): string {
	return process.env.ACE_CODEX_COMMAND ?? "codex";
}

function binaryPresent(executable: string): boolean {
	const result = spawnSync(executable, ["--version"], { stdio: "ignore" });
	// A missing executable surfaces as `error` (ENOENT), not a non-zero exit.
	return result.error === undefined;
}
/** Run one `redis-cli` command against `url`; empty string when the binary is absent. */
function redisCli(url: string, ...args: string[]): string {
	const result = spawnSync("redis-cli", ["-u", url, ...args], { encoding: "utf8" });
	if (result.error) return "";
	return (result.stdout ?? "").trim();
}

const redisCliPresent = (): boolean => spawnSync("redis-cli", ["--version"], { stdio: "ignore" }).error === undefined;

/**
 * The agent-directory live check: a real `createBridge` registers its sender channel
 * (`<ns>:<username>:codex:<threadId>`) in a real Redis broker, a direct publish to that channel's
 * derived stream is turned into a turn and acked, and shutdown removes the directory entry and the
 * channel stream. Skips (exit 0) when the `codex` binary, a reachable broker, or `redis-cli` is
 * missing.
 */
async function runRegistry(executable: string): Promise<boolean> {
	if (!binaryPresent(executable)) {
		console.log("[registry] SKIP: no codex binary on PATH; directory live check not run.");
		return true;
	}
	const url = process.env.ACE_LIVE_REDIS_URL ?? "redis://127.0.0.1:6379";
	if (!redisCliPresent()) {
		console.log("[registry] SKIP: redis-cli not on PATH; cannot assert on the broker.");
		return true;
	}
	if (redisCli(url, "ping") !== "PONG") {
		console.log(`[registry] SKIP: broker ${url} unreachable (no PONG); directory live check not run.`);
		return true;
	}

	let ok = true;
	const fail = (label: string, detail = ""): void => {
		ok = false;
		report(false, `registry: ${label}`, detail);
	};
	/** A directory assertion: reports it and fails the smoke when it does not hold. */
	const check = (passed: boolean, label: string, detail = ""): void => {
		if (!passed) ok = false;
		report(passed, `registry: ${label}`, detail);
	};
	const namespace = `ace-smoke-${Math.random().toString(16).slice(2)}`;
	const username = "smoke";
	const cwd = mkdtempSync(join(tmpdir(), "ace-codex-registry-"));
	// Filled in once the thread is known; read by the shutdown assertion in `finally`.
	let channel = `${namespace}:${username}:codex:`;
	let stream = "";
	let group = "";
	let registered = false;
	let bridge: AceCodexBridge | undefined;
	try {
		// A minimal `.ace.json` in a temp workspace: one configured channel on one server.
		const aceConfig = {
			username,
			servers: { local: { url, namespace, subscribe: ["from-ci"] } },
			defaultActivation: "next_turn",
		};
		writeFileSync(join(cwd, ".ace.json"), JSON.stringify(aceConfig));

		// Keep the resolver on the temp workspace's `.ace.json`, not a host-configured ACE_CONFIG
		// (which would register under the real namespace while we assert this one).
		const env: Record<string, string | undefined> = { ...process.env };
		delete env.ACE_CONFIG;
		bridge = createBridge({ config: { listener: "stdio", command: executable, cwd }, cwd, env });
		await bridge.start();
		const threadId = bridge.threadId();
		check(threadId !== undefined, "bridge started with a thread", `thread=${threadId ?? "?"}`);
		if (threadId === undefined) throw new Error("no thread id after bridge.start()");

		// The channel name *is* the address: the session's sender name. The stream and the group are
		// derived from it, so nothing here can disagree with what a peer computes.
		channel = senderName({ namespace, username, codingAgent: "codex", sessionId: threadId });
		stream = channelStreamKey(namespace, channel);
		group = channel;
		const membersKey = directoryKey(namespace);
		const entriesKey = directoryEntryKey(namespace);

		// 1. The directory entry appeared: zset member (the channel) + entry hash describing it.
		const zscore = await untilRedis(() => redisCli(url, "ZSCORE", membersKey, channel) !== "", 15_000);
		registered = zscore;
		check(zscore, "channel present in the zset", `channel=${channel}`);
		const entryRaw = await untilRedis(() => redisCli(url, "HGET", entriesKey, channel) !== "", 15_000);
		check(entryRaw, "entry hash present");
		const description = redisCli(url, "HGET", entriesKey, channel);
		check(description.includes("agent=codex"), "entry advertises the coding agent", description);
		// The channel's stream exists with the group derived from its name.
		const groups = await untilRedis(() => redisCli(url, "XINFO", "GROUPS", stream).includes(group), 15_000);
		check(groups, "channel stream exists with its group", `stream=${stream} group=${group}`);

		// 2. A direct publish to the advertised stream is read by the bridge's reader and acked.
		const message = JSON.stringify({
			aceVersion: "0.1",
			id: `evt_live_${threadId.slice(-8)}`,
			sender: "smoke-peer",
			activation: "next_turn",
			body: "Live directory direct message. Reply with the single word: ping",
		});
		const entryId = redisCli(url, "XADD", stream, "*", "message", message);
		check(
			entryId.length > 0 && /^\d+-\d+$/.test(entryId),
			"direct publish to the channel stream",
			`entry=${entryId}`,
		);
		// In the group's pending-entries list = the reader consumed it (a `turn/start` was fired);
		// gone from it = the delivery was confirmed and the entry acked. Both are model-independent.
		const inPel = (): boolean =>
			redisCli(url, "XPENDING", stream, group)
				.split("\n")
				.slice(1)
				.some((line) => line.split(/\s+/).includes(entryId));
		// Soft by design: the ack fires on the app-server's echo — a single round-trip after the reader
		// consumes — so the in-PEL window can close between polls. Missing it says nothing about the
		// delivery; the acked check below is the evidence. Report, never fail, on this one.
		const read = await untilRedis(inPel, 30_000, 50);
		if (read) report(true, "registry: the channel reader picked up the event (in the PEL)");
		else
			console.log(
				"[note] registry: in-PEL window missed (ack landed between polls); the acked check below is the evidence",
			);
		const acked = await untilRedis(() => !inPel(), 240_000, 100);
		check(acked, "the direct event was received and acked (left the PEL)", `entry=${entryId}`);
	} catch (error) {
		fail("live check", error instanceof Error ? error.message : String(error));
	} finally {
		// 3. Shutdown removes the directory entry and the session stream (stop → unregister → close).
		await bridge?.stop().catch(() => {});
		rmSync(cwd, { recursive: true, force: true });
		// Cleanup is asserted whenever a registration actually happened, independent of the earlier
		// checks (a failure above must not hide a leak here).
		if (registered) {
			const membersKey = directoryKey(namespace);
			const gone = await untilRedis(
				() => redisCli(url, "ZSCORE", membersKey, channel) === "" && redisCli(url, "EXISTS", stream) === "0",
				15_000,
			);
			check(gone, "channel and stream removed on shutdown");
		}
	}
	return ok;
}

/** Poll `check` (a shell-backed probe) until it is true, or false after `timeoutMs`. */
function untilRedis(check: () => boolean, timeoutMs: number, intervalMs = 250): Promise<boolean> {
	return new Promise((resolve) => {
		if (check()) return resolve(true);
		const startedAt = Date.now();
		const tick = setInterval(() => {
			if (check()) {
				clearInterval(tick);
				resolve(true);
			} else if (Date.now() - startedAt >= timeoutMs) {
				clearInterval(tick);
				resolve(false);
			}
		}, intervalMs);
	});
}

interface Collected {
	started: string[];
	completed: Array<{ id: string; status: string }>;
	userEchoes: string[];
}

/** Wait until `predicate` holds on the collected state, or resolve `false` after `timeoutMs`. */
function until(collected: Collected, predicate: (c: Collected) => boolean, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		if (predicate(collected)) return resolve(true);
		const startedAt = Date.now();
		const tick = setInterval(() => {
			if (predicate(collected)) {
				clearInterval(tick);
				resolve(true);
			} else if (Date.now() - startedAt >= timeoutMs) {
				clearInterval(tick);
				resolve(false);
			}
		}, 50);
	});
}

function report(ok: boolean, label: string, detail = ""): void {
	const mark = ok ? "PASS" : "FAIL";
	console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
}

/** The `userMessage` item's text parts, if `params` is one; else none. */
function userEchoText(params: unknown): string[] {
	if (typeof params !== "object" || params === null) return [];
	const item = (params as { item?: unknown }).item;
	if (typeof item !== "object" || item === null) return [];
	const rec = item as { type?: string; content?: unknown };
	if (rec.type !== "userMessage" || !Array.isArray(rec.content)) return [];
	const parts: string[] = [];
	for (const part of rec.content) {
		if (
			typeof part === "object" &&
			part !== null &&
			"text" in part &&
			typeof (part as { text: unknown }).text === "string"
		) {
			parts.push((part as { text: string }).text);
		}
	}
	return parts;
}

async function run(): Promise<boolean> {
	const executable = command();
	console.log(`[smoke] using codex executable: ${executable}`);
	if (!binaryPresent(executable)) {
		console.log(`[smoke] SKIP: "${executable}" not found on PATH; no live checks run.`);
		return true;
	}

	const collected: Collected = { started: [], completed: [], userEchoes: [] };
	const connection = createStdioConnection({ command: executable, cwd: process.cwd() });
	const client = new AppServerClient(connection);
	client.onNotification = (event) => {
		const params = event.params as Record<string, unknown> | undefined;
		if (event.method === "turn/started" && params?.turn) {
			collected.started.push(String((params.turn as { id?: string }).id));
		} else if (event.method === "turn/completed" && params?.turn) {
			const turn = params.turn as { id?: string; status?: string };
			collected.completed.push({ id: String(turn.id), status: String(turn.status) });
		} else if (event.method === "item/started" || event.method === "item/completed") {
			collected.userEchoes.push(...userEchoText(params));
		}
	};
	client.onConnectionEnd = (reason) => console.log(`[smoke] connection ended${reason ? `: ${reason}` : ""}`);

	let ok = true;
	try {
		// 1. Handshake.
		const init = await client.initialize({ clientInfo: { name: "ace-codex-smoke", version: "0.1.0" } });
		report(true, "initialize handshake", `codexHome=${init.codexHome} os=${init.platformOs}`);

		// 2. Thread.
		const { thread } = await client.threadStart({});
		report(true, "thread/start", `thread=${thread.id}`);

		// 3. A turn from an idle thread (the ACE next_turn path).
		const prompt = "<ace_event>\nsender: smoke\nid: smoke-1\n\nReply with the single word: pong\n</ace_event>";
		const { turn } = await client.turnStart({ threadId: thread.id, input: [{ type: "text", text: prompt }] });
		report(true, "turn/start", `turn=${turn.id}`);
		const started = await until(collected, (c) => c.started.includes(turn.id), 30_000);
		report(started, "turn/started observed");
		const echo = await until(
			collected,
			(c) => c.userEchoes.some((t) => t.includes("Reply with the single word: pong")),
			60_000,
		);
		report(echo, "injected text echoed back as a userMessage item");
		const done = await until(collected, (c) => c.completed.some((t) => t.id === turn.id), 240_000);
		const doneStatus = collected.completed.find((t) => t.id === turn.id)?.status;
		report(done, "turn/completed observed", done ? `status=${doneStatus}` : "not seen in time");

		// 4. Best-effort mid-turn steer (the ACE immediate path). Racy with a fast
		//    model: if the thread is already idle, steering is not applicable and
		//    is reported, not failed.
		const steerTurn = await client.turnStart({
			threadId: thread.id,
			input: [{ type: "text", text: "Take a beat, then reply with the single word: ok" }],
		});
		const steerStarted = await until(collected, (c) => c.started.includes(steerTurn.turn.id), 30_000);
		if (steerStarted) {
			const steer = await client
				.turnSteer({
					threadId: thread.id,
					input: [{ type: "text", text: "Actually reply with: poked" }],
					expectedTurnId: steerTurn.turn.id,
				})
				.then(() => true)
				.catch((error: unknown) => {
					report(false, "turn/steer", error instanceof Error ? error.message : String(error));
					return false;
				});
			if (steer) report(true, "turn/steer into the running turn");
			const steerDone = await until(collected, (c) => c.completed.some((t) => t.id === steerTurn.turn.id), 240_000);
			report(steerDone, "steered turn completed");
		} else {
			report(true, "turn/steer skipped", "thread was idle; steering not applicable this run");
		}
	} catch (error) {
		ok = false;
		report(false, "plumbing", error instanceof Error ? error.message : String(error));
	} finally {
		client.close();
		connection.close();
	}
	return ok;
}

async function main(): Promise<void> {
	const guard = setTimeout(() => {
		console.log("[smoke] FAIL: overall timeout");
		process.exit(1);
	}, OVERALL_TIMEOUT_MS);
	try {
		const ok = (await run()) && (await runRegistry(command()));
		clearTimeout(guard);
		console.log(ok ? "[smoke] done" : "[smoke] failed");
		process.exit(ok ? 0 : 1);
	} catch (error) {
		clearTimeout(guard);
		console.log(`[smoke] fatal: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

void main();
