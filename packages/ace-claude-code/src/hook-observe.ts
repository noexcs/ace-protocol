import { readFileSync } from "node:fs";
import { appendAckObservation, extractAceEvents } from "./ack.ts";

/**
 * `UserPromptSubmit` hook that makes acknowledgement possible on a host with no delivery ack.
 *
 * Claude Code does not acknowledge `notifications/claude/channel` — the `await` on the notification
 * resolves when it is written to the transport, not when the model read it. So "handed to the host"
 * is not "the agent can see it". This hook runs on every prompt the session submits; the host injects
 * a channel event as a self-started prompt, so a channel turn runs this hook with the rendered
 * `<ace_event>` block in the `prompt` field. It appends what it saw to the acknowledgement trail the
 * MCP server polls, and the runtime acknowledges the broker only once the event is observed.
 *
 * It must be fast (it blocks the turn while it runs) and must never fail in a way that surfaces to
 * the session: it always exits 0. A failed write just means the event is not acknowledged this pass,
 * and the transport's reclaim redelivers it.
 */
const input = readFileSync(0, "utf8");

let event: { prompt?: unknown; cwd?: unknown };
try {
	event = JSON.parse(input) as { prompt?: unknown; cwd?: unknown };
} catch {
	// Not JSON, or stdin was closed: nothing to observe.
	event = {};
}

const prompt = typeof event.prompt === "string" ? event.prompt : "";
const projectDir = typeof event.cwd === "string" ? event.cwd : (process.env.CLAUDE_PROJECT_DIR ?? process.cwd());

if (prompt.includes("<ace_event>")) {
	try {
		await appendAckObservation(projectDir, {
			t: new Date().toISOString(),
			blocks: extractAceEvents(prompt),
			prompt,
		});
	} catch {
		// Swallowed on purpose: a hook that throws would interrupt the turn.
	}
}

process.exit(0);
