import type { AceMessage } from "../protocol/ace-message.ts";
import { renderAceEvent } from "./pi-adapter.ts";

/** Something that can decide when an injected event has reached the conversation. */
export interface DeliveryObserver {
	/** Resolves once the host surfaced `message` in the conversation, i.e. this rendered text. */
	observe(message: AceMessage, rendered?: string): Promise<void>;
	/** Drop a pending observation that will never be satisfied (injection gave up). */
	release?(message: AceMessage, rendered?: string): void;
}

/**
 * Resolves an injection once it shows up in the conversation.
 *
 * The host echoes the injected text back in a message event — oh-my-pi emits the very string we
 * handed it — so the observer matches on that string. Matching the whole rendered event means no
 * id parsing and no false positives from an event body that happens to mention an id.
 *
 * Why this exists: "handed to the host" is not "the agent can see it". An idle oh-my-pi session
 * queues a `followUp` without starting a turn, so an injection that resolved on hand-off let the
 * transport acknowledge events the agent never received. Until the message event arrives, the
 * broker entry stays pending.
 */
export class AceDeliveryObserver implements DeliveryObserver {
	private readonly renderEvent: (message: AceMessage) => string;
	private readonly waiters = new Map<string, Array<() => void>>();

	constructor(options: { renderEvent?: (message: AceMessage) => string } = {}) {
		this.renderEvent = options.renderEvent ?? renderAceEvent;
	}

	observe(message: AceMessage, rendered?: string): Promise<void> {
		const text = rendered ?? this.renderEvent(message);
		return new Promise((resolve) => {
			const waiters = this.waiters.get(text) ?? [];
			waiters.push(resolve);
			this.waiters.set(text, waiters);
		});
	}

	release(message: AceMessage, rendered?: string): void {
		const text = rendered ?? this.renderEvent(message);
		const waiters = this.waiters.get(text);
		if (!waiters) return;
		this.waiters.delete(text);
	}

	/** Feed every host message event here. */
	accept(event: unknown): void {
		const text = messageText(event);
		if (text === undefined) return;
		const waiters = this.waiters.get(text);
		if (!waiters) return;
		this.waiters.delete(text);
		for (const resolve of waiters) resolve();
	}

	/** How many injections are still waiting, for diagnostics. */
	get pendingCount(): number {
		let total = 0;
		for (const waiters of this.waiters.values()) total += waiters.length;
		return total;
	}
}

/** The text of a host message event, or `undefined` when it is not a user message. */
function messageText(event: unknown): string | undefined {
	if (typeof event !== "object" || event === null) return undefined;
	if (!("message" in event)) return undefined;
	const message: unknown = event.message;
	if (typeof message !== "object" || message === null) return undefined;
	if ("role" in message && message.role !== undefined && message.role !== "user") return undefined;
	const content = "content" in message ? message.content : undefined;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		if (!("type" in part) || part.type !== "text") continue;
		if ("text" in part && typeof part.text === "string") parts.push(part.text);
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}
