/**
 * Live verification against a real oh-my-pi session: `npm run verify:omp`.
 *
 * Starts `omp --mode rpc`, loads the ACE extension into it, publishes events over a real broker and
 * asserts what the session did with them. This is the regression net for the delivery mapping: an
 * idle oh-my-pi session queues `deliverAs: "steer" | "followUp"` without starting a turn, so an
 * event injected that way never reaches the agent while its broker entry is acknowledged. The
 * `next_turn` scenario below fails on exactly that bug (no `message_start` frame, entry still acked).
 *
 * Requirements: `omp` on PATH with a working model configuration (one small turn per injected event),
 * and a broker reachable at `ACE_VERIFY_REDIS_URL` (default `redis://127.0.0.1:6379`).
 * Set `ACE_VERIFY_OMP=0` to skip.
 *
 * ```bash
 * redis-server --port 6379 --daemonize yes --save ''   # if no broker is running
 * npm run verify:omp
 * ```
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createClient } from "redis";
import type { AceMessage } from "../vendor/ace-runtime/dist/index.js";
import { channelName, channelStreamKey } from "../vendor/ace-runtime/dist/index.js";

const url = process.env.ACE_VERIFY_REDIS_URL ?? "redis://127.0.0.1:6379";
const extensionPath = new URL("../extensions/ace.ts", import.meta.url).pathname;
const probePath = new URL("./probe-system-prompt.ts", import.meta.url).pathname;
const run = `${Date.now().toString(36)}`;
const scratch = mkdtempSync(join(tmpdir(), "ace-omp-"));
/** The namespace and username the scratch config declares; the channel names derive from them. */
const namespace = "verify";
const username = "verify";

interface Result {
	scenario: string;
	expectation: string;
	actual: string;
	ok: boolean;
}

const results: Result[] = [];
const check = (scenario: string, expectation: string, actual: unknown, ok: boolean): void =>
	void results.push({ scenario, expectation, actual: String(actual), ok });

/** One scenario: a channel, a live session, events published into it, assertions on what came back. */
interface Scenario {
	name: string;
	event: AceMessage;
	/** Frame types, and fragments the injected user message must contain given the channel's stream. */
	expect: { frame?: string; userMessage?: (stream: string) => string[] };
	/** Whether a turn is expected at all — `manual` events are stored, not injected. */
	turn: boolean;
}

const scenarios: Scenario[] = [
	{
		name: "next_turn",
		event: {
			aceVersion: "0.1",
			id: "evt_next_turn",
			// The sender and its description are what our own publisher stamps: a channel-shaped sender,
			// plus the sender's own account of where it runs.
			sender: "verify:verify:ci",
			sessionId: "01a102b6-9dac-75b6-80ca-21cbbf58e914",
			senderDescription: "agent=ci | session=58e914 | cwd=/tmp/verify | host=verify-host",
			activation: "next_turn",
			body: "Reply with exactly: ACE-OMP-OK",
		},
		expect: {
			frame: "message_start",
			userMessage: (stream) => [
				"<ace_event>",
				"sender: verify:verify:ci",
				`channel: ${stream}`,
				"sender description: agent=ci | session=58e914 | cwd=/tmp/verify | host=verify-host",
				"id: evt_next_turn",
			],
		},
		turn: true,
	},
	{
		name: "manual",
		event: {
			aceVersion: "0.1",
			id: "evt_manual",
			sender: "ci",
			activation: "manual",
			body: "retain me, do not act",
		},
		expect: {},
		turn: false,
	},
];

if (process.env.ACE_VERIFY_OMP === "0") {
	console.log("ACE oh-my-pi verification skipped (ACE_VERIFY_OMP=0)");
	process.exit(0);
}

const admin = createClient({ url });
try {
	await admin.connect();
} catch (error) {
	console.error(`cannot reach the broker at ${url}: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

/** The channel's stream is derived from its name; nothing about the address is configured. */
function streamOf(local: string): string {
	return channelStreamKey(namespace, channelName(namespace, username, local));
}

function writeConfig(local: string): string {
	const path = join(scratch, ".ace.json");
	writeFileSync(
		path,
		`${JSON.stringify(
			{
				username,
				servers: { local: { url, namespace, subscribe: [local] } },
			},
			null,
			2,
		)}\n`,
	);
	return path;
}

/** A running `omp --mode rpc` session with the ACE extension loaded. */
class OmpSession {
	readonly frames: Array<Record<string, unknown>> = [];
	readonly userMessages: string[] = [];
	readonly logs: string[] = [];
	readonly settled: Promise<void>;
	private readonly child: ReturnType<typeof spawn>;
	private resolveSettled!: () => void;
	private sawSettled = false;

	constructor(cwd: string) {
		this.settled = new Promise((resolve) => {
			this.resolveSettled = resolve;
		});
		this.child = spawn("omp", ["--mode", "rpc", "--no-ui", "--no-extensions", "-e", extensionPath, "-e", probePath], {
			cwd,
			env: { ...process.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const lines = createInterface({ input: this.child.stdout as NodeJS.ReadableStream });
		lines.on("line", (line) => this.accept(line));
		this.child.stderr?.on("data", (chunk: Buffer) => {
			for (const line of String(chunk).split("\n")) {
				const text = line.trim();
				if (text.length === 0) continue;
				this.logs.push(text);
				console.log(`  [omp] ${text}`);
			}
		});
	}

	private accept(line: string): void {
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		this.frames.push(frame);
		if (frame.type === "message_start" && roleOf(frame) === "user") {
			const text = textOf("message" in frame ? contentOf(frame) : undefined);
			if (text !== undefined) this.userMessages.push(text);
		}
		if (frame.type === "session_settled" && !this.sawSettled) {
			this.sawSettled = true;
			this.resolveSettled();
		}
	}

	/** Wait for a frame type, or give up after `timeoutMs`. */
	async waitForFrame(type: string, timeoutMs: number): Promise<boolean> {
		return this.waitFor(() => this.frames.some((frame) => frame.type === type), timeoutMs);
	}

	/** Wait for a line the extension logged (runtime lines go to stderr, which this harness captures). */
	async waitForLog(fragment: string, timeoutMs: number): Promise<boolean> {
		return this.waitFor(() => this.logs.some((line) => line.includes(fragment)), timeoutMs);
	}

	hasLog(fragment: string): boolean {
		return this.logs.some((line) => line.includes(fragment));
	}

	async waitForSettled(timeoutMs: number): Promise<boolean> {
		await this.waitFor(() => this.sawSettled, timeoutMs);
		return this.sawSettled;
	}

	private async waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return true;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return predicate();
	}

	/** Kill the session and wait for it to exit, so teardown cannot race the next stream. */
	async stop(): Promise<void> {
		if (this.child.exitCode !== null) return;
		const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
		this.child.kill();
		await exited;
	}
}

/** The role of a frame's message, when it has one. */
function roleOf(frame: Record<string, unknown>): string | undefined {
	if (!("message" in frame)) return undefined;
	const message: unknown = frame.message;
	if (typeof message !== "object" || message === null || !("role" in message)) return undefined;
	return typeof message.role === "string" ? message.role : undefined;
}

/** The content of a frame's message. */
function contentOf(frame: Record<string, unknown>): unknown {
	if (!("message" in frame)) return undefined;
	const message: unknown = frame.message;
	if (typeof message !== "object" || message === null || !("content" in message)) return undefined;
	return message.content;
}

function textOf(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		if (!("type" in part) || part.type !== "text") continue;
		if ("text" in part && typeof part.text === "string") parts.push(part.text);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

for (const scenario of scenarios) {
	// A unique channel per scenario keeps them isolated without configuring any address.
	const local = `inbox-${run}-${scenario.name}`;
	const stream = streamOf(local);
	writeConfig(local);
	const session = new OmpSession(scratch);
	try {
		const ready = await session.waitForFrame("ready", 60_000);
		if (!ready) {
			check(scenario.name, "session starts", "no ready frame", false);
			continue;
		}
		// `ready` is emitted before the extension starts, and the consumer group is created at the
		// stream's tail (`XGROUP CREATE … $`). Publishing before that point loses the event for good,
		// so wait for the subscription to report itself live.
		const listening = await session.waitForLog("listening", 60_000);
		if (!listening) {
			check(scenario.name, "extension subscribes", `logs=${session.logs.slice(-3).join(" | ")}`, false);
			continue;
		}
		await admin.xAdd(stream, "*", { message: JSON.stringify(scenario.event) });
		const received = await session.waitForLog(`received id=${scenario.event.id}`, 60_000);

		const settled = scenario.turn ? await session.waitForSettled(120_000) : false;
		await new Promise((resolve) => setTimeout(resolve, scenario.turn ? 0 : 2_000));

		const injected = session.userMessages.some((text) =>
			(scenario.expect.userMessage?.(stream) ?? []).every((fragment) => text.includes(fragment)),
		);
		const turns = session.frames.filter((frame) => frame.type === "turn_start").length;
		const outstanding = await pending(stream);
		const length = await admin.xLen(stream);

		if (scenario.turn) {
			// The trust rule belongs to the system prompt, not to the event: assert on the payload the
			// provider was handed, and that neither sentence the event used to carry comes back.
			const probed = await session.waitForLog("ACE_PROBE_SYSTEM_PROMPT policy=true", 15_000);
			const removedSentences = session.logs.filter(
				(line) =>
					line.includes("ACE_PROBE_SYSTEM_PROMPT") &&
					(line.includes("askSentence=true") || line.includes("notice=true")),
			);
			check(
				scenario.name,
				"the provider request carries ACE's system-prompt policy and neither removed sentence",
				`policy=${probed ? "true" : "false"} removedSentences=${removedSentences.length}`,
				Boolean(probed) && removedSentences.length === 0,
			);
			check(
				scenario.name,
				"event reaches the conversation, the turn settles and the entry is acknowledged",
				`received=${received} injected=${injected} turns=${turns} settled=${settled} pending=${outstanding}`,
				received && injected && turns >= 1 && settled && outstanding === 0,
			);
		} else {
			check(
				scenario.name,
				"event is retained without starting a turn, and acknowledged",
				`received=${received} stored=${session.hasLog(`stored id=${scenario.event.id}`)} injected=${injected} turns=${turns} pending=${outstanding} xlen=${length}`,
				received &&
					session.hasLog(`stored id=${scenario.event.id}`) &&
					!injected &&
					turns === 0 &&
					outstanding === 0,
			);
		}
	} finally {
		await session.stop();
		await admin.del(stream);
	}
}

/**
 * How many entries the session has read but not acknowledged. The reading group is the subscribing
 * session's own sender name — derived, never configured — so it is discovered from the stream.
 */
async function pending(stream: string): Promise<number> {
	const groups: unknown = await admin.xInfoGroups(stream);
	if (!Array.isArray(groups)) return 0;
	const name = groupName(groups[0]);
	if (name === undefined) return 0;
	const summary = await admin.xPending(stream, name);
	if (typeof summary !== "object" || summary === null || !("pending" in summary)) return 0;
	return Number(summary.pending);
}

/** `XINFO GROUPS` reports `{ name, consumers, pending, … }` per group. */
function groupName(group: unknown): string | undefined {
	if (typeof group !== "object" || group === null) return undefined;
	const record = group as Record<string, unknown>;
	return typeof record.name === "string" ? record.name : undefined;
}

const ok = results.every((result) => result.ok);
const width = Math.max(...results.map((result) => result.scenario.length));
console.log(`\nACE oh-my-pi verification against ${url} (omp ${await ompVersion()})\n`);
for (const result of results) {
	console.log(
		`${result.ok ? "ok  " : "FAIL"} ${result.scenario.padEnd(width)}  ${result.expectation}  →  ${result.actual}`,
	);
}
console.log(`\n${results.filter((result) => result.ok).length}/${results.length} scenarios passed`);

await admin.quit();
rmSync(scratch, { recursive: true, force: true });
process.exit(ok ? 0 : 1);

async function ompVersion(): Promise<string> {
	return new Promise((resolve) => {
		const child = spawn("omp", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString();
		});
		child.on("close", () => resolve(out.trim() || "unknown"));
		child.on("error", () => resolve("unknown"));
	});
}
