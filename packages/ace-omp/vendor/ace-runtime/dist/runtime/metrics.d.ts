/**
 * Counters the runtime keeps per channel, so `/ace stats` can answer "is it keeping up?" without
 * scraping logs.
 */
export type AceCounter = "received" | "rejected" | "deduped" | "injected" | "queued" | "stored" | "spooled" | "reconnected" | "reclaimed" | "dropped" | "runFailed";
export type AceMetricsSnapshot = Record<string, Partial<Record<AceCounter, number>>>;
/** Mutable counter registry; `scope` is a channel name (or `"runtime"`). */
export declare class AceMetrics {
    private readonly counters;
    increment(scope: string, counter: AceCounter, amount?: number): void;
    /** Counters grouped by scope, with counter names sorted for stable output. */
    snapshot(): AceMetricsSnapshot;
    /** One line per scope, e.g. `inbox: received=12 injected=11 deduped=1`. */
    render(): string[];
}
//# sourceMappingURL=metrics.d.ts.map