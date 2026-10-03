/**
 * Put dead-lettered events back on the streams they came from.
 *
 * ```bash
 * npm run replay:dead-letters                       # newest dead-letter file under ./.ace
 * npm run replay:dead-letters -- path/to/file.jsonl
 * npm run replay:dead-letters -- --dry-run path/to/file.jsonl
 * npm run replay:dead-letters -- --url redis://host:6379 path/to/file.jsonl
 * npm run replay:dead-letters -- --dir /var/lib/ace/spool
 * ```
 *
 * The broker defaults to `ACE_REDIS_URL`, then the Redis Streams default; the destination stream and
 * field come from each record, so replaying needs no `.ace.json`. Payloads are written verbatim and
 * validated again by the receiving runtime, which is why a replay does not depend on the parser.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	createRedisStreamsAddClient,
	parseDeadLetters,
	REDIS_STREAMS_DEFAULTS,
	replayDeadLetters,
	summarizeReplay,
} from "../src/index.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const urlFlag = flagValue("--url");
const dirFlag = flagValue("--dir");
const files = args.filter((arg) => !arg.startsWith("--") && arg !== urlFlag && arg !== dirFlag);
const url = urlFlag ?? process.env.ACE_REDIS_URL ?? REDIS_STREAMS_DEFAULTS.url;

function flagValue(flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) {
		console.error(`replay:dead-letters: ${flag} needs a value`);
		process.exit(2);
	}
	return value;
}

/** The newest `dead-letter.*.jsonl` under the spool directory, when no file was given. */
function newestDeadLetter(dir: string): string | undefined {
	if (!existsSync(dir)) return undefined;
	let newest: { path: string; mtimeMs: number } | undefined;
	for (const entry of readdirSync(dir)) {
		if (!entry.startsWith("dead-letter.") || !entry.endsWith(".jsonl")) continue;
		const path = join(dir, entry);
		const { mtimeMs } = statSync(path);
		if (newest === undefined || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
	}
	return newest?.path;
}

const directory = resolve(dirFlag ?? join(process.cwd(), ".ace"));
const targets =
	files.length > 0
		? files.map((file) => resolve(file))
		: [newestDeadLetter(directory)].filter((path): path is string => path !== undefined);
if (targets.length === 0) {
	console.error(`replay:dead-letters: no dead-letter file under ${directory} — pass one explicitly`);
	process.exit(1);
}

console.log(`ACE dead-letter replay → ${url}${dryRun ? " (dry run)" : ""}\n`);
const client = createRedisStreamsAddClient(url, (error) => console.error(`  broker: ${String(error)}`));
let failed = 0;
let replayed = 0;
let skipped = 0;

try {
	for (const file of targets) {
		const { records, skipped: unusable } = parseDeadLetters(readFileSync(file, "utf8"));
		skipped += unusable;
		if (dryRun) {
			console.log(
				`${file}\n  ${records.length} replayable, ${unusable} unusable\n  → ${summarizeReplay(records) || "(nothing)"}`,
			);
			continue;
		}
		const outcome = await replayDeadLetters(records, async (stream, field, payload) => {
			await client.add(stream, field, payload);
		});
		replayed += outcome.replayed;
		skipped += outcome.skipped;
		failed += outcome.failed.length;
		for (const failure of outcome.failed) {
			console.error(`  FAILED ${failure.stream} ${failure.brokerId}: ${String(failure.error)}`);
		}
		console.log(
			`${file}\n  replayed ${outcome.replayed}, skipped ${outcome.skipped}, failed ${outcome.failed.length}\n  → ${summarizeReplay(records) || "(nothing)"}`,
		);
	}
} finally {
	await client.close();
}

console.log(`\n${replayed} replayed, ${skipped} skipped, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
