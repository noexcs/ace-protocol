import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * This package is the Claude Code side of ACE: an MCP channel plugin. Everything here may speak both
 * the host SDK and `ace-runtime`, but it must reach the core **through its public entry** (`ace-runtime`,
 * i.e. the built barrel) — never through the core's sources — so the two packages move independently.
 *
 * These tests fail the moment the plugin reaches into the core's internals, or ships a dependency the
 * installer cannot resolve.
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

describe("package boundary", () => {
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
		// The MCP server is run from the plugin root (`bun run src/server.ts`); after a tarball install
		// there is no `ace-runtime` in node_modules, so the plugin reaches the core through its vendored
		// copy by relative path, never through the bare specifier.
		const sources = typescriptFiles("src");
		expect(sources.length).toBeGreaterThan(0);
		const bare = sources.filter((file) => /from "ace-runtime"/.test(readFileSync(join(PACKAGE_ROOT, file), "utf8")));

		expect(bare).toEqual([]);
		expect(readFileSync(join(PACKAGE_ROOT, "src/server.ts"), "utf8")).toContain(
			"../vendor/ace-runtime/dist/index.js",
		);
	});

	it("runs the server the manifest points at, at a path that exists", () => {
		const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
			scripts?: Record<string, string>;
		};
		const entry = /bun run (src\/server\.ts)/.exec(manifest.scripts?.start ?? "")?.[1];

		expect(entry).toBeDefined();
		expect(existsSync(join(PACKAGE_ROOT, entry ?? ""))).toBe(true);
	});
});
