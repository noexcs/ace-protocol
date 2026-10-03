import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ACE_CONFIG_FILENAME,
	channelWarnings,
	createPublishers,
	createTransports,
	loadAceConfig,
	parseAceConfig,
	resolveAceConfig,
} from "../../src/runtime/ace-config.ts";
import { AceConfigError } from "../../src/runtime/endpoint-config.ts";

const inbox = {
	name: "inbox",
	transport: "redis-streams",
	config: { stream: "ace:in.a", group: "agent-a" },
	options: {},
};
const toB = { name: "to-b", transport: "redis-streams", config: { stream: "ace:in.b" }, options: {} };

const directories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "ace-config-"));
	directories.push(directory);
	return directory;
}

function writeConfig(directory: string, config: unknown): string {
	const path = join(directory, ACE_CONFIG_FILENAME);
	writeFileSync(path, JSON.stringify(config));
	return path;
}

afterEach(() => {
	while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true });
});

describe("parseAceConfig", () => {
	it("accepts a subscription and a default activation", () => {
		expect(parseAceConfig({ defaultActivation: "immediate", subscribe: [inbox] }, ".ace.json")).toEqual({
			defaultActivation: "immediate",
			subscribe: [{ ...inbox }],
		});
	});

	it("accepts publish channels with a sender and keeps options", () => {
		const parsed = parseAceConfig(
			{
				sender: "agent-a",
				subscribe: [inbox],
				publish: [{ ...toB, options: { socket: { connectTimeout: 5000 } } }],
			},
			".ace.json",
		);

		expect(parsed.sender).toBe("agent-a");
		expect(parsed.publish?.[0]?.options).toEqual({ socket: { connectTimeout: 5000 } });
	});

	it("accepts enabled: false and keeps it on the entry", () => {
		expect(parseAceConfig({ subscribe: [{ ...inbox, enabled: false }] }, ".ace.json").subscribe[0]?.enabled).toBe(
			false,
		);
	});

	it.each([
		["a non-object document", ["not", "an", "object"]],
		["a delegated defaultActivation", { defaultActivation: "default", subscribe: [inbox] }],
		["missing subscribe", { defaultActivation: "next_turn" }],
		["empty subscribe", { subscribe: [] }],
		["an unsupported transport", { subscribe: [{ ...inbox, transport: "kafka" }] }],
		["an unknown transport kind", { subscribe: [{ name: "x", transport: "kafka", config: { topic: "t" } }] }],
		[
			"a subscription without a stream",
			{ subscribe: [{ name: "x", transport: "redis-streams", config: { group: "g" } }] },
		],
		["an unknown setting in config", { subscribe: [{ ...inbox, config: { ...inbox.config, strem: "typo" } }] }],
		["an unknown top-level key", { subscribe: [{ ...inbox, stram: "typo" }] }],
		["an empty description", { subscribe: [{ ...inbox, description: "" }] }],
		["a non-boolean enabled", { subscribe: [{ ...inbox, enabled: "yes" }] }],
		["a non-object config", { subscribe: [{ ...inbox, config: "stream" }] }],
		["a non-object options", { subscribe: [{ ...inbox, options: 7 }] }],
		["an invalid activation", { subscribe: [{ ...inbox, activation: "soon" }] }],
		[
			"activation on a publish channel",
			{ sender: "agent-a", subscribe: [inbox], publish: [{ ...toB, activation: "immediate" }] },
		],
		["publish without a sender", { subscribe: [inbox], publish: [toB] }],
		["an empty publish array", { sender: "agent-a", subscribe: [inbox], publish: [] }],
		[
			"a publish channel without a stream",
			{ sender: "agent-a", subscribe: [inbox], publish: [{ name: "o", transport: "redis-streams", config: {} }] },
		],
		["a sender with a space", { sender: "agent a", subscribe: [inbox], publish: [toB] }],
		["a sender with a newline", { sender: "agent\na", subscribe: [inbox], publish: [toB] }],
		["an over-long sender", { sender: "a".repeat(129), subscribe: [inbox], publish: [toB] }],
		["a duplicated subscribe name", { subscribe: [inbox, inbox] }],
		["a duplicated publish name", { sender: "agent-a", subscribe: [inbox], publish: [toB, toB] }],
	])("rejects %s", (_name, document) => {
		expect(() => parseAceConfig(document, ".ace.json")).toThrow(AceConfigError);
	});

	it("accepts a sender without publish channels", () => {
		expect(parseAceConfig({ sender: "agent-a", subscribe: [inbox] }, ".ace.json").sender).toBe("agent-a");
	});

	it("names the file in the error", () => {
		expect(() => parseAceConfig({}, "/tmp/project/.ace.json")).toThrow(/\/tmp\/project\/\.ace\.json/);
	});
});

describe("channelWarnings", () => {
	it("warns when two subscriptions split a stream inside one group", () => {
		const warnings = channelWarnings({
			subscribe: [
				{ ...inbox, name: "a" },
				{ ...inbox, name: "b" },
			],
		});

		expect(warnings[0]).toMatch(/same group/);
	});

	it("warns when two subscriptions deliver every event twice to one agent", () => {
		const warnings = channelWarnings({
			subscribe: [
				{ ...inbox, name: "a" },
				{ ...inbox, name: "b", config: { stream: "ace:in.a", group: "other" } },
			],
		});

		expect(warnings[0]).toMatch(/every event twice/);
	});

	it("stays quiet for distinct channels", () => {
		expect(
			channelWarnings({ subscribe: [inbox, { ...inbox, name: "b", config: { stream: "ace:in.b", group: "g" } }] }),
		).toEqual([]);
	});
});

describe("loadAceConfig", () => {
	it("reads .ace.json from the working directory", () => {
		const cwd = temporaryDirectory();
		writeConfig(cwd, { subscribe: [inbox] });

		const loaded = loadAceConfig({ cwd });

		expect(loaded?.source).toBe(join(cwd, ACE_CONFIG_FILENAME));
		expect(loaded?.config.subscribe).toEqual([{ ...inbox }]);
	});

	it("prefers ACE_CONFIG over the working directory", () => {
		const cwd = temporaryDirectory();
		const elsewhere = join(temporaryDirectory(), "custom.json");
		writeConfig(cwd, { subscribe: [inbox] });
		writeFileSync(
			elsewhere,
			JSON.stringify({ subscribe: [{ ...inbox, config: { stream: "ace:custom", group: "g" } }] }),
		);

		expect(loadAceConfig({ cwd, env: { ACE_CONFIG: elsewhere } })?.config.subscribe[0]?.config.stream).toBe(
			"ace:custom",
		);
	});

	it("returns undefined without a config file", () => {
		expect(loadAceConfig({ cwd: temporaryDirectory(), env: {} })).toBeUndefined();
	});

	it("reports invalid JSON with the path", () => {
		const cwd = temporaryDirectory();
		writeFileSync(join(cwd, ACE_CONFIG_FILENAME), "{ not json");

		expect(() => loadAceConfig({ cwd })).toThrow(/not valid JSON/);
	});
});

describe("resolveAceConfig", () => {
	it("resolves channels, sender and warnings from the file", () => {
		const cwd = temporaryDirectory();
		const source = writeConfig(cwd, { sender: "agent-a", subscribe: [inbox], publish: [toB] });

		const resolved = resolveAceConfig({ cwd, env: {} });

		expect(resolved).toMatchObject({ source, sender: "agent-a" });
		expect(resolved.subscribe[0]?.name).toBe("inbox");
		expect(resolved.publish[0]?.name).toBe("to-b");
		expect(resolved.disabled).toEqual([]);
		expect(resolved.warnings).toEqual([]);
	});

	it("filters disabled channels out and reports them", () => {
		const cwd = temporaryDirectory();
		writeConfig(cwd, {
			sender: "agent-a",
			subscribe: [inbox, { ...inbox, name: "paused", enabled: false, config: { stream: "ace:paused", group: "g" } }],
			publish: [{ ...toB, enabled: false }],
		});

		const resolved = resolveAceConfig({ cwd, env: {} });

		expect(resolved.subscribe.map((endpoint) => endpoint.name)).toEqual(["inbox"]);
		expect(resolved.publish).toEqual([]);
		expect(resolved.disabled.sort()).toEqual(["paused", "to-b"]);
	});

	it("leaves sender undefined when nothing is published", () => {
		const cwd = temporaryDirectory();
		writeConfig(cwd, { subscribe: [inbox] });

		expect(resolveAceConfig({ cwd, env: {} }).sender).toBeUndefined();
	});

	it("requires the configuration file: MQ settings never come from the environment", () => {
		const cwd = temporaryDirectory();

		expect(() =>
			resolveAceConfig({ cwd, env: { ACE_STREAM: "ace:env", ACE_REDIS_URL: "redis://elsewhere" } }),
		).toThrow(/no \.ace\.json in/);
	});
});

describe("createTransports / createPublishers", () => {
	it("keys one transport per subscription name", () => {
		const transports = createTransports(
			[
				{ ...inbox },
				{ name: "alerts", transport: "redis-streams", config: { stream: "ace:alerts", group: "g" }, options: {} },
			],
			{ onError: () => {} },
		);

		expect(Object.keys(transports).sort()).toEqual(["alerts", "inbox"]);
		expect(transports.inbox).not.toBe(transports.alerts);
	});

	it("keys one publisher per publication name", () => {
		const publishers = createPublishers(
			[{ ...toB }, { name: "to-c", transport: "redis-streams", config: { stream: "ace:in.c" }, options: {} }],
			{ onError: () => {} },
		);

		expect(Object.keys(publishers).sort()).toEqual(["to-b", "to-c"]);
		expect(publishers["to-b"]).not.toBe(publishers["to-c"]);
	});

	it("rejects an unsupported subscription transport kind", () => {
		expect(() =>
			createTransports([{ name: "alerts", transport: "kafka", config: { topic: "ace" }, options: {} }], {
				onError: () => {},
			}),
		).toThrow(/unsupported transport "kafka"/);
	});

	it("rejects an unsupported publication transport kind", () => {
		expect(() =>
			createPublishers([{ name: "to-b", transport: "nats", config: { subject: "ace" }, options: {} }], {
				onError: () => {},
			}),
		).toThrow(/unsupported transport "nats"/);
	});
});
