#!/usr/bin/env node
/**
 * Vendor drift guard for the host packages that ship a **copy** of ace-runtime's build:
 *
 *   - `packages/ace-claude-code/vendor/ace-runtime` — the Claude plugin installs from this repo, so the
 *     copy is tracked and the host's `file:` dependency points at it.
 *   - `packages/ace-omp/vendor/ace-runtime` — the omp extension loader refuses a bare `ace-runtime`
 *     specifier from a linked sibling package, so the plugin imports the core through this copy,
 *     relative to its own file. See `docs/ace-plan.md`.
 *
 * `ace-codex` needs none of this: it depends on `file:../ace-runtime` and is launched by us, not by a
 * host loader.
 *
 * What it does:
 *   - compares `packages/ace-runtime/dist` (built) against each vendored `dist`, file by file, by
 *     sha256 — and compares the two `package.json` versions as a cheap first signal;
 *   - `--build` runs `npm run build` in `packages/ace-runtime` first, so the comparison is against the
 *     current sources;
 *   - `--write` refreshes a vendored copy in place (copies only the files that differ, drops files the
 *     build no longer has, and syncs the version field);
 *   - exits non-zero on any difference, printing exactly which files drift.
 *
 * Usage: node scripts/check-vendor-sync.ts [--build] [--write]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUNTIME = join(ROOT, "packages/ace-runtime");
const VENDORS = ["packages/ace-claude-code/vendor/ace-runtime", "packages/ace-omp/vendor/ace-runtime"];
const IGNORED = /(^|\/)(node_modules|\.git)(\/|$)|\.tsbuildinfo$/;
const WRITE = process.argv.includes("--write");

/** Every file under `dir`, as `{ relativePath: sha256 }`. */
function fingerprint(dir) {
	if (!existsSync(dir)) return undefined;
	const files = {};
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			const rel = relative(dir, path);
			if (IGNORED.test(rel)) continue;
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) files[rel] = createHash("sha256").update(readFileSync(path)).digest("hex");
		}
	};
	walk(dir);
	return files;
}

function version(dir) {
	const manifest = join(dir, "package.json");
	return existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")).version : undefined;
}

if (process.argv.includes("--build")) {
	process.stdout.write("[vendor-sync] building ace-runtime…\n");
	execFileSync("npm", ["run", "build"], { cwd: RUNTIME, stdio: "inherit" });
}

const built = fingerprint(join(RUNTIME, "dist"));
const builtVersion = version(RUNTIME);
if (built === undefined) {
	process.stderr.write("[vendor-sync] packages/ace-runtime/dist is missing — build it first or pass --build\n");
	process.exit(2);
}

let failed = false;
for (const relativeVendor of VENDORS) {
	const vendor = join(ROOT, relativeVendor);
	let vendored = fingerprint(join(vendor, "dist"));
	let vendoredVersion = version(vendor);

	if (vendored === undefined) {
		if (!WRITE) {
			process.stderr.write(`[vendor-sync] ${relativeVendor}/dist is missing — the host cannot run\n`);
			failed = true;
			continue;
		}
		// Bootstrap: the vendored copy is the core's manifest plus its build.
		mkdirSync(join(vendor, "dist"), { recursive: true });
		copyFileSync(join(RUNTIME, "package.json"), join(vendor, "package.json"));
		vendored = {};
		vendoredVersion = builtVersion;
	}

	const lines = [];
	if (builtVersion !== vendoredVersion) lines.push(`version: ace-runtime ${builtVersion} vs vendor ${vendoredVersion}`);
	for (const [path, hash] of Object.entries(built)) {
		if (!(path in vendored)) lines.push(`missing in vendor: ${path}`);
		else if (vendored[path] !== hash) lines.push(`differs:          ${path}`);
	}
	for (const path of Object.keys(vendored)) {
		if (!(path in built)) lines.push(`stale in vendor:  ${path}`);
	}

	if (lines.length === 0) {
		process.stdout.write(`[vendor-sync] ${relativeVendor}: in sync (${Object.keys(built).length} files)\n`);
		continue;
	}

	if (!WRITE) {
		process.stderr.write(`[vendor-sync] ${relativeVendor}: DRIFT — not the current build:\n`);
		for (const line of lines) process.stderr.write(`  ${line}\n`);
		failed = true;
		continue;
	}

	const builtDist = join(RUNTIME, "dist");
	const vendoredDist = join(vendor, "dist");
	let copied = 0;
	let removed = 0;
	for (const [path, hash] of Object.entries(built)) {
		if (vendored[path] === hash) continue;
		const target = join(vendoredDist, path);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(builtDist, path), target);
		copied += 1;
	}
	for (const path of Object.keys(vendored)) {
		if (path in built) continue;
		rmSync(join(vendoredDist, path), { force: true });
		removed += 1;
	}
	if (builtVersion !== vendoredVersion) {
		const manifestPath = join(vendor, "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		manifest.version = builtVersion;
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	}
	process.stdout.write(
		`[vendor-sync] ${relativeVendor}: refreshed (${copied} copied, ${removed} stale removed, version ${builtVersion})\n`,
	);
}

if (failed) {
	process.stderr.write("[vendor-sync] fix: node scripts/check-vendor-sync.ts --write\n");
	process.exit(1);
}
