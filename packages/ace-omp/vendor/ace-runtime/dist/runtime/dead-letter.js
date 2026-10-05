import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
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
    dir;
    retentionMs;
    maxFiles;
    now;
    logger;
    onError;
    file;
    records = 0;
    constructor(options) {
        this.dir = options.dir;
        this.retentionMs = options.retentionMs ?? 24 * 60 * 60 * 1000;
        this.maxFiles = options.maxFiles ?? 50;
        this.now = options.now ?? (() => Date.now());
        this.logger = options.logger;
        this.onError = options.onError ?? (() => { });
    }
    /** Append one record durably. Throws when the write fails, so the caller keeps the entry pending. */
    async record(subscription, entry) {
        const record = {
            at: this.now(),
            subscription,
            streamEntryId: entry.streamEntryId,
            stream: entry.stream,
            field: entry.field,
            attempts: entry.attempts,
            reason: entry.reason,
            payload: entry.payload ?? null,
        };
        mkdirSync(this.dir, { recursive: true });
        const path = this.filePath();
        appendDurably(path, `${JSON.stringify(record)}\n`);
        this.records += 1;
        this.prune();
        this.logger?.info?.(`[ACE] dead letter subscribe=${subscription} streamEntryId=${entry.streamEntryId} attempts=${entry.attempts} path=${path}`);
    }
    /** Records appended by this runtime, for `/ace`. */
    get count() {
        return this.records;
    }
    /** Directory holding the records, for `/ace`. */
    get directory() {
        return this.dir;
    }
    /** Path of this runtime's file; decided on the first record, nothing is written before that. */
    filePath() {
        this.file ??= join(this.dir, `dead-letter.${this.now()}.jsonl`);
        return this.file;
    }
    /** Keep the dead-letter files bounded: age first, then count. */
    prune() {
        const files = readdirSync(this.dir)
            .filter((entry) => entry.startsWith("dead-letter.") && entry.endsWith(".jsonl"))
            .map((entry) => {
            const path = join(this.dir, entry);
            return { path, mtimeMs: statSync(path).mtimeMs };
        })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
        const cutoff = this.now() - this.retentionMs;
        files.forEach((file, index) => {
            if (file.mtimeMs >= cutoff && index < this.maxFiles)
                return;
            try {
                rmSync(file.path, { force: true });
            }
            catch (error) {
                this.onError(error);
            }
        });
    }
}
/** Write and fsync: the caller may only acknowledge once the record is on disk. */
function appendDurably(path, content) {
    const fd = openSync(path, "a", 0o600);
    try {
        if (content.length > 0)
            writeSync(fd, content);
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
//# sourceMappingURL=dead-letter.js.map