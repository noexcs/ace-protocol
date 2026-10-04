import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync, } from "node:fs";
import { join } from "node:path";
/**
 * Burst thresholds used for every subscription: a surge (more than 20 events inside one second) spills to
 * a file and injects one summary instead of 20 turns. Not configuration — the mechanism is a default
 * implementation detail, not a tuning knob.
 */
export const DEFAULT_SPOOL_RULE = { afterEvents: 20, windowMs: 1000 };
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
    /** Append a retained `manual` event so it survives a restart. */
    appendManual(subscription, message) {
        this.appendDurably(this.manualPath(subscription), `${JSON.stringify(message)}\n`);
    }
    /** Manual events persisted by earlier sessions, oldest first. */
    loadManual(subscription) {
        const path = this.manualPath(subscription);
        let content;
        try {
            content = readFileSync(path, "utf8");
        }
        catch {
            return [];
        }
        const messages = [];
        for (const line of content.split("\n")) {
            if (line.trim().length === 0)
                continue;
            try {
                messages.push(JSON.parse(line));
            }
            catch {
                this.report(new Error(`ignoring malformed line in ${path}`));
            }
        }
        return messages;
    }
    /** Close every open window now (called on shutdown). */
    async flush() {
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
        try {
            const lines = spooling.events.map((message) => `${JSON.stringify(message)}\n`).join("");
            this.appendDurably(spooling.path, lines);
            await this.onBatch({ subscription, path: spooling.path, events: spooling.events });
            this.prune(subscription);
            this.logger.info?.(`[ACE] spool flushed subscribe=${subscription} events=${spooling.events.length}`);
            for (const waiter of spooling.waiters)
                waiter.resolve({ spooled: true, path: spooling.path });
        }
        catch (error) {
            // Not acknowledged on purpose: the transport redelivers, so nothing is silently lost.
            this.report(error);
            for (const waiter of spooling.waiters)
                waiter.reject(error);
        }
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