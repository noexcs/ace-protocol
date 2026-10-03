import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { AceLogger } from "../logger.ts";
import type { DroppedEntry } from "../transport/redis-streams-transport.ts";

/** One line of the dead-letter file: the last copy of an event nobody could deliver. */
export interface DeadLetterRecord {
	/** When the transport gave up, epoch ms. */
	at: number;
	/** Channel the event arrived on. */
	subscription: string;
	/** Broker entry id, to trace it back to the stream. */
	brokerId: string;
	/** How many deliveries were attempted before giving up. */
	attempts: number;
	/** Why it was dropped. */
	reason: string;
	/** Raw payload, verbatim — the record must stay readable without ACE's parser. */
	payload: string | null;
}

export interface DeadLetterSinkOptions {
	/** Where the files go; the extension points this at the spool directory. */
	dir: string;
	/** Files older than this are pruned first (default 24h, matching the burst spool). */
	retentionMs?: number;
	/** Files kept regardless of age (default 50, matching the burst spool). */
	maxFiles?: number;
	/** Injectable clock for tests. */
	now?: () => number;
	logger?: AceLogger;
	/** Called when a prune fails; a write failure is thrown to the caller instead. */
	onError?: (error: unknown) => void;
}

/**
 * Keeps the events the transport gave up on (RFC §17).
 *
 * Why a file and not another stream: the entries that land here are the ones no handler could
 * deliver, so storing them must not depend on the same machinery that just failed. Same policy as
 * the burst spool — JSONL, `fsync` before the caller acknowledges, one file per runtime, pruned by
 * age then count — but **no summary event is injected**: the agent already failed to receive this
 * event `reclaimAttempts` times, and feeding it back would loop.
 */
export class DeadLetterSink {
	private readonly dir: string;
	private readonly retentionMs: number;
	private readonly maxFiles: number;
	private readonly now: () => number;
	private readonly logger: AceLogger | undefined;
	private readonly onError: (error: unknown) => void;
	private file: string | undefined;
	private records = 0;

	constructor(options: DeadLetterSinkOptions) {
		this.dir = options.dir;
		this.retentionMs = options.retentionMs ?? 24 * 60 * 60 * 1000;
		this.maxFiles = options.maxFiles ?? 50;
		this.now = options.now ?? (() => Date.now());
		this.logger = options.logger;
		this.onError = options.onError ?? (() => {});
	}

	/** Append one record durably. Throws when the write fails, so the caller keeps the entry pending. */
	async record(subscription: string, entry: DroppedEntry): Promise<void> {
		const record: DeadLetterRecord = {
			at: this.now(),
			subscription,
			brokerId: entry.brokerId,
			attempts: entry.attempts,
			reason: entry.reason,
			payload: entry.payload ?? null,
		};
		mkdirSync(this.dir, { recursive: true });
		const path = this.filePath();
		appendDurably(path, `${JSON.stringify(record)}\n`);
		this.records += 1;
		this.prune();
		this.logger?.info?.(
			`[ACE] dead letter subscribe=${subscription} brokerId=${entry.brokerId} attempts=${entry.attempts} path=${path}`,
		);
	}

	/** Records appended by this runtime, for `/ace`. */
	get count(): number {
		return this.records;
	}

	/** Directory holding the records, for `/ace`. */
	get directory(): string {
		return this.dir;
	}

	/** Path of this runtime's file; decided on the first record, nothing is written before that. */
	private filePath(): string {
		this.file ??= join(this.dir, `dead-letter.${this.now()}.jsonl`);
		return this.file;
	}

	/** Keep the dead-letter files bounded: age first, then count. */
	private prune(): void {
		const files = readdirSync(this.dir)
			.filter((entry) => entry.startsWith("dead-letter.") && entry.endsWith(".jsonl"))
			.map((entry) => {
				const path = join(this.dir, entry);
				return { path, mtimeMs: statSync(path).mtimeMs };
			})
			.sort((a, b) => b.mtimeMs - a.mtimeMs);

		const cutoff = this.now() - this.retentionMs;
		files.forEach((file, index) => {
			if (file.mtimeMs >= cutoff && index < this.maxFiles) return;
			try {
				rmSync(file.path, { force: true });
			} catch (error) {
				this.onError(error);
			}
		});
	}
}

/** Write and fsync: the caller may only acknowledge once the record is on disk. */
function appendDurably(path: string, content: string): void {
	const fd = openSync(path, "a", 0o600);
	try {
		if (content.length > 0) writeSync(fd, content);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
