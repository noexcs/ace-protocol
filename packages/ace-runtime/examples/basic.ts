/**
 * ACE 0.1 end-to-end example (design doc §26).
 *
 * ```text
 * External producer ─ InMemoryTransport ─ ACE Runtime ─ PiExtensionAdapter ─ Pi session ─ LLM
 * ```
 *
 * Pick a model from your Pi configuration (`provider/modelId`):
 *
 * ```bash
 * ACE_MODEL=tailscale-zcs/Qwen3.8-27B npm run example:basic --workspace=ace-runtime
 * ```
 *
 * Publish your own ACE message instead of the demo event, either inline:
 *
 * ```bash
 * ACE_EVENT='{"aceVersion":"0.1","id":"e1","sender":"ci","activation":"immediate","body":"Deploy failed."}' \
 *   ACE_MODEL=tailscale-zcs/Qwen3.8-27B npm run example:basic --workspace=ace-runtime
 * ```
 *
 * or from a file: `ACE_EVENT="$(cat event.json)"`. Events with `activation: "manual"` are
 * retained by the runtime and then explicitly activated, so all four activation values are
 * observable from the command line. Without `ACE_MODEL` the session uses the model from Pi
 * settings.
 */

import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	type AceMessage,
	AceRuntime,
	consoleAceLogger,
	decodeAceMessage,
	type EndpointConfig,
	InMemoryTransport,
	PiExtensionAdapter,
} from "../src/index.ts";

const demoEvent: AceMessage = {
	aceVersion: "0.1",
	id: "evt_123",
	sender: "build-service",
	activation: "next_turn",
	body: "Build failed for project foo.",
};
const event = process.env.ACE_EVENT ? decodeAceMessage(process.env.ACE_EVENT) : demoEvent;

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

const transport = new InMemoryTransport();
const adapter = new PiExtensionAdapter({
	// The extension adapter talks to the host through `sendUserMessage`; a Pi `AgentSession` is such a
	// host, and `isStreaming` is the idle probe the adapter asks for.
	pi: session,
	isIdle: () => !session.isStreaming,
});
adapter.onRunError((error) => console.error("[ACE] agent run failed:", error));
const subscription: EndpointConfig = {
	name: "build-events",
	transport: "memory",
	activation: "default",
	config: {},
	options: {},
};
const runtime = new AceRuntime({
	engine: adapter,
	subscribe: [subscription],
	transports: { [subscription.name]: transport },
	logger: consoleAceLogger,
});

session.subscribe((event_) => {
	if (event_.type === "message_update" && event_.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event_.assistantMessageEvent.delta);
	}
});

try {
	await runtime.start();

	console.log(`[ACE] publishing ${event.sender}/${event.id} (activation=${event.activation})\n`);
	await transport.publish(event);

	// `manual` events are retained instead of starting a turn; show the explicit activation hook.
	const pending = runtime.pendingEvents[0];
	if (pending) {
		console.log(
			`\n[ACE] ${runtime.pendingEvents.length} manual event(s) retained; activating ${pending.message.id}\n`,
		);
		await runtime.activatePendingEvent(pending.message.sender, pending.message.id);
	}

	await session.waitForIdle();
	console.log("\n[ACE] done");
} finally {
	await runtime.stop();
	session.dispose();
}
