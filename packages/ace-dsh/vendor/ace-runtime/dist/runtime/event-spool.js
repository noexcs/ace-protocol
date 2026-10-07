import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, } from "node:fs";
import { join } from "node:path";
/** How long to wait before retrying a summary whose injection failed (the events are already durable). */
const RETRY_FAILED_BATCH_MS = 5_000;
/** How many records a manual file may hold before it is compacted on the next prune. */
const MANUAL_COMPACT_AFTER = 200;
/**
 * Burst thresholds used for every subscription: a surge (more than 20 events inside one second) spills to
 * a file and injects one summary instead of 20 turns. Not configuration — the mechanism is a default
 * implementation detail, not a tuning knob.
 */
export const DEFAULT_SPOOL_RULE = { afterEvents: 20, windowMs: 1000 };
/** The `(sender, id)` identity a record and its tombstone share. */
function manualKeyOf(value) {
    if (typeof value !== "object" || value === null)
        return undefined;
    const record = value;
    const sender = typeof record.removedSender === "string" ? record.removedSender : undefined;
    const id = typeof record.removedId === "string" ? record.removedId : undefined;
    if (sender !== undefined && id !== undefined)
        return `${sender}\u0000${id}`;
    const message = messageOf(record);
    return message === undefined ? undefined : `${message.sender}\u0000${message.id}`;
}
function isTombstone(value) {
    return typeof value === "object" && value !== null && "removedId" in value;
}
/** The envelope inside a record, or a bare envelope as older files wrote it. */
function messageOf(value) {
    if (typeof value !== "object" || value === null)
        return undefined;
    const record = value;
    const candidate = "message" in record ? record.message : value;
    if (typeof candidate !== "object" || candidate === null)
        return undefined;
    const message = candidate;
    return typeof message.id === "string" && typeof message.sender === "string" ? candidate : undefined;
}
function storedAtOf(value) {
    if (typeof value !== "object" || value === null)
        return undefined;
    const storedAt = value.storedAt;
    return typeof storedAt === "number" && Number.isFinite(storedAt) ? storedAt : undefined;
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
export class EventSpool {
    dir;
    rules;
    retentionMs;
    maxFiles;
    onBatch;
    onError;
    logger;
    now;
    setTimer;
    windows = new Map();
    /** Batches that are on disk but whose summary has not been injected yet. */
    failedBatches = [];
    /** One retry timer at a time, so a run of failures cannot pile up timers. */
    retryTimer;
    constructor(options) {
        this.dir = options.dir;
        this.rules = options.rules;
        this.retentionMs = options.retentionMs ?? 24 * 60 * 60 * 1000;
        this.maxFiles = options.maxFiles ?? 50;
        this.onBatch = options.onBatch;
        this.onError = options.onError ?? (() => { });
        this.logger = options.logger ?? {};
        this.now = options.now ?? (() => Date.now());
        this.setTimer =
            options.setTimer ??
                ((callback, ms) => {
                    const timer = setTimeout(callback, ms);
                    timer.unref?.();
                    return { cancel: () => clearTimeout(timer) };
                });
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
    /**
     * Offer one event to the spool.
     *
     * Resolves with `spooled: false` when the caller should dispatch and acknowledge it normally, or
     * with `spooled: true` (after the flush) when the event went to a file and may be acknowledged.
     */
    async offer(subscription, message) {
        const rule = this.rules(subscription);
        if (!rule)
            return { spooled: false };
        const state = this.windowFor(subscription, rule);
        state.count += 1;
        if (!state.spooling && state.count <= rule.afterEvents)
            return { spooled: false };
        if (!state.spooling) {
            const path = this.newFilePath(subscription);
            state.spooling = { path, events: [], waiters: [] };
            this.logger.info?.(`[ACE] spool started subscribe=${subscription} file=${path}`);
        }
        const spooling = state.spooling;
        return new Promise((resolve, reject) => {
            spooling.events.push(message);
            spooling.waiters.push({ resolve, reject });
        });
    }
    /**
     * Append a retained `manual` event so it survives a restart.
     *
     * The record carries its own `storedAt`; the retainer's clock is not the event's clock.
     */
    appendManual(subscription, message) {
        this.appendDurably(this.manualPath(subscription), `${JSON.stringify({ storedAt: this.now(), message })}\n`);
    }
    /**
     * Mark a retained event as delivered, by appending a tombstone.
     *
     * Appending rather than rewriting: activation is a user action taken one event at a time, and rewriting
     * the whole file for each one is both O(n) and non-atomic — a crash mid-rewrite loses every other
     * pending event. The tombstone is compacted away later, in {@link prune}.
     */
    forgetManual(subscription, message) {
        try {
            this.appendDurably(this.manualPath(subscription), `${JSON.stringify({ removedSender: message.sender, removedId: message.id, at: this.now() })}\n`);
        }
        catch (error) {
            // The event is already injected; failing to mark it is a duplicate risk on the next restart, which
            // is worth reporting but not worth failing the activation over.
            this.report(error);
        }
    }
    /**
     * Manual events persisted by earlier sessions, oldest first, with tombstones applied.
     *
     * Three line shapes are understood: the current `{storedAt, message}`, a tombstone
     * `{removedSender, removedId}`, and a bare message envelope written before records carried a time (its
     * time is then the file's mtime, which is the closest honest answer available).
     */
    loadManual(subscription) {
        const path = this.manualPath(subscription);
        let content;
        try {
            content = readFileSync(path, "utf8");
        }
        catch {
            return [];
        }
        let fallbackAt = this.now();
        try {
            fallbackAt = statSync(path).mtimeMs;
        }
        catch {
            // Keep the clock at hand; the file is readable but its mtime is not, which is odd but harmless.
        }
        const records = [];
        const removed = new Set();
        for (const line of content.split("\n")) {
            if (line.trim().length === 0)
                continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                this.report(new Error(`ignoring malformed line in ${path}`));
                continue;
            }
            const key = manualKeyOf(parsed);
            if (key !== undefined && isTombstone(parsed)) {
                removed.add(key);
                const index = records.findIndex((record) => manualKeyOf(record.message) === key);
                if (index !== -1)
                    records.splice(index, 1);
                continue;
            }
            const message = messageOf(parsed);
            if (message === undefined) {
                this.report(new Error(`ignoring unrecognised line in ${path}`));
                continue;
            }
            if (key !== undefined && removed.has(key))
                continue;
            records.push({ message, storedAt: storedAtOf(parsed) ?? fallbackAt });
        }
        return records;
    }
    /** Close every open window now (called on shutdown). */
    async flush() {
        await this.retryFailedBatches();
        for (const subscription of [...this.windows.keys()])
            await this.flushWindow(subscription);
    }
    /** Open windows, for `/ace stats`. */
    openWindows() {
        const open = [];
        for (const [subscription, state] of this.windows) {
            if (state.spooling) {
                open.push({ subscription, buffered: state.spooling.events.length, path: state.spooling.path });
            }
        }
        return open;
    }
    windowFor(subscription, rule) {
        const now = this.now();
        let state = this.windows.get(subscription);
        if (!state || now - state.windowStart >= rule.windowMs) {
            state?.timer?.cancel();
            state = { windowStart: now, count: 0, spooling: undefined };
            state.timer = this.setTimer(() => void this.flushWindow(subscription), rule.windowMs);
            this.windows.set(subscription, state);
        }
        return state;
    }
    async flushWindow(subscription) {
        const state = this.windows.get(subscription);
        this.windows.delete(subscription);
        state?.timer?.cancel();
        const spooling = state?.spooling;
        if (!state || !spooling)
            return;
        const batch = { subscription, path: spooling.path, events: spooling.events };
        try {
            const lines = spooling.events.map((message) => `${JSON.stringify(message)}\n`).join("");
            this.appendDurably(spooling.path, lines);
        }
        catch (error) {
            // Nothing reached the disk, so the transport must redeliver: this is the one failure that rejects.
            this.report(error);
            for (const waiter of spooling.waiters)
                waiter.reject(error);
            return;
        }
        // The events are durable, so the delivery contract is already met — acknowledging is safe even when the
        // summary cannot be injected yet. Redelivering instead would inject the same events twice: once
        // individually (the redelivered event is no longer seen as spooled) and once from the file. The summary
        // is retried until it lands instead.
        const delivered = await this.deliverBatch(batch);
        if (!delivered) {
            this.failedBatches.push(batch);
            this.scheduleRetry();
        }
        for (const waiter of spooling.waiters)
            waiter.resolve({ spooled: true, path: spooling.path });
    }
    /** Inject one batch's summary. Returns whether it landed; a failure is reported, never thrown. */
    async deliverBatch(batch) {
        try {
            await this.onBatch(batch);
            this.prune(batch.subscription);
            this.logger.info?.(`[ACE] spool flushed subscribe=${batch.subscription} events=${batch.events.length}`);
            return true;
        }
        catch (error) {
            this.report(error);
            return false;
        }
    }
    /** Retry every batch whose summary has not landed yet. */
    async retryFailedBatches() {
        if (this.failedBatches.length === 0)
            return;
        const pending = this.failedBatches.splice(0);
        for (const batch of pending) {
            if (await this.deliverBatch(batch))
                continue;
            this.failedBatches.push(batch);
            this.scheduleRetry();
        }
    }
    /** One retry timer at a time, so a run of failures cannot pile up timers. */
    scheduleRetry() {
        this.retryTimer?.cancel();
        this.retryTimer = this.setTimer(() => {
            this.retryTimer = undefined;
            void this.retryFailedBatches();
        }, RETRY_FAILED_BATCH_MS);
    }
    /** Write and fsync: an acknowledgement may only follow a durable append. */
    appendDurably(path, content) {
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
    /** Keep one subscription's spool files bounded: age first, then count. */
    prune(subscription) {
        const prefix = `${subscription}.`;
        const files = readdirSync(this.dir)
            .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".jsonl"))
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
                this.report(error);
            }
        });
        this.pruneManual(subscription);
    }
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
    pruneManual(subscription) {
        const path = this.manualPath(subscription);
        let content;
        try {
            content = readFileSync(path, "utf8");
        }
        catch {
            return;
        }
        const lines = content.split("\n").filter((line) => line.trim().length > 0);
        if (lines.length <= MANUAL_COMPACT_AFTER)
            return;
        const cutoff = this.now() - this.retentionMs;
        const kept = this.loadManual(subscription).filter((record) => record.storedAt >= cutoff);
        try {
            const rewritten = kept.map((record) => `${JSON.stringify(record)}\n`).join("");
            writeFileSync(path, rewritten, { mode: 0o600 });
            this.logger.info?.(`[ACE] compacted manual subscribe=${subscription} lines=${lines.length} kept=${kept.length}`);
        }
        catch (error) {
            this.report(error);
        }
    }
    newFilePath(subscription) {
        return join(this.dir, `${subscription}.${this.now()}.jsonl`);
    }
    manualPath(subscription) {
        return join(this.dir, `manual-${subscription}.jsonl`);
    }
    report(error) {
        try {
            this.onError(error);
        }
        catch {
            // A failing error hook must not break the spool.
        }
    }
}
//# sourceMappingURL=event-spool.js.map