import { afterEach, describe, expect, it } from "vitest";
import type { DeliveryObserver } from "../../src/agent/event-delivery-observer.ts";
import { renderAceEvent } from "../../src/agent/pi-adapter.ts";
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

/** Observer that resolves only when the test says so. */
class ControllableObserver implements DeliveryObserver {
	readonly observed: AceMessage[] = [];
	readonly released: AceMessage[] = [];
	private resolveCurrent?: () => void;

	observe(message: AceMessage): Promise<void> {
		this.observed.push(message);
		return new Promise((resolve) => {
			this.resolveCurrent = resolve;
		});
	}

	release(message: AceMessage): void {
		this.released.push(message);
	}

	deliver(): void {
		this.resolveCurrent?.();
	}
}

function setup(
	options: {
		idle?: boolean;
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
		isIdle: () => options.idle ?? true,
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

	it("fails the injection when the event never arrives, so the entry stays pending", async () => {
		const observer = new ControllableObserver();
		const timer = new ManualTimer();
		const { adapter } = setup({ observer, timer, idle: true, supportsAside: true });

		const injecting = adapter.inject(event, "next_turn");
		await Promise.resolve();
		expect(timer.armed).toBe(true);

		timer.fire();

		await expect(injecting).rejects.toThrow(/was not observed in the conversation/);
		expect(observer.released).toEqual([event]);
	});

	it("releases the observation and rethrows when the host refuses the message", async () => {
		const observer = new ControllableObserver();
		const { pi, adapter } = setup({ observer, idle: true, supportsAside: true });
		pi.fail = new Error("session is shutting down");

		await expect(adapter.inject(event, "next_turn")).rejects.toThrow("session is shutting down");

		expect(observer.released).toEqual([event]);
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
