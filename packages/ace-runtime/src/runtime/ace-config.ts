import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConcreteActivation } from "../protocol/ace-message.ts";
import { isConcreteActivation } from "../protocol/ace-message.ts";
import type { AcePublisher } from "../transport/redis-streams-publisher.ts";
import { RedisStreamsPublisher } from "../transport/redis-streams-publisher.ts";
import type { DroppedEntry } from "../transport/redis-streams-transport.ts";
import {
	REDIS_STREAMS_DEFAULTS,
	RedisStreamsTransport,
	redisStreamsConfigFrom,
} from "../transport/redis-streams-transport.ts";
import type { Transport } from "../transport/transport.ts";
import { describeValue, isPlainObject } from "../utils.ts";
import {
	AceConfigError,
	type EndpointConfig,
	optionalStringField,
	rejectUnknownKeys,
	requiredStringField,
	validateEndpointConfig,
	validateSender,
} from "./endpoint-config.ts";
import type { AceMetrics } from "./metrics.ts";

/**
 * Name of the runtime configuration file read from the session working directory.
 *
 * Every MQ setting (addresses, streams, groups, targets, identity) lives here; the code holds only
 * the generic mechanisms and the defaults a transport falls back to.
 */
export const ACE_CONFIG_FILENAME = ".ace.json";

/** Transport kinds this runtime can build from configuration (RFC §4.1 lists the others). */
export const SUPPORTED_TRANSPORTS: readonly string[] = ["redis-streams"];

/** The key that identifies a channel inside its broker; used to spot duplicated subscriptions. */
const ADDRESS_KEY_BY_TRANSPORT: Record<string, string> = { "redis-streams": "stream" };

/**
 * Runtime configuration (RFC §10) as stored in {@link ACE_CONFIG_FILENAME}.
 *
 * `subscribe` and `publish` use the vocabulary of MQ APIs (MQTT/AsyncAPI operations): from this
 * runtime's point of view, `subscribe` lists the channels it receives events from and `publish`
 * the channels its tools may send to.
 */
export interface AceConfigFile {
	/** Fallback activation for subscriptions and messages that delegate with `default` (RFC §8). */
	defaultActivation?: ConcreteActivation;
	/** Sender identifier this session publishes under (RFC §5.3); required once `publish` exists. */
	sender?: string;
	/** Channels this runtime receives ACE events from. */
	subscribe: EndpointConfig[];
	/** Channels this runtime may send ACE events to (RFC §19); the address stays here (§4.1). */
	publish?: EndpointConfig[];
	/** Retention limits for `manual` events (defaults: 100 events, 24h). */
	manual?: { max?: number; ttlMs?: number };
	/** Agent directory this session publishes itself to (RFC §22 item 1). Absent: no registration. */
	registry?: { url: string; prefix?: string };
	/**
	 * Only meaningful in a **host-global** file: `"ignore"` makes that file win over a project one, so a
	 * cloned repository cannot redirect a session the user configured centrally. Absent: a project file
	 * wins, as it always has.
	 */
	projectConfig?: "ignore";
}

export interface LoadedAceConfig {
	/** Path the configuration was read from, for logs and `/ace` output. */
	source: string;
	config: AceConfigFile;
	/**
	 * The later candidate this file shadowed, when one exists: a project `.ace.json` that won over a
	 * host-global one has to be visible, or "why is my global broker not used" is unanswerable.
	 */
	shadowed?: string;
}

/** Subscriptions, publications, identity, the activation default, and where they came from. */
export interface ResolvedAceConfig {
	/** Enabled subscriptions only. */
	subscribe: EndpointConfig[];
	/** Enabled publications only. */
	publish: EndpointConfig[];
	/** Channel names skipped because `enabled` is false. */
	disabled: string[];
	defaultActivation?: ConcreteActivation;
	/** Sender identity; absent when the configuration has no `publish` channels. */
	sender?: string;
	/** Configuration smells that are legal but almost always mistakes. */
	warnings: string[];
	/** Retention limits for `manual` events, resolved from the file. */
	manual: { max?: number; ttlMs?: number };
	/** Agent directory to register in, when configured. */
	registry?: { url: string; prefix?: string };
	source: string;
}

/** Validate a parsed `.ace.json` document. */
export function parseAceConfig(value: unknown, source: string): AceConfigFile {
	if (!isPlainObject(value)) {
		throw new AceConfigError(`${source} must contain a JSON object, received ${describeValue(value)}`);
	}

	const { defaultActivation, subscribe, sender } = value;
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
	if (!Array.isArray(subscribe) || subscribe.length === 0) {
		throw new AceConfigError(`${source}: subscribe must be a non-empty array`);
	}

	const subscriptions = parseEndpoints(subscribe, source, "subscribe");
	for (const subscription of subscriptions) validateSubscriptionSettings(subscription);

	const publications = value.publish === undefined ? undefined : parseEndpoints(value.publish, source, "publish");
	if (publications) {
		for (const publication of publications) validatePublicationSettings(publication);
	}

	if (value.registry !== undefined) {
		if (!isPlainObject(value.registry)) {
			throw new AceConfigError(`${source}: registry must be an object, received ${describeValue(value.registry)}`);
		}
		rejectUnknownKeys(value.registry, ["url", "prefix"], `${source}: registry`);
		if (typeof value.registry.url !== "string" || value.registry.url.length === 0) {
			throw new AceConfigError(
				`${source}: registry.url must be a non-empty string, received ${describeValue(value.registry.url)}`,
			);
		}
		if (
			value.registry.prefix !== undefined &&
			(typeof value.registry.prefix !== "string" || value.registry.prefix.length === 0)
		) {
			throw new AceConfigError(
				`${source}: registry.prefix must be a non-empty string, received ${describeValue(value.registry.prefix)}`,
			);
		}
	}

	if (value.manual !== undefined) {
		if (!isPlainObject(value.manual)) {
			throw new AceConfigError(`${source}: manual must be an object, received ${describeValue(value.manual)}`);
		}
		rejectUnknownKeys(value.manual, ["max", "ttlMs"], `${source}: manual`);
		for (const key of ["max", "ttlMs"]) {
			const limit = value.manual[key];
			if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1)) {
				throw new AceConfigError(
					`${source}: manual.${key} must be a positive integer, received ${describeValue(limit)}`,
				);
			}
		}
	}

	if (sender !== undefined) validateSender(sender, source);

	return {
		defaultActivation,
		...(sender === undefined ? {} : { sender: sender as string }),
		subscribe: subscriptions,
		...(publications ? { publish: publications } : {}),
		...(value.manual === undefined ? {} : { manual: value.manual as { max?: number; ttlMs?: number } }),
		...(value.registry === undefined ? {} : { registry: value.registry as { url: string; prefix?: string } }),
	};
}

function parseEndpoints(value: unknown, source: string, role: "subscribe" | "publish"): EndpointConfig[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new AceConfigError(`${source}: ${role} must be a non-empty array when present`);
	}

	const endpoints = value.map((entry) => validateEndpointConfig(entry, role));
	const names = new Set<string>();
	for (const endpoint of endpoints) {
		if (names.has(endpoint.name))
			throw new AceConfigError(`${source}: ${role} name "${endpoint.name}" is configured twice`);
		names.add(endpoint.name);
	}
	return endpoints;
}

/** Reject unknown transport kinds and invalid settings for one subscription. */
function validateSubscriptionSettings(subscription: EndpointConfig): void {
	switch (subscription.transport) {
		case "redis-streams":
			redisStreamsConfigFrom(subscription);
			return;
		default:
			throw new AceConfigError(
				`subscribe "${subscription.name}" uses unsupported transport ${describeValue(subscription.transport)} (available: ${SUPPORTED_TRANSPORTS.join(", ")})`,
			);
	}
}

/** Reject unknown transport kinds and invalid settings for one publication. */
function validatePublicationSettings(publication: EndpointConfig): void {
	const subject = `publish "${publication.name}" config`;
	switch (publication.transport) {
		case "redis-streams":
			requiredStringField(publication.config, "stream", subject);
			optionalStringField(publication.config, "url", REDIS_STREAMS_DEFAULTS.url, subject);
			optionalStringField(publication.config, "field", REDIS_STREAMS_DEFAULTS.field, subject);
			rejectUnknownKeys(publication.config, ["stream", "url", "field"], subject);
			return;
		default:
			throw new AceConfigError(
				`publish "${publication.name}" uses unsupported transport ${describeValue(publication.transport)} (available: ${SUPPORTED_TRANSPORTS.join(", ")})`,
			);
	}
}

/**
 * Configuration smells that are legal but almost always mistakes: more than one subscription reading
 * the same address from one agent either splits the events or delivers every event twice.
 */
export function channelWarnings(config: AceConfigFile): string[] {
	const byAddress = new Map<string, EndpointConfig[]>();
	for (const subscription of config.subscribe) {
		const addressKey = ADDRESS_KEY_BY_TRANSPORT[subscription.transport];
		if (!addressKey) continue;
		const address = subscription.config[addressKey];
		if (typeof address !== "string") continue;
		const key = `${subscription.transport} ${address}`;
		byAddress.set(key, [...(byAddress.get(key) ?? []), subscription]);
	}

	const warnings: string[] = [];
	if (config.sender !== undefined) {
		warnings.push(
			`sender "${config.sender}" is unused: this session publishes as "<coding-agent>:<sessionId>" (the same value as its directory member)`,
		);
	}
	for (const [key, subscriptions] of byAddress) {
		if (subscriptions.length < 2) continue;
		const names = subscriptions.map((subscription) => `"${subscription.name}"`).join(" and ");
		const groups = new Set(subscriptions.map((subscription) => String(subscription.config.group)));
		warnings.push(
			groups.size === 1
				? `subscribe ${names} read ${key} in the same group: events are split between them`
				: `subscribe ${names} read ${key} with different groups: this agent receives every event twice`,
		);
	}
	return warnings;
}

/**
 * Load `.ace.json` from `ACE_CONFIG` or `<cwd>/.ace.json`.
 *
 * Returns `undefined` when neither exists; {@link resolveAceConfig} turns that into an error.
 */
export function loadAceConfig(options: {
	cwd: string;
	env?: Readonly<Record<string, string | undefined>>;
	/**
	 * Host-owned global candidates, in the host's own order: the files a session should fall back to
	 * wherever it was started (a host that keeps its own state in a config directory has one). The
	 * runtime knows no host's convention — it only applies the order below.
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

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(source, "utf8"));
	} catch (error) {
		throw new AceConfigError(
			`${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const shadowed = candidates.slice(candidates.indexOf(source) + 1).find((candidate) => existsSync(candidate));
	return {
		source,
		config: parseAceConfig(interpolateEnv(parsed, env, source), source),
		...(shadowed === undefined ? {} : { shadowed }),
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

/**
 * Resolve everything a host needs to run ACE in a session.
 *
 * MQ configuration comes from `.ace.json` only — `ACE_CONFIG` selects a different file path, but
 * there is no environment-variable fallback for addresses, streams, or groups. Disabled channels are
 * filtered out here so no transport is ever started for them.
 */
export function resolveAceConfig(options: {
	cwd: string;
	env?: Readonly<Record<string, string | undefined>>;
	/** Host-owned global candidates, in the host's own order — see {@link loadAceConfig}. */
	globalConfigPaths?: readonly string[];
}): ResolvedAceConfig {
	const loaded = loadAceConfig(options);
	if (!loaded) {
		const looked = [join(options.cwd, ACE_CONFIG_FILENAME), ...(options.globalConfigPaths ?? [])];
		throw new AceConfigError(
			`no ${ACE_CONFIG_FILENAME} found — looked in ${looked.join(", ")} (and in $ACE_CONFIG): create one with the ` +
				`subscribe channels to consume and any optional publish channels`,
		);
	}

	const { config, source, shadowed } = loaded;
	const isEnabled = (endpoint: EndpointConfig) => endpoint.enabled !== false;
	const disabled = [...config.subscribe, ...(config.publish ?? [])]
		.filter((endpoint) => !isEnabled(endpoint))
		.map((endpoint) => endpoint.name);

	return {
		subscribe: config.subscribe.filter(isEnabled),
		publish: (config.publish ?? []).filter(isEnabled),
		disabled,
		defaultActivation: config.defaultActivation,
		...(config.sender === undefined ? {} : { sender: config.sender }),
		warnings: [
			...channelWarnings(config),
			...(shadowed === undefined ? [] : [`${source} overrides the global ${shadowed}`]),
		],
		manual: config.manual ?? {},
		...(config.registry === undefined ? {} : { registry: config.registry }),
		source,
	};
}

/**
 * Create one transport per subscription, keyed by subscription name (the key
 * {@link AceRuntime} expects).
 */
export interface TransportFactoryOptions {
	onError: (error: unknown) => void;
	metrics?: AceMetrics;
	/**
	 * Where an entry the transport gave up on goes (dead letters). The channel name is bound here,
	 * so one sink can serve every subscription without the transport knowing its own name.
	 */
	onDropped?: (subscription: string, entry: DroppedEntry) => void | Promise<void>;
}

export function createTransports(
	subscriptions: readonly EndpointConfig[],
	options: TransportFactoryOptions,
): Record<string, Transport> {
	const transports: Record<string, Transport> = {};
	for (const subscription of subscriptions) {
		transports[subscription.name] = createTransport(subscription, options);
	}
	return transports;
}

function createTransport(subscription: EndpointConfig, options: TransportFactoryOptions): Transport {
	switch (subscription.transport) {
		case "redis-streams":
			return new RedisStreamsTransport(subscription, {
				onError: options.onError,
				...(options.metrics === undefined ? {} : { metrics: options.metrics }),
				...(options.onDropped === undefined
					? {}
					: { onDropped: (entry: DroppedEntry) => options.onDropped?.(subscription.name, entry) }),
			});
		default:
			throw new AceConfigError(
				`subscribe "${subscription.name}" uses unsupported transport "${subscription.transport}" (available: ${SUPPORTED_TRANSPORTS.join(", ")})`,
			);
	}
}

/**
 * Create one publisher per publication, keyed by publication name (the key the publishing tool
 * looks up).
 */
export function createPublishers(
	publications: readonly EndpointConfig[],
	options: { onError: (error: unknown) => void },
): Record<string, AcePublisher> {
	const publishers: Record<string, AcePublisher> = {};
	for (const publication of publications) {
		publishers[publication.name] = createPublisher(publication, options.onError);
	}
	return publishers;
}

function createPublisher(publication: EndpointConfig, onError: (error: unknown) => void): AcePublisher {
	const subject = `publish "${publication.name}" config`;
	switch (publication.transport) {
		case "redis-streams":
			return new RedisStreamsPublisher({
				url: optionalStringField(publication.config, "url", REDIS_STREAMS_DEFAULTS.url, subject),
				stream: requiredStringField(publication.config, "stream", subject),
				field: optionalStringField(publication.config, "field", REDIS_STREAMS_DEFAULTS.field, subject),
				clientOptions: publication.options,
				onError,
			});
		default:
			throw new AceConfigError(
				`publish "${publication.name}" uses unsupported transport "${publication.transport}" (available: ${SUPPORTED_TRANSPORTS.join(", ")})`,
			);
	}
}

/** `${VAR}` occurrences in configuration strings, so a broker password never has to be committed. */
const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ESCAPED_DOLLAR = "\u0000ace-literal-dollar\u0000";

/**
 * Replace `${VAR}` in every string of the document with its environment value.
 *
 * An unset variable is an error rather than an empty string: silently connecting with a blank
 * password produces a confusing failure much later. Use `$${VAR}` for a literal.
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
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				interpolateEnv(entry, env, source, path ? `${path}.${key}` : key),
			]),
		);
	}
	return value;
}
