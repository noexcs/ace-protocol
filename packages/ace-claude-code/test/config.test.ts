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
	it("resolves one subscription and one publication, with no warnings", () => {
		const resolved = resolveAceConfig({ cwd: exampleDir, env: {} });
		expect(resolved.subscribe.map((endpoint) => endpoint.name)).toEqual(["inbox"]);
		expect(resolved.publish.map((endpoint) => endpoint.name)).toEqual(["outbox"]);
		expect(resolved.disabled).toEqual([]);
		// No `sender` in the file: identity is the directory member, so there is nothing to warn about.
		expect(resolved.sender).toBeUndefined();
		expect(resolved.warnings).toEqual([]);
	});

	it("keeps the activation of the inbox as the runtime default", () => {
		const resolved = resolveAceConfig({ cwd: exampleDir, env: {} });
		expect(resolved.subscribe[0]?.activation).toBe("default");
	});
});

describe("resolveAceConfig without a configuration file", () => {
	it("throws a broker-free error naming the directory", () => {
		const cwd = temporaryDirectory();
		expect(() => resolveAceConfig({ cwd, env: {} })).toThrow(/no \.ace\.json in/);
	});

	it("rejects a document missing a subscribe stream", () => {
		const cwd = temporaryDirectory();
		writeFileSync(
			join(cwd, ACE_CONFIG_FILENAME),
			JSON.stringify({ subscribe: [{ name: "inbox", transport: "redis-streams", config: { group: "g" } }] }),
		);
		expect(() => resolveAceConfig({ cwd, env: {} })).toThrow();
	});
});
