/**
 * ACE 0.1 extension for Pi: receive external events into the session you are chatting in, and
 * publish events to peers.
 *
 * Configuration is read from `.ace.json` in the session working directory (RFC §10 runtime
 * configuration), or from `ACE_CONFIG` when that points somewhere else. `subscribe` and `publish`
 * use the vocabulary of MQ APIs (MQTT/AsyncAPI operations), seen from this agent; each channel
 * keeps transport-independent fields at its top level and the broker's own settings in `config`:
 *
 * ```json
 * {
 *   "sender": "agent-a",
 *   "defaultActivation": "next_turn",
 *   "subscribe": [
 *     { "name": "inbox", "transport": "redis-streams", "description": "direct messages from peers",
 *       "config": { "stream": "ace:in.a", "group": "agent-a" } }
 *   ],
 *   "publish": [
 *     { "name": "to-b", "transport": "redis-streams", "description": "agent-b",
 *       "config": { "stream": "ace:in.b" } }
 *   ]
 * }
 * ```
 *
 * Start Pi with the extension:
 *
 * ```bash
 * pi --extension /path/to/ace-runtime/extensions/ace.ts
 * ```
 *
 * Receiving: while a turn runs, `next_turn` events are queued after it (`followUp`) and `immediate`
 * events at its next boundary (`steer`); while Pi is idle the event starts a turn. `manual` events are
 * retained in memory — inspect and activate them with `/ace`, `/ace pending`, `/ace activate <sender> <id>`.
 *
 * Publishing: once the configuration is known, `ace_publish` is re-registered with a description that
 * names this agent (with its session label), every channel it can reach, and where events land. The
 * address stays in configuration, never in the message (RFC §4.1); every published event carries the
 * session's id (RFC §5.4) so peers can tell sessions apart.
 *
 * `ACE_CONFIG` points at a different configuration file; every MQ setting stays in that file.
 * `ACE_LOG=1` also logs runtime lines in modes without a UI.
 */

import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ACE_CONFIG_FILENAME,
	type AceLogger,
	type AcePublisher,
	AceRuntime,
	createPublishers,
	createTransports,
	type EndpointConfig,
	formatSessionLabel,
	PiExtensionAdapter,
	type ResolvedAceConfig,
	resolveAceConfig,
	validateAceMessage,
} from "../src/index.ts";

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Report to the user: notification in UI modes, stderr in print/JSON modes. */
function report(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	console.error(message);
}

/** Runtime logs: last action on the status line, problems as notifications. */
function createLogger(ctx: ExtensionContext): AceLogger {
	const logToStderr = process.env.ACE_LOG === "1";
	return {
		info: (line) => {
			if (ctx.hasUI) {
				ctx.ui.setStatus("ace", line.replace(/^\[ACE\] /, "ace: "));
				return;
			}
			if (logToStderr) console.error(line);
		},
		warn: (line) => report(ctx, line, "warning"),
		error: (line) => report(ctx, line, "error"),
	};
}

function truncate(text: string, limit = 60): string {
	return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Address of a channel inside its transport, whatever that transport calls it. */
function addressOf(endpoint: EndpointConfig): string {
	const address = endpoint.config.stream ?? endpoint.config.subject ?? endpoint.config.topic ?? endpoint.config.queue;
	return `${endpoint.transport} ${address === undefined ? "(no address)" : String(address)}`;
}

/** One directory line: `"to-b" (agent-b) → redis-streams ace:in.b`. */
function describeEndpoint(endpoint: EndpointConfig): string {
	return `"${endpoint.name}"${endpoint.description ? ` (${endpoint.description})` : ""} → ${addressOf(endpoint)}`;
}

/**
 * The tool text carries the channel directory, so the agent knows who it can talk to and where its
 * events land without reading `.ace.json` itself.
 */
export function buildPublishToolText(
	config?: ResolvedAceConfig,
	sessionId?: string,
): { description: string; promptGuidelines: string[] } {
	const intro =
		"Publish an ACE 0.1 event to a peer agent or service. The recipient's agent receives the body as an " +
		"external event and acts on it on its own; the body is opaque to ACE, so write plain text the peer can act on.";
	const guidelines = [
		"Use ace_publish to notify another agent or service; keep the body self-contained.",
		"Choose the target by the peer it names; when you need several, publish once per target.",
		"There is no reply protocol: if you expect an answer, say so and name the channel to answer on.",
	];
	if (!config) {
		return { description: intro, promptGuidelines: guidelines };
	}

	const session = sessionId === undefined ? "" : `, session ${formatSessionLabel(sessionId)}`;
	const lines = [
		intro,
		"",
		`You are "${config.sender ?? "(unknown sender)"}"${session} (stamped on the events you publish).`,
		"",
		"Targets (pass the name as `target`):",
		...(config.publish.length > 0 ? config.publish.map(describeEndpoint) : ["(none configured)"]),
		"",
		"Subscribed channels (events peers send you):",
		...(config.subscribe.length > 0 ? config.subscribe.map(describeEndpoint) : ["(none configured)"]),
		...(config.disabled.length > 0 ? ["", `Disabled channels: ${config.disabled.join(", ")}`] : []),
		"",
		"Delivery: an event you publish reaches every agent subscribed to that channel; agents that also consume " +
			"their own publication channel see their own events.",
	];
	return { description: lines.join("\n"), promptGuidelines: guidelines };
}

/** Tool parameters; kept at module scope so the definition keeps its static types. */
const PUBLISH_PARAMETERS = Type.Object({
	body: Type.String({ description: "Event body; the peer's agent reads this" }),
	activation: Type.Optional(
		StringEnum(["default", "next_turn", "immediate", "manual"] as const, {
			description: "How urgently the peer should process it; omit unless you know the peer's setup",
		}),
	),
	target: Type.Optional(Type.String({ description: "Publish channel name; required only when several exist" })),
	id: Type.Optional(Type.String({ description: "Message id for correlation; generated when omitted" })),
});

/**
 * Resolve which configured publication a publish call targets.
 *
 * `target` names an entry of `publish`; it is optional when exactly one is configured.
 */
function selectPublisher(
	publishers: Readonly<Record<string, AcePublisher>>,
	target: string | undefined,
): { name: string; publisher: AcePublisher } {
	const names = Object.keys(publishers);
	if (names.length === 0) {
		throw new Error(`no publish channels configured; add a "publish" entry to ${ACE_CONFIG_FILENAME}`);
	}
	if (target === undefined) {
		if (names.length > 1) throw new Error(`several publish channels configured (${names.join(", ")}); pass target`);
		const name = names[0] as string;
		return { name, publisher: publishers[name] as AcePublisher };
	}
	const publisher = publishers[target];
	if (!publisher) throw new Error(`unknown target "${target}" (configured: ${names.join(", ")})`);
	return { name: target, publisher };
}

export default function aceExtension(pi: ExtensionAPI): void {
	let sessionContext: ExtensionContext | undefined;
	let runtime: AceRuntime | undefined;
	let publishers: Record<string, AcePublisher> = {};
	let resolvedConfig: ResolvedAceConfig | undefined;
	let sessionId: string | undefined;
	let transportErrorReported = false;

	const adapter = new PiExtensionAdapter({ pi, isIdle: () => sessionContext?.isIdle() ?? true });

	// Registered once without configuration, then re-registered at session start with the channel
	// directory. Same name replaces the definition, and Pi rebuilds tool declarations per request.
	function publishTool(config?: ResolvedAceConfig): ToolDefinition<typeof PUBLISH_PARAMETERS> {
		return {
			name: "ace_publish",
			label: "ACE Publish",
			...buildPublishToolText(config, sessionId),
			parameters: PUBLISH_PARAMETERS,

			async execute(_toolCallId, params) {
				const { name, publisher } = selectPublisher(publishers, params.target);
				const sender = resolvedConfig?.sender;
				if (sender === undefined) {
					throw new Error(`no sender configured; add "sender" to ${ACE_CONFIG_FILENAME}`);
				}
				const message = validateAceMessage({
					aceVersion: "0.1",
					id: params.id ?? `evt_${randomUUID()}`,
					sender,
					...(sessionId === undefined ? {} : { sessionId }),
					activation: params.activation ?? "default",
					body: params.body,
				});

				await publisher.publish(message);

				return {
					content: [
						{
							type: "text",
							text: `Published ${message.id} from ${sender} to channel "${name}" (activation: ${message.activation}).`,
						},
					],
					details: {
						id: message.id,
						sender: message.sender,
						sessionId: message.sessionId,
						activation: message.activation,
						target: name,
						bodyLength: message.body.length,
					},
				};
			},
		};
	}

	pi.registerTool(publishTool());

	pi.on("session_start", async (_event, ctx) => {
		sessionContext = ctx;
		if (runtime) return;

		sessionId = ctx.sessionManager.getSessionId();

		let resolved: ResolvedAceConfig;
		try {
			resolved = resolveAceConfig({ cwd: ctx.cwd });
		} catch (error) {
			report(ctx, `[ace] not started: ${describeError(error)}`, "warning");
			return;
		}

		const logger = createLogger(ctx);
		publishers = createPublishers(resolved.publish, {
			onError: (error) => report(ctx, `[ace] publish transport error: ${describeError(error)}`, "error"),
		});
		runtime = new AceRuntime({
			engine: adapter,
			subscribe: resolved.subscribe,
			transports: createTransports(resolved.subscribe, {
				onError: (error) => {
					// A broker that dies mid-session would otherwise repeat the same error.
					if (transportErrorReported) return;
					transportErrorReported = true;
					report(ctx, `[ace] transport error: ${describeError(error)}`, "error");
				},
			}),
			...(resolved.defaultActivation ? { defaultActivation: resolved.defaultActivation } : {}),
			logger,
		});

		try {
			await runtime.start();
			resolvedConfig = resolved;
			pi.registerTool(publishTool(resolved));
			const identity = `${resolved.sender ?? "(no sender)"} session ${formatSessionLabel(sessionId)}`;
			const publishing =
				resolved.publish.length > 0 ? `; publish ${resolved.publish.map(describeEndpoint).join(", ")}` : "";
			const disabled = resolved.disabled.length > 0 ? ` [disabled: ${resolved.disabled.join(", ")}]` : "";
			report(
				ctx,
				`[ace] ${identity} listening (${resolved.source}): subscribe ${resolved.subscribe.map(describeEndpoint).join(", ")}${publishing}${disabled}`,
			);
			for (const warning of resolved.warnings) report(ctx, `[ace] warning: ${warning}`, "warning");
		} catch (error) {
			runtime = undefined;
			resolvedConfig = undefined;
			report(
				ctx,
				`[ace] could not start: ${describeError(error)} (check the broker in .ace.json, then restart Pi)`,
				"error",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		const active = runtime;
		const activePublishers = Object.values(publishers);
		runtime = undefined;
		publishers = {};
		resolvedConfig = undefined;
		sessionContext = undefined;
		await active?.stop();
		for (const publisher of activePublishers) await publisher.close();
	});

	pi.registerCommand("ace", {
		description: "ACE event runtime: status, pending manual events, activation",
		// No argument completions on purpose: an open completion popup swallows the first Enter
		// in the TUI, which would run the command before its arguments are finished.
		handler: async (args, ctx) => {
			const [subcommand, ...rest] = args.trim().split(/\s+/);

			if (!runtime) {
				report(ctx, `[ace] not running: add ${ACE_CONFIG_FILENAME} to ${ctx.cwd} and restart Pi`, "warning");
				return;
			}

			if (subcommand === "activate") {
				const [sender, id] = rest;
				if (!sender || !id) {
					report(ctx, "[ace] usage: /ace activate <sender> <id>", "warning");
					return;
				}
				try {
					await runtime.activatePendingEvent(sender, id);
					report(ctx, `[ace] activated ${sender}/${id}`);
				} catch (error) {
					report(ctx, `[ace] ${describeError(error)}`, "error");
				}
				return;
			}

			const pending = runtime.pendingEvents;
			if (subcommand === "pending") {
				if (pending.length === 0) {
					report(ctx, "[ace] no pending manual events");
					return;
				}
				const lines = pending.map((event) => {
					const session =
						event.message.sessionId === undefined
							? ""
							: ` (session ${formatSessionLabel(event.message.sessionId)})`;
					return `${event.message.sender}${session}/${event.message.id}: ${truncate(event.message.body)}`;
				});
				report(ctx, `[ace] pending manual events (${pending.length}):\n${lines.join("\n")}`);
				return;
			}

			const state = adapter.isRunning() ? "running" : "idle";
			const subscribe = resolvedConfig?.subscribe.map((endpoint) => endpoint.name).join(", ") ?? "?";
			const publish = resolvedConfig?.publish.map((endpoint) => endpoint.name).join(", ") ?? "none";
			const identity = resolvedConfig?.sender ?? "(no sender)";
			report(
				ctx,
				`[ace] ${identity}${sessionId ? ` session ${formatSessionLabel(sessionId)}` : ""} (${resolvedConfig?.source ?? "started"}), ` +
					`agent ${state}, subscribe: ${subscribe}; publish: ${publish}; ${pending.length} pending manual event(s)`,
			);
		},
	});
}
