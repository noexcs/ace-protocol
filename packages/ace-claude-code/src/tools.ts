import { randomUUID } from "node:crypto";
import type {
	AceMessage,
	EndpointConfig,
	PendingAceEvent,
	ResolvedAceConfig,
	ResolvedServer,
} from "../vendor/ace-runtime/dist/index.js";
import {
	ACE_TOOL_NAMES,
	CHANNELS_PARAMETERS,
	channelListingInput,
	channelStreamKey,
	channelsToolText,
	deliveredChannel,
	describeSender,
	failedTarget,
	formatChannelListing,
	formatPublishResult,
	hostFacts,
	NO_SESSION_LABEL,
	PUBLISH_PARAMETERS,
	TOOL_ERROR_TEXT,
	TOOL_TEXT,
	validateAceMessage,
} from "../vendor/ace-runtime/dist/index.js";

/** One JSON Schema `inputSchema` for an MCP tool. */
type JsonSchema = Record<string, unknown>;

/** An MCP tool as the `tools/list` response carries it. */
export interface McpTool {
	name: string;
	description: string;
	inputSchema: JsonSchema;
}

/** The MCP `CallTool` result body: text content, `isError` when the tool failed. */
export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

/**
 * The runtime surface the tools read: the retained `manual` events and the explicit activation
 * hook. `AceRuntime` satisfies this structurally, and a test can stand in with a fake.
 */
export interface AceRuntimeSurface {
	pendingEvents: readonly PendingAceEvent[];
	activatePendingEvent(sender: string, id: string): Promise<void>;
}

/** Where a publish call goes: a channel on one of the servers this session is live on. */
export interface PublishedTarget {
	server: ResolvedServer;
	/** The uploaded channel name the event is addressed to. */
	channel: string;
	/** The sender name to publish as on that server (its inbox channel). */
	sender: string;
}

/**
 * Publishing is a channel name resolved to a server: the surface `startAce` hands the tools. The
 * event is built per target, because the sender name belongs to one server.
 */
export interface PublishSurface {
	/** The senders this session publishes as, one per live server (= its inbox channel names). */
	senders: string[];
	/** Live server names, for messages that name where a target was looked for. */
	serverNames: string[];
	/** Resolve a channel name (or `<server>:<channel>`) to a server and its uploaded channel. */
	resolve(name: string): Promise<PublishedTarget>;
	/** Derive the stream from the channel name and append the message with the server's writer. */
	send(target: PublishedTarget, message: AceMessage): Promise<void>;
}

/**
 * Everything a tool handler needs, built once at startup in {@link server.ts} and read live by the
 * handlers so a tool call reflects the current runtime state.
 *
 * A channel name is the address: this session's inbox is the channel named by its sender, in
 * `subscriptions` alongside the configured ones. `publish` resolves a target channel name to a
 * server and writes to it; `sessionId` is carried as the ACE `sessionId` (RFC §5.4), which names
 * the sender's instance — display-only, never an authorization.
 */
export interface ToolContext {
	config?: ResolvedAceConfig;
	/** The channels the runtime reads (derived): configured subscriptions plus one inbox per live server. */
	subscriptions: EndpointConfig[];
	/** The derived inbox the agent directory registered for this session, when there is one. */
	inbox?: EndpointConfig;
	/** The host session id, when Claude Code exposes it; carried as the ACE `sessionId` (RFC §5.4). */
	sessionId?: string;
	codingAgent: string;
	/** Session working directory, carried into the sender description. */
	cwd: string;
	runtime?: AceRuntimeSurface;
	/** The publishing surface; absent when ACE is not running. */
	publish?: PublishSurface;
}

/**
 * The text of the tools **only this host** has. The shared tools (`ace_publish`, `ace_channels`) take
 * their names, descriptions and parameter schemas from `ace-runtime`, where every host reads the same
 * spec — a copy here is what `test/tool-text-unity.test.ts` fails on. `ace_agents` has no counterpart
 * on this host, so the `ace_channels` pointer to it is dropped (see {@link channelsToolText}).
 */
const HOST_TOOL_TEXT = {
	pending: {
		description:
			"List the manual ACE events this session is holding: retained because their activation is `manual`, to be delivered only when explicitly activated.",
	},
	activate: {
		description: "Activate one retained manual ACE event by (sender, id), injecting it as next_turn now.",
	},
} as const;

/**
 * The four ACE tools, as `tools/list` returns them. When this session registered in the agent
 * directory, `senders` names the channel(s) it answers to: what other sessions pass as `target` for
 * a direct event to this one.
 */
export function buildToolDefinitions(senders: readonly string[] = []): McpTool[] {
	return [
		{
			name: ACE_TOOL_NAMES.channels,
			description: channelsToolText({ agentsTool: false }),
			// A TypeBox schema *is* JSON Schema at runtime; the cast only crosses the structural gap
			// (TypeBox's types carry no index signature).
			inputSchema: CHANNELS_PARAMETERS as unknown as JsonSchema,
		},
		{
			name: ACE_TOOL_NAMES.publish,
			description: senders.length === 0 ? TOOL_TEXT.publish.intro : publishDescription(senders),
			inputSchema: PUBLISH_PARAMETERS as unknown as JsonSchema,
		},
		{
			name: "ace_pending",
			description: HOST_TOOL_TEXT.pending.description,
			inputSchema: { type: "object", properties: {} },
		},
		{
			name: "ace_activate",
			description: HOST_TOOL_TEXT.activate.description,
			inputSchema: {
				type: "object",
				properties: {
					sender: { type: "string", description: "The sender of the retained event" },
					id: { type: "string", description: "The id of the retained event" },
				},
				required: ["sender", "id"],
			},
		},
	];
}

/** The `ace_publish` description with this session's directory channel(s) appended, when it has any. */
function publishDescription(senders: readonly string[]): string {
	const listed = senders.map((sender) => `"${sender}"`).join(", ");
	return (
		TOOL_TEXT.publish.intro +
		` This session is in the agent directory as ${listed}; other agent sessions can send it a ` +
		`direct event by passing that name as their target.`
	);
}

/** Run one tool by name with its (already schema-checked) arguments. */
export async function executeTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
	try {
		switch (name) {
			case ACE_TOOL_NAMES.channels:
				return channelsTool(ctx);
			case ACE_TOOL_NAMES.publish:
				return await publishTool(ctx, args);
			case "ace_pending":
				return pendingTool(ctx);
			case "ace_activate":
				return await activateTool(ctx, args);
			default:
				return errorResult(`unknown tool "${name}"`);
		}
	} catch (error) {
		return errorResult(error instanceof Error ? error.message : String(error));
	}
}

function requireRuntime(ctx: ToolContext): AceRuntimeSurface {
	const runtime = ctx.runtime;
	if (!runtime) {
		throw new Error(TOOL_ERROR_TEXT.notRunning);
	}
	return runtime;
}

function channelsTool(ctx: ToolContext): ToolResult {
	if (!ctx.config) return errorResult(TOOL_ERROR_TEXT.notRunning);
	const listing = channelListingInput(ctx.subscriptions, ctx.inbox);
	return textResult(
		formatChannelListing(listing.subscriptions, {
			...(listing.derivedName === undefined ? {} : { derivedName: listing.derivedName }),
		}),
	);
}

function pendingTool(ctx: ToolContext): ToolResult {
	const runtime = requireRuntime(ctx);
	const pending = runtime.pendingEvents;
	if (pending.length === 0) return textResult("no pending manual events");
	const lines = pending.map((event) => `${event.message.sender}/${event.message.id}: ${truncate(event.message.body)}`);
	return textResult(`pending manual events (${pending.length}):\n${lines.join("\n")}`);
}

async function activateTool(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
	const runtime = requireRuntime(ctx);
	const sender = typeof args.sender === "string" ? args.sender : "";
	const id = typeof args.id === "string" ? args.id : "";
	if (!sender || !id) throw new Error("usage: ace_activate { sender, id }");
	await runtime.activatePendingEvent(sender, id);
	return textResult(`activated ${sender}/${id}`);
}

async function publishTool(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
	const body = typeof args.body === "string" ? args.body : undefined;
	const rawTarget = args.target;
	const target = typeof rawTarget === "string" ? [rawTarget] : Array.isArray(rawTarget) ? rawTarget : undefined;
	if (body === undefined || body.length === 0 || target === undefined || target.length === 0) {
		throw new Error(TOOL_ERROR_TEXT.usagePublish);
	}
	const surface = ctx.publish;
	if (surface === undefined) throw new Error(TOOL_ERROR_TEXT.notRunning);
	const activation =
		typeof args.activation === "string" && args.activation !== "default" ? args.activation : "next_turn";

	// The id is the runtime's: the caller reads it back from the result instead of choosing it. The
	// sender carries a self-description, so a receiver can show who and where it is without any lookup.
	const id = `evt_${randomUUID()}`;
	const description = describeSender(
		hostFacts({
			codingAgent: ctx.codingAgent,
			sessionId: ctx.sessionId ?? NO_SESSION_LABEL,
			cwd: ctx.cwd,
		}),
	);

	const delivered: string[] = [];
	const failures: string[] = [];
	const sentStreams = new Set<string>();
	const senders: string[] = [];
	for (const name of [...new Set(target.filter((t): t is string => typeof t === "string"))]) {
		try {
			const resolved = await surface.resolve(name);
			const stream = channelStreamKey(resolved.server.namespace, resolved.channel);
			// The same channel twice in one call is one delivery.
			const address = `${resolved.server.url}#${stream}`;
			if (sentStreams.has(address)) {
				delivered.push(deliveredChannel(resolved.channel));
				continue;
			}
			sentStreams.add(address);
			if (!senders.includes(resolved.sender)) senders.push(resolved.sender);
			// A sender name belongs to one server, so the event is built per target rather than once.
			const message = validateAceMessage({
				aceVersion: "0.1",
				id,
				sender: resolved.sender,
				...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
				senderDescription: description,
				activation,
				body,
			});
			await surface.send(resolved, message);
			delivered.push(deliveredChannel(resolved.channel));
		} catch (error) {
			failures.push(failedTarget(name, describeError(error)));
		}
	}

	if (delivered.length === 0) throw new Error(TOOL_ERROR_TEXT.nothingPublished(failures));
	return textResult(formatPublishResult({ id, sender: senders.join(", "), activation, delivered, failures }));
}

function errorResult(message: string): ToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

function textResult(message: string): ToolResult {
	return { content: [{ type: "text", text: message }] };
}

function truncate(text: string, limit = 60): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
