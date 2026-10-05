import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ACE_CONFIG_FILENAME, resolveAceConfig } from "ace-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The config the plugin ships in `example/` is exercised through the real resolver, so it stays
// valid by construction. Resolving only reads and validates the file — no broker is contacted.
let exampleDir: string;
const directories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "ace-cc-config-"));
	directories.push(directory);
	return directory;
}

beforeAll(() => {
	// Load the shipped example directly rather than re-serialising it.
	const example = readFileSync(resolve(import.meta.dirname, "../example/.ace.json"), "utf8");
	exampleDir = temporaryDirectory();
	writeFileSync(join(exampleDir, ACE_CONFIG_FILENAME), example);
});

afterAll(() => {
	while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true });
});

describe("resolveAceConfig over the shipped example", () => {
	it("resolves the user, the server and the subscribed channel name, with no warnings", () => {
		const resolved = resolveAceConfig({ cwd: exampleDir, env: {} });
		expect(resolved.username).toBe("claude");
		expect(resolved.servers.map((server) => server.name)).toEqual(["local"]);
		// A short subscribe name is completed to the uploaded channel name `<ns>:<username>:<name>`.
		expect(resolved.subscriptions.map((subscription) => subscription.name)).toEqual(["ace:claude:inbox"]);
		expect(resolved.subscriptions[0]?.server.name).toBe("local");
		expect(resolved.warnings).toEqual([]);
	});

	it("keeps the configured activation as the runtime default", () => {
		const resolved = resolveAceConfig({ cwd: exampleDir, env: {} });
		expect(resolved.defaultActivation).toBe("next_turn");
	});
});

describe("resolveAceConfig without a configuration file", () => {
	it("throws a broker-free error naming the directory", () => {
		const cwd = temporaryDirectory();
		expect(() => resolveAceConfig({ cwd, env: {} })).toThrow(/no \.ace\.json found/);
	});

	it("rejects a document with no servers", () => {
		const cwd = temporaryDirectory();
		writeFileSync(join(cwd, ACE_CONFIG_FILENAME), JSON.stringify({ username: "claude", subscribe: ["inbox"] }));
		expect(() => resolveAceConfig({ cwd, env: {} })).toThrow();
	});
});
