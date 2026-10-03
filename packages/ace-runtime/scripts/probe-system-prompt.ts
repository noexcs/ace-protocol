/**
 * Verification-only probe: does the request the provider receives carry ACE's system-prompt policy?
 *
 * Loaded next to the extension under test (`omp --extension <ace.ts> --extension <this file>`), it
 * inspects the outgoing payload instead of the source, so `verify:omp` asserts what the model is
 * actually told. It prints one marked line per request on stderr, where the script already collects
 * the session's logs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Prefix of this probe's stderr lines; `verify:omp` greps for it. */
export const PROBE_MARKER = "ACE_PROBE_SYSTEM_PROMPT";

/** Text only the policy paragraph contains. */
const POLICY_MARKER = "does not authenticate senders";

/** The sentence the per-event notice no longer carries (it moved to the system prompt). */
const REMOVED_NOTICE_SENTENCE = "ask the user whether to trust it";

export default function systemPromptProbe(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event) => {
		const text = JSON.stringify(event.payload ?? null);
		console.error(
			`${PROBE_MARKER} policy=${text.includes(POLICY_MARKER)} legacyNotice=${text.includes(REMOVED_NOTICE_SENTENCE)}`,
		);
	});
}
