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
/** A host's own *state paths* and environment: naming one here would leak that host into the core.
 *  A host's name as a field *value* (`codingAgent: "oh-my-pi"`) is legitimate — only locations are not. */
const HOST_SPECIFIC = /"\.omp"|\.omp\//;

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

	// No module in this package imports Pi at all any more: the SDK adapter was dead code no host ran
	// (the omp extension instantiates `PiExtensionAdapter`), so it and its helpers were deleted. The
	// extension, its manager view and the omp tests live in `packages/ace-omp`, whose own boundary
	// test keeps them in line.
	it("keeps every Pi import out of this package", () => {
		const withPi = typescriptFiles("src").filter(importsPi).sort();

		expect(withPi).toEqual([]);
	});

	it("keeps every host's own paths and environment variables out", () => {
		// The core is host-neutral; a hardcoded `~/.omp` here would quietly become the host's default.
		// The host passes its candidates in, they are not guessed.
		const offenders = [...HOST_NEUTRAL_DIRECTORIES.flatMap(typescriptFiles), ...HOST_NEUTRAL_FILES].filter((file) =>
			HOST_SPECIFIC.test(readFileSync(join(PACKAGE_ROOT, file), "utf8")),
		);

		expect(offenders).toEqual([]);
	});

	it("resolves the package root correctly", () => {
		expect(relative(PACKAGE_ROOT, PACKAGE_ROOT)).toBe("");
		expect(readdirSync(PACKAGE_ROOT)).toContain("package.json");
	});
});
