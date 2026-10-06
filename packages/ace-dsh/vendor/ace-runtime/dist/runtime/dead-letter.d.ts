import type { AceLogger } from "../logger.ts";
import type { DroppedEntry } from "../transport/redis-streams-transport.ts";
/** One line of the dead-letter file: the last copy of an event nobody could deliver. */
export interface DeadLetterRecord {
    /** When the transport gave up, epoch ms. */
    at: number;
    /** Channel the event arrived on. */
    subscription: string;
    /** Stream entry id, to trace it back to the stream. */
    streamEntryId: string;
    /** Stream it came from; `replay:dead-letters` publishes back here. */
    stream: string;
    /** Field the payload was stored under, so a replay writes the same shape. */
    field: string;
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
export declare class DeadLetterSink {
    private readonly dir;
    private readonly retentionMs;
    private readonly maxFiles;
    private readonly now;
    private readonly logger;
    private readonly onError;
    private file;
    private records;
    constructor(options: DeadLetterSinkOptions);
    /** Append one record durably. Throws when the write fails, so the caller keeps the entry pending. */
    record(subscription: string, entry: DroppedEntry): Promise<void>;
    /** Records appended by this runtime, for `/ace`. */
    get count(): number;
    /** Directory holding the records, for `/ace`. */
    get directory(): string;
    /** Path of this runtime's file; decided on the first record, nothing is written before that. */
    private filePath;
    /** Keep the dead-letter files bounded: age first, then count. */
    private prune;
}
//# sourceMappingURL=dead-letter.d.ts.map