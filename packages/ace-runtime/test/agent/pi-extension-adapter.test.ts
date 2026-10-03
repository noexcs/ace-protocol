import { describe, expect, it } from "vitest";
import { renderAceEvent } from "../../src/agent/pi-adapter.ts";
import { type ExtensionMessageApi, PiExtensionAdapter } from "../../src/agent/pi-extension-adapter.ts";
import type { AceMessage } from "../../src/protocol/ace-message.ts";

const event: AceMessage = {
	aceVersion: "0.1",
	id: "evt_001",
	sender: "build-service",
	activation: "next_turn",
	body: "Build failed for project foo.",
};

class FakePi implements ExtensionMessageApi {
	readonly sent: Array<{ content: string; options: { deliverAs?: "steer" | "followUp" } | undefined }> = [];

	sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void {
		this.sent.push({ content, options });
	}
}

function setup(idle = true) {
	const pi = new FakePi();
	const adapter = new PiExtensionAdapter({ pi, isIdle: () => idle });
	return { pi, adapter };
}

describe("PiExtensionAdapter", () => {
	it("sends the rendered event as a user message with followUp delivery for next_turn", async () => {
		const { pi, adapter } = setup();

		await adapter.inject(event, "next_turn");

		expect(pi.sent).toEqual([{ content: renderAceEvent(event), options: { deliverAs: "followUp" } }]);
	});

	it("uses steer delivery for immediate", async () => {
		const { pi, adapter } = setup();

		await adapter.inject({ ...event, activation: "immediate" }, "immediate");

		expect(pi.sent[0]?.options).toEqual({ deliverAs: "steer" });
	});

	it("always passes deliverAs so Pi can queue the event of a streaming turn", async () => {
		const { pi, adapter } = setup(false);

		await adapter.inject(event, "next_turn");

		expect(pi.sent[0]?.options?.deliverAs).toBe("followUp");
	});

	it("reports the running state from the idle probe", () => {
		expect(setup(false).adapter.isRunning()).toBe(true);
		expect(setup(true).adapter.isRunning()).toBe(false);
	});

	it("assumes idle before a session context exists", async () => {
		const pi = new FakePi();
		const adapter = new PiExtensionAdapter({ pi });

		expect(adapter.isRunning()).toBe(false);
		await expect(adapter.inject(event, "next_turn")).resolves.toBeUndefined();
	});

	it("honours a custom renderer", async () => {
		const pi = new FakePi();
		const adapter = new PiExtensionAdapter({ pi, renderEvent: (message) => `ACE:${message.body}` });

		await adapter.inject(event, "next_turn");

		expect(pi.sent[0]?.content).toBe("ACE:Build failed for project foo.");
	});

	it("resolves immediately even while a turn runs", async () => {
		const { adapter } = setup(false);
		await expect(adapter.waitForIdle()).resolves.toBeUndefined();
	});
});
