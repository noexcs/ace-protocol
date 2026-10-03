/**
 * Counters the runtime keeps per channel, so `/ace stats` can answer "is it keeping up?" without
 * scraping logs.
 */
export type AceCounter =
	| "received"
	| "rejected"
	| "deduped"
	| "injected"
	| "queued"
	| "stored"
	| "spooled"
	| "reconnected"
	| "reclaimed"
	| "dropped"
	| "runFailed";

export type AceMetricsSnapshot = Record<string, Partial<Record<AceCounter, number>>>;

/** Mutable counter registry; `scope` is a channel name (or `"runtime"`). */
export class AceMetrics {
	private readonly counters = new Map<string, Map<AceCounter, number>>();

	increment(scope: string, counter: AceCounter, amount = 1): void {
		const scopeCounters = this.counters.get(scope) ?? new Map<AceCounter, number>();
		scopeCounters.set(counter, (scopeCounters.get(counter) ?? 0) + amount);
		this.counters.set(scope, scopeCounters);
	}

	/** Counters grouped by scope, with counter names sorted for stable output. */
	snapshot(): AceMetricsSnapshot {
		const snapshot: AceMetricsSnapshot = {};
		for (const [scope, scopeCounters] of [...this.counters].sort(([a], [b]) => a.localeCompare(b))) {
			const entries = [...scopeCounters].sort(([a], [b]) => a.localeCompare(b));
			snapshot[scope] = Object.fromEntries(entries) as Partial<Record<AceCounter, number>>;
		}
		return snapshot;
	}

	/** One line per scope, e.g. `inbox: received=12 injected=11 deduped=1`. */
	render(): string[] {
		return Object.entries(this.snapshot()).map(
			([scope, counters]) =>
				`${scope}: ${Object.entries(counters)
					.map(([name, value]) => `${name}=${value}`)
					.join(" ")}`,
		);
	}
}
