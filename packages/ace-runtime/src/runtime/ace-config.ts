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
	/** Where burst files go; the thresholds themselves live on each subscription. */
	spool?: { dir: string; retentionMs?: number; maxFiles?: number };
}

export interface LoadedAceConfig {
	/** Path the configuration was read from, for logs and `/ace` output. */
	source: string;
	config: AceConfigFile;
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
	/** Burst spool directory and retention, when configured. */
	spool?: { dir: string; retentionMs?: number; maxFiles?: number };
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
	if (!Array.isArray(subscribe) || subscribe.length === 0) {
		throw new AceConfigError(`${source}: subscribe must be a non-empty array`);
	}

	const subscriptions = parseEndpoints(subscribe, source, "subscribe");
	for (const subscription of subscriptions) validateSubscriptionSettings(subscription);

	const publications = value.publish === undefined ? undefined : parseEndpoints(value.publish, source, "publish");
	if (publications) {
		for (const publication of publications) validatePublicationSettings(publication);
	}

	if (value.spool !== undefined) {
		if (!isPlainObject(value.spool)) {
			throw new AceConfigError(`${source}: spool must be an object, received ${describeValue(value.spool)}`);
		}
		rejectUnknownKeys(value.spool, ["dir", "retentionMs", "maxFiles"], `${source}: spool`);
		if (typeof value.spool.dir !== "string" || value.spool.dir.length === 0) {
			throw new AceConfigError(
				`${source}: spool.dir must be a non-empty string, received ${describeValue(value.spool.dir)}`,
			);
		}
		for (const key of ["retentionMs", "maxFiles"]) {
			const limit = value.spool[key];
			if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1)) {
				throw new AceConfigError(
					`${source}: spool.${key} must be a positive integer, received ${describeValue(limit)}`,
				);
			}
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

	if (sender !== undefined && publications) validateSender(sender, source);
	if (publications && sender === undefined) {
		throw new AceConfigError(`${source}: sender is required when publish is configured (peers identify you by it)`);
	}

	return {
		defaultActivation,
		...(sender === undefined ? {} : { sender: sender as string }),
		subscribe: subscriptions,
		...(publications ? { publish: publications } : {}),
		...(value.manual === undefined ? {} : { manual: value.manual as { max?: number; ttlMs?: number } }),
		...(value.spool === undefined
			? {}
			: { spool: value.spool as { dir: string; retentionMs?: number; maxFiles?: number } }),
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
	for (const subscription of config.subscribe) {
		if (subscription.enabled === false) continue;
		if (subscription.activation !== undefined && subscription.activation !== "default") continue;
		warnings.push(
			`subscribe "${subscription.name}" does not pin activation: a sender may demand immediate; set "activation" to "next_turn" unless you want that`,
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
}): LoadedAceConfig | undefined {
	const env = options.env ?? process.env;
	const source = env.ACE_CONFIG ?? join(options.cwd, ACE_CONFIG_FILENAME);
	if (!existsSync(source)) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(source, "utf8"));
	} catch (error) {
		throw new AceConfigError(
			`${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return { source, config: parseAceConfig(interpolateEnv(parsed, env, source), source) };
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
}): ResolvedAceConfig {
	const loaded = loadAceConfig(options);
	if (!loaded) {
		throw new AceConfigError(
			`no ${ACE_CONFIG_FILENAME} in ${options.cwd}: create one (subscribe channels to consume, optional publish channels)`,
		);
	}

	const { config, source } = loaded;
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
		warnings: channelWarnings(config),
		manual: config.manual ?? {},
		...(config.spool === undefined ? {} : { spool: config.spool }),
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
