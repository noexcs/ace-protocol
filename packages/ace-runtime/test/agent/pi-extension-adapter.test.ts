import { afterEach, describe, expect, it } from "vitest";
import type { DeliveryObserver } from "../../src/agent/event-delivery-observer.ts";
import { renderAceEvent } from "../../src/agent/event-rendering.ts";
import {
	type DeliverAs,
	detectHostDelivery,
	type ExtensionMessageApi,
	PiExtensionAdapter,
} from "../../src/agent/pi-extension-adapter.ts";
import type { AceMessage } from "../../src/protocol/ace-message.ts";

const event: AceMessage = {
	aceVersion: "0.1",
	id: "evt_001",
	sender: "build-service",
	activation: "next_turn",
	body: "Build failed for project foo.",
};

class FakePi implements ExtensionMessageApi {
	readonly sent: Array<{ content: string; options: { deliverAs?: DeliverAs } | undefined }> = [];
	fail?: Error;

	sendUserMessage(content: string, options?: { deliverAs?: DeliverAs }): void {
		if (this.fail) throw this.fail;
		this.sent.push({ content, options });
	}
}

/** Timer the adapter's delivery wait uses; tests fire timeouts by hand. */
class ManualTimer {
	private callbacks: Array<() => void> = [];

	setTimer = (callback: () => void, _ms: number): { cancel: () => void } => {
		this.callbacks.push(callback);
		return {
			cancel: () => {
				this.callbacks = this.callbacks.filter((entry) => entry !== callback);
			},
		};
	};

	fire(): void {
		const callbacks = this.callbacks;
		this.callbacks = [];
		for (const callback of callbacks) callback();
	}

	get armed(): boolean {
		return this.callbacks.length > 0;
	}
}

/** Observer that resolves only when the test says so; keeps every pending waiter. */
class ControllableObserver implements DeliveryObserver {
	readonly observed: AceMessage[] = [];
	readonly released: AceMessage[] = [];
	private readonly waiters: Array<() => void> = [];

	observe(message: AceMessage): Promise<void> {
		this.observed.push(message);
		const { promise, resolve } = Promise.withResolvers<void>();
		this.waiters.push(resolve);
		return promise;
	}

	release(message: AceMessage): void {
		this.released.push(message);
	}

	/** Resolve every pending observation at once, the way the host echoes a delivered message. */
	deliver(): void {
		for (const resolve of this.waiters.splice(0)) resolve();
	}
}

function setup(
	options: {
		idle?: boolean;
		/** A mutable idle probe, for a test that changes the agent state between calls. */
		isIdle?: () => boolean;
		supportsAside?: boolean;
		observer?: DeliveryObserver;
		timer?: ManualTimer;
		renderEvent?: (message: AceMessage) => string;
	} = {},
) {
	const pi = new FakePi();
	const timer = options.timer ?? new ManualTimer();
	const adapter = new PiExtensionAdapter({
		pi,
		isIdle: options.isIdle ?? (() => options.idle ?? true),
		host: { supportsAside: options.supportsAside ?? false },
		setTimer: timer.setTimer,
		...(options.observer ? { observeDelivery: options.observer } : {}),
		...(options.renderEvent ? { renderEvent: options.renderEvent } : {}),
	});
	return { pi, adapter, timer };
}

describe("PiExtensionAdapter delivery", () => {
	// The hosts disagree here, and the difference is invisible in their types: upstream Pi starts a
	// turn for any `sendUserMessage`, oh-my-pi queues `steer`/`followUp` and returns (an idle session
	// then never drains it). Hence: no `deliverAs` on an idle agent, and `aside` where it exists.
	it.each<[string, "next_turn" | "immediate", boolean, boolean, DeliverAs | undefined]>([
		["next_turn, idle, upstream Pi", "next_turn", true, false, undefined],
		["next_turn, running, upstream Pi", "next_turn", false, false, "followUp"],
		["next_turn, idle, oh-my-pi", "next_turn", true, true, "aside"],
		["next_turn, running, oh-my-pi", "next_turn", false, true, "aside"],
		["immediate, idle, upstream Pi", "immediate", true, false, undefined],
		["immediate, running, upstream Pi", "immediate", false, false, "steer"],
		["immediate, idle, oh-my-pi", "immediate", true, true, undefined],
		["immediate, running, oh-my-pi", "immediate", false, true, "steer"],
	])("%s → %s", async (_name, mode, idle, supportsAside, expected) => {
		const { pi, adapter } = setup({ idle, supportsAside });

		await adapter.inject({ ...event, activation: mode }, mode);

		expect(pi.sent[0]?.content).toBe(renderAceEvent({ ...event, activation: mode }));
		expect(pi.sent[0]?.options?.deliverAs).toBe(expected);
	});

	it("reports the running state from the idle probe", () => {
		expect(setup({ idle: false }).adapter.isRunning()).toBe(true);
		expect(setup({ idle: true }).adapter.isRunning()).toBe(false);
	});

	it("honours a custom renderer", async () => {
		const { pi, adapter } = setup({ renderEvent: (message) => `ACE:${message.body}` });

		await adapter.inject(event, "next_turn");

		expect(pi.sent[0]?.content).toBe("ACE:Build failed for project foo.");
	});

	it("resolves immediately even while a turn runs", async () => {
		const { adapter } = setup({ idle: false });
		await expect(adapter.waitForIdle()).resolves.toBeUndefined();
	});
});

describe("PiExtensionAdapter idempotent injection", () => {
	it("sends the same identity once and re-waits for the observation on the second call", async () => {
		// The regression that shipped in 0.2.13: the live path (this adapter) had no identity check, so
		// a broker redelivery called `sendUserMessage` again and the agent saw the block 2–4 times.
		const observer = new ControllableObserver();
		const { pi, adapter } = setup({ observer, idle: true, supportsAside: true });
		const context = { subscription: "inbox" };

		const first = adapter.inject(event, "next_turn", context);
		await Promise.resolve();
		// The first delivery is still waiting; the broker redelivers the same entry.
		const second = adapter.inject(event, "next_turn", context);
		await Promise.resolve();

		expect(pi.sent).toHaveLength(1);
		// Two waiters: the redelivery re-attached to the observation instead of re-sending.
		expect(observer.observed).toEqual([event, event]);

		observer.deliver();
		await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
		expect(pi.sent).toHaveLength(1);
	});

	it("resolves a redelivery immediately when the event already surfaced", async () => {
		const observer = new ControllableObserver();
		const { pi, adapter } = setup({ observer, idle: true, supportsAside: true });

		const first = adapter.inject(event, "next_turn");
		await Promise.resolve();
		observer.deliver();
		await first;

		await expect(adapter.inject(event, "next_turn")).resolves.toBeUndefined();
		expect(pi.sent).toHaveLength(1);
	});

	it("re-waits a redelivery under the original delivery's rule, not the current agent state", async () => {
		// The first send was queued (`aside` while running), so its wait had no wall clock. If the agent
		// goes idle before the broker redelivers, a freshly computed rule would call this a bounded path and
		// arm a timer the original delivery never had; the recorded rule must win.
		const observer = new ControllableObserver();
		const timer = new ManualTimer();
		let idle = false;
		const { pi, adapter } = setup({ observer, timer, isIdle: () => idle, supportsAside: true });

		const first = adapter.inject(event, "next_turn");
		await Promise.resolve();
		expect(pi.sent[0]?.options?.deliverAs).toBe("aside");
		expect(timer.armed).toBe(false);

		idle = true;
		const second = adapter.inject(event, "next_turn");
		await Promise.resolve();
		expect(pi.sent).toHaveLength(1);
		expect(timer.armed).toBe(false);

		observer.deliver();
		await Promise.all([first, second]);
	});

	it("sends two events that share a body but have different ids", async () => {
		const observer = new ControllableObserver();
		const { pi, adapter } = setup({ observer, idle: true, supportsAside: true });
		const first: AceMessage = { ...event, id: "evt_1", body: "same body" };
		const second: AceMessage = { ...event, id: "evt_2", body: "same body" };

		const a = adapter.inject(first, "next_turn");
		const b = adapter.inject(second, "next_turn");
		await Promise.resolve();

		expect(pi.sent).toHaveLength(2);
		observer.deliver();
		await Promise.all([a, b]);
	});

	it("sends the same id on two subscriptions as two deliveries", async () => {
		// Per-subscription dedup (RFC §17): the subscription is part of the identity, so an event published
		// to two channels this session reads reaches it twice.
		const observer = new ControllableObserver();
		const { pi, adapter } = setup({ observer, idle: true, supportsAside: true });

		const a = adapter.inject(event, "next_turn", { subscription: "inbox" });
		const b = adapter.inject(event, "next_turn", { subscription: "team" });
		await Promise.resolve();

		expect(pi.sent).toHaveLength(2);
		observer.deliver();
		await Promise.all([a, b]);
	});
});

describe("PiExtensionAdapter observed delivery", () => {
	it("does not resolve before the event shows up in the conversation", async () => {
		const observer = new ControllableObserver();
		const { adapter } = setup({ observer, idle: true, supportsAside: true });

		let settled = false;
		const injecting = adapter.inject(event, "next_turn").then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(observer.observed).toEqual([event]);
		expect(settled).toBe(false);

		observer.deliver();
		await injecting;
		expect(settled).toBe(true);
	});

	it("keeps waiting without a wall clock on the queued (aside) path", async () => {
		// A queued delivery surfaces at the next step boundary, and a model turn can last minutes: its
		// surface time is not knowable, so a 30s wall clock would fail a delivery that already succeeded.
		const observer = new ControllableObserver();
		const timer = new ManualTimer();
		const { adapter } = setup({ observer, timer, idle: true, supportsAside: true });

		const injecting = adapter.inject(event, "next_turn");
		await Promise.resolve();

		// No timer was armed (deterministic — `ManualTimer` only fires when told), so nothing can throw
		// on a wall clock while the observation is pending.
		expect(timer.armed).toBe(false);
		expect(observer.observed).toEqual([event]);

		observer.deliver();
		await expect(injecting).resolves.toBeUndefined();
	});

	it("fails the bounded (steer) path when the event never arrives, so the entry stays pending", async () => {
		const observer = new ControllableObserver();
		const timer = new ManualTimer();
		const { adapter } = setup({ observer, timer, idle: false, supportsAside: true });

		const injecting = adapter.inject(event, "immediate");
		await Promise.resolve();
		expect(timer.armed).toBe(true);

		timer.fire();

		await expect(injecting).rejects.toThrow(/was not observed in the conversation/);
		expect(observer.released).toEqual([event]);
	});

	it("fails the bounded prompt path when the event never arrives", async () => {
		const observer = new ControllableObserver();
		const timer = new ManualTimer();
		const { adapter } = setup({ observer, timer, idle: true, supportsAside: false });

		const injecting = adapter.inject(event, "next_turn");
		await Promise.resolve();
		expect(timer.armed).toBe(true);

		timer.fire();

		await expect(injecting).rejects.toThrow(/was not observed in the conversation/);
	});

	it("releases the observation and rethrows when the host refuses the message", async () => {
		const observer = new ControllableObserver();
		const { pi, adapter } = setup({ observer, idle: true, supportsAside: true });
		pi.fail = new Error("session is shutting down");

		await expect(adapter.inject(event, "next_turn")).rejects.toThrow("session is shutting down");

		expect(observer.released).toEqual([event]);
		// A refused send is not "handed to the host": the redelivery must reach `sendUserMessage` again.
		await expect(adapter.inject(event, "next_turn")).rejects.toThrow("session is shutting down");
	});

	it("keeps resolving on hand-off alone when no observer is wired", async () => {
		const { pi, adapter } = setup({ idle: true, supportsAside: true });

		await expect(adapter.inject(event, "next_turn")).resolves.toBeUndefined();

		expect(pi.sent).toHaveLength(1);
	});
});

describe("detectHostDelivery", () => {
	afterEach(() => {
		delete process.env.ACE_DELIVERY;
	});

	it("reads oh-my-pi's SDK self-reference as aside support", () => {
		expect(detectHostDelivery({ pi: {} }).supportsAside).toBe(true);
	});

	it("reads upstream Pi's extension API as portable delivery", () => {
		expect(detectHostDelivery({ sendUserMessage: () => {} }).supportsAside).toBe(false);
		expect(detectHostDelivery(undefined).supportsAside).toBe(false);
	});

	it("lets ACE_DELIVERY override the probe", () => {
		process.env.ACE_DELIVERY = "portable";
		expect(detectHostDelivery({ pi: {} }).supportsAside).toBe(false);

		process.env.ACE_DELIVERY = "aside";
		expect(detectHostDelivery({}).supportsAside).toBe(true);
	});
});
