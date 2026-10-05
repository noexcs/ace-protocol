import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * This package is the host side of ACE: the oh-my-pi / Pi plugin. Everything here may speak both the
 * host SDK and `ace-runtime`, but it must reach the core **through its public entry** (`ace-runtime`,
 * i.e. the built package) — never through the core's sources — so the two packages can move
 * independently.
 *
 * These tests fail the moment the plugin reaches into the core's internals, or the extension stops
 * being discoverable by the host.
 */
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Every TypeScript file under `dir`, relative to the package root. */
function typescriptFiles(directory: string): string[] {
	const absolute = join(PACKAGE_ROOT, directory);
	if (!existsSync(absolute)) return [];
	return readdirSync(absolute).flatMap((entry) => {
		const path = join(absolute, entry);
		if (statSync(path).isDirectory()) return typescriptFiles(join(directory, entry));
		return entry.endsWith(".ts") ? [join(directory, entry)] : [];
	});
}

const CORE_SOURCE_IMPORT = /["'](?:\.\.\/)+src\/|ace-runtime\/src\//;

describe("package boundary", () => {
	it("consumes the core through its public entry, never through its sources", () => {
		const offenders = ["extensions", "scripts", "test"]
			.flatMap(typescriptFiles)
			.filter((file) => CORE_SOURCE_IMPORT.test(readFileSync(join(PACKAGE_ROOT, file), "utf8")));

		expect(offenders).toEqual([]);
	});

	it("declares the extension the host loads, at a path that exists", () => {
		const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
		const declared = manifest.omp?.extensions ?? [];

		expect(declared.length).toBeGreaterThan(0);
		for (const entry of declared) expect(existsSync(join(PACKAGE_ROOT, entry))).toBe(true);
	});

	it("keeps the docs-test's relative path to the shared contracts document valid", () => {
		// `test/extensions/tool-text-docs.test.ts` compares the tool text against the contracts doc at
		// the repository root; it can only do that while this package sits one level below the root.
		const docs = fileURLToPath(new URL("../../../../docs/ace-runtime-contracts.md", import.meta.url));

		expect(existsSync(docs)).toBe(true);
		expect(relative(PACKAGE_ROOT, docs).startsWith("../")).toBe(true);
	});
});
