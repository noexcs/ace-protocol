/**
 * Reproduction for bug 1 of the seventh open round: "a session's self-echo is dropped for some channels
 * it reads — self-publishes to `ace:noexcs:inbox` produced ZERO self-echoes while `ace:noexcs:team`
 * echoed".
 *
 * It stands one runtime in for one session, subscribes it to two channels on one broker (the session's
 * own inbox and a topic), publishes with the session's own sender to both streams, and asserts that
 * both deliveries come back, marked `self`. The claim is that one of the two never does.
 *
 * The finding: both do. No channel selects for a drop. What the two-real-session evaluation saw as
 * "ZERO self-echoes" was delivery lag — its own transcripts show every one of those publishes arriving
 * with `self: yes` several turns later, while only the `manual` one never did (by design: `manual` is
 * retained, not injected). See `test/runtime/ace-runtime.test.ts` for the regression test that pins the
 * invariant and `docs/ace-runtime-contracts.md` §4.3 for the documented lag.
 *
 * Requires a broker; run with `node scripts/repro-self-echo.ts`:
 *   redis-server --port 6379 --daemonize yes --save ''
 *   ACE_VERIFY_REDIS_URL=redis://127.0.0.1:6379 node scripts/repro-self-echo.ts
 */
import { createClient } from "redis";
import {
	type AceMessage,
	AceMetrics,
	AceRuntime,
	type AgentEngine,
	channelStreamKey,
	createTransports,
	type EndpointConfig,
	type InjectionMode,
} from "../src/index.ts";

const url = process.env.ACE_VERIFY_REDIS_URL ?? "redis://127.0.0.1:6379";
const run = `${Date.now().toString(36)}`;
const sender = `repro:noexcs:oh-my-pi:${run}`;
const inboxChannel = sender;
const teamChannel = `repro:noexcs:team:${run}`;

/** Records what the runtime injected, so the reproduction can compare the two channels. */
class RecordingEngine implements AgentEngine {
	readonly injections: Array<{ id: string; subscription: string; self: boolean | undefined }> = [];

	async inject(message: AceMessage, _mode: InjectionMode, context?: { subscription: string; self?: boolean }) {
		this.injections.push({ id: message.id, subscription: context?.subscription ?? "?", self: context?.self });
	}

	isRunning(): boolean {
		return false;
	}

	async waitForIdle(): Promise<void> {}
}

const admin = createClient({ url });
await admin.connect();

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await settle(20);
	}
	return false;
}

function endpoint(name: string, channel: string): EndpointConfig {
	return {
		name,
		channel,
		transport: "redis-streams",
		config: { stream: channelStreamKey("repro", channel), group: sender, url, blockMs: 50 },
		options: {},
	};
}

const inbox = endpoint("session-inbox", inboxChannel);
const team = endpoint(teamChannel, teamChannel);
const engine = new RecordingEngine();
const metrics = new AceMetrics();
const runtime = new AceRuntime({
	engine,
	metrics,
	subscribe: [inbox, team],
	transports: createTransports([inbox, team], { onError: () => {} }),
	selfSenders: [sender],
	dedupCapacity: 64,
});
await runtime.start();

const message = (id: string): AceMessage => ({
	aceVersion: "0.1",
	id,
	sender,
	activation: "next_turn",
	body: `body ${id}`,
});
await admin.xAdd(inbox.config.stream as string, "*", { message: JSON.stringify(message("evt_inbox_self")) });
await admin.xAdd(team.config.stream as string, "*", { message: JSON.stringify(message("evt_team_self")) });
await waitFor(() => engine.injections.length >= 2);
await settle(300);

const bySubscription = new Map(engine.injections.map((injection) => [injection.subscription, injection]));
const inboxEcho = bySubscription.get("session-inbox");
const teamEcho = bySubscription.get(teamChannel);
const ok =
	inboxEcho?.id === "evt_inbox_self" &&
	inboxEcho.self === true &&
	teamEcho?.id === "evt_team_self" &&
	teamEcho.self === true;

console.log(`self-echo on the session's own inbox: ${JSON.stringify(inboxEcho ?? null)}`);
console.log(`self-echo on the subscribed topic:      ${JSON.stringify(teamEcho ?? null)}`);
console.log(ok ? "PASS: both channels echoed the self-publish" : "FAIL: a self-echo was dropped");

await runtime.stop();
await admin.del(inbox.config.stream as string);
await admin.del(team.config.stream as string);
await admin.quit();
process.exit(ok ? 0 : 1);
