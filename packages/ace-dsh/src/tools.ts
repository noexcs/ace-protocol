/**
 * The model-facing ACE tools, bound to one live session.
 *
 * The tool *surface* is the core's: names, descriptions, guidelines, argument validation, result text and
 * the reader checks all come from `ace-runtime`, so a model working in DeepSeek Harness reads the same
 * protocol text it would read on Pi. What is written here is only the binding — which session a call
 * belongs to, and how a descriptor's canonical string value reaches the host.
 *
 * Four tools, not five: `ace_channels` exists to report which *persistent* channels came up, and this host
 * reads live channels only. Skipping it keeps the model-facing surface honest — no tool that would always
 * answer "none".
 */

import { randomUUID } from "node:crypto";
import {
	ACE_TOOL_NAMES,
	buildPublishToolText,
	codingAgentOf,
	compareDiscoveredSessions,
	deliveredChannel,
	describeDiscovered,
	duplicateTarget,
	failedTarget,
	formatDiscoveredSessions,
	formatPublishResult,
	NO_LIVE_SESSIONS,
	type PublishTargetRow,
	type RegistryEntry,
	type ResolvedChannelTarget,
	readerFactsOf,
	receiveFile,
	resolveChannelTarget,
	resolvePublishTargets,
	storeFile,
	TOOL_ARGUMENTS,
	TOOL_ERROR_TEXT,
	TOOL_TEXT,
	validateAceMessage,
	validateAgentsInput,
	validateGetInput,
	validatePublishInput,
	validateStoreInput,
	type XferTarget,
} from "../vendor/ace-runtime/dist/index.js";
import { activatePending, pendingReport } from "./manual.ts";
import type { AceSession } from "./session.ts";

/** What only this host can say in the model-facing text, appended to the core's own description. */
export const DSH_PUBLISH_SPECIFICS = [
	"Delivery in DeepSeek Harness: the event enters the receiving session's own conversation as one `<ace_event>` block — `immediate` steers into that session's running turn (and starts one when it is idle), `next_turn` queues it for the next turn, and `manual` is retained until the receiving user activates it.",
	"A session is addressable only while it is live: `ace_agents` lists the channels that are registered right now, and a session that has been closed is not listed. This host reads live channels only, so a channel that no live session names is not something this session can be reached on.",
].join(" ");

/**
 * One parameter of one tool, in the host's own schema dialect (the core's TypeBox schemas are not it).
 *
 * `channel` is why the `oneOf` member exists: ACE takes one channel name *or* a list of them, and declaring
 * only `array` makes the host's validator reject the common single-target call before this plugin's own
 * code — which accepts both — ever runs.
 */
export type AceParameterSpec =
	| { readonly type: "string"; readonly required?: true; readonly description: string }
	| { readonly type: "number"; readonly required?: true; readonly description: string }
	| {
			readonly type: "array";
			readonly required?: true;
			readonly description: string;
			readonly items: { readonly type: "string" };
	  }
	| {
			readonly description: string;
			readonly oneOf: readonly [
				{ readonly type: "string" },
				{ readonly type: "array"; readonly items: { readonly type: "string" } },
			];
	  };

/** One tool the host registers: everything the model sees, plus a body that returns its text. */
export interface AceToolDescriptor {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, AceParameterSpec>;
	/** Returns the model-facing result text. Throws to fail the call, as ACE does. */
	run(args: Record<string, unknown>, session: AceSession | undefined): Promise<string>;
}

/** A stable, human reason from an unknown thrown value: what every `status=failed error=` row carries. */
function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Fold the core's guidelines into the description; the host's tool schema has no separate slot for them. */
function withGuidelines(description: string, guidelines: readonly string[]): string {
	if (guidelines.length === 0) return description;
	return `${description}\n\nGuidelines:\n${guidelines.map((line) => `- ${line}`).join("\n")}`;
}

/** A publish target plus the directory view the reader checks are answered from. */
type PublishTarget = ResolvedChannelTarget & { list: () => Promise<RegistryEntry[]> };

/** Resolve one target name against the live directory, keeping the view the fact checks need. */
function targetResolver(session: AceSession): (name: string) => Promise<PublishTarget> {
	const active = session.targetServers();
	return async (name: string) => {
		const target = await resolveChannelTarget({
			name,
			active,
			configured: [...session.configuredServers],
			username: session.config.username,
		});
		const link = active.find((candidate) => candidate.server.name === target.server.name);
		if (link === undefined) throw new Error(`server "${target.server.name}" is not live in this session`);
		return { ...target, list: () => link.list() };
	};
}

function publishTool(): AceToolDescriptor {
	const text = buildPublishToolText(undefined, undefined, "", DSH_PUBLISH_SPECIFICS);
	return {
		name: ACE_TOOL_NAMES.publish,
		description: withGuidelines(text.description, text.promptGuidelines),
		parameters: {
			body: { type: "string", required: true, description: TOOL_TEXT.publish.params.body },
			activation: { type: "string", description: TOOL_TEXT.publish.params.activation },
			channel: {
				// One name or a list; the DSL has no other way to say `string | string[]`.
				oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
				description: TOOL_TEXT.publish.params.channel,
			},
		},
		async run(args, session) {
			if (session === undefined) throw new Error(TOOL_ERROR_TEXT.notRunning);
			const input = validatePublishInput(args, {
				servers: session.configuredServers.map((server) => server.name),
			});
			if (!session.live) throw new Error(TOOL_ERROR_TEXT.noDirectory);
			const id = `evt_${randomUUID()}`;
			const description = session.senderDescription();
			const activation = input.activation ?? "next_turn";
			const resolution = await resolvePublishTargets(input.targets, targetResolver(session));
			const rows: PublishTargetRow[] = [];
			const senders: string[] = [];

			for (const outcome of resolution) {
				if (outcome.kind === "failure") {
					rows.push(failedTarget(outcome.name, outcome.detail));
					continue;
				}
				if (outcome.kind === "duplicate") {
					rows.push(duplicateTarget(outcome.name, outcome.of));
					continue;
				}
				const target = outcome.target;
				try {
					// Two independent checks, not a verdict: a live entry names the channel, and this session
					// reads it. Both are reported so a stored-but-unread row is visible as exactly that.
					const facts = readerFactsOf({
						channel: target.channel,
						live: await target.list(),
						subscriptions: session.readChannels(),
						own: [...session.senders],
					});
					const completedShortName = outcome.name !== target.channel;
					if (!senders.includes(target.sender)) senders.push(target.sender);
					// A sender belongs to one server, so the envelope is built per resolved target.
					const message = validateAceMessage({
						aceVersion: "0.1",
						id,
						sender: target.sender,
						sessionId: session.sessionId,
						senderDescription: description,
						activation,
						body: input.body,
					});
					await session.store(target.server.name, target.channel, message);
					rows.push(deliveredChannel(target.channel, facts, { completedShortName }));
				} catch (error) {
					rows.push(failedTarget(outcome.name, describeError(error)));
				}
			}

			const result = formatPublishResult({ id, sender: senders.join(","), activation, rows });
			// Nothing stored is a failed call, with the same field-list text rather than a sentence.
			if (!rows.some((row) => row.status === "stored")) throw new Error(result);
			return result;
		},
	};
}

function agentsTool(): AceToolDescriptor {
	return {
		name: ACE_TOOL_NAMES.agents,
		description: withGuidelines(TOOL_TEXT.agents.description, TOOL_TEXT.agents.guidelines),
		parameters: {
			agent: { type: "string", description: TOOL_TEXT.agents.params.agent },
			limit: { type: "number", description: TOOL_TEXT.agents.params.limit },
		},
		async run(args, session) {
			if (session === undefined) throw new Error(TOOL_ERROR_TEXT.notRunning);
			const input = validateAgentsInput(args);
			if (!session.live) throw new Error(TOOL_ERROR_TEXT.noDirectory);
			const own = session.readChannels();
			// This session's own channel is dropped, as the tool's own text says: the listing answers "who else
			// can I reach". A channel a session does not read is added to the directory by another session, so
			// every entry whose name this session answers to is this session.
			const peers = (await session.listPeers())
				.filter(({ entry }) => !own.includes(entry.channel))
				.filter(({ entry }) => input.agent === undefined || codingAgentOf(entry) === input.agent)
				.sort(compareDiscoveredSessions);
			// The label is the `<server>:<channel>` form `ace_publish` accepts, so it is added only when there is
			// more than one server to tell apart — with one, the prefix is noise.
			const many = session.servers.length > 1;
			const rows = peers
				.slice(0, input.limit)
				.map(({ server, entry }) => describeDiscovered(entry, many ? { server } : {}));
			if (rows.length === 0) return NO_LIVE_SESSIONS;
			return formatDiscoveredSessions(rows, {
				...(input.agent === undefined ? {} : { filter: input.agent }),
				servers: session.servers.map((server) => server.name),
			});
		},
	};
}

function storeFileTool(): AceToolDescriptor {
	return {
		name: ACE_TOOL_NAMES.storeFile,
		description: withGuidelines(TOOL_TEXT.storeFile.description, TOOL_TEXT.storeFile.guidelines),
		parameters: {
			path: { type: "string", required: true, description: TOOL_TEXT.storeFile.params.path },
			ttl: { type: "string", description: TOOL_TEXT.storeFile.params.ttl },
			name: { type: "string", description: TOOL_TEXT.storeFile.params.name },
		},
		async run(args, session) {
			if (session === undefined) throw new Error(TOOL_ERROR_TEXT.notRunning);
			const input = validateStoreInput(args);
			if (!session.live) throw new Error(TOOL_ERROR_TEXT.noDirectory);
			const result = await storeFile({ root: session.cwd, input, targets: session.xferTargets() });
			return result.text;
		},
	};
}

function getFileTool(): AceToolDescriptor {
	return {
		name: ACE_TOOL_NAMES.getFile,
		description: withGuidelines(TOOL_TEXT.getFile.description, TOOL_TEXT.getFile.guidelines),
		parameters: {
			token: { type: "string", required: true, description: TOOL_TEXT.getFile.params.token },
		},
		async run(args, session) {
			if (session === undefined) throw new Error(TOOL_ERROR_TEXT.notRunning);
			const input = validateGetInput(args);
			if (!session.live) throw new Error(TOOL_ERROR_TEXT.noDirectory);
			const result = await receiveFile({
				root: session.cwd,
				token: input.token,
				sessionId: session.sessionId,
				targets: session.xferTargets() as readonly XferTarget[],
			});
			return result.text;
		},
	};
}

/**
 * The tool names this host adds to ACE's own four.
 *
 * ACE deliberately keeps `manual` activation out of the model-facing surface — the event is retained so a
 * *person* decides whether it enters the conversation. These two exist because the host's `/ace` command was
 * not dispatched by the client in the build this was installed into, which left the user with no way to
 * reach the held events at all. `ace_activate` therefore carries the decision in its own description: it is
 * the user's call, and the model calls it only when the user has named the event.
 */
export const HOST_TOOL_NAMES = {
	pending: "ace_pending",
	activate: "ace_activate",
} as const;

/** What this session is holding for manual activation — the same text `/ace pending` prints. */
function pendingTool(): AceToolDescriptor {
	return {
		name: HOST_TOOL_NAMES.pending,
		description: [
			'List the ACE events this session is holding for manual activation: events a peer published with `activation: "manual"`, which nothing delivers until someone chooses to deliver them.',
			"Use it when the user asks what is waiting, or to get the `sender` and `id` that ace_activate takes. Each row carries both.",
		].join(" "),
		parameters: {},
		async run(_args, session) {
			if (session === undefined) throw new Error(TOOL_ERROR_TEXT.notRunning);
			return pendingReport(session);
		},
	};
}

/** Deliver one held event into this conversation, on the user's instruction. */
function activateTool(): AceToolDescriptor {
	return {
		name: HOST_TOOL_NAMES.activate,
		description: [
			"Deliver one ACE event this session is holding for manual activation into this conversation.",
			"Activation is the user's decision, not yours: call this only after the user has asked for that exact event — read `ace_pending` first, and take both `sender` and `id` from the row it lists.",
			"If the user has not named an event, show them the listing instead of activating anything.",
		].join(" "),
		parameters: {
			sender: {
				type: "string",
				required: true,
				description: "The sender to activate, exactly as ace_pending lists it in `sender=`.",
			},
			id: {
				type: "string",
				required: true,
				description: "The event id to activate, exactly as ace_pending lists it in `id=`.",
			},
		},
		async run(args, session) {
			if (session === undefined) throw new Error(TOOL_ERROR_TEXT.notRunning);
			const sender = typeof args.sender === "string" ? args.sender : "";
			const id = typeof args.id === "string" ? args.id : "";
			if (sender === "" || id === "") {
				throw new Error("ace_activate needs both `sender` and `id`, exactly as `ace_pending` lists them");
			}
			return activatePending(session, sender, id);
		},
	};
}

/** Every tool this host registers, in registration order. */
export const ACE_TOOL_DESCRIPTORS: readonly AceToolDescriptor[] = [
	publishTool(),
	agentsTool(),
	storeFileTool(),
	getFileTool(),
	pendingTool(),
	activateTool(),
];

/** The known argument keys per tool, as the core declares them. Re-exported for the command's help text. */
export { TOOL_ARGUMENTS };
