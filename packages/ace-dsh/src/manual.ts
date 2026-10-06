/**
 * The manual-activation surface: what is held, and how one held event is delivered.
 *
 * ACE puts `manual` activation in the user's hands — the runtime retains the event and nothing enters the
 * conversation until someone says so. On this host that decision is reachable two ways: `/ace` (the human
 * command, the ACE-sanctioned path) and, because the host's client did not dispatch the command in the
 * build this was installed into, two tools as well. Both go through this file, so the wording and the
 * behaviour cannot drift between them.
 */

import { formatInstant } from "../vendor/ace-runtime/dist/index.js";
import type { AceSession } from "./session.ts";

/** How a held event is named when it is activated, in both surfaces. */
export const ACTIVATE_USAGE = "`/ace activate <sender> <id>` — the sender and the id come from the listing";

/** What is held for manual activation, one line per event, with the identity activation takes. */
export function pendingReport(session: AceSession): string {
	const pending = session.runtime.pendingEvents;
	if (pending.length === 0) return "No ACE events are held for manual activation.";
	return [
		"ACE events held for manual activation — deliver one with `/ace activate <sender> <id>`:",
		...pending.map(
			(event) =>
				`  sender=${event.message.sender} id=${event.message.id} received=${formatInstant(event.storedAt)} via=${event.subscriptionName}`,
		),
		`total=${pending.length}`,
	].join("\n");
}

/**
 * Deliver one held event to this session.
 *
 * @throws when no held event has that `(sender, id)` — the runtime's own reason is the message.
 */
export async function activatePending(session: AceSession, sender: string, id: string): Promise<string> {
	await session.runtime.activatePendingEvent(sender, id);
	return `Activated ${sender}/${id}: the event is now delivered to this session.`;
}
