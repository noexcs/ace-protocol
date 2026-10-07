import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConcreteActivation } from "../protocol/ace-message.ts";
import { isConcreteActivation } from "../protocol/ace-message.ts";
import {
	type DroppedEntry,
	REDIS_STREAMS_DEFAULTS,
	RedisStreamsTransport,
	redisStreamsConfigFrom,
} from "../transport/redis-streams-transport.ts";
import type { Transport } from "../transport/transport.ts";
import { describeValue, isPlainObject } from "../utils.ts";
import { AceConfigError, type EndpointConfig, rejectUnknownKeys } from "./endpoint-config.ts";
import type { AceMetrics } from "./metrics.ts";
import { assertNoColon, channelStreamKey, NAMESPACE_DEFAULT, resolveLocalName } from "./naming.ts";

/**
 * Name of the runtime configuration file read from the session working directory.
 *
 * The file holds **only local deployment information**: who this user is, and which servers this
 * machine talks to. Channels, subscriptions and presence all live on a server.
 */
export const ACE_CONFIG_FILENAME = ".ace.json";

/** One server in the local file: where it is, and which namespace it owns. */
export interface ServerEntry {
	/** Redis connection string; `${VAR}` is interpolated from the environment. */
	url: string;
	/** Namespace this server owns; keys live under it. Defaults to `ace`. */
	namespace?: string;
	description?: string;
	/**
	 * Channel names this session reads **on this server**: a subscription belongs to the server that
	 * carries it, because the name is uploaded under that server's namespace and read over its url.
	 * A short name (`ci-ok`) is uploaded as `<namespace>:<username>:<name>`; a full channel name passes
	 * through. Absent: direct messages only (the derived inbox).
	 */
	subscribe?: string[];
}

/**
 * Runtime configuration as stored in {@link ACE_CONFIG_FILENAME}.
 *
 * `username` is the real user's name or nick, and it is the second level of the naming hierarchy
 * (`<ns>:<username>:<name>`): it keeps several people sharing one server from colliding, and it is
 * only ever *prepended to names* — never stored as a field.
 */
export interface AceConfigFile {
	username: string;
	servers: Record<string, ServerEntry>;
	/** Activation used when neither the subscription nor the message decides. */
	defaultActivation?: ConcreteActivation;
	/** Retention limits for `manual` events (defaults: 100 events, 24h). */
	manual?: { max?: number; ttlMs?: number };
	/**
	 * Only meaningful in a **host-global** file: `"ignore"` makes that file win over a project one, so a
	 * cloned repository cannot redirect a session the user configured centrally.
	 */
	projectConfig?: "ignore";
}

export interface LoadedAceConfig {
	/** Path the configuration was read from, for logs and `/ace` output. */
	source: string;
	config: AceConfigFile;
	/** The later candidate this file shadowed, when one exists. */
	shadowed?: string;
	/** `username` to fall back to (the global file's), when the winning file does not carry one. */
	usernameFallback?: string;
}

/** One server after resolution: keys and names are settled, nothing is left to default. */
export interface ResolvedServer {
	name: string;
	url: string;
	namespace: string;
	description?: string;
	/** Channel names this session reads on this server, as written in the file. */
	subscribe?: string[];
}

/**
 * One configured subscription after resolution: which server carries it, and the channel name on it.
 *
 * Only names here — the address, the group and the transport settings are derived by
 * {@link subscriptionEndpoint}, because the group depends on the *subscribing session's* sender name,
 * which the configuration layer does not know.
 */
export interface ResolvedSubscription {
	server: ResolvedServer;
	/** Uploaded channel name (`<ns>:<username>:<name>`). */
	channel: string;
	/** Local label for this subscription (equals the channel name unless a host renames it). */
	name: string;
}

/** Everything a host needs to run ACE in a session. */
export interface ResolvedAceConfig {
	username: string;
	servers: ResolvedServer[];
	subscriptions: ResolvedSubscription[];
	defaultActivation?: ConcreteActivation;
	manual: { max?: number; ttlMs?: number };
	/** Configuration smells that are legal but almost always mistakes. */
	warnings: string[];
	source: string;
	/**
	 * The later configuration candidate the winning file shadowed, when there is one. Exposed so a host's
	 * human face can say *which* global file the project file overrode, not only warn that it did.
	 */
	shadowed?: string;
}

/** Validate a parsed `.ace.json` document. */
/** Longest accepted `username`: it is a fixed segment of every sender name (see the sender cap). */
const MAX_USERNAME_LENGTH = 128;

export function parseAceConfig(value: unknown, source: string): AceConfigFile {
	if (!isPlainObject(value)) {
		throw new AceConfigError(`${source} must contain a JSON object, received ${describeValue(value)}`);
	}

	const { defaultActivation, username } = value;
	if (defaultActivation !== undefined && !isConcreteActivation(defaultActivation)) {
		throw new AceConfigError(
			`${source}: defaultActivation must be immediate|next_turn|manual, received ${describeValue(defaultActivation)}`,
		);
	}
	if (value.projectConfig !== undefined && value.projectConfig !== "ignore") {
		throw new AceConfigError(
			`${source}: projectConfig must be "ignore" when present, received ${describeValue(value.projectConfig)}`,
		);
	}
	if (username !== undefined) {
		if (typeof username !== "string") {
			throw new AceConfigError(`${source}: username must be a string, received ${describeValue(username)}`);
		}
		// The username is a fixed segment of every sender name this session publishes, and names are
		// bounded: a long one is accepted here and then rejected on every single publish (finding NR-4),
		// which is a worse way to learn about a typo.
		if (username.length > MAX_USERNAME_LENGTH) {
			throw new AceConfigError(
				`${source}: username must be at most ${MAX_USERNAME_LENGTH} characters, received ${username.length}`,
			);
		}
		refuseColon(username, `${source}: username`);
	}

	const servers = parseServers(value.servers, source);
	const manual = parseManual(value.manual, source);
	// The keys are checked after the ones with a dedicated message, so a typo gets the clearest answer.
	if (value.subscribe !== undefined) {
		throw new AceConfigError(
			`${source}: subscribe belongs inside a server — servers: { "<name>": { url, subscribe: ["<channel>"] } }`,
		);
	}
	rejectUnknownKeys(value, ["$schema", "username", "servers", "defaultActivation", "manual", "projectConfig"], source);

	return {
		username: typeof username === "string" ? username : "",
		servers,
		...(defaultActivation === undefined ? {} : { defaultActivation }),
		...(manual === undefined ? {} : { manual }),
		...(value.projectConfig === undefined ? {} : { projectConfig: value.projectConfig }),
	};
}

/** `server name` / `namespace` / `username` are colon-free: they are the fixed segments of a name. */
function refuseColon(value: string, subject: string): void {
	try {
		assertNoColon(value, subject);
	} catch (error) {
		throw new AceConfigError(error instanceof Error ? error.message : String(error));
	}
}

function parseServers(value: unknown, source: string): Record<string, ServerEntry> {
	if (!isPlainObject(value) || Object.keys(value).length === 0) {
		throw new AceConfigError(`${source}: servers must be a non-empty object of { "<name>": { url } }`);
	}
	const servers: Record<string, ServerEntry> = {};
	for (const [name, entry] of Object.entries(value)) {
		const subject = `${source}: servers["${name}"]`;
		refuseColon(name, `${source}: server name "${name}"`);
		if (!isPlainObject(entry)) {
			throw new AceConfigError(`${subject} must be an object, received ${describeValue(entry)}`);
		}
		rejectUnknownKeys(entry, ["url", "namespace", "description", "subscribe"], subject);
		if (typeof entry.url !== "string" || entry.url.length === 0) {
			throw new AceConfigError(`${subject}.url must be a non-empty string, received ${describeValue(entry.url)}`);
		}
		if (entry.namespace !== undefined) {
			if (typeof entry.namespace !== "string") {
				throw new AceConfigError(
					`${subject}.namespace must be a string, received ${describeValue(entry.namespace)}`,
				);
			}
			refuseColon(entry.namespace, `${subject}.namespace`);
		}
		if (entry.description !== undefined && typeof entry.description !== "string") {
			throw new AceConfigError(
				`${subject}.description must be a string, received ${describeValue(entry.description)}`,
			);
		}
		const subscribe = parseSubscriptions(entry.subscribe, `${subject}.subscribe`);
		servers[name] = {
			url: entry.url,
			...(typeof entry.namespace === "string" ? { namespace: entry.namespace } : {}),
			...(typeof entry.description === "string" ? { description: entry.description } : {}),
			...(subscribe === undefined ? {} : { subscribe }),
		};
	}
	return servers;
}

function parseSubscriptions(value: unknown, source: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new AceConfigError(
			`${source}: subscribe must be an array of channel names, received ${describeValue(value)}`,
		);
	}
	for (const name of value) {
		if (typeof name !== "string" || name.length === 0) {
			throw new AceConfigError(
				`${source}: subscribe entries must be non-empty strings, received ${describeValue(name)}`,
			);
		}
	}
	// JSON Schema cannot express uniqueness of array items, so this rule lives here (see the schema test).
	if (new Set(value).size !== value.length) {
		throw new AceConfigError(`${source}: a subscription name is configured twice`);
	}
	return [...value] as string[];
}

function parseManual(value: unknown, source: string): { max?: number; ttlMs?: number } | undefined {
	if (value === undefined) return undefined;
	if (!isPlainObject(value)) {
		throw new AceConfigError(`${source}: manual must be an object, received ${describeValue(value)}`);
	}
	rejectUnknownKeys(value, ["max", "ttlMs"], `${source}: manual`);
	const manual: { max?: number; ttlMs?: number } = {};
	if (value.max !== undefined) {
		// A negative capacity is not a smaller queue: the store evicts while `size > max`, so a negative
		// bound never satisfies the condition and wedges the event loop.
		const max = value.max;
		if (typeof max !== "number" || !Number.isInteger(max) || max < 0) {
			throw new AceConfigError(
				`${source}: manual.max must be a non-negative integer, received ${describeValue(max)}`,
			);
		}
		manual.max = max;
	}
	if (value.ttlMs !== undefined) {
		const ttlMs = value.ttlMs;
		if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < 0) {
			throw new AceConfigError(
				`${source}: manual.ttlMs must be a non-negative number, received ${describeValue(ttlMs)}`,
			);
		}
		manual.ttlMs = ttlMs;
	}
	return manual;
}

/**
 * Load `.ace.json` from `$ACE_CONFIG`, `<cwd>/.ace.json`, then the host's global candidates.
 *
 * Returns `undefined` when none exists; {@link resolveAceConfig} turns that into an error.
 */
export function loadAceConfig(options: {
	cwd: string;
	env?: Readonly<Record<string, string | undefined>>;
	/**
	 * Host-owned global candidates, in the host's own order: the files a session should fall back to
	 * wherever it was started. The runtime knows no host's convention — it only applies the order.
	 */
	globalConfigPaths?: readonly string[];
}): LoadedAceConfig | undefined {
	const env = options.env ?? process.env;
	const globals = options.globalConfigPaths ?? [];
	// A global file may refuse to be overridden (`"projectConfig": "ignore"`).
	const pinnedGlobal = globals.find((candidate) => declaredPolicy(candidate) === "ignore");
	const candidates = [
		...(env.ACE_CONFIG === undefined ? [] : [env.ACE_CONFIG]),
		...(pinnedGlobal === undefined ? [join(options.cwd, ACE_CONFIG_FILENAME)] : []),
		...globals,
	];
	const source = candidates.find((candidate) => existsSync(candidate));
	if (source === undefined) return undefined;

	const parsed = readJsonFile(source);
	const shadowed = candidates.slice(candidates.indexOf(source) + 1).find((candidate) => existsSync(candidate));
	const config = parseAceConfig(interpolateEnv(parsed, env, source), source);
	// `username` is the one field that inherits: a project file need not repeat who the user is.
	const usernameFallback = config.username !== "" ? undefined : globalUsername(globals, env, source);
	return {
		source,
		config,
		...(shadowed === undefined ? {} : { shadowed }),
		...(usernameFallback === undefined ? {} : { usernameFallback }),
	};
}

/** The `projectConfig` a file declares, read without validating the rest of it. */
function declaredPolicy(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isPlainObject(parsed) ? parsed.projectConfig : undefined;
	} catch {
		return undefined;
	}
}

function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new AceConfigError(
			`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)} — JSON allows no trailing commas and no comments`,
		);
	}
}

/** The username a global candidate declares, for a project file that omitted one. */
function globalUsername(
	globals: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
	source: string,
): string | undefined {
	for (const candidate of globals) {
		if (candidate === source || !existsSync(candidate)) continue;
		const parsed = interpolateEnv(readJsonFile(candidate), env, candidate);
		if (isPlainObject(parsed) && typeof parsed.username === "string" && parsed.username !== "")
			return parsed.username;
	}
	return undefined;
}

/**
 * Resolve everything a host needs to run ACE in a session.
 *
 * The `username` chain is the one place a file inherits from another: this file → the global file →
 * `$USER` → error. Every other field is taken whole from the winning file.
 */
export function resolveAceConfig(options: {
	cwd: string;
	env?: Readonly<Record<string, string | undefined>>;
	/** Host-owned global candidates, in the host's own order — see {@link loadAceConfig}. */
	globalConfigPaths?: readonly string[];
}): ResolvedAceConfig {
	const env = options.env ?? process.env;
	const loaded = loadAceConfig(options);
	if (!loaded) {
		const looked = [join(options.cwd, ACE_CONFIG_FILENAME), ...(options.globalConfigPaths ?? [])];
		throw new AceConfigError(
			[
				`no ${ACE_CONFIG_FILENAME} found — looked in ${looked.join(", ")} (and in $ACE_CONFIG). Create one, for example:`,
				"",
				"  {",
				`    "username": "you",`,
				`    "servers": { "local": { "url": "redis://127.0.0.1:6379" } }`,
				"  }",
				"",
				`  "url" is the Redis address to dial; "namespace" defaults to "ace".`,
				`  A short "subscribe" name such as "ci-ok" is uploaded as "ace:<username>:ci-ok"; a full name passes through.`,
				`  A project file wins over a host-global one — add "projectConfig": "ignore" to that global file to pin it.`,
			].join("\n"),
		);
	}

	const { config, source, shadowed, usernameFallback } = loaded;
	const username = config.username !== "" ? config.username : (usernameFallback ?? env.USER ?? "");
	if (username === "") {
		throw new AceConfigError(
			`${source}: username is required — set it in the file, in a host-global file, or in $USER`,
		);
	}

	const servers = Object.entries(config.servers).map(([name, entry]) => ({
		name,
		url: entry.url,
		namespace: entry.namespace ?? NAMESPACE_DEFAULT,
		...(entry.description === undefined ? {} : { description: entry.description }),
		...(entry.subscribe === undefined ? {} : { subscribe: entry.subscribe }),
	}));

	// A subscription lives on the server that carries it: the name is uploaded under that server's
	// namespace and read over that server's url, so nothing has to guess a server for a bare name.
	const subscriptions = servers.flatMap((server) =>
		(server.subscribe ?? []).map((local) => {
			const channel = resolveLocalName({ namespace: server.namespace, username, name: local });
			return { server, channel, name: channel };
		}),
	);

	return {
		username,
		servers,
		subscriptions,
		...(config.defaultActivation === undefined ? {} : { defaultActivation: config.defaultActivation }),
		manual: config.manual ?? {},
		warnings: [
			...(shadowed === undefined ? [] : [`${source} overrides the global ${shadowed}`]),
			...islandWarnings(servers),
		],
		source,
		...(shadowed === undefined ? {} : { shadowed }),
	};
}

/**
 * The channel names a live subscription still reads that the **current** configuration no longer lists.
 *
 * `.ace.json` is read once at session start, so a channel removed from the file since then is still
 * read — the removal takes effect only on restart (RFC §10). Naming those channels lets a host mark
 * their rows `note=config-removed` instead of leaving the stale subscription invisible.
 *
 * Best-effort by design: a current file that cannot be read, parsed or resolved yields no names at
 * all, because a stale `config-removed` would be worse than no note. `subscriptions` are the
 * resolved-at-start subscriptions; the current file is resolved the same way
 * {@link resolveAceConfig} resolves it, and a start subscription whose uploaded channel name is no
 * longer produced by it is reported.
 */
export function configRemovedChannels(options: {
	/** Subscriptions resolved at session start (the snapshot `ace_channels` lists). */
	subscriptions: readonly ResolvedSubscription[];
	cwd: string;
	env?: Readonly<Record<string, string | undefined>>;
	/** Host-owned global candidates, in the host's own order — see {@link loadAceConfig}. */
	globalConfigPaths?: readonly string[];
}): string[] {
	let current: ResolvedAceConfig;
	try {
		current = resolveAceConfig(options);
	} catch {
		return [];
	}
	const configured = new Set(current.subscriptions.map((subscription) => subscription.channel));
	return options.subscriptions
		.map((subscription) => subscription.channel)
		.filter((channel) => !configured.has(channel));
}

/**
 * The server a **full** channel name belongs to, from the name alone: a server owns exactly one
 * namespace, and the namespace is the name's first segment (`<ns>:<username>:<local>` everywhere).
 *
 * `undefined` for a short name — fewer than three segments carry no namespace to trust, so the caller
 * falls back to the live directory — and for a namespace several servers share, where only the
 * directory can say which one holds the session. Hosts call this before a directory lookup so a full
 * name is accepted as written even when no session happens to be registered under it.
 */
export function serverForChannel(options: {
	servers: readonly ResolvedServer[];
	channel: string;
}): ResolvedServer | undefined {
	const segments = options.channel.split(":");
	if (segments.length < 3) return undefined;
	const matches = options.servers.filter((server) => server.namespace === segments[0]);
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Two entries pointing at the same Redis with different namespaces are *not* two servers: they are one
 * server seen twice, with two disjoint directories. That is legal (and useful for isolation), but it is
 * the one way to get "I registered, why can't they see me" — so say it out loud.
 */
function islandWarnings(servers: readonly ResolvedServer[]): string[] {
	const byUrl = new Map<string, ResolvedServer[]>();
	for (const server of servers) byUrl.set(server.url, [...(byUrl.get(server.url) ?? []), server]);
	const warnings: string[] = [];
	for (const [, sharing] of byUrl) {
		if (sharing.length < 2) continue;
		const names = sharing.map((server) => `"${server.name}" (${server.namespace})`).join(", ");
		warnings.push(
			`servers ${names} share one Redis: each namespace is its own directory, so they cannot see each other`,
		);
	}
	return warnings;
}

/**
 * The runtime endpoint for a subscribed channel: the address and the group are derived from the
 * channel name, so nothing here can disagree with what a peer computes.
 */
export function subscriptionEndpoint(options: {
	channel: string;
	url: string;
	namespace: string;
	/** The subscribing session's sender name — the group equals it. */
	sender: string;
	/** Local label for this subscription; defaults to the channel name. */
	name?: string;
	activation?: ConcreteActivation;
	description?: string;
}): EndpointConfig {
	return {
		name: options.name ?? options.channel,
		channel: options.channel,
		transport: "redis-streams",
		...(options.description === undefined ? {} : { description: options.description }),
		...(options.activation === undefined ? {} : { activation: options.activation }),
		config: {
			stream: channelStreamKey(options.namespace, options.channel),
			group: options.sender,
			url: options.url,
			field: REDIS_STREAMS_DEFAULTS.field,
		},
		options: {},
	};
}

/** Create one transport per subscription, keyed by subscription name (the key `AceRuntime` expects). */
export interface TransportFactoryOptions {
	onError: (error: unknown) => void;
	metrics?: AceMetrics;
	onDropped?: (subscription: string, entry: DroppedEntry) => void | Promise<void>;
	/** Notices (reconnect, reclaimed entry, dropped entry), kept out of `onError`. */
	onNotice?: (message: string) => void;
}

export function createTransports(
	subscriptions: readonly EndpointConfig[],
	options: TransportFactoryOptions,
): Record<string, Transport> {
	const transports: Record<string, Transport> = {};
	for (const subscription of subscriptions) {
		redisStreamsConfigFrom(subscription);
		transports[subscription.name] = new RedisStreamsTransport(subscription, {
			onError: options.onError,
			...(options.metrics === undefined ? {} : { metrics: options.metrics }),
			...(options.onNotice === undefined ? {} : { onNotice: options.onNotice }),
			...(options.onDropped === undefined
				? {}
				: { onDropped: (entry) => options.onDropped?.(subscription.name, entry) }),
		});
	}
	return transports;
}

/** `${VAR}` occurrences in configuration strings, so a broker password never has to be committed. */
const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ESCAPED_DOLLAR = "\u0000ace-literal-dollar\u0000";

/**
 * Replace `${VAR}` in every string of the document with its environment value.
 *
 * An unset variable is an error rather than an empty string: silently connecting with a blank password
 * produces a confusing failure much later. Use `$${VAR}` for a literal.
 */
export function interpolateEnv(
	value: unknown,
	env: Readonly<Record<string, string | undefined>>,
	source: string,
	path = "",
): unknown {
	if (typeof value === "string") {
		// `$$` escapes a dollar so a literal `${VAR}` can be written in the configuration.
		const escaped = value.replaceAll("$$", ESCAPED_DOLLAR);
		return escaped
			.replace(ENV_PATTERN, (_match, name: string) => {
				const resolved = env[name];
				if (resolved === undefined) {
					throw new AceConfigError(
						`${source}: ${path || "<root>"} uses \${${name}} but the variable is not set — export ${name} in the shell that starts Pi (the runtime reads the process environment, not the file), and write $$ for a literal $`,
					);
				}
				return resolved;
			})
			.replaceAll(ESCAPED_DOLLAR, "$");
	}
	if (Array.isArray(value)) {
		return value.map((entry, index) => interpolateEnv(entry, env, source, `${path}[${index}]`));
	}
	if (isPlainObject(value)) {
		const resolved: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			resolved[key] = interpolateEnv(entry, env, source, path === "" ? key : `${path}.${key}`);
		}
		return resolved;
	}
	return value;
}
