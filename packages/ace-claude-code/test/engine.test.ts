import type { AceMessage, InjectionMode } from "ace-runtime";
import { describe, expect, it } from "vitest";
import { ClaudeCodeEngine } from "../src/engine.ts";

const message: AceMessage = {
	aceVersion: "0.1",
	id: "evt_1",
	sender: "ci",
	activation: "next_turn",
	body: "build failed",
};

/**
 * A controllable clock: tests decide when the observation timeout fires. No real timers. `fire`
 * awaits microtasks until the named timer is armed (the engine arms it inside `awaitObservation`,
 * after the awaited push resolves), then fires it — deterministic, no wall-clock.
 */
function controllableTimer() {
	const timers = new Map<number, () => void>();
	const armResolvers: Record<number, Array<() => void>> = {};
	let next = 0;
	return {
		setTimeout: (callback: () => void, _ms: number) => {
			next += 1;
			timers.set(next, callback);
			const resolvers = armResolvers[next] ?? [];
			armResolvers[next] = [];
			for (const resolve of resolvers) resolve();
			return {
				cancel: () => {
					timers.delete(next);
				},
			};
		},
		/** Await until the `n`th timer is armed (1-based), then fire it. */
		fire: async (n: number) => {
			if (!timers.has(n)) {
				const { promise, resolve } = Promise.withResolvers<void>();
				armResolvers[n] = [...(armResolvers[n] ?? []), resolve];
				await promise;
			}
			const callback = timers.get(n);
			timers.delete(n);
			callback?.();
		},
	};
}

interface FakeObserver {
	waiters: { message: AceMessage; resolve: () => void }[];
	observe: (message: AceMessage, rendered?: string) => Promise<void>;
	release: (message: AceMessage, rendered?: string) => void;
}

/** An observer that resolves `observe()` only when the test resolves the waiter. Structurally a DeliveryObserver. */
function fakeObserver(): FakeObserver {
	const waiters: { message: AceMessage; resolve: () => void }[] = [];
	return {
		waiters,
		observe: (message: AceMessage) => new Promise<void>((resolve) => waiters.push({ message, resolve })),
		release: (message: AceMessage) => {
			const index = waiters.findIndex((w) => w.message === message);
			if (index !== -1) waiters.splice(index, 1);
		},
	};
}

describe("ClaudeCodeEngine", () => {
	it("pushes the rendered event and resolves once it is observed", async () => {
		const observer = fakeObserver();
		const clock = controllableTimer();
		const pushed: string[] = [];
		const engine = new ClaudeCodeEngine({
			push: async (content) => void pushed.push(content),
			observer,
			setTimer: (callback, ms) => clock.setTimeout(callback, ms),
		});
		const injected = engine.inject(message, "next_turn");
		// The observer holds the exact message and the exact text we will push.
		expect(observer.waiters).toHaveLength(1);
		expect(observer.waiters[0].message).toBe(message);
		observer.waiters[0].resolve();
		await injected;
		expect(pushed).toHaveLength(1);
		expect(pushed[0]).toContain("<ace_event>");
		expect(pushed[0]).toContain("build failed");
	});

	it("times out and throws when the event is never observed", async () => {
		const observer = fakeObserver();
		const clock = controllableTimer();
		const engine = new ClaudeCodeEngine({
			push: async () => {},
			observer,
			ackTimeoutMs: 1000,
			setTimer: (callback, ms) => clock.setTimeout(callback, ms),
		});
		const injected = engine.inject(message, "next_turn");
		// Fire the only armed timer; the observation never resolves, so the wait must time out.
		await clock.fire(1);
		await expect(injected).rejects.toThrow(/not observed in the conversation within 1000ms/);
	});

	it("releases the observation when the push itself fails", async () => {
		const observer = fakeObserver();
		let released = 0;
		const engine = new ClaudeCodeEngine({
			push: async () => {
				throw new Error("push failed");
			},
			observer: {
				...observer,
				release: () => {
					released += 1;
				},
			},
			setTimer: (callback, ms) => controllableTimer().setTimeout(callback, ms),
		});
		await expect(engine.inject(message, "next_turn")).rejects.toThrow("push failed");
		expect(released).toBe(1);
	});

	it("never reports a turn as running, and idle resolves immediately", async () => {
		const clock = controllableTimer();
		const engine = new ClaudeCodeEngine({
			push: async () => {},
			observer: fakeObserver(),
			setTimer: (callback, ms) => clock.setTimeout(callback, ms),
		});
		expect(engine.isRunning()).toBe(false);
		await expect(engine.waitForIdle()).resolves.toBeUndefined();
	});
});

/** The host cannot splice mid-turn: `immediate` and `next_turn` are pushed byte-for-byte the same. */
describe("activation collapse on the channel", () => {
	it("pushes identical content for immediate and next_turn", async () => {
		const pushed: Record<string, string> = {};
		for (const mode of ["immediate", "next_turn"] as InjectionMode[]) {
			const observer = fakeObserver();
			const clock = controllableTimer();
			const engine = new ClaudeCodeEngine({
				push: async (content) => {
					pushed[mode] = content;
				},
				observer,
				setTimer: (callback, ms) => clock.setTimeout(callback, ms),
			});
			const injected = engine.inject(message, mode);
			observer.waiters[0].resolve();
			await injected;
		}
		expect(pushed.immediate).toBe(pushed.next_turn);
	});
});
