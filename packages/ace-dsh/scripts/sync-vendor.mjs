#!/usr/bin/env node
/**
 * Copy the built core (`packages/ace-runtime/dist`) into `vendor/ace-runtime`.
 *
 * The plugin imports the core by **relative path into the vendored build**, exactly as `ace-omp` does: the
 * copy is what the package ships and what its tests read, so the plugin is exercised against the same
 * bytes a user gets. A bare `ace-runtime` dependency would instead resolve through whatever the installing
 * profile happens to have — and the core is not published to a registry at all.
 *
 * Run after changing the core: `npm run sync:vendor`.
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const coreRoot = join(packageRoot, "..", "ace-runtime");
const coreDist = join(coreRoot, "dist");
const target = join(packageRoot, "vendor", "ace-runtime");

if (!existsSync(join(coreDist, "index.js"))) {
	console.error(`[sync-vendor] ${coreDist}/index.js is missing — build the core first:`);
	console.error("  (cd ../ace-runtime && npm install && npm run build)");
	process.exit(1);
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(coreDist, join(target, "dist"), { recursive: true });

// The core's own manifest travels with the build so the copy is self-describing; the plugin reaches it by
// relative path, so nothing here is resolved as a dependency at install time.
const manifest = JSON.parse(await readFile(join(coreRoot, "package.json"), "utf8"));
await writeFile(
	join(target, "package.json"),
	`${JSON.stringify(
		{
			name: manifest.name,
			version: manifest.version,
			description: manifest.description,
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./package.json": "./package.json" },
			license: manifest.license,
			dependencies: manifest.dependencies,
		},
		null,
		"\t",
	)}\n`,
);

console.log(`[sync-vendor] ${manifest.name}@${manifest.version} → vendor/ace-runtime/dist`);
