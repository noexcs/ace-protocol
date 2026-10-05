import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The runtime is meant to outlive Pi: protocol, activation, transports and the `AgentEngine`
 * contract must stay host-neutral so another agent host can reuse them (and so the package could be
 * split into core + per-host packages without touching behaviour — the omp/Pi host now lives in
 * `packages/ace-omp`).
 *
 * These tests fail the moment Pi leaks into a host-neutral module.
 */
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HOST_NEUTRAL_DIRECTORIES = ["src/protocol", "src/runtime", "src/transport", "src/tools"];
const HOST_NEUTRAL_FILES = ["src/agent/agent-engine.ts"];
const PI_IMPORT = "@earendil-works/";

/** Every TypeScript file under `dir`, relative to the package root. */
function typescriptFiles(directory: string): string[] {
	const absolute = join(PACKAGE_ROOT, directory);
	return readdirSync(absolute).flatMap((entry) => {
		const path = join(absolute, entry);
		if (statSync(path).isDirectory()) return typescriptFiles(join(directory, entry));
		return entry.endsWith(".ts") ? [directory === "." ? entry : join(directory, entry)] : [];
	});
}

function importsPi(file: string): boolean {
	return readFileSync(join(PACKAGE_ROOT, file), "utf8").includes(PI_IMPORT);
}

describe("host boundary", () => {
	it("keeps Pi out of the host-neutral modules", () => {
		const offenders = [...HOST_NEUTRAL_DIRECTORIES.flatMap(typescriptFiles), ...HOST_NEUTRAL_FILES].filter(importsPi);

		expect(offenders).toEqual([]);
	});

	// The Pi SDK adapter is the only Pi-coupled module left in this package: the extension, its
	// manager view and the omp tests moved to `packages/ace-omp`, whose own boundary test keeps them
	// in line.
	it("confines Pi imports to the SDK adapter", () => {
		const withPi = typescriptFiles("src").filter(importsPi).sort();

		expect(withPi).toEqual(["src/agent/pi-adapter.ts"]);
	});

	it("resolves the package root correctly", () => {
		expect(relative(PACKAGE_ROOT, PACKAGE_ROOT)).toBe("");
		expect(readdirSync(PACKAGE_ROOT)).toContain("package.json");
	});
});
