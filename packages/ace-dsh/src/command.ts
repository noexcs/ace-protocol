/**
 * `/ace` — the human face, writing its report into the session record.
 *
 * There is no panel to open and nothing to hold while it is read: a report is text, it scrolls back, and
 * it stays visible across turns, which is what the DeepSeek Harness command surface is for. The listing
 * itself is not re-implemented here — `/ace agents` calls the same tool body the model calls, so the two
 * faces cannot drift apart.
 */

import {
	ACE_TOOL_NAMES,
	formatChannelReport,
	formatSessionLabel,
	TOOL_ERROR_TEXT,
} from "../vendor/ace-runtime/dist/index.js";
import { activatePending, pendingReport } from "./manual.ts";
import type { AceSession } from "./session.ts";
import { ACE_TOOL_DESCRIPTORS } from "./tools.ts";

/** What a command handler returns to the dispatching UI. */
export interface AceCommandReply {
	readonly kind: "success" | "error";
	readonly text: string;
}

const HELP = [
	"ACE (Agent Context Event Protocol) — external events as an active input to this session.",
	"",
	"  /ace                 this session's channels, servers, peers and pending events",
	"  /ace agents [agent]  the live sessions that can be addressed right now",
	"  /ace pending         events held for manual activation",
	"  /ace activate <sender> <id>   deliver one held event to this session",
	"  /ace help            this text",
	"",
	"Configuration is `.ace.json` in this session's working directory (`$ACE_CONFIG` overrides it);",
	"it is read once when the session starts, so an edit takes effect on the next session.",
].join("\n");

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The session's own channels, servers and peers, plus what is held for manual activation. */
function statusReport(session: AceSession): string {
	// A configured subscription is a persistent (topic/service) channel. This host does not read those, and the
	// report shows them as unavailable rather than pretending the configured set is the read set.
	const ignored = session.config.subscriptions.map((subscription) => ({
		channel: subscription.channel,
		server: subscription.server.name,
	}));
	return formatChannelReport({
		identity: `dsh · ${formatSessionLabel(session.sessionId)}`,
		agentState: session.live ? "live" : "not live on any server",
		source: session.config.source,
		subscriptions: session.readEndpoints(),
		selfChannels: session.readChannels(),
		...(session.config.shadowed === undefined ? {} : { shadowed: session.config.shadowed }),
		servers: session.config.servers.map((server) => server.name),
		unavailableServers: [...session.unavailableServers],
		unavailableSubscriptions: ignored,
		pendingManual: session.runtime.pendingEvents.length,
		// This host has no dead-letter sink: an entry it gave up on stays in the broker's pending list, where
		// the transport's own reclaim pass owns it.
		deadLetters: { count: 0 },
	});
}

/** One retained event, activated by the identity the sender and the event id give it. */
async function activate(session: AceSession, rest: readonly string[]): Promise<AceCommandReply> {
	const [sender, id] = rest;
	if (sender === undefined || id === undefined) {
		return { kind: "error", text: `usage: /ace activate <sender> <id> — \`/ace pending\` lists both.` };
	}
	try {
		return { kind: "success", text: await activatePending(session, sender, id) };
	} catch (error) {
		return { kind: "error", text: `Could not activate ${sender}/${id}: ${describeError(error)}` };
	}
}

/**
 * Run one `/ace` line.
 *
 * @param line - the text after the command name; empty means the status report.
 * @param session - this session's ACE runtime, or `undefined` when it has no usable `.ace.json`.
 */
export async function runAceCommand(line: string, session: AceSession | undefined): Promise<AceCommandReply> {
	if (session === undefined) return { kind: "error", text: TOOL_ERROR_TEXT.notRunning };
	const [verb = "", ...rest] = line.split(/\s+/).filter((part) => part !== "");

	switch (verb) {
		case "":
		case "status":
			return { kind: "success", text: statusReport(session) };
		case "agents": {
			// The same body `ace_agents` runs: one listing, two faces.
			const tool = ACE_TOOL_DESCRIPTORS.find((descriptor) => descriptor.name === ACE_TOOL_NAMES.agents);
			if (tool === undefined) return { kind: "error", text: "the ace_agents tool is not registered" };
			const args: Record<string, unknown> = rest[0] === undefined ? {} : { agent: rest[0] };
			try {
				return { kind: "success", text: await tool.run(args, session) };
			} catch (error) {
				return { kind: "error", text: describeError(error) };
			}
		}
		case "pending":
			return { kind: "success", text: pendingReport(session) };
		case "activate":
			return activate(session, rest);
		case "help":
			return { kind: "success", text: HELP };
		default:
			return { kind: "error", text: `unknown subcommand "${verb}"\n\n${HELP}` };
	}
}
