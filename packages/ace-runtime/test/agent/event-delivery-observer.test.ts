import { describe, expect, it } from "vitest";
import { AceDeliveryObserver } from "../../src/agent/event-delivery-observer.ts";
import { renderAceEvent } from "../../src/agent/pi-adapter.ts";
import type { AceMessage } from "../../src/protocol/ace-message.ts";

const event: AceMessage = {
	aceVersion: "0.1",
	id: "evt_001",
	sender: "build-service",
	activation: "next_turn",
	body: "Build failed for project foo.",
};

/** The user message the host echoes back for an injected event. */
function userMessage(text: string): unknown {
	return { type: "message_start", message: { role: "user", content: [{ type: "text", text }] } };
}

describe("AceDeliveryObserver", () => {
	it("resolves once the injected text shows up in the conversation", async () => {
		const observer = new AceDeliveryObserver();
		const waiting = observer.observe(event);

		observer.accept(userMessage(renderAceEvent(event)));

		await expect(waiting).resolves.toBeUndefined();
		expect(observer.pendingCount).toBe(0);
	});

	it("accepts a plain string content", async () => {
		const observer = new AceDeliveryObserver();
		const waiting = observer.observe(event);

		observer.accept({ message: { role: "user", content: renderAceEvent(event) } });

		await expect(waiting).resolves.toBeUndefined();
	});

	it("ignores a different message, a non-user message and junk", async () => {
		const observer = new AceDeliveryObserver();
		const waiting = observer.observe(event);

		observer.accept(userMessage("[ACE Event]\nsender: ci\nid: evt_999\n\nsomething else"));
		observer.accept({ message: { role: "assistant", content: [{ type: "text", text: renderAceEvent(event) }] } });
		observer.accept(undefined);
		observer.accept({ message: { content: 7 } });

		expect(observer.pendingCount).toBe(1);
		observer.accept(userMessage(renderAceEvent(event)));
		await expect(waiting).resolves.toBeUndefined();
	});

	it("does not match a body that merely mentions the event id", async () => {
		const observer = new AceDeliveryObserver();
		const waiting = observer.observe(event);

		observer.accept(userMessage("did evt_001 land?"));

		expect(observer.pendingCount).toBe(1);
		observer.accept(userMessage(renderAceEvent(event)));
		await expect(waiting).resolves.toBeUndefined();
	});

	it("drops a pending observation on release", () => {
		const observer = new AceDeliveryObserver();
		void observer.observe(event);
		expect(observer.pendingCount).toBe(1);

		observer.release(event);

		expect(observer.pendingCount).toBe(0);
	});

	it("resolves every waiter for the same text", async () => {
		const observer = new AceDeliveryObserver();
		const first = observer.observe(event);
		const second = observer.observe(event);

		observer.accept(userMessage(renderAceEvent(event)));

		await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
	});

	it("honours a custom renderer", async () => {
		const observer = new AceDeliveryObserver({ renderEvent: (message) => `ACE:${message.id}` });
		const waiting = observer.observe(event);

		observer.accept(userMessage(`ACE:${event.id}`));

		await expect(waiting).resolves.toBeUndefined();
	});
});
