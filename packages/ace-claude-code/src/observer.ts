import type { AceMessage, DeliveryObserver } from "ace-runtime";
import { renderAceEvent } from "ace-runtime";
import type { AckObservation } from "./ack.ts";

interface PendingEntry {
	/** The exact rendered event we pushed; the key every other method matches against. */
	text: string;
	resolves: Set<() => void>;
}

/**
 * Decides when a channel-injected event has reached the conversation, from the `UserPromptSubmit`
 * hook's trail.
 *
 * The core `AceDeliveryObserver` matches a fed text only when it is *equal* to a rendered event.
 * That works on Pi — the host echoes the very string it was handed — but not here: Claude Code
 * wraps our `<ace_event>` block in its own `<channel source="…">` tag and may batch several events
 * into one prompt, so the rendered text is a run *inside* a larger prompt, never the whole of it.
 * Matching it exactly against the hook's prompt could therefore never resolve.
 *
 * This observer keeps its own pending table (it is not the core one) and matches each rendered
 * event as a **substring** of the prompt the hook saw. That is what makes "observed in the
 * conversation" hold on this host: the block is found inside the wrapper and among batched events.
 * If the host rewrites the block's bytes, it is not a substring and the injection is not observed —
 * the engine's timeout then releases it for redelivery rather than acknowledging an event the model
 * may never have read.
 */
export class ChannelObserver implements DeliveryObserver {
	private readonly pending = new Map<string, PendingEntry>();

	observe(message: AceMessage, rendered?: string): Promise<void> {
		const text = rendered ?? renderAceEvent(message);
		return new Promise((resolve) => {
			const entry = this.pending.get(text) ?? { text, resolves: new Set() };
			entry.resolves.add(resolve);
			this.pending.set(text, entry);
		});
	}

	release(message: AceMessage, rendered?: string): void {
		const text = rendered ?? renderAceEvent(message);
		this.pending.delete(text);
	}

	/**
	 * Resolve every pending event whose rendered text appears in the observed prompt. The host wraps
	 * our content verbatim, so a pushed event is a contiguous run inside the prompt; matching the
	 * whole rendered event (not an id) keeps it false-positive-free.
	 */
	feed(observation: AckObservation): void {
		for (const [text, entry] of [...this.pending]) {
			if (observation.prompt.includes(text)) {
				this.pending.delete(text);
				for (const resolve of entry.resolves) resolve();
			}
		}
	}
}
