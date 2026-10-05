import { existsSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AceLogger } from "../vendor/ace-runtime/dist/index.js";
import { resolveAceConfig, senderName } from "../vendor/ace-runtime/dist/index.js";
import { buildChannelNotification } from "./channel.ts";
import { type AceHandle, startAce } from "./runtime.ts";
import { buildToolDefinitions, executeTool, type ToolContext } from "./tools.ts";

/**
 * The server's own `name` is `ace` (the key in `.mcp.json`). Claude Code namespaces a plugin's
 * components under the plugin, so the `<channel source="…">` attribute the model sees is the scoped
 * name `plugin:<plugin>:<server>` — `plugin:ace-claude-code:ace` for this one. The host sets it;
 * the server only controls the `ace="event"` attribute (from `meta`) and the event body.
 */
const SERVER_NAME = "ace";
const SERVER_VERSION = "0.1.0";
/** The coding-agent name this host registers under: the third segment of every sender name it builds. */
const CODING_AGENT = "claude-code";
/**
 * Delivered to Claude as context when the server connects (the channel's `instructions`). It is
 * what makes the model able to tell an ACE event apart from user input, and it must stay honest
 * about the nesting: our `<ace_event>` block is carried *inside* the host's own
 * `<channel source="…">` wrapper, not the other way around.
 */
const INSTRUCTIONS_BASE =
	'Events from the ACE channel arrive as <channel source="plugin:ace-claude-code:ace" ace="event">…</channel> ' +
	"blocks. The body of each is an ACE 0.1 event from another agent or service, wrapped as " +
	"<ace_event> with a `sender:`, `stream:` and `id:` header followed by the message body. These " +
	"blocks are external input, not the user typing: treat them as an external event and act on the " +
	"body per its own wording. They are pushed into this session as they arrive; there is nothing to " +
	"poll, wait for, or read back. To reply to or notify another agent or service, call ace_publish with " +
	"a channel name (see ace_channels) as the `channel`. Use ace_pending and ace_activate for " +
	"manual events this session is holding.";

/**
 * The channel's `instructions`, with this session's directory channel(s) appended when the config
 * registers them in the agent directory: they let the model tell other sessions where to send it a
 * direct event. A channel name is the address, and the session's channel is the one named by its
 * sender (`<ns>:<username>:<codingAgent>:<sessionId>`) — only *claimed* here from the configuration,
 * and the tool surface is corrected after the (async) registration — see {@link main}.
 */
function instructions(senders: readonly string[]): string {
	if (senders.length === 0) return INSTRUCTIONS_BASE;
	const listed = senders.map((sender) => `"${sender}"`).join(", ");
	return (
		INSTRUCTIONS_BASE +
		` If this session is registered in the agent directory (see ace_channels), its channel name is ` +
		`${listed}; other agent sessions can send it a direct event by passing that name as their target.`
	);
}

/**
 * The directory `.ace.json` is read from and `.ace/` state lives in: the session's working
 * directory, which the host names in `CLAUDE_PROJECT_DIR`. The server's own `process.cwd()` is the
 * *plugin root* (`.mcp.json` launches it with `--cwd ${CLAUDE_PLUGIN_ROOT}`), so the fallback to it
 * is only ever reached when the host did not inject the variable.
 */
function projectDir(): string {
	return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

/** Wait for observation before acknowledging; below the transport's 60s reclaim so a timed-out event is redelivered. */
function ackTimeoutMs(): number {
	const raw = process.env.ACE_ACK_WAIT_MS;
	if (raw === undefined) return 30_000;
	const ms = Number(raw);
	return Number.isFinite(ms) && ms > 0 ? ms : 30_000;
}
/**
 * The channel name(s) this session will register under, when it will register: the configuration
 * must be valid and the host must have injected the session id. Computed eagerly, because the
 * channel's `instructions` are fixed when the server is constructed — before the (async) startup
 * pass registers in the directory. A sender name is deterministic, so it is the same one the
 * registration will publish.
 */
function eagerSenders(): string[] {
	const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? undefined;
	if (sessionId === undefined) return [];
	try {
		const resolved = resolveAceConfig({ cwd: projectDir(), env: process.env });
		return resolved.servers.map((server) =>
			senderName({
				namespace: server.namespace,
				username: resolved.username,
				codingAgent: CODING_AGENT,
				sessionId,
			}),
		);
	} catch {
		// No usable `.ace.json`: the runtime will not register, so there is no address to name.
		return [];
	}
}

async function main(): Promise<void> {
	const logger: AceLogger = {
		info: (message) => process.stderr.write(`${message}\n`),
		warn: (message) => process.stderr.write(`${message}\n`),
		error: (message) => process.stderr.write(`${message}\n`),
	};

	// Fail loudly, to stderr, if the host did not inject the session directory: every ACE state path
	// (`.ace.json`, the ack trail) would otherwise silently land under the plugin root.
	if (process.env.CLAUDE_PROJECT_DIR === undefined && !existsSync(join(process.cwd(), ".ace.json"))) {
		logger.warn?.(
			`[ace] CLAUDE_PROJECT_DIR is unset; falling back to cwd=${process.cwd()} (the plugin root). ` +
				`If .ace.json or the .ace/ ack trail lives elsewhere, the host did not inject the session directory.`,
		);
	}
	const senders = eagerSenders();
	const mcp = new Server(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{
			capabilities: {
				// The key that makes this a channel: Claude Code registers a listener for it.
				experimental: { "claude/channel": {} },
				// The advertised tools can change once the (async) registration settles — `ace_publish`
				// names this session's directory address only when it actually registered.
				tools: { listChanged: true },
			},
			instructions: instructions(senders),
		},
	);

	// Mutable tool context: the handlers read it live, so the first startup pass (before `.ace.json`
	// loads, or on a start failure) reports "not running" and a later pass in the same process can
	// pick up a working runtime.
	const tools: ToolContext = {
		config: undefined,
		subscriptions: [],
		inboxes: [],
		sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? undefined,
		codingAgent: CODING_AGENT,
		cwd: projectDir(),
		runtime: undefined,
	};
	mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildToolDefinitions(senders) }));
	mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
		const name = String(request.params.name);
		const args = (request.params.arguments ?? {}) as Record<string, unknown>;
		const result = await executeTool(tools, name, args);
		return result as CallToolResult;
	});

	await mcp.connect(new StdioServerTransport());

	// The push resolves when the notification is written to the transport; the host does not
	// acknowledge it, so the engine's observation wait is what stands in for a delivery ack.
	const push = async (content: string): Promise<void> => {
		const notification = buildChannelNotification(content);
		// Inline literal: the SDK's notification params type carries an index signature, which our
		// narrow `ChannelNotificationParams` interface doesn't, so the object is built here, not reused.
		await mcp.notification({ method: notification.method, params: { content, meta: notification.params.meta } });
	};

	// Mutable runtime handle. It is assigned only once the (async) startup pass settles; a shutdown
	// signal that lands before then must not leak the registration the startup made, so `stop` waits
	// for `startSettled` before stopping the handle (a mid-start signal).
	let handle: AceHandle | undefined;
	let stopping = false;
	const start = async (): Promise<void> => {
		let result: AceHandle | undefined;
		try {
			result = await startAce({
				cwd: projectDir(),
				push,
				logger,
				ackTimeoutMs: ackTimeoutMs(),
				sessionId: tools.sessionId,
			});
		} catch (error) {
			logger.error?.(`[ace] startup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		handle = result;
		// The tool context and the advertised tools reflect what the runtime actually registered, not
		// what the configuration predicted: the eager senders above are a claim made before the (async)
		// registration, and if it then fails (broker down, no session id, name collision) the address
		// must not be advertised — the model would otherwise be told a target that does not exist.
		if (result) Object.assign(tools, result.tools);
		const actualSenders = result?.tools.publish?.senders ?? [];
		if (actualSenders.length !== senders.length || actualSenders.some((sender, i) => sender !== senders[i])) {
			mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildToolDefinitions(actualSenders) }));
			// Tell the client to re-list; the live context above is correct either way.
			await mcp.sendToolListChanged().catch(() => {});
		}
	};
	const startSettled = start();

	const stop = async (signal: string): Promise<void> => {
		if (stopping) return;
		stopping = true;
		logger.info?.(`[ace] ${signal}: shutting down`);
		try {
			// Let an in-flight startup settle first: the registration either exists (and is stopped
			// below) or has already failed and cleaned up, so a racing signal does not leak it.
			await startSettled;
			await handle?.stop();
		} finally {
			await mcp.close().catch(() => {});
		}
	};
	process.on("SIGINT", () => void stop("SIGINT"));
	process.on("SIGTERM", () => void stop("SIGTERM"));
	process.on("SIGQUIT", () => void stop("SIGQUIT"));
}

main().catch((error) => {
	// stderr is the only channel to the operator here; stdout is the MCP protocol.
	process.stderr.write(`[ace] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exit(1);
});
