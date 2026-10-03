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
 * Receiving: `immediate` events cut into a running turn (`steer`) and start one when the agent is idle;
 * `next_turn` events never interrupt — they queue for the next boundary (`followUp` on Pi, `aside` on
 * oh-my-pi, which also starts a turn when idle). Where the host cannot promise the agent will see an
 * injected event (oh-my-pi's idle queue), the adapter waits until the event shows up in the conversation
 * before letting the transport acknowledge it, so a stalled session leaves the event pending instead of
 * losing it. `manual` events are retained in memory — inspect and activate them with `/ace`,
 * `/ace pending`, `/ace activate <sender> <id>`.
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
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	ACE_CONFIG_FILENAME,
	AceDeliveryObserver,
	type AceLogger,
	type AceMessage,
	AceMetrics,
	type AcePublisher,
	AceRuntime,
	AgentRegistry,
	createPublishers,
	createRedisAgentRegistry,
	createRedisStreamsAddClient,
	createTransports,
	DeadLetterSink,
	detectHostDelivery,
	type EndpointConfig,
	formatSessionLabel,
	PiExtensionAdapter,
	type RedisStreamsAddClient,
	type Registration,
	type RegistryEntry,
	type ResolvedAceConfig,
	resolveAceConfig,
	resolveTarget,
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

/**
 * Whether this context belongs to a subagent session.
 *
 * oh-my-pi rebinds extensions to every session it spawns ("Each child rebinds fresh Extension
 * instances to its OWN ExtensionAPI", `loader.ts`), so this factory runs again per subagent with its
 * own locals. ACE must run once, in the session the human talks to: a runtime per subagent would
 * join the same consumer group and silently take over events meant for the main session. The host
 * exposes `ctx.agent.kind` for exactly this decision (`types.ts`: "Check this, not `depth`, to tell
 * subagents apart").
 */
function isSubagentContext(ctx: ExtensionContext): boolean {
	if (!("agent" in ctx)) return false; // upstream Pi has no subagent rebinding: one session per process
	const agent: unknown = ctx.agent;
	if (typeof agent !== "object" || agent === null || !("kind" in agent)) return false;
	return agent.kind === "sub";
}

/** Which coding agent this extension runs in; `ACE_AGENT_NAME` overrides the probe. */
function codingAgentName(pi: unknown): string {
	const override = process.env.ACE_AGENT_NAME?.trim();
	if (override !== undefined && override.length > 0) return override;
	const marker = pi !== null && typeof pi === "object" && "pi" in pi ? pi.pi : undefined;
	return marker === undefined ? "pi" : "oh-my-pi";
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

/** One directory row: the member to address, what it says about itself, and how fresh it is. */
function describeDiscovered(entry: RegistryEntry): string {
	const renewsIn = Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000));
	return `${entry.member} — ${truncate(entry.channel.description, 120)} (renews in ${renewsIn}s)`;
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
		"Choose the target by the peer it names; pass a list to publish the same event to several at once.",
		"Call ace_agents for the sessions that are online, then pass a member as target.",
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
		"",
		"Other targets are resolved in the agent directory (`ace_agents`): the member of a live session, or a " +
			"prefix that matches exactly one. A list publishes the same event to each target.",
	];
	return { description: lines.join("\n"), promptGuidelines: guidelines };
}

/** Parameters of the directory listing tool. */
const AGENTS_PARAMETERS = Type.Object({
	agent: Type.Optional(Type.String({ description: 'Filter by coding agent, e.g. "oh-my-pi" or "pi"' })),
	limit: Type.Optional(Type.Number({ description: "Maximum rows to return (default 20, cap 50)" })),
});

/** Tool parameters; kept at module scope so the definition keeps its static types. */
const PUBLISH_PARAMETERS = Type.Object({
	body: Type.String({ description: "Event body; the peer's agent reads this" }),
	activation: Type.Optional(
		StringEnum(["default", "next_turn", "immediate", "manual"] as const, {
			description: "How urgently the peer should process it; omit unless you know the peer's setup",
		}),
	),
	target: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description:
				"Configured channel name, agent-directory member (or a prefix matching exactly one session), or a list of either",
		}),
	),
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
	let deadLetters: DeadLetterSink | undefined;
	let registry: AgentRegistry | undefined;
	let registration: Registration | undefined;
	let dynamicPublisher: RedisStreamsAddClient | undefined;
	let registryErrorReported: string | undefined;

	/** Directory problems are reported once per distinct message; they never fail a session. */
	function reportRegistryError(error: unknown): void {
		const text = describeError(error);
		if (registryErrorReported === text) return;
		registryErrorReported = text;
		if (sessionContext) report(sessionContext, `[ace] agent directory: ${text}`, "warning");
		else console.error(`[ace] agent directory: ${text}`);
	}

	// Where the host's delivery cannot be trusted to reach the agent (oh-my-pi queues into an idle
	// session without starting a turn), wait for the event to appear in the conversation. Upstream Pi's
	// `sendUserMessage` always starts a turn, so wiring the observer there would add a wait with no
	// measured problem behind it.
	const host = detectHostDelivery(pi);
	const delivery = host.supportsAside ? new AceDeliveryObserver() : undefined;
	if (delivery) pi.on("message_start", (event) => delivery.accept(event));

	const adapter = new PiExtensionAdapter({
		pi,
		isIdle: () => sessionContext?.isIdle() ?? true,
		host,
		...(delivery ? { observeDelivery: delivery } : {}),
	});

	// Registered once without configuration, then re-registered at session start with the channel
	// directory. Same name replaces the definition, and Pi rebuilds tool declarations per request.
	/** Where a publish call goes: a configured channel, or a session the directory knows. */
	type PublishTarget =
		| { kind: "channel"; name: string; publisher: AcePublisher }
		| { kind: "member"; member: string; stream: string };

	/**
	 * Configured channel names win; anything else is a directory member: an exact member, or a prefix
	 * that matches exactly one live session. Guessing between two sessions would send an event to the
	 * wrong agent, so an ambiguous target fails and names the candidates instead.
	 */
	async function resolvePublishTarget(name: string): Promise<PublishTarget> {
		const configured = publishers[name];
		if (configured) return { kind: "channel", name, publisher: configured };
		if (!registry) {
			throw new Error(
				`unknown target "${name}" (configured: ${Object.keys(publishers).join(", ") || "none"}; no agent directory configured)`,
			);
		}
		const resolution = resolveTarget(await registry.list(), name);
		if (!resolution.ok) {
			const candidates = resolution.candidates.slice(0, 10);
			throw new Error(
				resolution.reason === "ambiguous"
					? `target "${name}" matches ${resolution.candidates.length} sessions; pass the full member: ${candidates.join(", ")}`
					: `no live session matches "${name}"${candidates.length === 0 ? "" : ` (live: ${candidates.join(", ")})`}`,
			);
		}
		return { kind: "member", member: resolution.entry.member, stream: resolution.entry.channel.config.stream };
	}

	/**
	 * Send to a discovered session.
	 *
	 * Only the stream comes from the directory: the broker stays the one this session is configured
	 * with, so a registration cannot redirect our events to a broker of its choosing.
	 */
	async function publishToMember(stream: string, message: AceMessage): Promise<void> {
		const url = resolvedConfig?.registry?.url;
		if (url === undefined) throw new Error(`no agent directory configured; add "registry" to ${ACE_CONFIG_FILENAME}`);
		dynamicPublisher ??= createRedisStreamsAddClient(url, reportRegistryError);
		await dynamicPublisher.add(stream, "message", JSON.stringify(message));
	}

	/** The sessions other than this one that are live right now. */
	function agentsTool(): ToolDefinition<typeof AGENTS_PARAMETERS> {
		return {
			name: "ace_agents",
			label: "ACE Agents",
			description:
				"List the agent sessions reachable right now. Each row is a member you can pass to ace_publish as `target`.",
			promptGuidelines: ["Call ace_agents before ace_publish when the peer is not one of the configured channels."],
			parameters: AGENTS_PARAMETERS,
			async execute(_toolCallId, params) {
				if (!registry) {
					throw new Error(`no agent directory configured; add "registry" to ${ACE_CONFIG_FILENAME}`);
				}
				const agentPrefix = params.agent === undefined ? undefined : `${params.agent}:`;
				const live = (await registry.list())
					.filter((entry) => entry.member !== registration?.member)
					.filter((entry) => agentPrefix === undefined || entry.member.startsWith(agentPrefix))
					.sort((a, b) => b.expiresAt - a.expiresAt);
				const limit = Math.min(Math.max(Math.trunc(params.limit ?? 20), 1), 50);
				const rows = live.slice(0, limit).map((entry) => describeDiscovered(entry));
				return {
					content: [
						{
							type: "text",
							text: rows.length === 0 ? "No other agent sessions are registered right now." : rows.join("\n"),
						},
					],
					details: { count: rows.length },
				};
			},
		};
	}

	function publishTool(config?: ResolvedAceConfig): ToolDefinition<typeof PUBLISH_PARAMETERS> {
		return {
			name: "ace_publish",
			label: "ACE Publish",
			...buildPublishToolText(config, sessionId),
			parameters: PUBLISH_PARAMETERS,

			async execute(_toolCallId, params) {
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

				const requested =
					params.target === undefined ? [] : typeof params.target === "string" ? [params.target] : params.target;
				// One entry per delivery: no target keeps the old "the single configured channel" behavior.
				const targets: Array<string | undefined> = requested.length === 0 ? [undefined] : [...new Set(requested)];
				const delivered: string[] = [];
				const failures: string[] = [];
				const sentStreams = new Set<string>();

				for (const name of targets) {
					try {
						if (name === undefined) {
							const selected = selectPublisher(publishers, undefined);
							await selected.publisher.publish(message);
							delivered.push(`channel "${selected.name}"`);
							continue;
						}
						const target = await resolvePublishTarget(name);
						if (target.kind === "channel") {
							await target.publisher.publish(message);
							delivered.push(`channel "${target.name}"`);
							continue;
						}
						// The same session twice in one call is one delivery.
						if (sentStreams.has(target.stream)) {
							delivered.push(`member "${target.member}" (already sent)`);
							continue;
						}
						sentStreams.add(target.stream);
						await publishToMember(target.stream, message);
						delivered.push(`member "${target.member}"`);
					} catch (error) {
						failures.push(`"${name ?? "(configured)"}": ${describeError(error)}`);
					}
				}

				if (delivered.length === 0) {
					throw new Error(`nothing published: ${failures.join("; ")}`);
				}
				return {
					content: [
						{
							type: "text",
							text: [
								`Published ${message.id} from ${sender} to ${delivered.length} target(s): ${delivered.join(", ")} (activation: ${message.activation}).`,
								...(failures.length > 0 ? [`Failed: ${failures.join("; ")}`] : []),
							].join("\n"),
						},
					],
					details: {
						id: message.id,
						sender: message.sender,
						sessionId: message.sessionId,
						activation: message.activation,
						delivered,
						failed: failures,
						bodyLength: message.body.length,
					},
				};
			},
		};
	}

	pi.registerTool(publishTool());
	pi.registerTool(agentsTool());

	pi.on("session_start", async (_event, ctx) => {
		if (isSubagentContext(ctx)) return; // one runtime, in the interactive session
		sessionContext = ctx;
		if (runtime) return;

		const currentSessionId = ctx.sessionManager.getSessionId();
		sessionId = currentSessionId;

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
		const spoolDir =
			resolved.spool?.dir ??
			(resolved.subscribe.some((entry) => entry.spool) ? join(ctx.cwd, ".ace", "spool") : undefined);
		// The advertised stream is this session's inbox: subscribe to it, or the address a peer
		// discovered through the directory would have nobody reading it.
		let subscriptions = resolved.subscribe;
		if (resolved.registry) {
			try {
				registry = new AgentRegistry({
					store: createRedisAgentRegistry({
						url: resolved.registry.url,
						...(resolved.registry.prefix === undefined ? {} : { prefix: resolved.registry.prefix }),
						onError: reportRegistryError,
					}),
					...(resolved.registry.prefix === undefined ? {} : { prefix: resolved.registry.prefix }),
					logger,
					onError: reportRegistryError,
				});
				registration = await registry.register({
					codingAgent: codingAgentName(pi),
					sessionId: currentSessionId,
					cwd: ctx.cwd,
					url: resolved.registry.url,
				});
				subscriptions = [
					...resolved.subscribe,
					{
						name: "session-inbox",
						transport: "redis-streams",
						description: "this session's inbox (agent directory)",
						config: { stream: registration.stream, group: registration.group, url: resolved.registry.url },
						options: {},
					},
				];
			} catch (error) {
				registration = undefined;
				await registry?.close();
				registry = undefined;
				report(ctx, `[ace] not registered: ${describeError(error)}`, "warning");
			}
		}

		const metrics = new AceMetrics();
		// Dead letters go next to the burst files: same directory, same retention policy, different
		// prefix. Nothing is written until an entry is actually given up on.
		deadLetters = new DeadLetterSink({
			dir: resolved.spool?.dir ?? join(ctx.cwd, ".ace"),
			...(resolved.spool?.retentionMs === undefined ? {} : { retentionMs: resolved.spool.retentionMs }),
			...(resolved.spool?.maxFiles === undefined ? {} : { maxFiles: resolved.spool.maxFiles }),
			logger,
			onError: (error) => report(ctx, `[ace] dead letter: ${describeError(error)}`, "error"),
		});
		runtime = new AceRuntime({
			engine: adapter,
			metrics,
			subscribe: subscriptions,
			...(spoolDir
				? {
						spool: {
							dir: spoolDir,
							...(resolved.spool?.retentionMs === undefined ? {} : { retentionMs: resolved.spool.retentionMs }),
							...(resolved.spool?.maxFiles === undefined ? {} : { maxFiles: resolved.spool.maxFiles }),
						},
					}
				: {}),
			manual: resolved.manual,
			transports: createTransports(subscriptions, {
				metrics,
				onDropped: (subscription, entry) => deadLetters?.record(subscription, entry),
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
			const directory = registration === undefined ? "" : `; registered as ${registration.member}`;
			report(
				ctx,
				`[ace] ${identity} listening (${resolved.source}): subscribe ${resolved.subscribe.map(describeEndpoint).join(", ")}${publishing}${disabled}${directory}`,
			);
			for (const warning of resolved.warnings) report(ctx, `[ace] warning: ${warning}`, "warning");
			if (resolved.subscribe.some((entry) => entry.spool)) {
				report(ctx, `[ace] spooling bursts to ${spoolDir}`, "info");
			}
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

	pi.on("session_shutdown", async (_event, ctx) => {
		if (isSubagentContext(ctx)) return;
		const activeRegistry = registry;
		const activeRegistration = registration;
		const activePublisher = dynamicPublisher;
		const active = runtime;
		const activePublishers = Object.values(publishers);
		runtime = undefined;
		publishers = {};
		resolvedConfig = undefined;
		sessionContext = undefined;
		deadLetters = undefined;
		registry = undefined;
		registration = undefined;
		dynamicPublisher = undefined;
		if (activeRegistry !== undefined && activeRegistration !== undefined) await activeRegistry.unregister();
		await activeRegistry?.close();
		await activePublisher?.close();
		await active?.stop();
		for (const publisher of activePublishers) await publisher.close();
	});

	pi.registerCommand("ace", {
		description: "ACE event runtime: status, pending manual events, activation",
		// No argument completions on purpose: an open completion popup swallows the first Enter
		// in the TUI, which would run the command before its arguments are finished.
		handler: async (args, ctx) => {
			const [subcommand, ...rest] = args.trim().split(/\s+/);

			if (isSubagentContext(ctx)) {
				report(ctx, "[ace] this is a subagent session; ACE runs in the main session", "warning");
				return;
			}

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
			if (subcommand === "stats") {
				const lines = runtime.metrics.render();
				const windows = runtime
					.openSpoolWindows()
					.map((window) => `  spooling ${window.subscription}: ${window.buffered} buffered → ${window.path}`);
				report(
					ctx,
					[
						`[ace] stats (pending manual: ${pending.length}, dead letters: ${deadLetters?.count ?? 0} → ${deadLetters?.directory ?? "none"}${resolvedConfig?.sender ? `, sender ${resolvedConfig.sender}` : ""})`,
						...(lines.length > 0 ? lines.map((line) => `  ${line}`) : ["  (nothing yet)"]),
						...windows,
					].join("\n"),
				);
				return;
			}

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
					`agent ${state}, subscribe: ${subscribe}; publish: ${publish}; ${pending.length} pending manual event(s), ${deadLetters?.count ?? 0} dead letter(s)`,
			);
		},
	});
}
