# ace-omp

The ACE 0.1 host plugin for **oh-my-pi** (and upstream **Pi**): external events — CI results, alerts,
peer agents — become an active input to a running coding session.

- **Core:** [`ace-runtime`](../ace-runtime) — protocol, activation, the event dispatcher, spools,
  pending stores, transports, the agent directory, and the `AgentEngine` contract. This package
  consumes it as `file:../ace-runtime`, so build the core first: `cd ../ace-runtime && npm run build`.
- **Host registration:** the host discovers the plugin through this package's `package.json` —
  `"omp": { "extensions": ["./extensions/ace.ts"] }`. Nothing is patched into the host.
- **Layout:** `extensions/ace.ts` (the plugin), `extensions/ace-manager.ts` (the `/ace` manager view),
  `test/extensions/*` (its tests), `scripts/verify-omp.ts` (end-to-end against a real host and broker),
  `scripts/probe-system-prompt.ts` (a probe the verification loads beside the plugin).
- **Gates:** `npm run check` (biome + tsc + the shared contracts), `npm test` (vitest), and
  `npm run verify:omp` (needs an `omp` binary and a model; it skips with a printed reason otherwise).

Everything below is the host-facing documentation, moved here from the core package's README when
the two were split.

## Install

oh-my-pi discovers plugins through the `omp.extensions` field of an installed package, and this package
is the plugin: link it once and the host finds the extension by itself.

```bash
cd packages/ace-omp
bun install                            # installs the vendored core as well
omp plugin link "$PWD"                 # registers it under ~/.omp/plugins
omp plugin list                        # → ace-omp, enabled, manifest ./extensions/ace.ts
```

**Why the core is vendored.** The host's extension loader resolves relative imports and the plugin's own
`node_modules`, but *not* a bare `ace-runtime` specifier that points at a linked sibling package: the
extension then fails to load with `Cannot find package 'ace-runtime'` (probed against omp 18.5.0 — the
same probe shows `redis` and `typebox` resolving fine, so it is the sibling package, not bare imports in
general). This package therefore carries the core's build in `vendor/ace-runtime` and the extension
imports it by relative path — `../vendor/ace-runtime/dist/index.js`. After changing the core, refresh the
copy: `node scripts/check-vendor-sync.ts --write` at the repository root.

Upstream **Pi** (not oh-my-pi) has no plugin registry and resolves relative to the package anyway, so
`pi --extension /path/to/ace-omp/extensions/ace.ts` is enough there.

### Upgrading from the pre-split package

The plugin used to ship inside `ace-runtime`. That package no longer declares an extension, so an
install still pointing at it loads **nothing at all** — no plugin, and no error to read:
`omp plugin list --json` shows it as `"manifest": null`. Move the install over:

```bash
omp plugin link /path/to/ace-protocol/packages/ace-omp
omp plugin uninstall ace-runtime
```

## Inject events into a live Pi session

The extension in [`extensions/ace.ts`](extensions/ace.ts) runs **inside** Pi and injects external events into the
session you are chatting in — no separate runtime process, no second session.

```bash
# 1. every MQ setting lives in .ace.json (code holds the mechanisms, not the addresses)
cat > .ace.json <<'JSON'
{
  "$schema": "/path/to/ace-runtime/schema/ace-config.schema.json",
  "defaultActivation": "next_turn",
  "subscribe": [
    {
      "name": "inbox",
      "transport": "redis-streams",
      "description": "direct messages addressed to me",
      "activation": "next_turn",
      "config": {
        "stream": "ace:in.a",
        "group": "agent-a",
        "url": "redis://127.0.0.1:6379"
      }
    }
  ]
}
JSON

# 2. start the host: oh-my-pi loads the installed plugin by itself, upstream Pi needs the entry path
omp                                                       # oh-my-pi, with the plugin installed
pi --extension /path/to/ace-runtime/extensions/ace.ts      # upstream Pi, from a checkout

# 3. publish from anywhere; the event lands in the running conversation
redis-cli XADD ace:events '*' message \
  '{"aceVersion":"0.1","id":"e1","sender":"ci","activation":"next_turn","body":"Build failed."}'
```

Load it permanently by copying or symlinking the file into `~/.pi/agent/extensions/` (or a project
`.pi/extensions/`). `.ace.json` is read once per session: restart Pi or `/reload` after editing it. Set
`ACE_CONFIG` to read it from another path.

### `.ace.json`

| Field | Meaning |
|---|---|
| `sender` | **Deprecated, unused**: a session publishes as `<coding-agent>:<sessionId>` (its directory member). Accepted so old files keep loading; a warning is reported when present |
| `defaultActivation` | `immediate` \| `next_turn` \| `manual`; the RFC §8 fallback when neither subscription nor message decides |
| `subscribe[]` | Channels this agent receives events from; `name` is the key its transport is registered under |
| `publish[]` | Channels the `ace_publish` tool may send to; `name` is the target the model passes |
| `*.transport` | Transport kind; `redis-streams` is the only one implemented (RFC §4.1 names the others) |
| `subscribe[].activation` | Receiver override for this channel (RFC §8); `default` delegates to the message. Not allowed on `publish` |
| `*.description` | Who sits on the other end; shown to the model in the `ace_publish` description |
| `*.enabled` | `false` keeps the channel configured but starts nothing for it (default `true`) |
| `manual` | Retention for `manual` events (`{ max?, ttlMs? }`, defaults 100 events / 24h) |
| `registry` | Agent directory this session publishes itself to (`{ url, prefix? }`); absent means no registration (RFC §22 item 1) |
| `*.config` | Transport settings, validated against the kind; unknown keys are errors |
| `*.options` | Raw options handed to the transport's client library; never validated |
| `config.stream` … | redis-streams subscribe: `stream`, `group`, `url`, `consumer`, `field`, `count`, `blockMs`, `reclaimIdleMs`, `reclaimAttempts`, `retryDelayMs`, `maxRetryDelayMs`; publish: `stream`, `url`, `field` |

`.ace.json` is the only source of MQ configuration — there is no environment fallback for addresses, streams, or
groups. `ACE_CONFIG` selects a different config file path; runtime lines always go to stderr, and `/ace list`
prints the channel topology (ACE keeps nothing in the UI status slot).

Two things that used to be configuration are deliberately built in and absent from the file: burst spooling
(`<cwd>/.ace/spool`, 20 events per one-second window) and the inbound filter — nothing drops an event because of
its `sender`; the user's trust decision in the conversation is what gates action.

Secrets stay out of the file: `${VAR}` in any string is resolved from the environment when the file is read
(`"url": "redis://:${REDIS_PASSWORD}@broker:6379"`), `$$` writes a literal `${`, and an unset variable fails the
load instead of silently becoming an empty string.

### Bursts and redelivery

Two built-in policies keep a busy channel from flooding a conversation; neither is configuration.

- **Burst spooling** — beyond 20 events inside a one-second window, the rest are appended to a JSONL file under
  `<cwd>/.ace/spool`, and the agent gets **one** summary event naming the file, the senders and the window. 200 CI
  failures cost one turn instead of 200.
- **Redelivery** — `reclaimIdleMs` / `reclaimAttempts`: an event whose handler failed stays in the group's pending
  list, is claimed back after `reclaimIdleMs`, and is retried up to `reclaimAttempts` deliveries before the runtime
  reports and acknowledges it rather than retrying forever.

Deduplication is identity-based: `(sender, id)` is remembered for `dedupCapacity` events, and **only handled events
are remembered** — a redelivery after a failure is retried, never mistaken for a duplicate.

When an entry is dropped after `reclaimAttempts`, the transport hands its last copy to the dead-letter sink first:
one JSONL line per event (raw payload, broker id, attempts, reason) in `dead-letter.<timestamp>.jsonl`, in the same
directory as the burst files and with the same built-in retention (24h / 50 files). The entry is acknowledged
**only once that line is fsynced**; a sink that cannot write leaves the entry pending — visible in the group's PEL —
and reports the write error once. No summary event is injected: the agent already failed to receive it
`reclaimAttempts` times, so feeding it back would loop. `/ace` and `/ace stats` count what was recorded, and
`npm run replay:dead-letters` puts the records back on the streams they came from (each line carries its
`stream` and `field`).

[`schema/ace-config.schema.json`](schema/ace-config.schema.json) describes the file, so editors validate and
autocomplete it after adding a `$schema` line (a local path inside the installed package works equally):

```json
{ "$schema": "https://raw.githubusercontent.com/noexcs/ace-protocol/v0.1.10/packages/ace-runtime/schema/ace-config.schema.json", "subscribe": [ … ] }
```

The schema covers structure, types, per-kind required keys, and "publish needs a sender". Two rules are semantic and
stay in the validator: names must be unique within `subscribe` and within `publish`, and one transport instance cannot
serve two subscriptions. `test/runtime/ace-config-schema.test.ts` fails when the schema and the validator disagree.

### What injection looks like

| Effective activation | Pi idle | Pi running |
|---|---|---|
| `next_turn` | event starts a turn | queued with `followUp`, processed after the current run's pending work |
| `immediate` | event starts a turn | queued with `steer`, processed at the current turn's next boundary |
| `manual` | retained in memory, no turn | retained in memory, no turn |

Pi resolves idle-vs-streaming itself for `sendUserMessage`, so the extension passes the delivery mode and lets Pi
queue the event; the last action also shows on the status line (`ace: injecting id=… sender=… agent=running`).

### Talking to another agent

`publish` plus the `ace_publish` tool make two Pi sessions exchange ACE events (RFC §19, Agent → Agent). Each
side consumes what the other publishes, so neither sees its own messages:

```text
agent A                                    agent B
  .ace.json                                  .ace.json
  subscribe: from-b = ace:to-a                subscribe: from-a = ace:to-b
  publish:   to-b   = ace:to-b                publish:   to-a   = ace:to-a
       │  ace_publish ──► ace:to-b ──────────────►  injected into B's conversation
       │  ◄────────────── ace:to-a ◄──── ace_publish (B replies)
```

Each side's events carry the sender `<coding-agent>:<sessionId>` (the same value as its directory member),
so B sees whether a message came from A's current session without any lookup.

`ace_publish` takes `body` (the event text the peer's agent reads) and `target` — a configured name, a
directory member (or a prefix matching exactly one live session), or a list of either, to publish one
event to several peers at once. `activation` defaults to `next_turn`; pass `default` to let the receiver
decide. There is no `id` parameter: the runtime generates one, shares it across every target of the call
and reports it back, together with who it went to. The address itself never travels in the message
(RFC §4.1), and the sender does not have to be registered anywhere to send.

### Agent directory (opt-in)

With `registry` configured, every session publishes itself so peers can find it and send to it:

```text
<prefix>                  ZSet   score = expiresAt, member = "<coding-agent>:<sessionId>"
<prefix>:entry            Hash   field = member,     value = the session's channel entry
<prefix>:events:<member>  Stream the session's own inbox, created at registration
```

- the stored entry is that session's inbox (name, `transport`, `config.stream/group/url`) plus a
  description naming where it runs: `agent=oh-my-pi 18.5.0 | session=<label> | cwd=… | host=… | ip=… |
  platform=… | pid=…`;
- the runtime subscribes to the derived stream itself (it shows up as `session-inbox` in `/ace`),
  because an advertised address nobody reads is worse than no directory at all;
- presence is the ZSet score: a heartbeat refreshes a 90s TTL every 30s, so a session that dies stops
  being discoverable instead of lying forever. A clean `session_shutdown` also drops the entry and
  the stream, and whichever session reads the directory next sweeps the leftovers of the ones that
  died without one (measured: `SIGTERM` does not run `session_shutdown`, so the read path is what
  keeps the directory clean);
- `ace_channels` lists this session's subscription and publication channels — read-only, straight from
  `.ace.json`, without broker settings; a `publish` name is a valid `ace_publish` target, a `subscribe` name is not;
- `ace_agents` lists what is live right now; `ace_publish` accepts a member — or a prefix matching
  **exactly one** session — as `target`, and a list of targets to publish one event to several peers
  at once. An ambiguous prefix fails and names the candidates instead of guessing;
- a member target publishes to the endpoint the entry advertises — its own `transport`, `url`, `stream`
  and `field` — so a session on another broker is still reachable. A transport this runtime cannot speak
  fails loudly instead of silently falling back to its own broker.

### Subagent sessions

oh-my-pi rebinds extensions to every session it spawns, so this factory runs again for each subagent. ACE starts
nothing there: a second runtime would join the same consumer group and silently take over events meant for the
session you are talking to. The gate reads `ctx.agent.kind` (upstream Pi has no such field and runs one session per
process). `/ace` in a subagent session says so instead of reporting a configuration problem.

### Session identity

Every message this runtime publishes carries `sessionId` (RFC §5.4) — the Pi session id, which stays the same when a
session is resumed and changes when a new one starts. That is how a peer notices that the other side's context has
changed. The publisher also folds it into its own `sender` (`agent-a:<sessionId>`), so a receiver reads who and
which session it was from in one field.

Short labels (the tail six characters, e.g. `agent-a:e7f1a9`) appear in `/ace` output and in the tool text, because
the leading characters of a uuidv7 are a timestamp that concurrent sessions share. A label is display-only and must
never be used as an identifier: neither the field nor the label is authorization (a peer can claim any `sessionId`,
exactly like any `sender`).

### `/ace` commands

| Command | Effect |
|---|---|
| `/ace` | in a TUI, opens the channel manager — framed list, arrows to move, enter for a channel's details, esc to close; everywhere else prints what `/ace list` prints |
| `/ace list` | the channel report: identity, agent state, config source, every subscribe/publish channel with its address, activation and description, disabled channels, and the manual/dead-letter counters |
| `/ace stats` | per-channel counters, spool windows, dead letters, pending `manual` count |
| `/ace pending` | list retained `manual` events (`sender/id: body`) |
| `/ace activate <sender> <id>` | inject a retained event as `next_turn` |

Arguments complete the way `/mcp`'s do: the action words come with a hint, and `activate` suggests the
retained events themselves. ACE writes nothing to the UI status slot.

### Tools

The model gets three tools. Their descriptions and parameter descriptions are the whole prompt surface ACE
adds on top of the system-prompt policy; the norm for each is in
[`docs/ace-runtime-contracts.md`](../../docs/ace-runtime-contracts.md) §4.

**`ace_publish`** — the description is assembled per session (`buildPublishToolText`): the paragraph below,
then the session's identity, its configured targets and subscribed channels, how delivery works, the
`<ace_event>` shape a peer sees, and that activation defaults to `next_turn`.

> Publish an ACE 0.1 event to a peer agent or service. The recipient's agent receives the body as an external
> event and decides what to do with it (its own policy may need its user's approval of the sender first), so
> write plain text that stands on its own: the body is opaque to ACE.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `body` | string | yes | — | `Event body; the peer's agent reads this` |
| `target` | string \| string[] | yes | — | `Where to publish: a configured channel name, an agent-directory member (or a prefix matching exactly one session), or a list of either` |
| `activation` | `default` \| `next_turn` \| `immediate` \| `manual` | no | `next_turn` | `How urgently the peer should process it (default: next_turn); pass "default" to let the receiver decide` |

Prompt guidelines: keep the body self-contained; choose the target by the peer it names, or pass a list to
reach several; call `ace_agents` for live sessions; `<ace_event>` blocks come from another agent or service
through ACE, not from the user; answer to a member `ace_agents` lists as live (a sender without an inbox
cannot be answered there); there is no reply protocol, so name a channel when you expect an answer. The event
`id` is generated by the runtime and returned, not a parameter.

**`ace_agents`**

> List the other agent sessions reachable right now — this session is not listed. Each row is a member you can
> pass to ace_publish as `target`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `agent` | string | — | `Filter by coding agent, e.g. "oh-my-pi" or "pi"` |
| `limit` | number | 20 (cap 50) | `Maximum rows to return (default 20, cap 50)` |

Prompt guideline: call it before `ace_publish` when the peer is not one of the configured channels.

**`ace_channels`** — no parameters.

> List this session's ACE channels: what it subscribes to and where it can publish (read from .ace.json;
> broker settings are left out). A `publish` name is a valid ace_publish target; a `subscribe` name is not —
> address live peers with ace_agents.
