import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isConcreteActivation } from "../protocol/ace-message.js";
import { RedisStreamsPublisher } from "../transport/redis-streams-publisher.js";
import { REDIS_STREAMS_DEFAULTS, RedisStreamsTransport, redisStreamsConfigFrom, } from "../transport/redis-streams-transport.js";
import { describeValue, isPlainObject } from "../utils.js";
import { AceConfigError, optionalStringField, rejectUnknownKeys, requiredStringField, validateEndpointConfig, validateSender, } from "./endpoint-config.js";
/**
 * Name of the runtime configuration file read from the session working directory.
 *
 * Every MQ setting (addresses, streams, groups, targets, identity) lives here; the code holds only
 * the generic mechanisms and the defaults a transport falls back to.
 */
export const ACE_CONFIG_FILENAME = ".ace.json";
/** Transport kinds this runtime can build from configuration (RFC §4.1 lists the others). */
export const SUPPORTED_TRANSPORTS = ["redis-streams"];
/** The key that identifies a channel inside its broker; used to spot duplicated subscriptions. */
const ADDRESS_KEY_BY_TRANSPORT = { "redis-streams": "stream" };
/** Validate a parsed `.ace.json` document. */
export function parseAceConfig(value, source) {
    if (!isPlainObject(value)) {
        throw new AceConfigError(`${source} must contain a JSON object, received ${describeValue(value)}`);
    }
    const { defaultActivation, subscribe, sender } = value;
    if (defaultActivation !== undefined && !isConcreteActivation(defaultActivation)) {
        throw new AceConfigError(`${source}: defaultActivation must be immediate|next_turn|manual, received ${describeValue(defaultActivation)}`);
    }
    if (!Array.isArray(subscribe) || subscribe.length === 0) {
        throw new AceConfigError(`${source}: subscribe must be a non-empty array`);
    }
    const subscriptions = parseEndpoints(subscribe, source, "subscribe");
    for (const subscription of subscriptions)
        validateSubscriptionSettings(subscription);
    const publications = value.publish === undefined ? undefined : parseEndpoints(value.publish, source, "publish");
    if (publications) {
        for (const publication of publications)
            validatePublicationSettings(publication);
    }
    if (value.registry !== undefined) {
        if (!isPlainObject(value.registry)) {
            throw new AceConfigError(`${source}: registry must be an object, received ${describeValue(value.registry)}`);
        }
        rejectUnknownKeys(value.registry, ["url", "prefix"], `${source}: registry`);
        if (typeof value.registry.url !== "string" || value.registry.url.length === 0) {
            throw new AceConfigError(`${source}: registry.url must be a non-empty string, received ${describeValue(value.registry.url)}`);
        }
        if (value.registry.prefix !== undefined &&
            (typeof value.registry.prefix !== "string" || value.registry.prefix.length === 0)) {
            throw new AceConfigError(`${source}: registry.prefix must be a non-empty string, received ${describeValue(value.registry.prefix)}`);
        }
    }
    if (value.manual !== undefined) {
        if (!isPlainObject(value.manual)) {
            throw new AceConfigError(`${source}: manual must be an object, received ${describeValue(value.manual)}`);
        }
        rejectUnknownKeys(value.manual, ["max", "ttlMs"], `${source}: manual`);
        for (const key of ["max", "ttlMs"]) {
            const limit = value.manual[key];
            if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
                throw new AceConfigError(`${source}: manual.${key} must be a positive integer, received ${describeValue(limit)}`);
            }
        }
    }
    if (sender !== undefined)
        validateSender(sender, source);
    return {
        defaultActivation,
        ...(sender === undefined ? {} : { sender: sender }),
        subscribe: subscriptions,
        ...(publications ? { publish: publications } : {}),
        ...(value.manual === undefined ? {} : { manual: value.manual }),
        ...(value.registry === undefined ? {} : { registry: value.registry }),
    };
}
function parseEndpoints(value, source, role) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new AceConfigError(`${source}: ${role} must be a non-empty array when present`);
    }
    const endpoints = value.map((entry) => validateEndpointConfig(entry, role));
    const names = new Set();
    for (const endpoint of endpoints) {
        if (names.has(endpoint.name))
            throw new AceConfigError(`${source}: ${role} name "${endpoint.name}" is configured twice`);
        names.add(endpoint.name);
    }
    return endpoints;
}
/** Reject unknown transport kinds and invalid settings for one subscription. */
function validateSubscriptionSettings(subscription) {
    switch (subscription.transport) {
        case "redis-streams":
            redisStreamsConfigFrom(subscription);
            return;
        default:
            throw new AceConfigError(`subscribe "${subscription.name}" uses unsupported transport ${describeValue(subscription.transport)} (available: ${SUPPORTED_TRANSPORTS.join(", ")})`);
    }
}
/** Reject unknown transport kinds and invalid settings for one publication. */
function validatePublicationSettings(publication) {
    const subject = `publish "${publication.name}" config`;
    switch (publication.transport) {
        case "redis-streams":
            requiredStringField(publication.config, "stream", subject);
            optionalStringField(publication.config, "url", REDIS_STREAMS_DEFAULTS.url, subject);
            optionalStringField(publication.config, "field", REDIS_STREAMS_DEFAULTS.field, subject);
            rejectUnknownKeys(publication.config, ["stream", "url", "field"], subject);
            return;
        default:
            throw new AceConfigError(`publish "${publication.name}" uses unsupported transport ${describeValue(publication.transport)} (available: ${SUPPORTED_TRANSPORTS.join(", ")})`);
    }
}
/**
 * Configuration smells that are legal but almost always mistakes: more than one subscription reading
 * the same address from one agent either splits the events or delivers every event twice.
 */
export function channelWarnings(config) {
    const byAddress = new Map();
    for (const subscription of config.subscribe) {
        const addressKey = ADDRESS_KEY_BY_TRANSPORT[subscription.transport];
        if (!addressKey)
            continue;
        const address = subscription.config[addressKey];
        if (typeof address !== "string")
            continue;
        const key = `${subscription.transport} ${address}`;
        byAddress.set(key, [...(byAddress.get(key) ?? []), subscription]);
    }
    const warnings = [];
    if (config.sender !== undefined) {
        warnings.push(`sender "${config.sender}" is unused: this session publishes as "<coding-agent>:<sessionId>" (the same value as its directory member)`);
    }
    for (const [key, subscriptions] of byAddress) {
        if (subscriptions.length < 2)
            continue;
        const names = subscriptions.map((subscription) => `"${subscription.name}"`).join(" and ");
        const groups = new Set(subscriptions.map((subscription) => String(subscription.config.group)));
        warnings.push(groups.size === 1
            ? `subscribe ${names} read ${key} in the same group: events are split between them`
            : `subscribe ${names} read ${key} with different groups: this agent receives every event twice`);
    }
    return warnings;
}
/**
 * Load `.ace.json` from `ACE_CONFIG` or `<cwd>/.ace.json`.
 *
 * Returns `undefined` when neither exists; {@link resolveAceConfig} turns that into an error.
 */
export function loadAceConfig(options) {
    const env = options.env ?? process.env;
    const source = env.ACE_CONFIG ?? join(options.cwd, ACE_CONFIG_FILENAME);
    if (!existsSync(source))
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(source, "utf8"));
    }
    catch (error) {
        throw new AceConfigError(`${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
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
export function resolveAceConfig(options) {
    const loaded = loadAceConfig(options);
    if (!loaded) {
        throw new AceConfigError(`no ${ACE_CONFIG_FILENAME} in ${options.cwd}: create one (subscribe channels to consume, optional publish channels)`);
    }
    const { config, source } = loaded;
    const isEnabled = (endpoint) => endpoint.enabled !== false;
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
        ...(config.registry === undefined ? {} : { registry: config.registry }),
        source,
    };
}
export function createTransports(subscriptions, options) {
    const transports = {};
    for (const subscription of subscriptions) {
        transports[subscription.name] = createTransport(subscription, options);
    }
    return transports;
}
function createTransport(subscription, options) {
    switch (subscription.transport) {
        case "redis-streams":
            return new RedisStreamsTransport(subscription, {
                onError: options.onError,
                ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
                ...(options.onDropped === undefined
                    ? {}
                    : { onDropped: (entry) => options.onDropped?.(subscription.name, entry) }),
            });
        default:
            throw new AceConfigError(`subscribe "${subscription.name}" uses unsupported transport "${subscription.transport}" (available: ${SUPPORTED_TRANSPORTS.join(", ")})`);
    }
}
/**
 * Create one publisher per publication, keyed by publication name (the key the publishing tool
 * looks up).
 */
export function createPublishers(publications, options) {
    const publishers = {};
    for (const publication of publications) {
        publishers[publication.name] = createPublisher(publication, options.onError);
    }
    return publishers;
}
function createPublisher(publication, onError) {
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
            throw new AceConfigError(`publish "${publication.name}" uses unsupported transport "${publication.transport}" (available: ${SUPPORTED_TRANSPORTS.join(", ")})`);
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
export function interpolateEnv(value, env, source, path = "") {
    if (typeof value === "string") {
        // `$$` escapes a dollar so a literal `${VAR}` can be written in the configuration.
        const escaped = value.replaceAll("$$", ESCAPED_DOLLAR);
        return escaped
            .replace(ENV_PATTERN, (_match, name) => {
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
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
            key,
            interpolateEnv(entry, env, source, path ? `${path}.${key}` : key),
        ]));
    }
    return value;
}
//# sourceMappingURL=ace-config.js.map