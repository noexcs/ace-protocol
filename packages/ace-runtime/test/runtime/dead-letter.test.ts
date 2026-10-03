import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DeadLetterRecord, DeadLetterSink } from "../../src/runtime/dead-letter.ts";
import type { DroppedEntry } from "../../src/transport/redis-streams-transport.ts";

const directories: string[] = [];

function temporaryDirectory(): string {
	const dir = mkdtempSync(join(tmpdir(), "ace-dead-letter-"));
	directories.push(dir);
	return dir;
}

afterEach(() => {
	while (directories.length > 0) rmSync(directories.pop() as string, { recursive: true, force: true });
});

const entry: DroppedEntry = {
	brokerId: "1791053000000-0",
	payload: '{"aceVersion":"0.1","id":"evt_1"}',
	attempts: 3,
	reason: "after 3 delivery attempts",
};

function filesIn(dir: string): string[] {
	return readdirSync(dir).filter((name) => name.startsWith("dead-letter."));
}

describe("DeadLetterSink", () => {
	it("records the last copy of the event, raw payload included", async () => {
		const dir = temporaryDirectory();
		const sink = new DeadLetterSink({ dir, now: () => 1_000 });

		await sink.record("inbox", entry);

		const [file] = filesIn(dir);
		expect(file).toBe("dead-letter.1000.jsonl");
		const [record] = readFileSync(join(dir, file as string), "utf8")
			.trim()
			.split("\n");
		expect(JSON.parse(record as string)).toEqual({
			at: 1_000,
			subscription: "inbox",
			brokerId: entry.brokerId,
			attempts: 3,
			reason: "after 3 delivery attempts",
			payload: '{"aceVersion":"0.1","id":"evt_1"}',
		} satisfies DeadLetterRecord);
		expect(sink.count).toBe(1);
		expect(sink.directory).toBe(dir);
	});

	it("appends further records to the same file", async () => {
		const dir = temporaryDirectory();
		const sink = new DeadLetterSink({ dir, now: () => 1_000 });

		await sink.record("inbox", entry);
		await sink.record("alerts", { ...entry, brokerId: "1791053000001-0", payload: undefined });

		const lines = readFileSync(join(dir, "dead-letter.1000.jsonl"), "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1] as string)).toMatchObject({
			subscription: "alerts",
			brokerId: "1791053000001-0",
			payload: null,
		});
		expect(sink.count).toBe(2);
	});

	it("creates nothing until the first record", () => {
		const dir = join(temporaryDirectory(), "nested");
		new DeadLetterSink({ dir });
		expect(() => statSync(dir)).toThrow();
	});

	it("prunes by age before count, keeping the newest files", async () => {
		const dir = temporaryDirectory();
		const now = Date.now();
		const stale = join(dir, "dead-letter.1.jsonl");
		writeFileSync(stale, "{}\n");
		const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
		utimesSync(stale, twoHoursAgo, twoHoursAgo);
		const sink = new DeadLetterSink({ dir, now: () => now, retentionMs: 60 * 60 * 1000 });

		await sink.record("inbox", entry);

		expect(filesIn(dir)).toEqual([`dead-letter.${now}.jsonl`]);
	});

	it("keeps at most maxFiles records", async () => {
		const dir = temporaryDirectory();
		for (const name of ["dead-letter.1.jsonl", "dead-letter.2.jsonl"]) writeFileSync(join(dir, name), "{}\n");
		const sink = new DeadLetterSink({ dir, now: () => 9_000, maxFiles: 2 });

		await sink.record("inbox", entry);

		const kept = filesIn(dir).sort();
		expect(kept).toHaveLength(2);
		expect(kept).toContain("dead-letter.9000.jsonl");
	});

	it("rejects when the record cannot be written, so the caller keeps the entry pending", async () => {
		const dir = temporaryDirectory();
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "not a directory");
		const sink = new DeadLetterSink({ dir: blocker });

		await expect(sink.record("inbox", entry)).rejects.toThrow();
		expect(sink.count).toBe(0);
	});
});
