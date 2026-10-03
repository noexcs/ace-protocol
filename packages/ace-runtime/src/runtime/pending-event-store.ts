import type { AceMessage } from "../protocol/ace-message.ts";

/** A `manual` ACE event retained by the runtime until it is activated (RFC §7.3). */
export interface PendingAceEvent {
	readonly message: AceMessage;
	readonly subscriptionName: string;
}

/**
 * In-memory holding area for `manual` events (RFC §7.3, §12).
 *
 * MVP limitation: events live in process memory only. A restart loses them;
 * there is no query, inbox, or persistence API (ACE 0.1 does not define one).
 * Ordering is arrival order; identity is `(sender, id)` (RFC §5.2).
 */
export class PendingEventStore {
	private readonly events: PendingAceEvent[] = [];

	/** Retained events, oldest first. */
	list(): readonly PendingAceEvent[] {
		return [...this.events];
	}

	store(message: AceMessage, subscriptionName: string): PendingAceEvent {
		const event: PendingAceEvent = { message, subscriptionName };
		this.events.push(event);
		return event;
	}

	/** Remove and return the first event matching `(sender, id)`. */
	take(sender: string, id: string): PendingAceEvent | undefined {
		const index = this.events.findIndex((event) => event.message.sender === sender && event.message.id === id);
		if (index === -1) return undefined;
		return this.events.splice(index, 1)[0];
	}
}
