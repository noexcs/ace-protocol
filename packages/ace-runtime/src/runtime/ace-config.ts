import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConcreteActivation } from "../protocol/ace-message.ts";
import { isConcreteActivation } from "../protocol/ace-message.ts";
import {
	REDIS_STREAMS_DEFAULTS,
	RedisStreamsTransport,
	redisStreamsConfigFrom,
} from "../transport/redis-streams-transport.ts";
import type { Transport } from "../transport/transport.ts";
import { describeValue, isPlainObject } from "../utils.ts";
import { AceConfigError, type EndpointConfig, rejectUnknownKeys } from "./endpoint-config.ts";
import type { AceMetrics } from "./metrics.ts";
import { assertNoColon, channelName, channelStreamKey, NAMESPACE_DEFAULT, resolveLocalName } from "./naming.ts";

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
	/** Channel names this session subscribes to. Absent: direct messages only (the derived inbox). */
	subscribe?: string[];
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
}

/** Validate a parsed `.ace.json` document. */
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
		refuseColon(username, `${source}: username`);
	}

	const servers = parseServers(value.servers, source);
	const subscribe = parseSubscriptions(value.subscribe, source);
	const manual = parseManual(value.manual, source);

	return {
		username: typeof username === "string" ? username : "",
		servers,
		...(subscribe === undefined ? {} : { subscribe }),
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
		rejectUnknownKeys(entry, ["url", "namespace", "description"], subject);
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
		servers[name] = {
			url: entry.url,
			...(typeof entry.namespace === "string" ? { namespace: entry.namespace } : {}),
			...(typeof entry.description === "string" ? { description: entry.description } : {}),
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
		if (typeof value.max !== "number") throw new AceConfigError(`${source}: manual.max must be a number`);
		manual.max = value.max;
	}
	if (value.ttlMs !== undefined) {
		if (typeof value.ttlMs !== "number") throw new AceConfigError(`${source}: manual.ttlMs must be a number`);
		manual.ttlMs = value.ttlMs;
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
		throw new AceConfigError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
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
			`no ${ACE_CONFIG_FILENAME} found — looked in ${looked.join(", ")} (and in $ACE_CONFIG): create one with ` +
				`"username", "servers", and any channels to subscribe to`,
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
	}));

	const subscriptions = (config.subscribe ?? []).map((name) => {
		const { server, channel } = resolveSubscription({ servers, username, name });
		return { server, channel, name: channel };
	});

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
	};
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
 * Resolve one configured subscription name to a server and its uploaded channel name.
 *
 * A short name (`ci-failures`) needs a single server to default to; with several, qualify it
 * (`lan:ci-failures`) rather than let the runtime guess which one was meant.
 */
export function resolveSubscription(options: { servers: readonly ResolvedServer[]; username: string; name: string }): {
	server: ResolvedServer;
	channel: string;
} {
	const { servers, username, name } = options;
	const first = servers[0];
	if (first === undefined) throw new AceConfigError("no servers configured");

	const qualified = name.includes(":");
	if (!qualified) {
		if (servers.length > 1) {
			const names = servers.map((server) => `"${server.name}"`).join(", ");
			throw new AceConfigError(
				`subscribe "${name}" is ambiguous with several servers configured (${names}): qualify it as "<server>:${name}"`,
			);
		}
		return { server: first, channel: channelName(first.namespace, username, name) };
	}

	const [serverName, ...rest] = name.split(":");
	const server = servers.find((candidate) => candidate.name === serverName);
	if (server === undefined) {
		const names = servers.map((candidate) => `"${candidate.name}"`).join(", ");
		throw new AceConfigError(`subscribe "${name}" names unknown server "${serverName}" (configured: ${names})`);
	}
	const short = rest.join(":");
	const uploaded = resolveLocalName({ namespace: server.namespace, username, name: short });
	return { server, channel: uploaded };
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
	onDropped?: (subscription: string, entry: unknown) => void | Promise<void>;
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
					throw new AceConfigError(`${source}: ${path || "<root>"} uses \${${name}} but the variable is not set`);
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
