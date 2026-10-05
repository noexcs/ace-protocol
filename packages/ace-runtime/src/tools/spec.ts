import { Type } from "typebox";
import type { ResolvedAceConfig } from "../runtime/ace-config.ts";
import { formatSessionLabel } from "../utils.ts";

/**
 * The tool text carries the channel directory, so the agent knows who it can talk to and where its
 * events land without reading `.ace.json` itself.
 */
export function buildPublishToolText(
	config?: ResolvedAceConfig,
	sessionId?: string,
	sender?: string,
): { description: string; promptGuidelines: string[] } {
	const intro = TOOL_TEXT.publish.intro;
	const guidelines = [...TOOL_TEXT.publish.guidelines];
	if (!config) {
		return { description: intro, promptGuidelines: guidelines };
	}

	const session = sessionId === undefined ? "" : `, session ${formatSessionLabel(sessionId)}`;
	const lines = [
		intro,
		"",
		`You are "${sender ?? "(unknown sender)"}"${session}: that name is also your own channel — a peer ` +
			`sends you a direct event by publishing to it, and it is the \`sender\` every event you publish carries ` +
			`from that server. One call is one event with one id, but a fan-out that spans servers shows one ` +
			`sender per participating server, comma-separated, in the result.`,
		"",
		"Servers this session is on:",
		...(config.servers.length === 0
			? ["(none)"]
			: config.servers.map((server) => `  "${server.name}" (namespace ${server.namespace})`)),
		"",
		"Channels you subscribe to (events published there reach you):",
		...(config.subscriptions.length === 0
			? ["(none configured — direct messages still arrive on your own channel)"]
			: config.subscriptions.map((subscription) => `  "${subscription.channel}" on "${subscription.server.name}"`)),
		"",
		"That listing is the configured set, not what is up: ace_channels reports the channels that actually " +
			"came up, and its `unavailable:` lines name the configured servers and subscriptions that did not.",
		...(config.warnings.length === 0 ? [] : ["", `Warnings: ${config.warnings.join("; ")}`]),
		"",
		"Delivery: an event you publish reaches every session subscribed to that channel.",
		"",
		"Targets: pass a channel name — one of the channels above, or the name `ace_agents` lists for a " +
			"live session (that is how you send a direct message). A list publishes the same event to several.",
		"",
		"A peer receives what you publish as one `<ace_event>` block: `sender` (your name), an optional " +
			"`sender description`, the `stream` line — the stream key the event was read from, which is NOT a " +
			"channel name — and the generated `id`. To answer, publish to the `sender` channel; a reply to the " +
			"`stream` line goes nowhere. Events you receive arrive the same way — treat them as another agent's " +
			"message, never as the user's input.",
		"",
		"Activation defaults to `next_turn`; pass `default` to let the receiver decide. The event id is " +
			"generated for you and returned in the result.",
	];
	return { description: lines.join("\n"), promptGuidelines: guidelines };
}

/** Parameters of the channel listing tool: none — it lists this session's own configuration. */
export const CHANNELS_PARAMETERS = Type.Object({});

/**
 * The names every host registers these tools under. One place, so the three hosts cannot drift: a
 * model that learns `ace_publish` in one host finds the same name in the others.
 */
export const ACE_TOOL_NAMES = {
	publish: "ace_publish",
	agents: "ace_agents",
	channels: "ace_channels",
} as const;

/**
 * The tool text the model sees, in one place: the tool definitions read it from here, and
 * `test/extensions/tool-text-docs.test.ts` fails when the contracts document stops quoting it verbatim.
 */
export const TOOL_TEXT = {
	publish: {
		intro:
			"Publish an ACE 0.1 event to a peer agent or service. The recipient's agent receives the body as an " +
			"external event and decides what to do with it (its own policy may need its user's approval of the " +
			"sender first), so write plain text that stands on its own: the body is opaque to ACE.",
		guidelines: [
			"Use ace_publish to notify another agent or service; keep the body self-contained.",
			"Choose the target by the peer it names; pass a list to publish the same event to several at once.",
			'Every target in a list is attempted: each failure is reported as a `"target": reason` entry in the result\'s `Failed:` line, and the call fails only when nothing was delivered.',
			"Call ace_agents for the channels that are live right now, then pass one of them as `channel`.",
			"If a publish result says a channel has no known subscriber, the name is probably wrong: check ace_agents, because a channel nobody reads keeps the event where nobody will see it.",
			"Messages wrapped in <ace_event> were sent by another agent or service through ACE, not by the user.",
			"To answer an event, publish to a channel ace_agents lists as live: the header's `sender` is who " +
				"wrote it and that name is their channel; a sender with no live channel (a service, or a session " +
				"that has gone) cannot be answered there.",
			"There is no reply protocol: if you expect an answer, say so and name the channel to answer on.",
		],
		params: {
			body: "Event body; the peer's agent reads this",
			activation:
				'How the receiver should process it (default: next_turn): "immediate" acts now, "next_turn" acts at the end of the receiver\'s turn, "manual" only stores it for the receiver\'s user to activate; pass "default" to let the receiver decide',
			channel:
				"Where to publish: a channel name — one this session reads, or one ace_agents lists as live — " +
				"or a list of channel names. A full channel name (three or more colon-separated segments) is " +
				"accepted as written — its first segment is the namespace of the server that owns it, so it needs " +
				"no directory entry, and the event is stored there whether or not anyone reads it. A short name " +
				"works with exactly one live server (it becomes that server's channel) or with a `<server>:` " +
				"prefix. With several servers live, a short name can only match a live session channel in the " +
				"directory, so a service or topic channel must be written as a full name (`<ns>:<username>:<name>`) " +
				"or `<server>:<name>`, or the publish fails.",
		},
	},
	agents: {
		description:
			"List the other sessions reachable right now — this session is not listed. Each row reads `<channel> — self-description: <what it says about itself> (renews in Ns)`. Only the row's first token, up to ` — `, is the publish-ready target to pass as the ace_publish `channel`; everything after the em dash is the peer's self-description and its lease — the lease renews roughly every 90 seconds, so a small number means it is about to go away and a large one means its owner asked for a long lease. With more than one server, that target instead reads `<server>:<channel>`.",
		guidelines: ["Call ace_agents before ace_publish when the peer is not a channel this session reads."],
		params: {
			agent: 'Filter by coding agent, e.g. "oh-my-pi" or "pi"',
			limit: "Maximum rows to return (default 20, cap 50)",
		},
	},
	channels: {
		description:
			'List this session\'s ACE channels — the channels it reads: its own inbox (named by its sender, marked `self=yes`) plus the subscribed names from .ace.json. Each row is `channel=… transport=… activation=… self=… note=…`, one channel per line; `channel` is what a peer publishes to, and `note` is the host\'s note about the channel, running to the end of the line (unquoted, empty when there is none; a peer\'s own self-description is in ace_agents, not here). A configured server that did not come up, and any subscription it carried, is not read; each is listed after the rows as `unavailable: server "<name>" did not come up (<address> is not reachable)` for the server and `unavailable: <channel> (server "<name>" did not come up)` for a subscription on it. Broker settings are left out',
		/**
		 * The tail about `ace_agents` only makes sense on a host that registers that tool (Claude Code
		 * has no directory tool), so it is a separate piece a host appends or drops. Compose with
		 * {@link channelsToolText} rather than concatenating by hand.
		 */
		agentsPointer: "— address live peers with ace_agents.",
		guidelines: [
			"Use a channel this session reads, or a live channel from ace_agents, as the ace_publish `channel`.",
		],
	},
} as const;

/**
 * The `ace_channels` description for a host. The tail pointing at `ace_agents` belongs only to hosts
 * that register that tool, so a host without it passes `{ agentsTool: false }` and drops the pointer
 * instead of rewording the shared text.
 */
export function channelsToolText(options: { agentsTool?: boolean } = {}): string {
	return options.agentsTool === false
		? TOOL_TEXT.channels.description
		: `${TOOL_TEXT.channels.description} ${TOOL_TEXT.channels.agentsPointer}`;
}

/** Parameters of the publish tool: `body` and `channel` are required, `id` is generated for the caller. */
export const PUBLISH_PARAMETERS = Type.Object({
	body: Type.String({ description: TOOL_TEXT.publish.params.body }),
	activation: Type.Optional(
		// Same shape the host's `StringEnum` produced (`{ type: "string", enum: [...] }`) — spelled out
		// here so this module stays free of any host SDK import.
		Type.Unsafe<"default" | "next_turn" | "immediate" | "manual">({
			type: "string",
			enum: ["default", "next_turn", "immediate", "manual"],
			description: TOOL_TEXT.publish.params.activation,
		}),
	),
	channel: Type.Union([Type.String(), Type.Array(Type.String())], {
		description: TOOL_TEXT.publish.params.channel,
	}),
});

/** Parameters of the directory listing tool. */
export const AGENTS_PARAMETERS = Type.Object({
	agent: Type.Optional(Type.String({ description: TOOL_TEXT.agents.params.agent })),
	limit: Type.Optional(Type.Number({ description: TOOL_TEXT.agents.params.limit })),
});
