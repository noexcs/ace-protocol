/** Mutable counter registry; `scope` is a channel name (or `"runtime"`). */
export class AceMetrics {
    counters = new Map();
    increment(scope, counter, amount = 1) {
        const scopeCounters = this.counters.get(scope) ?? new Map();
        scopeCounters.set(counter, (scopeCounters.get(counter) ?? 0) + amount);
        this.counters.set(scope, scopeCounters);
    }
    /** Counters grouped by scope, with counter names sorted for stable output. */
    snapshot() {
        const snapshot = {};
        for (const [scope, scopeCounters] of [...this.counters].sort(([a], [b]) => a.localeCompare(b))) {
            const entries = [...scopeCounters].sort(([a], [b]) => a.localeCompare(b));
            snapshot[scope] = Object.fromEntries(entries);
        }
        return snapshot;
    }
    /** One line per scope, e.g. `inbox: received=12 injected=11 deduped=1`. */
    render() {
        return Object.entries(this.snapshot()).map(([scope, counters]) => `${scope}: ${Object.entries(counters)
            .map(([name, value]) => `${name}=${value}`)
            .join(" ")}`);
    }
}
//# sourceMappingURL=metrics.js.map