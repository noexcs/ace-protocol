#!/usr/bin/env node
/**
 * Vendor drift guard for `packages/ace-claude-code/vendor/ace-runtime`.
 *
 * That package depends on `file:./vendor/ace-runtime` — a **copy** of ace-runtime's build output,
 * refreshed by hand. `ace-codex`, by contrast, depends on `file:../ace-runtime`, so it follows the
 * live package. Nothing kept the copy honest: change `ace-runtime` and the Claude host silently
 * keeps running the old runtime.
 *
 * What it does:
 *   - compares `packages/ace-runtime/dist` (built) against the vendored `dist`, file by file, by
 *     sha256 — and compares the two `package.json` versions as a cheap first signal;
 *   - `--build` runs `npm run build` in `packages/ace-runtime` first, so the comparison is against
 *     the current sources;
 *   - exits non-zero on any difference, printing exactly which files drift.
 *
 * Usage: node scripts/check-vendor-sync.ts [--build] [--write]
 *
 * `--write` refreshes the vendored copy in place (copies only the files that differ, drops files the
 * build no longer has, and syncs the version field). Without it the command is a pure check.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUNTIME = join(ROOT, "packages/ace-runtime");
const VENDOR = join(ROOT, "packages/ace-claude-code/vendor/ace-runtime");
const IGNORED = /(^|\/)(node_modules|\.git)(\/|$)|\.tsbuildinfo$/;

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
const vendored = fingerprint(join(VENDOR, "dist"));
const builtVersion = version(RUNTIME);
const vendoredVersion = version(VENDOR);

if (built === undefined) {
	process.stderr.write("[vendor-sync] packages/ace-runtime/dist is missing — build it first or pass --build\n");
	process.exit(2);
}
if (vendored === undefined) {
	process.stderr.write(`[vendor-sync] ${relative(ROOT, VENDOR)}/dist is missing — the Claude host cannot run\n`);
	process.exit(2);
}

const drift = [];
for (const [path, hash] of Object.entries(built)) {
	if (!(path in vendored)) drift.push(`missing in vendor: ${path}`);
	else if (vendored[path] !== hash) drift.push(`differs:          ${path}`);
}
for (const path of Object.keys(vendored)) {
	if (!(path in built)) drift.push(`stale in vendor:  ${path}`);
}

const lines = [];
if (builtVersion !== vendoredVersion) lines.push(`version: ace-runtime ${builtVersion} vs vendor ${vendoredVersion}`);
lines.push(...drift);

if (lines.length === 0) {
	process.stdout.write(`[vendor-sync] in sync: ${Object.keys(built).length} files, ace-runtime ${builtVersion}\n`);
	process.exit(0);
}

if (!process.argv.includes("--write")) {
	process.stderr.write(`[vendor-sync] DRIFT — the vendored runtime is not the current build:\n`);
	for (const line of lines) process.stderr.write(`  ${line}\n`);
	process.stderr.write(`[vendor-sync] fix: node scripts/check-vendor-sync.ts --write\n`);
	process.exit(1);
}

/** Refresh the vendored copy in place: copy what differs, drop what is gone, sync the version. */
const builtDist = join(RUNTIME, "dist");
const vendoredDist = join(VENDOR, "dist");
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
let versionChanged = false;
if (builtVersion !== vendoredVersion) {
	const manifestPath = join(VENDOR, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.version = builtVersion;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	versionChanged = true;
}
process.stdout.write(
	`[vendor-sync] refreshed: ${copied} file(s) copied, ${removed} stale removed, version ${vendoredVersion} → ${builtVersion}${versionChanged ? "" : " (unchanged)"}\n`,
);
