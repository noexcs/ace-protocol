import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import type { AceLogger } from "../logger.ts";
import type { AceMessage } from "../protocol/ace-message.ts";

/** A burst that was written to disk instead of injected event by event. */
export interface SpooledBatch {
	subscription: string;
	path: string;
	/** The events that went into the file, in arrival order. */
	events: readonly AceMessage[];
}

/** Per-subscription thresholds: events beyond this in a window are spooled. */
export interface SpoolRule {
	afterEvents: number;
	windowMs: number;
}

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
	setTimer?: (callback: () => void, ms: number) => { cancel: () => void };
}

interface Waiter {
	resolve: (outcome: { spooled: boolean; path?: string }) => void;
	reject: (error: unknown) => void;
}

interface WindowState {
	windowStart: number;
	count: number;
	timer?: { cancel: () => void };
	spooling: { path: string; events: AceMessage[]; waiters: Waiter[] } | undefined;
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
	private readonly dir: string;
	private readonly rules: (subscription: string) => SpoolRule | undefined;
	private readonly retentionMs: number;
	private readonly maxFiles: number;
	private readonly onBatch: (batch: SpooledBatch) => void | Promise<void>;
	private readonly onError: (error: unknown) => void;
	private readonly logger: AceLogger;
	private readonly now: () => number;
	private readonly setTimer: (callback: () => void, ms: number) => { cancel: () => void };
	private readonly windows = new Map<string, WindowState>();

	constructor(options: EventSpoolOptions) {
		this.dir = options.dir;
		this.rules = options.rules;
		this.retentionMs = options.retentionMs ?? 24 * 60 * 60 * 1000;
		this.maxFiles = options.maxFiles ?? 50;
		this.onBatch = options.onBatch;
		this.onError = options.onError ?? (() => {});
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
	async offer(subscription: string, message: AceMessage): Promise<{ spooled: boolean; path?: string }> {
		const rule = this.rules(subscription);
		if (!rule) return { spooled: false };

		const state = this.windowFor(subscription, rule);
		state.count += 1;

		if (!state.spooling && state.count <= rule.afterEvents) return { spooled: false };
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
	appendManual(subscription: string, message: AceMessage): void {
		this.appendDurably(this.manualPath(subscription), `${JSON.stringify(message)}\n`);
	}

	/** Manual events persisted by earlier sessions, oldest first. */
	loadManual(subscription: string): AceMessage[] {
		const path = this.manualPath(subscription);
		let content: string;
		try {
			content = readFileSync(path, "utf8");
		} catch {
			return [];
		}

		const messages: AceMessage[] = [];
		for (const line of content.split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				messages.push(JSON.parse(line) as AceMessage);
			} catch {
				this.report(new Error(`ignoring malformed line in ${path}`));
			}
		}
		return messages;
	}

	/** Close every open window now (called on shutdown). */
	async flush(): Promise<void> {
		for (const subscription of [...this.windows.keys()]) await this.flushWindow(subscription);
	}

	/** Open windows, for `/ace stats`. */
	openWindows(): Array<{ subscription: string; buffered: number; path: string }> {
		const open: Array<{ subscription: string; buffered: number; path: string }> = [];
		for (const [subscription, state] of this.windows) {
			if (state.spooling) {
				open.push({ subscription, buffered: state.spooling.events.length, path: state.spooling.path });
			}
		}
		return open;
	}

	private windowFor(subscription: string, rule: SpoolRule): WindowState {
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

	private async flushWindow(subscription: string): Promise<void> {
		const state = this.windows.get(subscription);
		this.windows.delete(subscription);
		state?.timer?.cancel();
		const spooling = state?.spooling;
		if (!state || !spooling) return;

		try {
			const lines = spooling.events.map((message) => `${JSON.stringify(message)}\n`).join("");
			this.appendDurably(spooling.path, lines);
			await this.onBatch({ subscription, path: spooling.path, events: spooling.events });
			this.prune(subscription);
			this.logger.info?.(`[ACE] spool flushed subscribe=${subscription} events=${spooling.events.length}`);
			for (const waiter of spooling.waiters) waiter.resolve({ spooled: true, path: spooling.path });
		} catch (error) {
			// Not acknowledged on purpose: the transport redelivers, so nothing is silently lost.
			this.report(error);
			for (const waiter of spooling.waiters) waiter.reject(error);
		}
	}

	/** Write and fsync: an acknowledgement may only follow a durable append. */
	private appendDurably(path: string, content: string): void {
		const fd = openSync(path, "a", 0o600);
		try {
			if (content.length > 0) writeSync(fd, content);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}

	/** Keep one subscription's spool files bounded: age first, then count. */
	private prune(subscription: string): void {
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
			if (file.mtimeMs >= cutoff && index < this.maxFiles) return;
			try {
				rmSync(file.path, { force: true });
			} catch (error) {
				this.report(error);
			}
		});
	}

	private newFilePath(subscription: string): string {
		return join(this.dir, `${subscription}.${this.now()}.jsonl`);
	}

	private manualPath(subscription: string): string {
		return join(this.dir, `manual-${subscription}.jsonl`);
	}

	private report(error: unknown): void {
		try {
			this.onError(error);
		} catch {
			// A failing error hook must not break the spool.
		}
	}
}
