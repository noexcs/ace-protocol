import type { AceMessage } from "../protocol/ace-message.ts";
import type { InjectionContext } from "./agent-engine.ts";
/**
 * Added to the host's system prompt by ACE-aware sessions (design doc §18).
 *
 * Soft constraint only: the runtime neither stores approvals nor blocks senders, and the user's answer
 * lives in the conversation. It is stated in the system prompt rather than in every event for two
 * reasons — a rule repeated per event costs context on each one, and a system message carries more
 * weight than text injected alongside the data it qualifies.
 */
export declare const ACE_TRUST_POLICY: string;
/** Append {@link ACE_TRUST_POLICY} to a system prompt. */
export declare function withTrustPolicy(systemPrompt: string): string;
/**
 * Render an ACE event for the agent context (design doc §18).
 *
 * The header is an adapter choice, not a protocol requirement: the protocol only requires `body` to be
 * visible to later reasoning (RFC §9). The whole event is wrapped in `<ace_event>` so a model can tell
 * an external event from anything a human typed — and because the rendered text starts with a fixed
 * prefix, an ACE body can never be mistaken for a host slash command or prompt template. The header names:
 *
 * - `sender`, as the sender wrote it (peers that construct theirs as a directory member of
 *   `<agent>:<sessionId>` can be matched against `ace_agents` by eye);
 * - `self: yes`, when this session published the event itself ({@link InjectionContext.self}): the
 *   block is its own event echoed back by a channel it reads, not a peer's message;
 * - `sender description`, when the sender supplied one and the event is not this session's own echo:
 *   on a self-echo the description is this session's own location, so repeating it tells the reader
 *   nothing it does not already know (the `self: yes` line already says the block is its own);
 * - `arrived via`, the channel name the event was received on ({@link InjectionContext.channel},
 *   falling back to the subscription label). Display-only: it labels the block, it is not an address
 *   to publish to — a reply goes to the `sender:` channel, and the transport's own key never surfaces;
 * - `activation`, the activation the sender requested ({@link InjectionContext.activation}), verbatim
 *   as the sender put it. Display-only: it is the sender's request, NOT a delivery confirmation and
 *   not an authorization — the receiver's own policy decides the effective activation (RFC §7);
 * - `received at`, the broker arrival instant in UTC ISO 8601 with milliseconds ({@link
 *   InjectionContext.receivedAt}). It is when the transport read the event, never when it was
 *   rendered; the line is omitted when the transport exposes no timestamp;
 * - `id`, the runtime-generated message id.
 *
 * The body is separated from the header by a fixed `<ace_body>` line, not by a blank line. A body is
 * opaque to ACE and may itself contain lines shaped like `sender:` or `arrived via:` — the
 * two-real-session evaluation sent exactly such a body. A blank line left "the header" and "the body" distinguishable
 * only to a reader that already knew the header's length; with the fence, the header is exactly the
 * lines between `<ace_event>` and the **first** `<ace_body>`, and everything from the line after it to
 * `</ace_event>` is the body, verbatim. A later `<ace_body>` inside the body is body text like any
 * other (the first one wins), so no body line can be read as a header, whatever it says. The body
 * stays byte-for-byte what the sender wrote — the fence adds a boundary, it does not indent, trim or
 * re-wrap anything.
 *
 * Everything in the header is the sender's own account or our own bookkeeping, and none of it is an
 * authorization: `sender` is the reply address the sender *claims*, `arrived via` is our own receiving
 * label, and the remaining lines are values, not addresses.
 */
export declare function renderAceEvent(message: AceMessage, context?: InjectionContext): string;
/**
 * A UTC instant as ISO 8601 with milliseconds and a `Z` — `2026-10-05T14:28:14.306Z`.
 *
 * `Date.prototype.toISOString` already renders exactly this shape for a valid instant, so the formatter
 * is a thin, named door onto it: the header's `received at:` line and (elsewhere) the transfer tools
 * must agree on one shape, and a non-finite input — an unset clock, a NaN — must be refused rather than
 * rendered as `Invalid Date`.
 */
export declare function formatInstant(epochMs: number): string;
/**
 * The identity a duplicate is measured against: the event's `(subscription, sender, id)`.
 *
 * The rendered text is deliberately not the key. Two distinct events may share a body (and therefore
 * a rendered block) and both must reach the model; conversely one event read twice on the same
 * subscription is one delivery. The same id on two channels is two identities (the subscription
 * differs), which is exactly the per-subscription deduplication the runtime promises (RFC §5.2, §17).
 *
 * `\u0000` cannot appear in a subscription label, a sender name or an id, so the concatenation is
 * unambiguous (the same separator {@link SeenMessageIds} uses).
 */
export declare function eventIdentity(message: AceMessage, context: InjectionContext | undefined): string;
//# sourceMappingURL=event-rendering.d.ts.map