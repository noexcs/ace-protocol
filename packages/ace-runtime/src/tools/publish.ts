import { type Activation, isActivation } from "../protocol/ace-message.ts";
import { type ResolvedServer, serverForChannel } from "../runtime/ace-config.ts";
import type { RegistryEntry } from "../runtime/agent-registry.ts";
import { resolveTarget } from "../runtime/agent-registry.ts";
import { channelName } from "../runtime/naming.ts";
import { INVALID_NAME_REASON, type LiveChannelDirectory, TOOL_ERROR_TEXT } from "./results.ts";
import { ACE_TOOL_NAMES, TOOL_ARGUMENTS } from "./spec.ts";

/**
 * The model's `ace_publish` arguments, checked before anything is resolved or sent.
 *
 * An invalid argument used to become a valid-looking channel: `""` was completed to `<ns>:<user>:`,
 * a number was stringified, and a list holding an empty entry had the whole array serialised as one
 * name. Every one of those produces a name nobody can read on a server that is up, so the call would
 * report success while nothing could ever be delivered. Validation fails the call instead, naming
 * the offending value — and it checks the arguments the host passed rather than a schema-checked
 * copy, because a host that coerces (see `PUBLISH_PARAMETERS` in `tools/spec.ts`) would have
 * rewritten them already.
 */
export interface PublishInput {
	/** The event body, unchanged. */
	body: string;
	/**
	 * The requested activation, or `undefined` when the caller omitted it (the hosts then send
	 * `next_turn`). Checked here, not by the declared schema: a host's enum rejection pre-empts the
	 * house sentence (`invalidActivation`), and a declared type would let a coercing host rewrite a
	 * wrong value into a legal-looking one.
	 */
	activation?: Activation;
	/**
	 * The channel names, in call order, trimmed, with **every input kept** — including an exact repeat.
	 * Dropping exact repeats here (as this function once did, on the string) collapsed two inputs into
	 * one row: `["team", "team"]` reported `targets=1` and no `duplicates=`, while two spellings of one
	 * channel (`local:team` and `ace:noexcs:team`) correctly reported `targets=2 duplicates=1`. One row
	 * per input is the contract, so the only de-duplication is {@link resolvePublishTargets}' on the
	 * *resolved* `(server, channel)` pair, and `targets=` counts inputs uniformly.
	 */
	targets: string[];
}

/** A character no name may carry: whitespace (including newlines) or a control character. */
const NAME_WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f]/;

/**
 * Refuse an argument the tool does not declare.
 *
 * Parameter schemas leave unknown keys visible to the tool on purpose (`AGENTS_PARAMETERS` in
 * `tools/spec.ts`: a host that closes the object may delete an extra key before the tool runs, which
 * is exactly the silent no-op this check exists to stop). An argument that reaches the tool and is then ignored is
 * indistinguishable, from the caller's side, from one that was honoured, so the call fails instead
 * and names every key the tool does not take.
 */
export function rejectUnknownArguments(tool: string, params: unknown, known: readonly string[]): void {
	if (typeof params !== "object" || params === null || Array.isArray(params)) return;
	const unknown = Object.keys(params).filter((key) => !known.includes(key));
	if (unknown.length > 0) throw new Error(TOOL_ERROR_TEXT.unknownArguments(tool, unknown, known));
}

/**
 * Trim a channel name and refuse the shapes no server can store: whitespace or a control character
 * inside it, and an empty colon-separated segment. `value` is known non-empty (the caller refuses an
 * empty entry first), so only the interior can be wrong. The caller supplies the message so a list
 * entry is reported by its position.
 */
function checkedName(value: string, message: (reason: string) => string): string {
	const name = value.trim();
	if (NAME_WHITESPACE_OR_CONTROL.test(name)) throw new Error(message(INVALID_NAME_REASON.whitespace));
	if (name.split(":").includes("")) throw new Error(message(INVALID_NAME_REASON.emptySegment));
	return name;
}

/** Validate the raw `ace_publish` arguments; throws a usage error naming the offending value. */
export function validatePublishInput(
	params: Record<string, unknown>,
	/**
	 * The configured server names, so a `<server>:` prefix can be recognised here. Optional because the
	 * prefix check is the only rule that needs the configuration; a caller that omits it still gets every
	 * other check, and `resolveChannelTarget` keeps its own guard as a backstop.
	 */
	options: { servers?: readonly string[] } = {},
): PublishInput {
	rejectUnknownArguments(ACE_TOOL_NAMES.publish, params, TOOL_ARGUMENTS.publish);

	const body = params.body;
	// A whitespace-only body is empty in every sense that matters — the peer's agent would read a
	// blank event — so the check is on the trimmed value, and the value is named as written.
	if (typeof body !== "string" || body.trim().length === 0) throw new Error(TOOL_ERROR_TEXT.invalidBody(body));

	// Checked here rather than by the declared enum (see `PUBLISH_PARAMETERS`): the host's enum
	// rejection is the host's wording, and it echoes the whole tool document instead of one sentence.
	const activation = params.activation;
	if (activation !== undefined && !isActivation(activation)) {
		throw new Error(TOOL_ERROR_TEXT.invalidActivation(activation));
	}

	const servers = options.servers ?? [];
	const channel = params.channel;
	if (typeof channel === "string") {
		if (channel.trim().length === 0) throw new Error(TOOL_ERROR_TEXT.invalidChannel(channel));
		return {
			body,
			activation,
			targets: [
				refuseAmbiguousServerRemainder(
					checkedName(channel, (reason) => TOOL_ERROR_TEXT.invalidChannelName(channel, reason)),
					servers,
				),
			],
		};
	}
	// An empty list is a usage error, not a no-op: "publish to nothing" has no success to report.
	if (!Array.isArray(channel) || channel.length === 0) throw new Error(TOOL_ERROR_TEXT.invalidChannel(channel));

	const targets: string[] = [];
	for (const [index, entry] of channel.entries()) {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			throw new Error(TOOL_ERROR_TEXT.invalidChannelEntry(entry, index, channel.length));
		}
		const name = checkedName(entry, (reason) =>
			TOOL_ERROR_TEXT.invalidChannelEntryName(entry, index, channel.length, reason),
		);
		// Every input becomes a target, exact repeats included: one row per input is the contract, and
		// the resolved-target de-duplication in `resolvePublishTargets` reports the repeat as a duplicate.
		targets.push(refuseAmbiguousServerRemainder(name, servers));
	}
	return { body, activation, targets };
}

/**
 * Refuse `<server>:<two-segment remainder>` before anything is resolved or sent, so the call fails the
 * way the other malformed inputs do — a sentence naming the value, with no event id and nothing stored.
 *
 * The same rule lives in {@link resolveChannelTarget}, where it is reached once the resolver knows the
 * server is live; that guard stays as a backstop, but by itself it reported this malformed input as a
 * per-target `status=failed` row beside a freshly minted id, which is the defect this pre-send check
 * removes. The prefix is decided by **configured** server name, up or down: the ambiguity comes from
 * the name's shape, not from whether the server answered.
 */
function refuseAmbiguousServerRemainder(name: string, servers: readonly string[]): string {
	const separator = name.indexOf(":");
	if (separator < 0) return name;
	const server = name.slice(0, separator);
	if (!servers.includes(server)) return name;
	const remainder = name.slice(separator + 1);
	if (remainder.split(":").length === 2) throw new Error(TOOL_ERROR_TEXT.ambiguousServerRemainder(server, remainder));
	return name;
}

/**
 * One server this session is live on, as target resolution needs it: the configured server, this
 * session's sender name on it (which is also its inbox channel), and its live directory.
 */
export interface TargetServer {
	server: ResolvedServer;
	sender: string;
	list(): Promise<RegistryEntry[]>;
}

/** A target resolved to a server: the uploaded channel name and the sender to publish as. */
export interface ResolvedChannelTarget {
	server: ResolvedServer;
	/** Uploaded channel name (`<ns>:<username>:<name>`, or a full name exactly as written). */
	channel: string;
	/** This session's sender name on that server. */
	sender: string;
}

/**
 * A resolved target's delivery identity: one delivery per (server, channel) pair. De-duplication must
 * run on this, not on the input strings, because two different names can resolve to one channel —
 * `local:inbox` and `ace:noexcs:inbox` are two strings, one channel, one delivery.
 *
 * A `note=stream-key` used to sit beside this: a channel whose name had the transport's own key shape
 * (`<ns>:ch:<channel>`, `channelStreamKey` in `runtime/naming.ts`) was named in the result, because the
 * old injected-block header printed a *transport key* and users copied that line into `ace_publish`.
 * The header now prints the **channel name** (`arrived via:`), so that mistake has no motive left, and
 * the shape-based match fired on legitimate channels whose name merely looked like a key. The note was
 * removed; a `note` is now only `completed-short-name`.
 */
function resolvedTargetKey(server: ResolvedServer, channel: string): string {
	return `${server.url}#${channel}`;
}

/**
 * What happened to one input target, in call order. A duplicate is reported rather than dropped in
 * silence, so the rendered result can carry one row per input and a caller sees that its second name
 * was the same delivery as an earlier one. `of` is the **resolved channel** the earlier input produced
 * — the delivery identity, the value a delivered row shows as its `target=` — not the earlier input
 * string.
 */
export type PublishTargetOutcome<T extends ResolvedChannelTarget = ResolvedChannelTarget> =
	| { readonly kind: "target"; readonly name: string; readonly target: T }
	| { readonly kind: "duplicate"; readonly name: string; readonly of: string }
	| { readonly kind: "failure"; readonly name: string; readonly detail: string };

/**
 * Resolve every `channel` argument and keep at most one delivery per resolved channel.
 *
 * One outcome per input, in call order, so the caller can render the result as one row per input. Each
 * input is attempted, so every input that fails is reported; but when a later input resolves to a
 * (server, channel) pair an earlier one already produced, it becomes a `duplicate` outcome instead of a
 * second delivery — string de-duplication cannot see that, because the two names differ. The duplicate
 * carries the earlier target's **resolved channel** as `of`, so it names the earlier delivery the way
 * that row does. The target type is generic, so a host can resolve to a richer target (a live
 * connection, say) and still get the original type back.
 */
export async function resolvePublishTargets<T extends ResolvedChannelTarget>(
	names: readonly string[],
	resolve: (name: string) => Promise<T>,
): Promise<PublishTargetOutcome<T>[]> {
	const outcomes: PublishTargetOutcome<T>[] = [];
	const firstChannel = new Map<string, string>();
	for (const name of names) {
		try {
			const target = await resolve(name);
			const key = resolvedTargetKey(target.server, target.channel);
			const earlier = firstChannel.get(key);
			if (earlier !== undefined) {
				outcomes.push({ kind: "duplicate", name, of: earlier });
				continue;
			}
			firstChannel.set(key, target.channel);
			outcomes.push({ kind: "target", name, target });
		} catch (error) {
			outcomes.push({ kind: "failure", name, detail: error instanceof Error ? error.message : String(error) });
		}
	}
	return outcomes;
}

/**
 * Resolve a `channel` argument to a server and an uploaded channel name.
 *
 * A target is a channel name. `<server>:<channel>` picks the server by its configured name — even
 * when that server is down, so a prefix is never mistaken for a short name and published to the
 * wrong server under a mangled name; it fails with `serverNotUp`. After that prefix the remainder is
 * either a one-segment local name (completed on that server) or a full name of three or more
 * segments (used as written); a two-segment remainder fails as ambiguous, because it reads both as a
 * local name that contains a colon and as a full name whose namespace was left off — completing it
 * either way writes an event nobody can read (`second:noexcs:remote` used to become
 * `ace2:noexcs:noexcs:remote`). A name of three or more segments is a full name whose first segment
 * is a namespace: only a server that owns that namespace may store the event, and one that is
 * configured but down fails with `namespaceNotUp` rather than accepting an event nobody can read. A
 * shorter name is a short name: with exactly one live server it becomes that server's channel,
 * otherwise the live directory decides which server holds it.
 */
export async function resolveChannelTarget(options: {
	name: string;
	/** The servers this session is live on. */
	active: readonly TargetServer[];
	/** Every server in `.ace.json`, whether or not it came up. */
	configured: readonly ResolvedServer[];
	username: string;
}): Promise<ResolvedChannelTarget> {
	const { name, active, configured, username } = options;
	const segments = name.split(":");
	const first = segments[0] ?? "";
	const complete = (short: string, namespace: string): string =>
		short.includes(":") && short.split(":").length >= 3 ? short : channelName(namespace, username, short);

	// 1. `<server>:<channel>`: the prefix is matched by configured server name, live or not.
	if (name.includes(":") && configured.some((server) => server.name === first)) {
		const live = active.find((candidate) => candidate.server.name === first);
		if (live === undefined) throw new Error(TOOL_ERROR_TEXT.serverNotUp(first));
		const remainder = name.slice(first.length + 1);
		const remainderSegments = remainder.split(":");
		if (remainderSegments.includes("")) {
			throw new Error(TOOL_ERROR_TEXT.invalidChannelName(name, INVALID_NAME_REASON.emptySegment));
		}
		// Two segments read two ways, so neither reading is safe to pick: fail and say which name is.
		if (remainderSegments.length === 2) {
			throw new Error(TOOL_ERROR_TEXT.ambiguousServerRemainder(first, remainder));
		}
		return {
			server: live.server,
			channel: complete(remainder, live.server.namespace),
			sender: live.sender,
		};
	}

	// 2. A full name (three or more segments) carries its namespace, so only its owner may store it.
	if (segments.length >= 3) {
		const owner = serverForChannel({ servers: configured, channel: name });
		if (owner !== undefined) {
			const live = active.find((candidate) => candidate.server.name === owner.name);
			if (live === undefined) throw new Error(TOOL_ERROR_TEXT.namespaceNotUp(first, owner.name));
			return { server: owner, channel: name, sender: live.sender };
		}
		// `serverForChannel` is undefined both for an unowned namespace and for one several servers
		// share; only the latter can be resolved further, by the directory.
		if (!configured.some((server) => server.namespace === first)) {
			throw new Error(TOOL_ERROR_TEXT.namespaceUnclaimed(first));
		}
	} else {
		// 3. A short name (one or two segments): with exactly one live server it is that server's channel.
		const only = active.length === 1 ? active[0] : undefined;
		if (only !== undefined) {
			return { server: only.server, channel: complete(name, only.server.namespace), sender: only.sender };
		}
	}

	if (active.length === 0) throw new Error(TOOL_ERROR_TEXT.noDirectory);

	// 4. Several live servers: the directory decides which one holds the channel.
	const matches: ResolvedChannelTarget[] = [];
	const live: LiveChannelDirectory[] = [];
	for (const candidate of active) {
		const entries = await candidate.list();
		live.push({ server: candidate.server.name, channels: entries.map((entry) => entry.channel) });
		const resolution = resolveTarget(entries, name);
		if (resolution.ok) {
			matches.push({ server: candidate.server, channel: resolution.entry.channel, sender: candidate.sender });
		}
	}
	const unique = matches[0];
	if (unique !== undefined && matches.length === 1) return unique;
	if (matches.length > 1) {
		throw new Error(
			TOOL_ERROR_TEXT.targetAmbiguous(
				name,
				matches.length,
				matches.map((match) => `${match.server.name}:${match.channel}`),
			),
		);
	}
	throw new Error(TOOL_ERROR_TEXT.targetNotFound(name, live));
}
