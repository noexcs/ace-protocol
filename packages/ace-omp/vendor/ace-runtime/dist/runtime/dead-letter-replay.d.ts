import type { DeadLetterRecord } from "./dead-letter.ts";
/** One parsed dead-letter line; `payload` is the raw event, `null` when the entry had no field. */
export type DeadLetterLine = DeadLetterRecord;
export interface ParsedDeadLetters {
    records: DeadLetterLine[];
    /** Lines that were not usable: malformed JSON, or missing the stream/payload a replay needs. */
    skipped: number;
}
export interface ReplayOutcome {
    replayed: number;
    skipped: number;
    failed: Array<{
        stream: string;
        streamEntryId: string;
        error: unknown;
    }>;
}
/**
 * Read a dead-letter file (JSONL, one record per line) into the records a replay can use.
 *
 * Records written by an older runtime — or before a replay existed at all — may lack `stream` or
 * `field`; those lines are skipped rather than guessed at, and counted so the caller can say so.
 */
export declare function parseDeadLetters(content: string): ParsedDeadLetters;
/**
 * Publish the recorded events back to the streams they came from, in file order.
 *
 * The payload is written verbatim: the receiving runtime validates it again, so a replay does not
 * depend on ACE's parser succeeding here. A record whose publish fails is reported and the rest
 * continue — one broken stream must not block the others.
 */
export declare function replayDeadLetters(records: readonly DeadLetterLine[], publish: (stream: string, field: string, payload: string) => Promise<void>): Promise<ReplayOutcome>;
/** One line per stream, for the CLI's summary. */
export declare function summarizeReplay(records: readonly DeadLetterLine[]): string;
//# sourceMappingURL=dead-letter-replay.d.ts.map