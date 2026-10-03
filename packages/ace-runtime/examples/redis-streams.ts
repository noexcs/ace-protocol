/**
 * ACE 0.1 over Redis Streams: consume events from a consumer group and drive a Pi session.
 *
 * ```bash
 * # throwaway broker
 * redis-server --port 6399 --daemonize yes --save '' --dir /tmp/ace-redis
 *
 * ACE_MODEL=tailscale-zcs/Qwen3.8-27B \
 * ACE_REDIS_URL=redis://127.0.0.1:6399 ACE_STREAM=ace:build-events ACE_GROUP=ace-example ACE_EXIT_AFTER=1 \
 *   npm run example:redis --workspace=ace-runtime
 *
 * # external producer (any process, any language)
 * redis-cli -p 6399 XADD ace:build-events '*' \
 *   message '{"aceVersion":"0.1","id":"e1","sender":"ci","activation":"next_turn","body":"Build failed."}'
 * ```
 *
 * Acknowledgement policy: an entry is `XACK`ed once the runtime accepted it — including invalid ACE
 * messages, which the runtime logs and drops — and left pending when injection failed.
 * `ACE_EXIT_AFTER` counts agent turns (events with `activation: "manual"` produce none), so a scripted
 * run can exit; without it the consumer runs until interrupted.
 */

import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { AceRuntime, consoleAceLogger, type EndpointConfig, PiAdapter, RedisStreamsTransport } from "../src/index.ts";

const subscription: EndpointConfig = {
	name: "build-events",
	transport: "redis-streams",
	activation: "default",
	options: {},
	config: {
		stream: process.env.ACE_STREAM ?? "ace:build-events",
		group: process.env.ACE_GROUP ?? "ace-example",
		...(process.env.ACE_REDIS_URL ? { url: process.env.ACE_REDIS_URL } : {}),
		...(process.env.ACE_CONSUMER ? { consumer: process.env.ACE_CONSUMER } : {}),
		...(process.env.ACE_FIELD ? { field: process.env.ACE_FIELD } : {}),
	},
};

const exitAfter = Number.parseInt(process.env.ACE_EXIT_AFTER ?? "0", 10);

const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
const [providerId, modelId] = (process.env.ACE_MODEL ?? "").split("/");
const model = providerId && modelId ? modelRuntime.getModel(providerId, modelId) : undefined;
if (process.env.ACE_MODEL && !model) {
	throw new Error(`Unknown model "${process.env.ACE_MODEL}" (expected "<provider>/<model>")`);
}

const { session } = await createAgentSession({
	modelRuntime,
	model,
	sessionManager: SessionManager.inMemory(),
});

const transport = new RedisStreamsTransport(subscription, {
	onError: (error) => console.error("[ACE] redis streams error:", error),
});
const runtime = new AceRuntime({
	engine: new PiAdapter({ session, onRunError: (error) => console.error("[ACE] agent run failed:", error) }),
	subscribe: [subscription],
	transports: { [subscription.name]: transport },
	logger: consoleAceLogger,
});

const finished = Promise.withResolvers<void>();
const interrupted = Promise.withResolvers<void>();
let turns = 0;

session.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
		return;
	}
	if (event.type === "agent_end") {
		turns += 1;
		if (exitAfter > 0 && turns >= exitAfter) finished.resolve();
	}
});
process.once("SIGINT", () => interrupted.resolve());

try {
	await runtime.start();
	console.log(
		`[ACE] consuming stream=${subscription.config.stream} group=${subscription.config.group} (exit after ${exitAfter > 0 ? exitAfter : "∞"} turn(s))\n`,
	);

	if (exitAfter > 0) {
		await finished.promise;
		console.log("\n[ACE] done");
	} else {
		await interrupted.promise;
		console.log("\n[ACE] interrupted");
	}
} finally {
	await runtime.stop();
	session.dispose();
}
