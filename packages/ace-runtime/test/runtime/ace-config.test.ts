import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ACE_CONFIG_FILENAME,
	interpolateEnv,
	loadAceConfig,
	parseAceConfig,
	resolveAceConfig,
	subscriptionEndpoint,
} from "../../src/runtime/ace-config.ts";
import { AceConfigError } from "../../src/runtime/endpoint-config.ts";
import { channelStreamKey, NAMESPACE_DEFAULT } from "../../src/runtime/naming.ts";

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

const minimal = { username: "noexcs", servers: { local: { url: "redis://127.0.0.1:6379" } } };

afterEach(() => {
	while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true });
});

describe("parseAceConfig", () => {
	it("accepts a username and a server", () => {
		expect(parseAceConfig(minimal, ".ace.json")).toEqual({
			username: "noexcs",
			servers: { local: { url: "redis://127.0.0.1:6379" } },
		});
	});

	it("refuses a colon in the fixed segments", () => {
		expect(() => parseAceConfig({ ...minimal, username: "noexcs:x" }, ".ace.json")).toThrow(/must not contain/);
		expect(() =>
			parseAceConfig({ username: "u", servers: { "ace:lan": { url: "redis://x" } } }, ".ace.json"),
		).toThrow(/must not contain/);
		expect(() =>
			parseAceConfig({ username: "u", servers: { lan: { url: "redis://x", namespace: "a:b" } } }, ".ace.json"),
		).toThrow(/must not contain/);
	});

	it("requires at least one server with a non-empty url", () => {
		expect(() => parseAceConfig({ username: "u", servers: {} }, ".ace.json")).toThrow(/non-empty object/);
		expect(() => parseAceConfig({ username: "u", servers: { lan: {} } }, ".ace.json")).toThrow(/url/);
		expect(() => parseAceConfig({ username: "u", servers: { lan: { url: "" } } }, ".ace.json")).toThrow(/url/);
	});

	it("rejects unknown settings inside a server entry", () => {
		expect(() =>
			parseAceConfig({ username: "u", servers: { lan: { url: "redis://x", prefix: "ace" } } }, ".ace.json"),
		).toThrow(/unknown setting/);
	});

	it("validates the remaining optional fields", () => {
		expect(() => parseAceConfig({ ...minimal, defaultActivation: "later" }, ".ace.json")).toThrow(
			/defaultActivation/,
		);
		expect(() => parseAceConfig({ ...minimal, projectConfig: "merge" }, ".ace.json")).toThrow(/projectConfig/);
		expect(() => parseAceConfig({ ...minimal, manual: { ttl: 5 } }, ".ace.json")).toThrow(/unknown setting/);
	});

	it("validates subscribe inside a server entry", () => {
		const server = (subscribe: unknown) => ({
			...minimal,
			servers: { local: { url: "redis://127.0.0.1:6379", subscribe } },
		});
		expect(() => parseAceConfig(server("inbox"), ".ace.json")).toThrow(/subscribe must be an array/);
		expect(() => parseAceConfig(server([""]), ".ace.json")).toThrow(/non-empty strings/);
		expect(() => parseAceConfig(server(["inbox", "inbox"]), ".ace.json")).toThrow(/configured twice/);
	});

	it("points a top-level subscribe at the per-server form", () => {
		expect(() => parseAceConfig({ ...minimal, subscribe: ["inbox"] }, ".ace.json")).toThrow(
			/subscribe belongs inside a server — servers: \{ "<name>": \{ url, subscribe: \["<channel>"\] \} \}/,
		);
	});

	it("accepts subscribe names as written inside a server", () => {
		const parsed = parseAceConfig(
			{ ...minimal, servers: { local: { url: "redis://127.0.0.1:6379", subscribe: ["inbox", "lan:ci-failures"] } } },
			".ace.json",
		);

		expect(parsed.servers.local.subscribe).toEqual(["inbox", "lan:ci-failures"]);
	});
});

describe("interpolateEnv", () => {
	// Built without writing `${` in a string literal: the linter reads that as a forgotten template.
	const dollar = "$";

	it("resolves a variable and refuses an unset one", () => {
		expect(interpolateEnv({ url: `redis://:${dollar}{PASS}@h` }, { PASS: "s3cret" }, ".ace.json")).toEqual({
			url: "redis://:s3cret@h",
		});
		expect(() => interpolateEnv({ url: `${dollar}{PASS}` }, {}, ".ace.json")).toThrow(/is not set/);
	});

	it("writes a literal with $$", () => {
		expect(interpolateEnv({ url: `${dollar}${dollar}{PASS}` }, { PASS: "x" }, ".ace.json")).toEqual({
			url: `${dollar}{PASS}`,
		});
	});
});

describe("loadAceConfig", () => {
	it("reads .ace.json from the working directory", () => {
		const cwd = temporaryDirectory();
		writeConfig(cwd, minimal);

		const loaded = loadAceConfig({ cwd, env: {} });

		expect(loaded?.source).toBe(join(cwd, ACE_CONFIG_FILENAME));
		expect(loaded?.config.username).toBe("noexcs");
	});

	it("prefers $ACE_CONFIG over the working directory", () => {
		const cwd = temporaryDirectory();
		const elsewhere = join(temporaryDirectory(), "custom.json");
		writeConfig(cwd, minimal);
		writeFileSync(elsewhere, JSON.stringify({ ...minimal, username: "from-env" }));

		expect(loadAceConfig({ cwd, env: { ACE_CONFIG: elsewhere } })?.config.username).toBe("from-env");
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

describe("host-global candidates", () => {
	it("falls back to a global file when the project has none", () => {
		const cwd = temporaryDirectory();
		const global = join(temporaryDirectory(), "ace.json");
		writeFileSync(global, JSON.stringify(minimal));

		expect(loadAceConfig({ cwd, env: {}, globalConfigPaths: [global] })?.source).toBe(global);
	});

	it("prefers the project file, and reports the global it shadowed", () => {
		const cwd = temporaryDirectory();
		writeConfig(cwd, minimal);
		const global = join(temporaryDirectory(), "ace.json");
		writeFileSync(global, JSON.stringify({ ...minimal, username: "global-user" }));

		const loaded = loadAceConfig({ cwd, env: {}, globalConfigPaths: [global] });
		expect(loaded?.source).toBe(join(cwd, ACE_CONFIG_FILENAME));
		expect(loaded?.shadowed).toBe(global);
		expect(resolveAceConfig({ cwd, env: {}, globalConfigPaths: [global] }).warnings.join(" ")).toContain(
			`overrides the global ${global}`,
		);
	});

	it("inherits username from the global file, then from $USER", () => {
		const cwd = temporaryDirectory();
		const global = join(temporaryDirectory(), "ace.json");
		writeFileSync(global, JSON.stringify({ ...minimal, username: "global-user" }));
		// The project file says who the servers are; who the *user* is comes from further up.
		writeConfig(cwd, { servers: minimal.servers });

		expect(resolveAceConfig({ cwd, env: {}, globalConfigPaths: [global] }).username).toBe("global-user");
		expect(resolveAceConfig({ cwd, env: { USER: "env-user" }, globalConfigPaths: [global] }).username).toBe(
			"global-user",
		);

		const noGlobal = temporaryDirectory();
		writeConfig(noGlobal, { servers: minimal.servers });
		expect(resolveAceConfig({ cwd: noGlobal, env: { USER: "env-user" } }).username).toBe("env-user");
		expect(() => resolveAceConfig({ cwd: noGlobal, env: {} })).toThrow(/username is required/);
	});

	it("lets a global file refuse to be overridden", () => {
		const cwd = temporaryDirectory();
		writeConfig(cwd, minimal);
		const global = join(temporaryDirectory(), "ace.json");
		writeFileSync(global, JSON.stringify({ ...minimal, username: "global-user", projectConfig: "ignore" }));

		expect(loadAceConfig({ cwd, env: {}, globalConfigPaths: [global] })?.config.username).toBe("global-user");
	});
});

describe("resolveAceConfig", () => {
	it("resolves servers with their namespace defaulted", () => {
		const cwd = temporaryDirectory();
		writeConfig(cwd, {
			username: "u",
			servers: { local: { url: "redis://x" }, lan: { url: "redis://y", namespace: "lan" } },
		});

		const resolved = resolveAceConfig({ cwd, env: {} });

		expect(resolved.servers).toEqual([
			{ name: "local", url: "redis://x", namespace: NAMESPACE_DEFAULT },
			{ name: "lan", url: "redis://y", namespace: "lan" },
		]);
	});

	it("resolves a short name against the only server, under that server's namespace", () => {
		const cwd = temporaryDirectory();
		writeConfig(cwd, {
			username: "noexcs",
			servers: { local: { url: "redis://x", subscribe: ["inbox"] } },
		});

		const resolved = resolveAceConfig({ cwd, env: {} });

		expect(resolved.subscriptions).toEqual([
			{
				server: { name: "local", url: "redis://x", namespace: "ace", subscribe: ["inbox"] },
				channel: "ace:noexcs:inbox",
				name: "ace:noexcs:inbox",
			},
		]);
	});

	it("resolves each short name under its own server's namespace, server by server", () => {
		const cwd = temporaryDirectory();
		writeConfig(cwd, {
			username: "u",
			servers: {
				lan: { url: "redis://lan", namespace: "lan", subscribe: ["from-wsl", "from-ci"] },
				local: { url: "redis://local", subscribe: ["ci-ok"] },
			},
		});

		const resolved = resolveAceConfig({ cwd, env: {} });

		expect(resolved.subscriptions.map(({ server, channel }) => [server.name, channel])).toEqual([
			["lan", "lan:u:from-wsl"],
			["lan", "lan:u:from-ci"],
			["local", "ace:u:ci-ok"],
		]);
	});

	it("resolves the same short name on two servers sharing a namespace to the same channel", () => {
		const cwd = temporaryDirectory();
		writeConfig(cwd, {
			username: "u",
			servers: {
				a: { url: "redis://a", namespace: "shared", subscribe: ["inbox"] },
				b: { url: "redis://b", namespace: "shared", subscribe: ["inbox"] },
			},
		});

		const resolved = resolveAceConfig({ cwd, env: {} });

		expect(resolved.subscriptions.map(({ server, channel }) => [server.name, channel])).toEqual([
			["a", "shared:u:inbox"],
			["b", "shared:u:inbox"],
		]);
	});

	it("passes a full channel name through untouched", () => {
		const cwd = temporaryDirectory();
		writeConfig(cwd, {
			username: "u",
			servers: { local: { url: "redis://x", subscribe: ["ace:someone-else:inbox"] } },
		});

		expect(resolveAceConfig({ cwd, env: {} }).subscriptions[0]?.channel).toBe("ace:someone-else:inbox");
	});

	it("reports two servers sharing one Redis as the two islands they are", () => {
		const cwd = temporaryDirectory();
		writeConfig(cwd, {
			username: "u",
			servers: { lan: { url: "redis://same", namespace: "lan" }, ci: { url: "redis://same", namespace: "ci" } },
		});

		expect(resolveAceConfig({ cwd, env: {} }).warnings.join(" ")).toContain("cannot see each other");
	});
});

describe("subscriptionEndpoint", () => {
	it("derives the address from the channel name and the group from the subscriber", () => {
		const sender = "ace:noexcs:oh-my-pi:01a10a";

		expect(
			subscriptionEndpoint({ channel: "ace:noexcs:ci-failures", url: "redis://x", namespace: "ace", sender }),
		).toEqual({
			name: "ace:noexcs:ci-failures",
			transport: "redis-streams",
			activation: undefined,
			description: undefined,
			config: {
				stream: channelStreamKey("ace", "ace:noexcs:ci-failures"),
				group: sender,
				url: "redis://x",
				field: "message",
			},
			options: {},
		});
	});

	it("takes a local label when the host needs one (the inbox)", () => {
		const endpoint = subscriptionEndpoint({
			channel: "ace:noexcs:oh-my-pi:01a10a",
			name: "session-inbox",
			url: "redis://x",
			namespace: "ace",
			sender: "ace:noexcs:oh-my-pi:01a10a",
		});

		expect(endpoint.name).toBe("session-inbox");
		expect(endpoint.config.group).toBe("ace:noexcs:oh-my-pi:01a10a");
	});
});

describe("AceConfigError", () => {
	it("is thrown for unusable configuration", () => {
		expect(() => parseAceConfig(null, ".ace.json")).toThrow(AceConfigError);
	});
});
