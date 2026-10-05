import { randomUUID } from "node:crypto";
import type { AcePublisher, PendingAceEvent, ResolvedAceConfig } from "ace-runtime";
import {
	ACE_TOOL_NAMES,
	CHANNELS_PARAMETERS,
	channelsToolText,
	describeSender,
	hostFacts,
	PUBLISH_PARAMETERS,
	TOOL_TEXT,
	validateAceMessage,
} from "ace-runtime";

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
/**
 * Everything a tool handler needs, built once at startup in {@link server.ts} and read live by the
 * handlers so a tool call reflects the current runtime state.
 *
 * When `.ace.json` configures a `registry`, this session registers in the agent directory and
 * `member` carries its name there: what other sessions pass as the `target` of `ace_publish` to
 * send this session a direct event. Publishing itself stays scoped to the channels named in
 * `.ace.json` (this host does not read the directory's live entries, so the Pi host's
 * `ace_agents` tool has no counterpart here). `sessionId` is carried as the ACE `sessionId`
 * (RFC §5.4), which names the sender's instance — the session id is exactly that, and it is
 * display-only, never an authorization.
 */
export interface ToolContext {
	config?: ResolvedAceConfig;
	/** This session's sender identity, from `.ace.json`; absent when there are no publish channels. */
	sender: string | undefined;
	/** The host session id, when Claude Code exposes it; carried as the ACE `sessionId` (RFC §5.4). */
	sessionId?: string;
	codingAgent: string;
	/** Publishers keyed by `publish` channel name. */
	publishers: Record<string, AcePublisher>;
	runtime?: AceRuntimeSurface;
	/**
	 * This session's name in the agent directory, when `.ace.json` configures a `registry`: the
	 * `target` other sessions pass to send this session a direct event.
	 */
	member?: string;
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
 * The four ACE tools, as `tools/list` returns them. When `member` is set, `ace_publish` names it:
 * this session's address in the agent directory, what other sessions pass as `target` for a
 * direct event to this one.
 */
export function buildToolDefinitions(member?: string): McpTool[] {
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
			description: member === undefined ? TOOL_TEXT.publish.intro : publishDescription(member),
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

/** The `ace_publish` description with this session's directory address appended, when it has one. */
function publishDescription(member: string): string {
	return (
		TOOL_TEXT.publish.intro +
		` This session is in the agent directory as "${member}"; other agent sessions can send it a ` +
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
		throw new Error(`ACE is not running in this session; .ace.json is missing or did not load`);
	}
	return runtime;
}

function channelsTool(ctx: ToolContext): ToolResult {
	const config = ctx.config;
	if (!config) {
		return errorResult(`ACE is not running in this session; .ace.json is missing or did not load`);
	}
	const lines: string[] = [];
	if (config.subscribe.length === 0) lines.push("subscribes to no channels");
	for (const endpoint of config.subscribe) {
		const parts = [`subscribe ${endpoint.name}`];
		if (endpoint.description) parts.push(`(${endpoint.description})`);
		if (endpoint.activation) parts.push(`activation=${endpoint.activation}`);
		lines.push(parts.join(" "));
	}
	if (ctx.member !== undefined) {
		// The directory registered a per-session inbox subscription that is not in `.ace.json`; list it
		// so the model knows how other sessions reach this one directly.
		lines.push(
			`subscribe session-inbox (this session's inbox from the agent directory; peers address it as "${ctx.member}")`,
		);
	}
	if (config.publish.length === 0) lines.push("can publish to no channels");
	for (const endpoint of config.publish) {
		const parts = [`publish ${endpoint.name}`];
		if (endpoint.description) parts.push(`(${endpoint.description})`);
		lines.push(parts.join(" "));
	}
	return textResult(`${ctx.sender ?? "(no sender)"}\n${lines.join("\n")}`);
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
		throw new Error("ace_publish requires a non-empty `body` and a `target` (string or list of strings)");
	}
	if (ctx.sender === undefined) {
		throw new Error("no `sender` is configured for this session; add one to .ace.json to publish");
	}
	const activation =
		typeof args.activation === "string" && args.activation !== "default" ? args.activation : "next_turn";

	const message = validateAceMessage({
		aceVersion: "0.1",
		id: `evt_${randomUUID()}`,
		sender: ctx.sender,
		...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
		senderDescription: describeSender(
			hostFacts({
				codingAgent: ctx.codingAgent,
				sessionId: ctx.sessionId ?? "(channel session)",
				cwd: process.cwd(),
			}),
		),
		activation,
		body,
	});

	const delivered: string[] = [];
	const failures: string[] = [];
	for (const name of [...new Set(target.filter((t): t is string => typeof t === "string"))]) {
		const publisher = ctx.publishers[name];
		if (publisher === undefined) {
			failures.push(
				`"${name}": not a configured publish channel (${Object.keys(ctx.publishers).join(", ") || "none"})`,
			);
			continue;
		}
		try {
			await publisher.publish(message);
			delivered.push(`channel "${name}"`);
		} catch (error) {
			failures.push(`"${name}": ${describeError(error)}`);
		}
	}

	if (delivered.length === 0) throw new Error(`nothing published: ${failures.join("; ")}`);
	return textResult(
		[
			`Published id=${message.id} from ${message.sender} to ${delivered.length} target(s): ${delivered.join(", ")} (activation: ${message.activation}).`,
			...(failures.length > 0 ? [`Failed: ${failures.join("; ")}`] : []),
		].join("\n"),
	);
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
