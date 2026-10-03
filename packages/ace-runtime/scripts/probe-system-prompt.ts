/**
 * Verification-only probe: what does the request the provider receives say about ACE?
 *
 * Loaded next to the extension under test (`omp --extension <ace.ts> --extension <this file>`), it inspects
 * the outgoing payload instead of the source, so `verify:omp` asserts what the model is actually told. It
 * prints one marked line per request on stderr, where the script already collects the session's logs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Prefix of this probe's stderr lines; `verify:omp` greps for it. */
export const PROBE_MARKER = "ACE_PROBE_SYSTEM_PROMPT";

/** Text only the system-prompt policy contains. */
const POLICY_MARKER = "does not authenticate senders";

/** Sentence the per-event notice used to carry (it moved to the system prompt and became a three-way ask). */
const REMOVED_ASK_SENTENCE = "ask the user whether to trust it";

/** The per-event provenance notice that was deleted outright: nothing may reintroduce it. */
const REMOVED_NOTICE_SENTENCE = "an external event another agent sent with ACE";

export default function systemPromptProbe(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event) => {
		const text = JSON.stringify(event.payload ?? null);
		console.error(
			`${PROBE_MARKER} policy=${text.includes(POLICY_MARKER)} ` +
				`askSentence=${text.includes(REMOVED_ASK_SENTENCE)} ` +
				`notice=${text.includes(REMOVED_NOTICE_SENTENCE)}`,
		);
	});
}
