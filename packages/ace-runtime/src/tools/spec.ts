import { Type } from "typebox";
import type { ResolvedAceConfig } from "../runtime/ace-config.ts";
import { formatSessionLabel } from "../utils.ts";

/**
 * The tool text carries the channel directory, so the agent knows who it can talk to and where its
 * events land without reading `.ace.json` itself.
 *
 * `hostSpecifics` is where a host appends what only it knows — its own commands for a `manual` event,
 * its pending-store limits and spool paths, the config file's resolution order and global candidate,
 * and so on. Core text states protocol semantics only: a host detail written into the core rots with
 * the host's version and leaks one host's implementation into every host's prompt.
 */
export function buildPublishToolText(
	config?: ResolvedAceConfig,
	sessionId?: string,
	sender?: string,
	hostSpecifics?: string,
): { description: string; promptGuidelines: string[] } {
	const intro = TOOL_TEXT.publish.intro;
	const guidelines = [...TOOL_TEXT.publish.guidelines];
	if (!config) {
		const base = hostSpecifics === undefined ? intro : `${intro}\n\nHost specifics: ${hostSpecifics}`;
		return { description: base, promptGuidelines: guidelines };
	}

	const session = sessionId === undefined ? "" : `, session ${formatSessionLabel(sessionId)}`;
	const lines = [
		intro,
		"",
		`You are "${sender ?? "(unknown sender)"}"${session}: that name is also your own channel — a peer ` +
			`sends you a direct event by publishing to it, and it is the \`sender\` every event you publish carries ` +
			`from that server. One call is one event with one id, but a fan-out that spans servers shows one ` +
			`sender per participating server, comma-separated, in the result.`,
		"",
		"Servers this session is on:",
		...(config.servers.length === 0
			? ["(none)"]
			: config.servers.map((server) => `  "${server.name}" (namespace ${server.namespace})`)),
		"",
		"Channels you subscribe to (events published there reach you):",
		...(config.subscriptions.length === 0
			? ["(none configured — direct messages still arrive on your own channel)"]
			: config.subscriptions.map((subscription) => `  "${subscription.channel}" on "${subscription.server.name}"`)),
		"",
		"That listing is the configured set, not what is up: ace_channels reports the channels that actually " +
			"came up, and its `unavailable:` lines name the configured servers and subscriptions that did not. The " +
			"config file is read once, as a snapshot, so removing a channel from it takes effect only on this " +
			"session's next restart, and ace_channels marks a channel that is still live `config-removed` in its note.",
		...(config.warnings.length === 0 ? [] : ["", `Warnings: ${config.warnings.join("; ")}`]),
		"",
		"Delivery: an event you publish reaches every session subscribed to that channel, but the guarantee is " +
			"storage, not delivery: a subscription receives what is published after it starts, so a session that " +
			"subscribes after the publish receives nothing of it.",
		"",
		"Targets: pass a channel name — one of the channels above, or the name `ace_agents` lists for a " +
			"live session (that is how you send a direct message). A list publishes the same event to several.",
		"",
		"A peer receives what you publish as one `<ace_event>` block, and reads it by that session's own policy " +
			"(see the system prompt) — the parsing rules for a block you *receive* are that policy's, not this " +
			"tool's. To answer, publish to the block's `sender` channel — that name is the peer's own channel.",
		"",
		"Omitted, `activation` is sent as `next_turn`; the four values and what each asks for are defined in the " +
			"`activation` parameter below. The event id is generated for you and returned in the result.",
		...(hostSpecifics === undefined ? [] : ["", `Host specifics: ${hostSpecifics}`]),
	];
	return { description: lines.join("\n"), promptGuidelines: guidelines };
}

/**
 * Parameters of the channel listing tool: none — it lists this session's own configuration.
 *
 * Every ACE tool leaves `additionalProperties` open, and each handler refuses an undeclared argument
 * itself (`rejectUnknownArguments` in `tools/publish.ts`). Closing the object would delegate the
 * decision to the host, and oh-my-pi answers an unrecognized key by *deleting* it before the tool
 * runs: with `additionalProperties: false`, `ace_channels {"foo": 1}` would reach the handler looking
 * exactly like no arguments at all — the silent no-op these schemas exist to stop. Left open, the
 * unknown key reaches the tool, which fails the call naming it.
 */
export const CHANNELS_PARAMETERS = Type.Object({});

/**
 * The argument names every ACE tool declares, next to the schemas that declare them.
 *
 * A host may hand an undeclared argument through, and one that reaches a handler is either ignored
 * (a silent no-op) or refused; the handlers refuse it (`rejectUnknownArguments`, `tools/publish.ts`),
 * naming every key the tool does not take. `channels` takes none.
 */
export const TOOL_ARGUMENTS = {
	publish: ["body", "channel", "activation"],
	agents: ["agent", "limit"],
	channels: [],
	storeFile: ["path", "ttl", "name"],
	getFile: ["token"],
} as const;

/**
 * The names every host registers these tools under. One place, so the three hosts cannot drift: a
 * model that learns `ace_publish` in one host finds the same name in the others.
 */
export const ACE_TOOL_NAMES = {
	publish: "ace_publish",
	agents: "ace_agents",
	channels: "ace_channels",
	storeFile: "ace_store_file",
	getFile: "ace_get_file",
} as const;

/**
 * The result-line grammar `ace_store_file` and `ace_get_file` share, verbatim, so a reader of either
 * alone learns the same syntax — including how whitespace is quoted — and the two cannot drift.
 * `test/tools/prompt-consistency.test.ts` pins that both descriptions carry it unchanged.
 */
export const RESULT_LINE_GRAMMAR =
	"The result is one line of `key=value` fields separated by single spaces, in the order given here. " +
	"A value that contains whitespace or a control character is JSON-quoted — wrapped in leading and " +
	"trailing double quotes, the quotes spanning the whole value — so strip the quotes before using it; a " +
	"value without them is bare, and an empty value stays empty.";

/**
 * The tool text the model sees, in one place: the tool definitions read it from here, and
 * `test/extensions/tool-text-docs.test.ts` fails when the contracts document stops quoting it verbatim.
 */
export const TOOL_TEXT = {
	publish: {
		intro:
			"Publish an ACE 0.1 event to a peer agent or service. The recipient's agent receives the body as an " +
			"external event and decides what to do with it (its own policy may need its user's approval of the sender " +
			"first), so write plain text that stands on its own: the body is opaque to ACE. Every event also carries " +
			"a generated `sender description:` line — `agent`, `session`, `cwd`, `host`, `ip`, `platform`, `pid` — " +
			"which the sender cannot turn off and every subscriber sees, and it stays on the broker with the body, " +
			"so never put a token or other secret in a body.\n\n" +
			"The result is a field list, not prose. Its header is `ace 0.1 publish id=… sender=… activation=… " +
			"targets=N stored=D failed=F duplicates=K` (a call that stored nothing has no event, so its header reads " +
			"`event=none` in place of `id=`/`sender=`). Field meanings, one per line: `id` the generated event id, " +
			"one per call; `sender` this session's channel on each participating server, comma-separated, and where a " +
			"reply goes; `activation` the value this call sent; `targets` the number of inputs, always " +
			"`stored + duplicates + failed`; `stored` the targets the event was written to; `failed` the inputs that " +
			"did not resolve or store; `duplicates` inputs that resolved to an already-stored `(server, channel)`, " +
			"always present (`0` when none); `target` the input as written, or the resolved channel on a stored row; " +
			"`status` `stored`, `duplicate` or `failed`; `peer_named` and `self_reads` two independent reader checks, " +
			"each `yes`/`no`; `awaiting_activation` `yes` on a stored row of a `manual` publish, meaning nothing is " +
			"injected until the receiver's user activates it; `of` on a duplicate row, the channel the earlier input " +
			"resolved to; `error` on a failed row, the quoted reason; `note` a name-shape remark on a stored row " +
			"(`completed-short-name`).\n\n" +
			"The guarantee is storage, not delivery: an event is written to the channel whether or not anyone reads " +
			"it, and a subscription receives what is published after it starts, so an event is not replayed to a " +
			"reader that appears later — with no TTL or retention ACE has no way to read it back, and the bytes are " +
			"still broker storage anyone with access to the server can read directly. `peer_named=` and " +
			"`self_reads=` answer their own question and nothing more: `peer_named=yes` says a live directory entry " +
			"names the channel (some other session's own channel equals it) and `self_reads=yes` that this session " +
			"reads it, while `peer_named=no`/`self_reads=no` do not prove nobody else reads it — a peer's own " +
			"subscriptions are not visible here. A target is a channel name, not a verified recipient: nothing " +
			"checks that the name belongs to a live session, so publishing to a mistyped or departed name stores " +
			"the event on that channel (or fails to resolve) with no directory check — read each stored row's " +
			"`peer_named=`/`self_reads=` and check ace_agents before trusting a name.\n\n" +
			"Publishing to a channel this session itself reads delivers the event back into this same session, " +
			"marked `self: yes` in the block; on that self-echo the block omits the `sender description:` line, " +
			"because that description is this session's own location and `self: yes` already says the block is " +
			"yours, so tell your own deliveries from a peer's by the `self:` line, never by whether " +
			"`sender description:` is present. One event sent to two channels this session reads comes back as two " +
			"deliveries, with the same id but in separate turns, and even a single delivery can lag several turns " +
			"behind the publish: the receiver's host decides when and how many event blocks land, so one publish's " +
			"deliveries can be spread over several turns.\n\n" +
			"`activation` is a request, not a delivery confirmation — the four values and what each asks for are " +
			"defined once in the `activation` parameter, and nothing here narrows them.\n\n" +
			"A stored event reaches the peer as one `<ace_event>` block; the receiver reads that block by its own " +
			"session policy, which is the authority on how to parse it. Reply to the block's `sender:` channel, " +
			"which is the peer's own channel.\n\n" +
			"Rows: one per input target, in input order — `target=<resolved channel> status=stored " +
			"peer_named=<yes|no> self_reads=<yes|no>`, with `awaiting_activation=yes` appended on a `manual` publish " +
			"and `note=<shape>` appended when the name has a noteworthy shape; `target=<input> status=duplicate " +
			'of=<resolved channel>`; or `target=<input> status=failed error="<reason>"`.\n\n' +
			"The two failure modes are different and are told apart by where they are reported: an invalid " +
			"`channel` — empty or whitespace-only, a whitespace or control character inside it, an empty " +
			"colon-separated segment, a value of the wrong type, an empty list, a `<server>:` prefix resting on a " +
			"two-segment remainder (which reads two ways, so neither reading is taken), a malformed `activation` — " +
			"and an unknown argument reject the whole call before anything is sent, as a human sentence naming the " +
			"value, so nothing is published; a valid entry that cannot be resolved is not that: it takes its own " +
			'`target=<input> status=failed error="<reason>"` row while the other entries are stored. When no input ' +
			"is stored the call fails, and the failure text is that same field list (`stored=0` with one " +
			"`status=failed` row per input), never a sentence.",
		guidelines: [
			"Use ace_publish to notify another agent or service; keep the body self-contained.",
			"Choose the target by the peer it names; pass a list to publish the same event to several at once.",
			"Each target in a list is attempted on its own, so a mixed list is non-atomic (the description gives " +
				"the row shapes and the two failure modes): read `stored=`, `duplicates=` and `failed=` on the " +
				"header and the `status=failed` rows, because catching errors alone reads a mistyped target as a " +
				"full success.",
			"Call ace_agents for the channels that are live right now, then pass one of them as `channel`.",
			"A peer you share two servers with has one ace_agents row per server (same session id, a different " +
				"`channel` each): to reach that peer, publish once with every row naming it as `channel`, one target " +
				"per shared server — read ace_agents first to get the rows.",
			"A publish row's `peer_named=` and `self_reads=` are two separate checks, not a verdict (the description " +
				"defines each): a `stored` row that reads `peer_named=no self_reads=no` was written where nothing " +
				"is known to read it, so treat that row as a failure for a direct message and check ace_agents — a " +
				"channel nobody else reads keeps the event where nobody will see it.",
			"To answer an event, publish to the block's `sender` channel: that name is the peer's own channel. " +
				"A sender with no live channel (a service, or a session that has gone) cannot be answered there.",
			"There is no reply protocol: `stored=` counts storage, not acknowledgement — the event is written to " +
				"the channel whether or not anyone reads it, and nothing confirms it was consumed — so if you expect " +
				"an answer, say so and name the channel to answer on.",
		],
		params: {
			body:
				"Event body; it must contain at least one non-whitespace character — the peer's agent reads this — " +
				"and is otherwise passed verbatim: stored and rendered exactly as written, never trimmed and never " +
				"re-wrapped, unlike a channel name, which is trimmed at both ends",
			activation:
				'How the receiver should process it: "immediate" asks the receiver\'s host to preempt — a mid-turn ' +
				"receiver has that turn end early (a tool still running is left in the background) and the event " +
				"begins the next turn, while an idle receiver starts a new turn — so choose it deliberately; " +
				'"next_turn" waits for the receiver\'s turn to end. "manual" only stores it for the receiver\'s user ' +
				"to activate — activation is a user action on the receiver's host, not a tool the receiver's agent " +
				"holds — and an unactivated manual event is dropped after the host's retention window rather than " +
				'waiting forever. "default" leaves the choice to the receiver\'s own policy, which can land it a turn ' +
				"later. The sender cannot observe which one actually happened: the requested value is recorded " +
				"verbatim in the stored event, readable by anyone with broker access, but the block's `activation:` " +
				"line echoes only that request, not what the receiver's host did with it, and the receiver's host " +
				'decides when it lands, so an "immediate" event can arrive ' +
				'one or more batches later just like the others. Omitting `activation` is not "default": the ' +
				'runtime then sends "next_turn". A value outside those four is a usage error naming it, decided ' +
				"by the tool before anything is sent",
			channel:
				"Where to publish: a channel name — one this session reads, or one ace_agents lists as live — or a " +
				"list of channel names. A name is written by these rules, in order; the first that applies wins:\n" +
				"1. Shape and trimming. Channel names are case-sensitive (`ace:noexcs:INBOX` is a different channel " +
				"from `ace:noexcs:inbox`), and every name must be a non-empty string — pass a string, not a number " +
				"or an object: a coercing host can hand one through and the call fails naming the value, just as an " +
				"empty list does. A name is trimmed at both ends, so leading and trailing whitespace is accepted; " +
				"whitespace or a control character inside the name, or an empty colon-separated segment " +
				"(`ace::foo`), is a usage error naming the value.\n" +
				"2. `<server>:` prefix. A first segment that matches a configured server name picks that server, " +
				'even when it is down: a configured server that did not come up fails (`server "<name>" did not ' +
				"come up`) instead of being published to another server under a completed name. After the prefix, a " +
				"one-segment name is completed to `<ns>:<username>:<name>` on that server and a name of three or " +
				"more segments is used as written, while a two-segment remainder is a usage error because it reads " +
				"two ways (`second:noexcs:remote` is either a local name containing a colon or a full name missing " +
				"its namespace); that error is specific to the prefix, because there the server is named and both " +
				"readings look intended. Its consequence: a peer's full four-segment channel under a prefix is " +
				"written in full (`local:ace:noexcs:oh-my-pi:<uuid>`), never as the prefix plus a short remainder " +
				"(`local:oh-my-pi:<uuid>`).\n" +
				"3. Unprefixed full name (three or more segments). Used as written: its first segment is the " +
				"namespace of the server that owns it, which must be a namespace configured and up — an unowned " +
				"namespace, or one whose server did not come up, fails and nothing is stored.\n" +
				"4. Any other name (a short name, one or two segments). Resolved by the live directory, except in " +
				"the single-server case: with exactly one server live, a short name is completed without the " +
				"directory to `<ns>:<username>:<name>` — the only case in which a short name is completed at all. " +
				"With two or more live servers a short name is not completed; it can only match a live session " +
				"channel in the directory, so an unprefixed two-segment name like `noexcs:inbox` keeps its colon " +
				"only in the single-server case and fails with several servers live, while a full name whose " +
				"namespace two configured servers share is likewise decided by the directory. A first segment that " +
				"matches no configured server name is not a prefix at all, so an unprefixed two-segment name like " +
				"`noexcs:inbox` or `foo:bar` is a short name whose local part keeps its colon.\n" +
				"5. Winning by directory (step 4 with two or more live servers). The name is matched against the " +
				"directory exactly or by unique prefix; several servers live means a service or topic channel that " +
				"no live session names must be written as a full name (`<ns>:<username>:<name>`) or " +
				"`<server>:<name>`. When no live channel matches, the failure names the live session channels it " +
				"read, capped at five with `+N more`.\n" +
				"The event is stored on the channel it names, reader or not; a channel has no TTL, no retention and " +
				"no way to be read back, so an event no subscriber reads is not replayed to one that appears later. " +
				"A short name the runtime auto-completed to a full name has its stored row carry " +
				"`note=completed-short-name`, so the caller sees the name the event actually landed on.",
		},
	},
	agents: {
		description:
			"List the other sessions reachable right now — this session is not listed. The listing merges every " +
			"live server's directory: the header names the servers searched (`servers=<name>,<name>`, live servers " +
			"only, in config order), so a live server with no peers contributes no rows but is still listed there. " +
			"The result is a header `ace " +
			"0.1 agents count=N servers=<name>,<name>` (plus `filter=<agent>` when an `agent` filter was given) then " +
			"one row per live (session, server) channel: `channel=<target> renews_in=<ISO 8601 duration> " +
			'self=<yes|no> description="<what it says about itself>"`. `count=` counts those rows, not sessions: one session live ' +
			"on N servers contributes N rows, once per server, carrying the same session id — that shared id is the " +
			"only thing tying the rows together. With no live session the header is still returned, " +
			"`count=0`, followed by a sentence saying whether nothing is registered or the filter matched nothing. " +
			"An `agent` filter that is empty or whitespace-only after trimming is no filter at all, so the rows are " +
			"listed whole rather than reduced to `count=0`. " +
			"Rows are sorted by channel name, then by server name when one channel name is live on two servers: the " +
			"same peers come back in the same order on every call, and `renews_in` is not a sort key. The `channel` " +
			"value is the publish-ready target to pass as the ace_publish `channel`, and is always the row's first " +
			"field — with more than one server it reads `<server>:<channel>`. `renews_in` is the peer's remaining " +
			"lease at the moment of the call as an ISO 8601 duration (`PT33S`, `PT1M30S`), not a countdown to expiry: " +
			"it is recomputed at each call from a lease the peer renews, so the same peer can read `PT70S` on one " +
			"call and `PT73S` on the next, and a small value means " +
			"its lease is close to lapsing rather than that it expires at a set time. `self` is `no` here because this session's own " +
			"channel is not listed. `description` is the peer's self-description, quoted and never shortened: it is " +
			"the peer's own words, not a value ACE checked. The directory is broker storage like any other: anyone " +
			"with access to a server's storage can read `<ns>:agents` and `<ns>:entry` directly, without credentials, " +
			"so each entry's `cwd`, `host`, `ip` and `pid` are exposed there. A row is a name, not a verified recipient — nothing " +
			"checks that it names a live session, so a publish to a name no row lists is not the directory's " +
			"business and can reach nobody. The list is capped at `limit` rows (default 20, at most 50), so a large " +
			"directory is truncated rather than complete.",
		guidelines: ["Call ace_agents before ace_publish when the peer is not a channel this session reads."],
		params: {
			agent:
				"Filter by coding agent: an exact, case-sensitive match on a live session's `agent=` " +
				"self-description value, e.g. " +
				'"oh-my-pi" or "pi" — not a prefix of its channel name, and `agent=OH-MY-PI` is a different ' +
				"value that matches nothing. Must be a string; it is trimmed, and an " +
				"empty or whitespace-only value is no filter (the directory is listed whole, never as an empty one).",
			limit:
				"Maximum rows to return: an integer (default 20, clamped to at least 1 and at most 50, so `limit: 0` " +
				'returns 1 row). A non-integer value — including `true` or `"5"` — is a usage error naming the value, ' +
				"never a coercion to a number.",
		},
	},
	channels: {
		description:
			"List this session's ACE channels — the channels it reads: its own inbox channels (one per server it is " +
			"live on, each named by this session's sender there and marked `self=yes`) plus the subscribed names from " +
			".ace.json. A channel is a shared broadcast topic, not a private mailbox: everyone subscribed reads every " +
			"event published to it, so `inbox` names a topic like any other, not something personal. The result is a " +
			"header `ace 0.1 channels count=N self=M unavailable=K` then one flush-left row per channel: `channel=… " +
			"activation=… self=… note=…`. `count` is the number of channel rows, `self` how many of them " +
			"are marked `self=yes`, and `unavailable` how many trailing lines begin `unavailable:` — those lines are " +
			'not channel rows: they name a configured server that did not come up (`unavailable: server "<name>" did ' +
			"not come up (<address> is not reachable)`) and each subscription it dropped (`unavailable: <channel> " +
			'(server "<name>" did not come up)`). `channel` is what a peer publishes to, and `note` is the host\'s ' +
			"note about the channel, running to the end of the line (unquoted, empty when there is none; a peer's own " +
			"self-description is in ace_agents, not here). A channel a live subscription still reads but that the " +
			"current `.ace.json` no longer lists carries `config-removed` in its note: the file is read once at " +
			"session start, so removing a channel from it takes effect only on restart. When a row has more than one " +
			"remark the note is a comma-joined list in a fixed order — the configured description first, then " +
			"`config-removed`. Server settings (url, namespace, " +
			"credentials) are left out",
		/**
		 * The tail about `ace_agents` only makes sense on a host that registers that tool (Claude Code
		 * has no directory tool), so it is a separate piece a host appends or drops. Compose with
		 * {@link channelsToolText} rather than concatenating by hand.
		 */
		agentsPointer: "— address live peers with ace_agents.",
		guidelines: [
			"Use a channel this session reads, or a live channel from ace_agents, as the ace_publish `channel`.",
		],
	},
	storeFile: {
		description:
			"Store a local file on every server this session is live on, under a fresh random token, and return the " +
			"token a peer fetches it with. This is not sending: ACE publishes no event and notifies no one — the " +
			"peer learns nothing until you hand it the token, by whatever channel you already have — but the bytes " +
			"go to every server this session is live on, and those servers need not be on this machine, so a remote " +
			"server does receive them over the network. The bytes never enter any model's context. The token is the " +
			"whole capability among ACE sessions — whoever holds it can fetch the bytes until the ttl expires, and " +
			"it carries no namespace and no server name — but it is not a barrier against the broker: anyone with " +
			"access to a server's storage can read `ace:xfer:<token>` and its `:meta` directly, without the token, " +
			"so the broker's own access control is all that protects the bytes. Treat the token as a secret and hand " +
			"it only to the intended peer. Storing needs SET permission on each server and fetching needs GET; a " +
			"copy that did not land is simply absent from `stored_on=`, so the permission on that server is the " +
			"thing to check. One call stores the same token on every live server, in configuration order, and " +
			"defines no success/failure semantics: `stored_on=` names exactly the servers the copy landed on and is " +
			"empty when none did, so relay only when it names at least one server. The size limit is per copy " +
			"(8 MiB by default, 64 MiB at most, and 512 MiB or more is refused outright — the Redis single-value " +
			"ceiling), so N servers cost N times the file size. No caller chooses where a receiver writes: fetched " +
			"bytes land only under the receiver's own quarantine directory. " +
			`${RESULT_LINE_GRAMMAR} The fields are: \`pickup=<token> size=<bytes> sha256=<hex> ` +
			"name=<effective name> ttl=<ISO 8601 duration> stored_at=<UTC ISO 8601 with ms> expires_at=<UTC ISO 8601 " +
			"with ms> stored_on=<server,server>`. `pickup=` is the token; `name=` is the **effective** file name " +
			"after the `name` argument's basename is taken and control characters are stripped, so a relayed line " +
			"shows the name the receiver will actually see; `ttl=` echoes the ttl you requested as an ISO 8601 " +
			"duration such as `PT2S` immediately after a store that asked for two seconds — it is not a remaining " +
			"time and not a countdown; `stored_at=` is when the bytes were stored (the instant the token's life " +
			"began, UTC with milliseconds and a `Z`) and `expires_at=` when the token will lapse; `stored_on=` " +
			"names exactly the servers the copy landed on.",
		guidelines: [
			"Use ace_store_file to make a local file fetchable, then hand the peer the whole result line and tell it " +
				"the token is the capability; the store itself publishes nothing.",
			"The token is the secret: anyone who holds it can fetch the file until it expires, so hand it only to the " +
				"intended peer, never publish it to a shared channel.",
			"Read stored_on= before relying on a store: an empty value means no server took the copy, and a peer can " +
				"fetch only from a server the two of you share.",
			"Storing needs SET and fetching needs GET; when a copy did not land, check the permission on that server.",
			"No caller chooses where a receiver writes: fetched bytes land only under the receiver's own quarantine " +
				"directory.",
		],
		params: {
			path:
				"Path of the local file to store: absolute, or relative to the session's working directory. It must " +
				"name a readable regular file — a missing path, a directory and an unreadable file each fail with " +
				"their own sentence. Reading is deliberately not restricted to the workspace, so a file such as " +
				"`~/.ssh/id_rsa` can be stored; do it only on purpose.",
			ttl:
				'How long the token stays valid, as an ISO 8601 duration such as "PT1H" or "P1D". Default ' +
				'"PT1H"; "P1D" is the maximum and a longer or non-positive value is a usage error naming it.',
			name:
				"Optional file name to store the bytes under, overriding the path's basename. Only the last path " +
				"segment survives and control characters are stripped, so a name that is empty after stripping, " +
				"`.` or `..` is refused. The receiver's write path is fixed by ACE — this only names the file inside " +
				"it.",
		},
	},
	getFile: {
		description:
			"Fetch a file a peer stored with ace_store_file, by its token. The token is the whole capability " +
			"among ACE sessions: anyone who holds it can fetch the same bytes until the ttl expires, and the read is " +
			"non-destructive, so fetching does not consume it and others can still fetch it. The tool tries " +
			"each of this session's live servers in configuration order and takes the first hit; fetching needs GET " +
			"permission and storing needed SET. Nothing is written outside `<working directory>/.ace/xfer/<token>/" +
			"<sessionId>/`: the file name comes from the sender's metadata, never from an argument, so no caller can " +
			"choose a write path — an existing file with identical bytes is overwritten, and a differing one is " +
			"written beside it with a numeric suffix. " +
			`${RESULT_LINE_GRAMMAR} The fields are: \`path=<quarantine path> sha256=<hex> size=<bytes> name=<name> ` +
			"from=<server> stored_at=<UTC ISO 8601 with ms> expires_at=<UTC ISO 8601 with ms>`. `path=` and " +
			'`from=` carry that quoting rule, so a path with a space appears as `path="/…/note (2).txt"`. `name=` ' +
			"is the stored file name. `stored_at=` and `expires_at=` are read from the blob's own metadata, " +
			"already written at store time, so the result says when the token was stored and when it lapses without " +
			"a re-fetch. `sha256=` is computed here from the bytes written, not taken on trust, so " +
			"compare it yourself with the hash the sender relayed and with the sender's metadata. A token absent " +
			"from every server is a normal, diagnosable outcome: it may have expired, or you and the sender may " +
			"share no server.",
		guidelines: [
			"Fetch only a token a peer you trust gave you; the token is the capability and anyone who holds it can " +
				"read the file.",
			"The fetch is always an explicit call: ace_get_file never runs on its own and delivers nothing into the " +
				"conversation.",
			"Compare the returned sha256= with the hash the sender relayed; the two are computed independently and " +
				"must match.",
			"A token on none of your servers is not a temporary error — it expired or you share no server with the " +
				"sender.",
		],
		params: {
			token:
				"The token, as ace_store_file returned it in `pickup=`: 32 hex characters (128 bits). Case is " +
				"not significant — a relayed token that changed case is normalised — but the shape is checked, so a " +
				"truncated or non-hex value is a usage error naming it. The token carries no namespace and no server " +
				"name: it is looked up on this session's own servers.",
		},
	},
} as const;

/**
 * The `ace_channels` description for a host. The tail pointing at `ace_agents` belongs only to hosts
 * that register that tool, so a host without it passes `{ agentsTool: false }` and drops the pointer
 * instead of rewording the shared text. `hostSpecifics` is the same host-supplied paragraph
 * {@link buildPublishToolText} takes (see there for why).
 */
export function channelsToolText(options: { agentsTool?: boolean; hostSpecifics?: string } = {}): string {
	const base =
		options.agentsTool === false
			? TOOL_TEXT.channels.description
			: `${TOOL_TEXT.channels.description} ${TOOL_TEXT.channels.agentsPointer}`;
	return options.hostSpecifics === undefined ? base : `${base}\n\nHost specifics: ${options.hostSpecifics}`;
}

/**
 * Parameters of the publish tool: all three are declared optional and none declares a type, and the
 * event id is generated for the caller. The tool itself validates every one of them.
 *
 * `body` and `channel` declare **no type at all** (`Type.Unsafe` over a description) on purpose, and
 * the descriptions carry the type. Both hosts rewrite tool arguments before the tool runs, and both key
 * on a declared type: Pi's `validateToolArguments` runs TypeBox's `Value.Convert` and then its own
 * schema-directed `coerceWithJsonSchema` (`42` → `"42"`, `null` → `""` in a string list), while
 * oh-my-pi repairs every type issue its validator reports by stringifying the value (`42` → `"42"`, a
 * container → its compact JSON). A node declaring `type: "string"` — a plain JSON-schema node
 * included, which is why the previous round's change did not stop it — therefore reached the tool
 * already rewritten into a valid-looking channel (`channel: 42` published as `ace:<user>:42`). A node
 * that declares no type leaves the validator with no issue to report and the converter with no type to
 * convert, so the raw value reaches `validatePublishInput` (`tools/publish.ts`), which refuses a
 * number, an object or an array and names it (`ace_publish \`channel\` must be a non-empty string or an
 * array of non-empty strings, received 42`). Callers therefore pass strings; a JSON-encoded list is
 * a string, not a list, and is refused rather than parsed.
 *
 * All three are also **optional in the declared schema**. A host's JSON-schema validator runs before
 * the tool: a missing declared-required key is rejected with the host's own wording and the whole tool
 * document echoed back (`channel must be (In: unknown) => To<unknown> (was missing)`), which pre-empts
 * the house sentence `validatePublishInput` would have written. The same goes for a declared `enum`:
 * `activation: "later"` was rejected by the host's enum check, never by ours. Declared optional, the
 * call reaches the tool, which names the missing value (`ace_publish \`body\` must contain at least one
 * non-whitespace character, received undefined`) and refuses an activation outside the four values. The four values stay
 * listed in the `activation` description — the description is what the host shows — so nothing the
 * model reads is lost; only the *rejection wording* moves to us, uniform with every other ACE refusal.
 */
export const PUBLISH_PARAMETERS = Type.Object({
	body: Type.Optional(Type.Unsafe<string>({ description: TOOL_TEXT.publish.params.body })),
	activation: Type.Optional(Type.Unsafe<string>({ description: TOOL_TEXT.publish.params.activation })),
	channel: Type.Optional(Type.Unsafe<string | string[]>({ description: TOOL_TEXT.publish.params.channel })),
});

/**
 * Parameters of the directory listing tool.
 *
 * Like every ACE tool, the object is left open and the handler refuses undeclared arguments (see
 * {@link CHANNELS_PARAMETERS}). Like `ace_publish`'s `body`/`channel`, both declared nodes also declare
 * **no type** (`Type.Unsafe` over a description): a host rewrites an argument keyed on its declared
 * type, and with `agent` declared `string` and `limit` declared `number` it silently produced
 * `agent: 5` → `"5"` (an empty directory) and `limit: "5"`/`limit: true` → `5`/`1`. With no declared
 * type the raw value reaches `validateAgentsInput` (`tools/agents.ts`), which refuses a non-string
 * `agent` and a non-integer `limit`, naming the value and the type.
 */
export const AGENTS_PARAMETERS = Type.Object({
	agent: Type.Optional(Type.Unsafe<string>({ description: TOOL_TEXT.agents.params.agent })),
	limit: Type.Optional(Type.Unsafe<number>({ description: TOOL_TEXT.agents.params.limit })),
});

/**
 * Parameters of `ace_store_file`. Like every ACE tool the object is left open and the handler refuses
 * undeclared arguments; like `ace_publish`'s nodes, each declares **no type** (`Type.Unsafe` over a
 * description) so a host that rewrites an argument keyed on its declared type has nothing to rewrite
 * and the raw value reaches `validateStoreInput`, which names a wrong one.
 */
export const STORE_FILE_PARAMETERS = Type.Object({
	path: Type.Optional(Type.Unsafe<string>({ description: TOOL_TEXT.storeFile.params.path })),
	ttl: Type.Optional(Type.Unsafe<string>({ description: TOOL_TEXT.storeFile.params.ttl })),
	name: Type.Optional(Type.Unsafe<string>({ description: TOOL_TEXT.storeFile.params.name })),
});

/** Parameters of `ace_get_file`; `token` declares no type for the same reason as the nodes above. */
export const GET_FILE_PARAMETERS = Type.Object({
	token: Type.Optional(Type.Unsafe<string>({ description: TOOL_TEXT.getFile.params.token })),
});
