import type { AceLogger } from "../logger.ts";
import type { AceMessage } from "../protocol/ace-message.ts";
/** A burst that was written to disk instead of injected event by event. */
export interface SpooledBatch {
    subscription: string;
    path: string;
    /** The events that went into the file, in arrival order. */
    events: readonly AceMessage[];
}
/** One retained `manual` event read back from disk. */
export interface ManualRecord {
    message: AceMessage;
    /** Epoch ms the event was stored, as the record itself says. */
    storedAt: number;
}
/** Per-subscription thresholds: events beyond this in a window are spooled. */
export interface SpoolRule {
    afterEvents: number;
    windowMs: number;
}
/**
 * Burst thresholds used for every subscription: a surge (more than 20 events inside one second) spills to
 * a file and injects one summary instead of 20 turns. Not configuration — the mechanism is a default
 * implementation detail, not a tuning knob.
 */
export declare const DEFAULT_SPOOL_RULE: SpoolRule;
export interface EventSpoolOptions {
    /** Directory for spool files; created with owner-only permissions. */
    dir: string;
    /** Thresholds per subscription; a subscription without a rule is never spooled. */
    rules: (subscription: string) => SpoolRule | undefined;
    /** Delete spool files older than this (default 24h). */
    retentionMs?: number;
    /** Keep at most this many spool files per subscription (default 50). */
    maxFiles?: number;
    /** Called when a window closes, so the host can inject one summary event. */
    onBatch: (batch: SpooledBatch) => void | Promise<void>;
    onError?: (error: unknown) => void;
    logger?: AceLogger;
    /** Injectable clock and timer for tests. */
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => {
        cancel: () => void;
    };
}
/**
 * Turns a burst into one file plus one summary event.
 *
 * A channel that receives far more events than a conversation can absorb would otherwise burn the
 * agent's context (and, for `immediate`, preempt it repeatedly). The first `afterEvents` events of a
 * window are dispatched as usual; the rest are appended to a JSONL file, and when the window closes
 * the host injects a single summary pointing at that file.
 *
 * An event is only acknowledged once its line is on disk (`fsync`), so a crash between injection and
 * flush cannot lose it: the transport redelivers, and the dedup window sees it again.
 */
export declare class EventSpool {
    private readonly dir;
    private readonly rules;
    private readonly retentionMs;
    private readonly maxFiles;
    private readonly onBatch;
    private readonly onError;
    private readonly logger;
    private readonly now;
    private readonly setTimer;
    private readonly windows;
    constructor(options: EventSpoolOptions);
    /**
     * Offer one event to the spool.
     *
     * Resolves with `spooled: false` when the caller should dispatch and acknowledge it normally, or
     * with `spooled: true` (after the flush) when the event went to a file and may be acknowledged.
     */
    offer(subscription: string, message: AceMessage): Promise<{
        spooled: boolean;
        path?: string;
    }>;
    /**
     * Append a retained `manual` event so it survives a restart.
     *
     * The record carries its own `storedAt`; the retainer's clock is not the event's clock.
     */
    appendManual(subscription: string, message: AceMessage): void;
    /**
     * Mark a retained event as delivered, by appending a tombstone.
     *
     * Appending rather than rewriting: activation is a user action taken one event at a time, and rewriting
     * the whole file for each one is both O(n) and non-atomic — a crash mid-rewrite loses every other
     * pending event. The tombstone is compacted away later, in {@link prune}.
     */
    forgetManual(subscription: string, message: AceMessage): void;
    /**
     * Manual events persisted by earlier sessions, oldest first, with tombstones applied.
     *
     * Three line shapes are understood: the current `{storedAt, message}`, a tombstone
     * `{removedSender, removedId}`, and a bare message envelope written before records carried a time (its
     * time is then the file's mtime, which is the closest honest answer available).
     */
    loadManual(subscription: string): ManualRecord[];
    /** Close every open window now (called on shutdown). */
    flush(): Promise<void>;
    /** Open windows, for `/ace stats`. */
    openWindows(): Array<{
        subscription: string;
        buffered: number;
        path: string;
    }>;
    private windowFor;
    private flushWindow;
    /** Write and fsync: an acknowledgement may only follow a durable append. */
    private appendDurably;
    /** Keep one subscription's spool files bounded: age first, then count. */
    private prune;
    /**
     * Bound one subscription's manual file: drop records the tombstones retired and records past the
     * retention window, then rewrite it only when there is enough to gain.
     *
     * Public because it is also the answer for a host that wants to compact on its own schedule; {@link prune}
     * calls it after every flush.
     *
     * A manual file grows by one line per retained event and one per activation, so it is the one file that
     * can only ever get longer; compaction is what makes the tombstone approach bounded.
     */
    pruneManual(subscription: string): void;
    private newFilePath;
    private manualPath;
    private report;
}
//# sourceMappingURL=event-spool.d.ts.map