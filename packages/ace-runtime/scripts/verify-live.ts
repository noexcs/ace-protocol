/**
 * Live verification against a real broker: `npm run verify:live`.
 *
 * Every scenario uses the real Redis Streams transport (real `XADD`/`XREADGROUP`/`XACK`), a real
 * publisher, and the real runtime; only the agent is stubbed, so no model credentials are needed.
 * Each scenario asserts on observable state (stream entries, pending entries, what the agent saw),
 * and the script exits non-zero when one of them regresses. A failing scenario is reported instead
 * of aborting the run.
 *
 * ```bash
 * redis-server --port 6379 --daemonize yes --save ''   # if no broker is running
 * npm run verify:live
 * ```
 *
 * Set `ACE_VERIFY_REDIS_URL` for a different broker, and `ACE_VERIFY_MODEL` for the optional Pi
 * end-to-end step (it needs the Pi CLI and a model; the broker scenarios never do).
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "redis";
import {
	type AceMessage,
	AceMetrics,
	AceRuntime,
	type AgentEngine,
	AgentRegistry,
	createRedisAgentRegistry,
	createRedisStreamsAddClient,
	DeadLetterSink,
	type EndpointConfig,
	type InjectionMode,
	parseDeadLetters,
	RedisStreamsPublisher,
	RedisStreamsTransport,
	registryMember,
	replayDeadLetters,
} from "../src/index.ts";

const url = process.env.ACE_VERIFY_REDIS_URL ?? "redis://127.0.0.1:6379";
const run = `${Date.now().toString(36)}`;

interface Result {
	scenario: string;
	expectation: string;
	actual: string;
	ok: boolean;
}

const results: Result[] = [];

function check(scenario: string, expectation: string, actual: unknown, ok: boolean): void {
	results.push({ scenario, expectation, actual: String(actual), ok });
}

/** Agent engine stub: records what it saw and can be told to fail. */
class StubEngine implements AgentEngine {
	readonly injections: Array<{ message: AceMessage; mode: InjectionMode }> = [];
	failures = 0;

	async inject(message: AceMessage, mode: InjectionMode): Promise<void> {
		if (this.failures > 0) {
			this.failures -= 1;
			throw new Error("stub engine unavailable");
		}
		this.injections.push({ message, mode });
	}

	isRunning(): boolean {
		return false;
	}

	async waitForIdle(): Promise<void> {}
}

const admin = createClient({ url });
await admin.connect();

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read the stored channel entry; the script only asserts on these four fields. */
function readChannel(raw: unknown): { name?: string; description?: string; stream?: string; group?: string } {
	if (typeof raw !== "string") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null) return {};
	const channel: { name?: string; description?: string; stream?: string; group?: string } = {};
	if ("name" in parsed && typeof parsed.name === "string") channel.name = parsed.name;
	if ("description" in parsed && typeof parsed.description === "string") channel.description = parsed.description;
	if ("config" in parsed) {
		const config: unknown = parsed.config;
		if (typeof config === "object" && config !== null) {
			if ("stream" in config && typeof config.stream === "string") channel.stream = config.stream;
			if ("group" in config && typeof config.group === "string") channel.group = config.group;
		}
	}
	return channel;
}

/** Wait until `predicate` holds, so a slow broker cannot make the run flaky. */
async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await settle(20);
	}
	return false;
}

async function pending(stream: string, group: string): Promise<number> {
	const summary = await admin.xPending(stream, group);
	return typeof summary === "object" && summary !== null && "pending" in summary ? Number(summary.pending) : 0;
}

function message(id: string, overrides: Partial<AceMessage> = {}): AceMessage {
	return { aceVersion: "0.1", id, sender: "ci", activation: "next_turn", body: `event ${id}`, ...overrides };
}

interface ScenarioContext {
	stream: string;
	group: string;
	engine: StubEngine;
	publish: (message: AceMessage) => Promise<void>;
	runtime: AceRuntime;
	metrics: AceMetrics;
}

/** Wire one fresh stream + subscription + publisher, run `body`, then clean up. */
async function scenario(
	name: string,
	body: (context: ScenarioContext) => Promise<void>,
	options: {
		config?: Record<string, unknown>;
		subscription?: Partial<EndpointConfig>;
		spool?: { afterEvents: number; windowMs: number };
	} = {},
): Promise<void> {
	const stream = `ace:verify:${run}:${name}`;
	const group = "verify";
	const subscription: EndpointConfig = {
		name: "inbox",
		transport: "redis-streams",
		activation: "next_turn",
		...(options.spool === undefined ? {} : { spool: options.spool }),
		config: { stream, group, url, blockMs: 50, ...options.config },
		options: {},
		...options.subscription,
	};

	const engine = new StubEngine();
	const metrics = new AceMetrics();
	const transport = new RedisStreamsTransport(subscription, { metrics, onError: () => {} });
	const publisher = new RedisStreamsPublisher({ url, stream, field: "message" });
	const runtime = new AceRuntime({
		engine,
		metrics,
		subscribe: [subscription],
		transports: { [subscription.name]: transport },
		...(options.spool === undefined ? {} : { spool: { dir: `/tmp/ace-verify-${run}` } }),
		dedupCapacity: 16,
	});

	await runtime.start();
	try {
		await body({
			stream,
			group,
			engine,
			publish: (entry) => publisher.publish(entry),
			runtime,
			metrics,
		});
	} catch (error) {
		check(name, "scenario completes", error instanceof Error ? error.message : String(error), false);
	} finally {
		await runtime.stop();
		await publisher.close();
		await admin.del(stream);
	}
}

// 1. A valid event is injected and acknowledged.
await scenario("valid", async ({ engine, publish, stream, group }) => {
	await publish(message("evt_ok"));
	await waitFor(() => engine.injections.length === 1);
	const outstanding = await pending(stream, group);
	check(
		"valid event",
		"injected + acked",
		`injections=${engine.injections.length} pending=${outstanding}`,
		engine.injections.length === 1 && outstanding === 0,
	);
});

// 2. A malformed message is rejected and still acknowledged (it must not block the stream).
await scenario("poison", async ({ engine, publish, stream, group }) => {
	await admin.xAdd(stream, "*", { message: "not-json" });
	await publish(message("evt_after_poison"));
	await waitFor(() => engine.injections.length === 1);
	const outstanding = await pending(stream, group);
	check(
		"poison message",
		"rejected + acked, stream continues",
		`injections=${engine.injections.length} pending=${outstanding}`,
		engine.injections.length === 1 && outstanding === 0,
	);
});

// 3. A failing handler leaves the entry pending; reclaim redelivers it to a healthy handler.
await scenario(
	"reclaim",
	async ({ engine, publish, stream, group }) => {
		engine.failures = 1;
		await publish(message("evt_reclaim"));
		const stranded = await waitFor(async () => (await pending(stream, group)) === 1);
		const redelivered = await waitFor(() => engine.injections.length === 1, 15_000);
		const outstanding = await pending(stream, group);
		check(
			"reclaim after failure",
			"pending, then redelivered + acked",
			`stranded=${stranded} redelivered=${redelivered} pending=${outstanding}`,
			stranded && redelivered && outstanding === 0,
		);
	},
	{ config: { reclaimIdleMs: 300, count: 1, blockMs: 50 } },
);

// 4. A redelivered identity is deduplicated at the agent boundary.
await scenario("dedup", async ({ engine, stream }) => {
	const publisher = new RedisStreamsPublisher({ url, stream, field: "message" });
	await publisher.publish(message("evt_same"));
	await publisher.publish(message("evt_same"));
	await publisher.close();

	await waitFor(() => engine.injections.length > 0);
	await settle(300);
	check(
		"duplicate identity",
		"injected once",
		`injections=${engine.injections.length}`,
		engine.injections.length === 1,
	);
});

// 5. A sender outside the allowlist is dropped (and acknowledged).
await scenario(
	"allowlist",
	async ({ engine, publish, stream, group }) => {
		await publish(message("evt_stranger", { sender: "stranger" }));
		await settle(300);
		const outstanding = await pending(stream, group);
		check(
			"sender allowlist",
			"dropped + acked",
			`injections=${engine.injections.length} pending=${outstanding}`,
			engine.injections.length === 0 && outstanding === 0,
		);
	},
	{ subscription: { allowedSenders: ["ci"] } },
);

// 6. A manual event is retained, then activated explicitly.
await scenario(
	"manual",
	async ({ engine, publish, runtime }) => {
		await publish(message("evt_manual", { activation: "manual" }));
		await waitFor(() => runtime.pendingEvents.length === 1);
		const retained = runtime.pendingEvents.length === 1 && engine.injections.length === 0;
		await runtime.activatePendingEvent("ci", "evt_manual");
		check(
			"manual activation",
			"retained, then injected on demand",
			`retained=${retained} injections=${engine.injections.length}`,
			retained && engine.injections.length === 1,
		);
	},
	{ subscription: { activation: "default" } },
);

// 7. A burst is spilled to a file and collapsed into one summary event.
await scenario(
	"spool",
	async ({ engine, publish }) => {
		const published = 4;
		// Concurrent publish so all events land inside one window (arrival jitter is the point of
		// the window, but a sequential publish loop can straddle two of them on a real broker).
		await Promise.all(["s1", "s2", "s3", "s4"].map((id) => publish(message(id))));
		const summarised = await waitFor(
			() => engine.injections.some((injection) => injection.message.sender === "ace-runtime"),
			15_000,
		);
		await settle(1_200); // let any straggler arrive, so "not every event was injected" is real
		const summary =
			engine.injections.find((injection) => injection.message.sender === "ace-runtime")?.message.body ?? "";
		const individual = engine.injections.filter((injection) => injection.message.sender === "ci").length;
		const spooledMatch = /(\d+) events were spooled to (\S+) because/.exec(summary);
		const spooled = Number(spooledMatch?.[1] ?? 0);
		const path = spooledMatch?.[2] ?? "";
		check(
			"burst spooling",
			"burst collapsed: fewer agent injections than events, file on disk",
			`individual=${individual}/${published} spooled=${spooled} file=${path !== "" && existsSync(path)}`,
			summarised && individual < published && spooled >= 1 && path !== "" && existsSync(path),
		);
	},
	{ spool: { afterEvents: 2, windowMs: 1_000 } },
);

// 8. The agent directory: a session registers itself, stays fresh, and leaves nothing behind.
await (async () => {
	const prefix = `ace:verify:agents:${run}`;
	const sessionId = `session-${run}`;
	const member = registryMember("verify-agent", sessionId);
	const registry = new AgentRegistry({
		store: createRedisAgentRegistry({ url, prefix }),
		prefix,
		ttlMs: 1_500,
		refreshMs: 300,
	});
	try {
		const registered = await registry.register({ codingAgent: "verify-agent", sessionId, cwd: "/tmp/verify", url });
		const visible = await waitFor(async () => (await registry.list()).some((entry) => entry.member === member));
		const stored = readChannel(await admin.hGet(`${prefix}:entry`, member));
		const firstScore = Number(await admin.zScore(prefix, member));
		await settle(800); // two heartbeats
		const renewedScore = Number(await admin.zScore(prefix, member));

		await registry.unregister();
		const gone = (await registry.list()).every((entry) => entry.member !== member);
		const streamGone = (await admin.exists(registered.stream)) === 0;
		const entryGone = (await admin.hLen(`${prefix}:entry`)) === 0;

		check(
			"agent directory",
			"registers, renews each heartbeat, and leaves nothing behind",
			`visible=${visible} name=${stored.name === member} stream=${stored.stream === registered.stream} group=${stored.group === registered.group} location=${stored.description?.includes("cwd=/tmp/verify")} renewed=${renewedScore > firstScore} gone=${gone && streamGone && entryGone}`,
			visible &&
				stored.name === member &&
				stored.stream === registered.stream &&
				stored.group === registered.group &&
				stored.description?.includes("cwd=/tmp/verify") === true &&
				renewedScore > firstScore &&
				gone &&
				streamGone &&
				entryGone,
		);
	} catch (error) {
		check("agent directory", "scenario completes", error instanceof Error ? error.message : String(error), false);
	} finally {
		await registry.close();
		await admin.del(prefix);
		await admin.del(`${prefix}:entry`);
	}
})();

// 9. A session that dies without unregistering: the next reader sweeps its leftovers.
await (async () => {
	const prefix = `ace:verify:agents-gc:${run}`;
	const sessionId = `session-gc-${run}`;
	const member = registryMember("verify-agent", sessionId);
	const registry = new AgentRegistry({
		store: createRedisAgentRegistry({ url, prefix }),
		prefix,
		ttlMs: 400,
		refreshMs: 0, // no heartbeat: the registration expires and nothing cleans up after itself
	});
	try {
		const registered = await registry.register({ codingAgent: "verify-agent", sessionId, cwd: "/tmp/gc", url });
		await settle(600); // past the expiry
		const live = await registry.list(); // the read is what sweeps
		const swept =
			live.every((entry) => entry.member !== member) &&
			(await admin.hLen(`${prefix}:entry`)) === 0 &&
			(await admin.exists(registered.stream)) === 0;
		check(
			"agent directory gc",
			"expired registrations lose their entry, hash field and stream",
			`swept=${swept} hashFields=${await admin.hLen(`${prefix}:entry`)} streamExists=${await admin.exists(registered.stream)}`,
			swept,
		);
	} catch (error) {
		check("agent directory gc", "scenario completes", error instanceof Error ? error.message : String(error), false);
	} finally {
		await registry.close();
		await admin.del(prefix);
		await admin.del(`${prefix}:entry`);
	}
})();

// 10. Dead letters: a dropped event is recorded with its stream, and a replay puts it back.
await (async () => {
	const stream = `ace:verify:dlq:${run}`;
	const dir = mkdtempSync(join(tmpdir(), "ace-verify-dlq-"));
	const subscription: EndpointConfig = {
		name: "inbox",
		transport: "redis-streams",
		config: { stream, group: "dlq", url, blockMs: 50, reclaimIdleMs: 200, reclaimAttempts: 1, count: 1 },
		options: {},
	};
	const sink = new DeadLetterSink({ dir });
	const failing = new RedisStreamsTransport(subscription, {
		onError: () => {},
		onDropped: (entry) => sink.record("inbox", entry),
	});
	const publisher = createRedisStreamsAddClient(url, () => {});
	const event = JSON.stringify({
		aceVersion: "0.1",
		id: "evt_dlq_1",
		sender: "ci",
		activation: "next_turn",
		body: "replay me",
	});
	let healthy: RedisStreamsTransport | undefined;
	try {
		await failing.start(async () => {
			throw new Error("agent unavailable");
		});
		await settle(300); // subscribe before publishing: the group starts at the tail
		await publisher.add(stream, "message", event);
		const dropped = await waitFor(() => readdirSync(dir).some((name) => name.startsWith("dead-letter.")), 10_000);
		await failing.stop();

		const file = join(dir, readdirSync(dir).find((name) => name.startsWith("dead-letter.")) ?? "missing");
		const parsed = parseDeadLetters(readFileSync(file, "utf8"));
		const record = parsed.records[0];

		const seen: string[] = [];
		healthy = new RedisStreamsTransport(
			{ ...subscription, config: { ...subscription.config, consumer: "healthy" } },
			{ onError: () => {} },
		);
		await healthy.start(async (raw) => {
			seen.push(String(raw));
		});
		const outcome = await replayDeadLetters(parsed.records, async (target, field, payload) => {
			await publisher.add(target, field, payload);
		});
		const delivered = await waitFor(() => seen.length > 0, 10_000);

		check(
			"dead letter replay",
			"a dropped event is recorded with its stream and can be put back",
			`dropped=${dropped} records=${parsed.records.length} stream=${record?.stream === stream} field=${record?.field === "message"} replayed=${outcome.replayed} redelivered=${delivered && seen[0] === event}`,
			dropped &&
				parsed.records.length === 1 &&
				record?.stream === stream &&
				record?.field === "message" &&
				outcome.replayed === 1 &&
				delivered &&
				seen[0] === event,
		);
	} catch (error) {
		check("dead letter replay", "scenario completes", error instanceof Error ? error.message : String(error), false);
	} finally {
		await healthy?.stop();
		await failing.stop();
		await publisher.close();
		rmSync(dir, { recursive: true, force: true });
		await admin.del(stream);
	}
})();

// Report
const ok = results.every((result) => result.ok);
const width = Math.max(...results.map((result) => result.scenario.length));
console.log(`\nACE live verification against ${url}\n`);
for (const result of results) {
	console.log(
		`${result.ok ? "ok  " : "FAIL"} ${result.scenario.padEnd(width)}  ${result.expectation}  →  ${result.actual}`,
	);
}
console.log(`\n${results.filter((result) => result.ok).length}/${results.length} scenarios passed`);

await admin.quit();
process.exit(ok ? 0 : 1);
