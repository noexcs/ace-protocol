import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

	it("declares no nested file: dependency — bun cannot resolve one inside an installed tarball", () => {
		// `file:./vendor/ace-runtime` resolved in a checkout but not in an install: bun rewrites the
		// specifier against its own cache root, where the tarball's `package/` level is missing. The
		// vendored core is reached by relative path instead (tsconfig paths + the vitest alias cover the
		// tests).
		const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		const fileDependencies = Object.entries(manifest.dependencies ?? {}).filter(([, spec]) =>
			spec.startsWith("file:"),
		);

		expect(fileDependencies).toEqual([]);
	});

	it("imports the runtime through the copy inside this package", () => {
		// The omp extension loader refuses a bare `ace-runtime` specifier (a linked sibling package does
		// not resolve there, while the package's own node_modules and relative paths do). The plugin
		// therefore reaches the core through its vendored copy — `docs/ace-plan.md` records the probe.
		const extensions = typescriptFiles("extensions");
		const bare = extensions.filter((file) =>
			/from "ace-runtime"/.test(readFileSync(join(PACKAGE_ROOT, file), "utf8")),
		);
		const entry = readFileSync(join(PACKAGE_ROOT, "extensions/ace.ts"), "utf8");

		expect(bare).toEqual([]);
		expect(entry).toContain("../vendor/ace-runtime/dist/index.js");
	});

	it("declares the extension the host loads, at a path that exists", () => {
		const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
		const declared = manifest.omp?.extensions ?? [];

		expect(declared.length).toBeGreaterThan(0);
		for (const entry of declared) expect(existsSync(join(PACKAGE_ROOT, entry))).toBe(true);
	});
});
