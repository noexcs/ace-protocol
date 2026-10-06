/**
 * ACE (Agent Context Event Protocol) 0.1 for DeepSeek Harness.
 *
 * An external event — a CI result, an alert, another agent — becomes an *active* input to a running
 * session instead of something the session polls for. This file is the host binding; the protocol,
 * the transports, the activation rules and the tool text all come from the vendored `ace-runtime` core,
 * which is the same code that runs on Pi, so a session here and a session there can talk to each other
 * over one broker with no translation.
 *
 * ## What one session gets
 *
 * - **Its own channel**, named by its sender (`<ns>:<username>:dsh:<sessionId>`), registered in the
 *   broker's directory while the session is live and withdrawn when it ends. That name *is* the address
 *   a peer publishes to; `ace_agents` lists the ones that are live right now.
 * - **Its own inbox**, read in a consumer group named after that channel — so two sessions are two
 *   readers, never one queue split between them.
 * - **Four tools** (`ace_publish`, `ace_agents`, `ace_store_file`, `ace_get_file`) and the `/ace`
 *   command, registered on the agent's own scope, so a session without `.ace.json` sees none of them.
 * - **The trust policy** in the system prompt: an ACE block is external text from a claimed sender, and
 *   the policy says how to read it and when to ask the user.
 *
 * ## Configuration
 *
 * `.ace.json` in the session's working directory — the same file and format ACE uses elsewhere — with
 * `$ACE_CONFIG` overriding it and `$DSH_HOME/ace.json` as the host-wide fallback. It is read once, when
 * the session is created. A session with no configuration file is completely inert: no connection, no
 * directory entry, no tools.
 *
 * **Live channels only.** This host reads the channel named by the session's own sender. Persistent
 * channels (`.ace.json` `subscribe`, i.e. topic and service channels) are reported and ignored, not read.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-commands";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-system-prompt";
import { defineTool, type ParameterSchemaSpec } from "@deepseek-ai/dsh-tools";

import { ACE_TRUST_POLICY, type AceLogger, loadAceConfig, resolveAceConfig } from "../vendor/ace-runtime/dist/index.js";
import { runAceCommand } from "./command.ts";
import type { AceDelivery } from "./dsh.ts";
import { DshAgentEngine } from "./engine.ts";
import { AceSession } from "./session.ts";
import { ACE_TOOL_DESCRIPTORS, type AceToolDescriptor } from "./tools.ts";

/** Cordis plugin name: what a profile's patch layer inserts. */
export const name = "ace-dsh";

/** Every host service this plugin needs before it can register anything. */
export const inject = ["agents", "tools", "commands", "systemPrompt"];

/**
 * Which copy of a host package this plugin actually loaded.
 *
 * A plugin shipped as a package can resolve `@deepseek-ai/*` from several places — the running
 * application's own installation, or a stale copy in the profile's shared `node_modules` — and which one
 * wins decides whether it is talking to the host that is actually running. One line at load answers it,
 * because from outside the process there is no way to tell.
 */
export function hostPackagePath(specifier: string): string {
	try {
		return createRequire(import.meta.url).resolve(specifier);
	} catch (error) {
		return `unresolved (${error instanceof Error ? error.message : String(error)})`;
	}
}

/** The third name segment of every channel this plugin registers. */
const CODING_AGENT = "dsh";

/** The Connection service the browser half's status route is registered on (absent in headless profiles). */
const STATUS_SERVICE = "connection";

/** The exact Fetch route the browser half reads, behind Connection's Host/Origin and session checks. */
const STATUS_ROUTE = "/api/ace.status";

/** The slice of Connection this plugin uses: the exact Fetch-route registry. */
interface StatusConnection {
	readonly fetch: {
		register(route: {
			readonly path: string;
			readonly methods: readonly string[];
			readonly requestBody: "buffered";
			readonly fetch: (request: Request) => Promise<Response>;
		}): () => unknown;
	};
}

/**
 * Where the trust policy sits among prompt sections.
 *
 * The first-party tool and SDK sections use first-party orders up to 5000; a host policy that describes
 * what arrives in the conversation belongs after them, and 5200 keeps it clear of both ranges.
 */
const TRUST_SECTION_ORDER = 5200;

/**
 * The parts of a live DeepSeek Harness agent this plugin uses.
 *
 * Structural on purpose: the host's `Agent` class is assigned into it, and this plugin then depends on
 * four methods and two fields rather than on an import that could drift.
 */
interface HostAgent {
	readonly status: "idle" | "running";
	readonly session: { readonly id: unknown; readonly header: { readonly cwd?: string } };
	readonly ctx: Context;
	followup(message: never): void;
	steer(message: never): void;
	whenIdle(): Promise<void>;
}

/** Where a session-wide ACE configuration may live outside a project: `$DSH_HOME/ace.json`. */
export function dshGlobalConfigPath(env: Readonly<Record<string, string | undefined>>): string {
	return join(env.DSH_HOME ?? join(env.HOME ?? "", ".dsh"), "ace.json");
}

/** The session's working directory: what `.ace.json` resolves against and what a transfer stores from. */
function sessionCwd(agent: HostAgent): string {
	return agent.session.header.cwd ?? process.cwd();
}

/** A stable, human reason from an unknown thrown value. */
function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Bind one descriptor to one session as a host tool: the core's text, this host's schema dialect. */
function dshTool(descriptor: AceToolDescriptor, session: AceSession) {
	return defineTool({
		name: descriptor.name,
		description: descriptor.description,
		// The core declares these schemas in TypeBox for the hosts that share them; the host dialects differ, so
		// the binding is where the same names, types and requiredness are re-declared.
		parameters: descriptor.parameters as unknown as ParameterSchemaSpec,
		output: {
			schema: { type: "string" as const },
			render: (_args: unknown, value: string) => [{ type: "text" as const, text: value }],
		},
		async execute(args: Record<string, unknown>) {
			return descriptor.run(args, session);
		},
	});
}

/**
 * Register the plugin: one ACE session per live agent that has a usable `.ace.json`.
 *
 * The registration points are the host's own lifecycle: `agent/created` is awaited and rollback-covered
 * (so a session that fails to publish cannot leave a registration behind), `agent/disposed` withdraws the
 * address, and the plugin's own disposer is the backstop for a reload that no `agent/disposed` reports.
 */
export function apply(ctx: Context): void {
	const sessions = new Map<string, AceSession>();
	const logger: AceLogger = {
		info: (message) => ctx.logger.info(message),
		warn: (message) => ctx.logger.warn(message),
		error: (message) => ctx.logger.error(message),
	};
	/** A problem that must be visible but must never take a session down. */
	const report = (message: string, error?: unknown): void => {
		const line = error === undefined ? message : `${message}: ${describeError(error)}`;
		ctx.logger.warn(line);
	};

	// One line, once, at load: it names the tree the model-facing calls come from, which is the difference
	// between a plugin talking to the running application and one talking to a stale profile copy.
	ctx.logger.info(`[ace] dsh-tools ${hostPackagePath("@deepseek-ai/dsh-tools")}`);
	ctx.logger.info(`[ace] dsh-llm ${hostPackagePath("@deepseek-ai/dsh-llm")}`);

	/** Mint the identified user-role message one event arrives in; the only step the host owns. */
	const buildMessage = (delivery: AceDelivery) =>
		createUserMessage({
			content: [{ type: "text", text: delivery.text }],
			source: {
				kind: "ace-event",
				sender: delivery.sender,
				eventId: delivery.eventId,
				...(delivery.channel === undefined ? {} : { channel: delivery.channel }),
				activation: delivery.activation,
				form: "notice",
				summary: boundContextSummary(delivery.summary),
			},
		});

	// `/ace` is registered **globally**, not on the agent's scope. A command resolved on the agent scope is
	// not visible to the client's catalog (`commands.list(sessionId)`), which is what decides whether a typed
	// line is dispatched locally or sent to the model as ordinary text — and a line that reaches the model
	// instead of the command is exactly what "the command does not exist" looks like from the user's side.
	// The handler resolves its own session from the invocation, so one global registration serves them all,
	// and a session with no ACE gets the same honest report as any other unconfigured session.
	ctx.commands.register({
		name: "ace",
		description: "ACE channels, live peers, and events held for manual activation",
		handler: async ({ agent, rawInput }) => runAceCommand(rawInput.trim(), sessions.get(String(agent.session.id))),
	});

	// Connection is optional — a headless or SDK profile has none, and this plugin must still load there — so it
	// is not declared in this plugin's own `inject`. It is *waited for* instead: `ctx.inject` runs this
	// registration when the service appears, which is the part a read-once `ctx.get()` gets wrong when the
	// loader composes rows concurrently. Measured the hard way: with the read-once form the route was never
	// registered in the web host, and the chip in the composer row read "off" forever while the session itself
	// was registered and perfectly reachable.
	void ctx.inject([STATUS_SERVICE], (scoped: Context) => {
		const connection = scoped.get(STATUS_SERVICE) as StatusConnection | undefined;
		if (connection?.fetch === undefined) return;
		scoped.effect(
			() =>
				connection.fetch.register({
					path: STATUS_ROUTE,
					methods: ["GET", "HEAD"],
					requestBody: "buffered",
					fetch: async (request) => {
						const sessionId = new URL(request.url).searchParams.get("session") ?? "";
						const session = sessions.get(sessionId);
						// Only the asked-for session, never the whole map: the browser already knows which
						// session it is, so nothing else needs to be exposed for the chip to work.
						const body = JSON.stringify({
							session: sessionId,
							live: session?.live === true,
							channels: session === undefined ? [] : [...session.senders],
							servers: session === undefined ? [] : session.servers.map((server) => server.name),
						});
						const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
						if (request.method === "HEAD") return new Response(null, { status: 200, headers });
						return new Response(body, { status: 200, headers });
					},
				}),
			"ace-dsh: status route",
		);
	});

	/** Register the per-agent surface. Everything here unwinds with the agent's own scope. */
	function bind(agent: HostAgent, session: AceSession): void {
		const scoped = agent.ctx;
		for (const descriptor of ACE_TOOL_DESCRIPTORS) scoped.tools.register(dshTool(descriptor, session));
		scoped.systemPrompt.section({
			name: "ace-dsh:trust",
			order: TRUST_SECTION_ORDER,
			text: ACE_TRUST_POLICY,
		});
	}

	/** Start ACE in one session, or leave it inert when the session has no configuration. */
	async function open(agent: HostAgent): Promise<void> {
		const sessionId = String(agent.session.id);
		if (sessions.has(sessionId)) return;
		const cwd = sessionCwd(agent);
		const globalConfigPaths = [dshGlobalConfigPath(process.env)];
		// Nothing to load: this session is not an ACE participant. No connection, no address, no tools.
		if (loadAceConfig({ cwd, globalConfigPaths }) === undefined) return;

		let config: ReturnType<typeof resolveAceConfig>;
		try {
			config = resolveAceConfig({ cwd, globalConfigPaths });
		} catch (error) {
			report(`[ace] the configuration in ${cwd} could not be used; ACE is off in this session`, error);
			return;
		}

		const engine = new DshAgentEngine({ agent: enginePort(agent), buildMessage, logger });
		const session = await AceSession.open({
			engine,
			config,
			sessionId,
			codingAgent: CODING_AGENT,
			cwd,
			logger,
			onProblem: report,
		});
		sessions.set(sessionId, session);
		bind(agent, session);
		ctx.logger.info(
			`[ace] ${session.senders.join(", ") || "(no server came up)"} · config ${config.source} · ${session.servers.length} server(s)`,
		);
	}

	/** Withdraw one session's address and stop its reader. */
	async function close(agent: HostAgent): Promise<void> {
		const sessionId = String(agent.session.id);
		const session = sessions.get(sessionId);
		if (session === undefined) return;
		sessions.delete(sessionId);
		await session.stop();
	}

	ctx.on("agent/created", async (payload) => {
		try {
			await open(payload.agent as unknown as HostAgent);
		} catch (error) {
			report("[ace] could not start ACE in a new session", error);
		}
	});

	ctx.on("agent/disposed", async (payload) => {
		try {
			await close(payload.agent as unknown as HostAgent);
		} catch (error) {
			report("[ace] could not shut ACE down cleanly", error);
		}
	});

	// Sessions already live when this plugin became active — a late activation, or an HMR reload — never fire
	// `agent/created`, so they are picked up here instead.
	for (const agent of ctx.agents.list()) {
		void open(agent as unknown as HostAgent).catch((error) =>
			report("[ace] could not start ACE in a live session", error),
		);
	}

	// Unloading takes every session this plugin opened with it: otherwise a reload would leave a reader
	// consuming a channel that nothing in the new plugin instance knows about.
	ctx.effect(
		() => async () => {
			const live = [...sessions.values()];
			sessions.clear();
			for (const session of live) await session.stop();
		},
		"ace-dsh: sessions",
	);
}

/** The engine's structural view of one live agent. */
function enginePort(agent: HostAgent) {
	return {
		sessionId: String(agent.session.id),
		cwd: sessionCwd(agent),
		get status() {
			return agent.status;
		},
		followup: (message: unknown) => agent.followup(message as never),
		steer: (message: unknown) => agent.steer(message as never),
		whenIdle: () => agent.whenIdle(),
		onRunError: (listener: (error: unknown) => void) =>
			agent.ctx.on("agent/error", (payload) => listener(payload.error)),
	};
}
