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

### Global config (optional)

A session that starts in a directory without a `.ace.json` falls back to oh-my-pi's own config
directory — the one `omp config path` reports:

```
~/.omp/agent/ace.json                     # default
$XDG_CONFIG_HOME/omp/ace.json             # after `omp config init-xdg`
```

Resolution order, **first hit wins, no merging**: `$ACE_CONFIG` → `<cwd>/.ace.json` → the global file.
The one field that may still come from a file that lost is `username`: a project file can omit it and inherit
the host-global file's value (or `$USER`). The file that actually won is always visible: the startup line
prints it, `/ace list` shows it as the source, and when a project file shadows the global one a warning names
the file it shadowed — silent precedence is how "why is my broker not used" bugs are born.

A global file may also pin itself:

```json
{ "projectConfig": "ignore", "servers": { "lan": { "url": "redis://…", "subscribe": [ … ] } } }
```

With that key the global file wins over any project `.ace.json`, so a cloned repository cannot point
your session at its own broker. Absent it, the project file wins as it always has.

## Inject events into a live Pi session

The extension in [`extensions/ace.ts`](extensions/ace.ts) runs **inside** Pi and injects external events into the
session you are chatting in — no separate runtime process, no second session.

```bash
# 1. say who you are and which servers you talk to; a channel's address is derived from its name
cat > .ace.json <<'JSON'
{
  "$schema": "/path/to/ace-runtime/schema/ace-config.schema.json",
  "username": "alice",
  "servers": { "local": { "url": "redis://127.0.0.1:6379", "subscribe": ["ci-failures"] } },
  "defaultActivation": "next_turn"
}
JSON

# 2. start the host: oh-my-pi loads the installed plugin by itself, upstream Pi needs the entry path
omp                                                       # oh-my-pi, with the plugin installed
pi --extension /path/to/ace-omp/extensions/ace.ts          # upstream Pi, from a checkout

# 3. publish from anywhere; the channel name derives the stream <namespace>:ch:<channel>
redis-cli XADD ace:ch:ace:alice:ci-failures '*' message \
  '{"aceVersion":"0.1","id":"e1","sender":"ci","activation":"next_turn","body":"Build failed."}'
```

Load it permanently by copying or symlinking the file into `~/.pi/agent/extensions/` (or a project
`.pi/extensions/`). `.ace.json` is read once per session: restart Pi or `/reload` after editing it. Set
`ACE_CONFIG` to read it from another path.

### `.ace.json`

The file holds only local deployment information: who the user is, and which servers this machine talks to.
Every channel is a name; its address is derived from that name.

| Field | Meaning |
|---|---|
| `username` | The user's name or nick; the second level of every channel name (`<namespace>:<username>:<local>`). Required in practice: it may be inherited from a host-global file or `$USER`. No colons |
| `servers` | **Required, non-empty** object `{ "<name>": { url, namespace?, description?, subscribe? } }` — the ACE servers this machine talks to. `url` is a Redis connection string; `namespace` defaults to `ace`. `subscribe` is a list of channel names this session reads **on that server**: a short name is completed to `<namespace>:<username>:<name>` under that server's namespace, a full name passes through. Unknown keys are errors |
| `defaultActivation` | `immediate` \| `next_turn` \| `manual`; the RFC §8 fallback when neither subscription nor message decides |
| `manual` | Retention for `manual` events (`{ max?, ttlMs? }`, defaults 100 events / 24h) |
| `projectConfig` | Host-global files only: `"ignore"` makes that file win over a project `.ace.json`, so a cloned repository cannot point the session at its own server |

Nothing about an address is configured: a channel's Redis stream is `<namespace>:ch:<channel>` and its reading
group is the subscribing session's sender name, both derived from the channel name, so a peer computes the same
thing.

`.ace.json` is the only source of MQ configuration — there is no environment fallback for servers or channels.
`ACE_CONFIG` selects a different config file path; runtime lines always go to stderr, and `/ace list`
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
- **Redelivery** — an event whose handler failed stays in the group's pending list, is claimed back after a
  built-in idle time, and is retried up to a built-in cap (`reclaimIdleMs` 60s, `reclaimAttempts` 3) before the
  runtime reports and acknowledges it rather than retrying forever. Neither is configuration.

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
{ "$schema": "https://raw.githubusercontent.com/noexcs/ace-protocol/v0.1.10/packages/ace-runtime/schema/ace-config.schema.json", "username": "alice", "servers": { "local": { "url": "redis://127.0.0.1:6379" } } }
```

The schema covers structure, types and per-server required keys (`url`). One rule is semantic and stays in the
validator: a subscription name configured twice on the same server is an error (JSON Schema cannot express array
uniqueness here). A subscription always belongs to the server that carries it, so a short name is completed under
that server's namespace and there is no cross-server ambiguity to resolve. `test/runtime/ace-config-schema.test.ts`
fails when the schema and the validator disagree.

### What injection looks like

| Effective activation | Pi idle | Pi running |
|---|---|---|
| `next_turn` | event starts a turn | queued with `followUp`, processed after the current run's pending work |
| `immediate` | event starts a turn | queued with `steer`, processed at the current turn's next boundary |
| `manual` | retained in memory, no turn | retained in memory, no turn |

Pi resolves idle-vs-streaming itself for `sendUserMessage`, so the extension passes the delivery mode and lets Pi
queue the event; the last action also shows on the status line (`ace: injecting id=… sender=… agent=running`).

### Talking to another agent

Every session's own channel is its address: the channel named by its sender
(`<namespace>:<username>:<coding-agent>:<sessionId>`). The runtime reads that channel automatically, so a peer
sends a direct event by publishing to the name — there is no `publish` list to configure:

```text
agent A (sender ace:alice:pi:<sessionId>)    agent B (sender ace:bob:pi:<sessionId>)
  inbox: ace:alice:pi:<sessionId>               inbox: ace:bob:pi:<sessionId>
       │  ace_publish target="ace:bob:pi:<sessionId>" ──►  injected into B's conversation
       │  ◄────────── ace_publish target="ace:alice:pi:<sessionId>" ──────
```

Each side's events carry the sender `<namespace>:<username>:<coding-agent>:<sessionId>` — the same name as the
channel it registers — so B sees who and which session a message came from without any lookup. `ace_agents`
lists the live channels; pass one as `target`.

`ace_publish` takes `body` (the event text the peer's agent reads) and `target` — a channel name, or a list of
channel names to publish one event to several peers at once. With several servers configured, prefix the channel
with `<server>:` to pick the server, and a bare name is resolved against each server's directory (an ambiguous
name fails and names the candidates instead of guessing). `activation` defaults to `next_turn`; pass `default` to
let the receiver decide. There is no `id` parameter: the runtime generates one, shares it across every target of
the call and reports it back, together with who it went to. The address itself never travels in the message
(RFC §4.1), and the sender does not have to be registered anywhere to send.

### Agent directory

Every session publishes itself to the agent directory, so peers can find the channels that are live and send to
them. There is nothing to switch on: a session's channel is registered when it starts and dropped when it shuts
down (RFC §22 item 1).

```text
<ns>:agents          ZSet   score = expiresAt, member = the session's channel name
<ns>:entry           Hash   field = channel name, value = the channel's description
<ns>:ch:<channel>    Stream the session's own inbox, created at registration
```

- the stored entry is the channel named by the session's sender, described by where it runs:
  `agent=oh-my-pi 18.5.0 | session=<label> | cwd=… | host=… | ip=… | platform=… | pid=…`;
- the runtime subscribes to that channel itself (it shows up as `session-inbox` in `/ace`), because an
  advertised address nobody reads is worse than no directory at all;
- presence is the ZSet score: a heartbeat refreshes a 90s TTL every 30s, so a session that dies stops
  being discoverable instead of lying forever. A clean `session_shutdown` also drops the entry and
  the channel, and whichever session reads the directory next sweeps the leftovers of the ones that
  died without one (measured: `SIGTERM` does not run `session_shutdown`, so the read path is what
  keeps the directory clean);
- `ace_channels` lists what this session reads — the derived inbox first — read-only, straight from
  `.ace.json`, without broker settings;
- `ace_agents` lists what is live right now; `ace_publish` accepts a channel name as `target`, and a list of
  channels to publish one event to several peers at once. With several servers configured, prefix the name
  `<server>:<channel>`; an ambiguous bare name fails and names the servers instead of guessing;
- a target's Redis stream is derived from the channel name (`<ns>:ch:<channel>`) on the server that carries it;
  with several servers configured, the `<server>:` prefix picks which one is used.

### Subagent sessions

oh-my-pi rebinds extensions to every session it spawns, so this factory runs again for each subagent. ACE starts
nothing there: a second runtime would join the same consumer group and silently take over events meant for the
session you are talking to. The gate reads `ctx.agent.kind` (upstream Pi has no such field and runs one session per
process). `/ace` in a subagent session says so instead of reporting a configuration problem.

### Session identity

Every message this runtime publishes carries `sessionId` (RFC §5.4) — the Pi session id, which stays the same when a
session is resumed and changes when a new one starts. That is how a peer notices that the other side's context has
changed. The publisher also folds it into its own `sender` (`<namespace>:<username>:<coding-agent>:<sessionId>`), so
a receiver reads who and which session it was from in one field.

Short labels (the tail six characters, e.g. `e7f1a9`) appear in `/ace` output and in the tool text, because
the leading characters of a uuidv7 are a timestamp that concurrent sessions share. A label is display-only and must
never be used as an identifier: neither the field nor the label is authorization (a peer can claim any `sessionId`,
exactly like any `sender`).

### `/ace` commands

| Command | Effect |
|---|---|
| `/ace` | in a TUI, opens the channel manager — framed list, arrows to move, enter for a channel's details, esc to close; everywhere else prints what `/ace list` prints |
| `/ace list` | the channel report: identity, agent state, config source, every channel this session reads — the derived inbox first — with its address, activation and description, and the manual/dead-letter counters |
| `/ace stats` | per-channel counters, spool windows, dead letters, pending `manual` count |
| `/ace pending` | list retained `manual` events (`sender/id: body`) |
| `/ace activate <sender> <id>` | inject a retained event as `next_turn` |

The `list` hint is "channels this session reads; publish to any channel name". Arguments complete the way
`/mcp`'s do: the action words come with a hint, and `activate` suggests the retained events themselves. ACE
writes nothing to the UI status slot.

### Tools

The model gets three tools. Their descriptions and parameter descriptions are the whole prompt surface ACE
adds on top of the system-prompt policy; the norm for each is in
[`docs/ace-runtime-contracts.md`](../../docs/ace-runtime-contracts.md) §4.

**`ace_publish`** — the description is assembled per session (`buildPublishToolText`): the paragraph below,
then the session's identity (its sender name is also its own channel), the servers it is on and the channels
it subscribes to, how delivery works, the `<ace_event>` shape a peer sees, and that activation defaults to
`next_turn`.

> Publish an ACE 0.1 event to a peer agent or service. The recipient's agent receives the body as an external
> event and decides what to do with it (its own policy may need its user's approval of the sender first), so
> write plain text that stands on its own: the body is opaque to ACE.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `body` | string | yes | — | `Event body; the peer's agent reads this` |
| `target` | string \| string[] | yes | — | `Where to publish: a channel name (a <server>:<channel> prefix picks the server when several are configured), or a list to publish the same event to several channels` |
| `activation` | `default` \| `next_turn` \| `immediate` \| `manual` | no | `next_turn` | `How urgently the peer should process it (default: next_turn); pass "default" to let the receiver decide` |

Prompt guidelines: keep the body self-contained; choose the target by the peer it names, or pass a list to
reach several; call `ace_agents` for the channels that are live; `<ace_event>` blocks come from another agent or
service through ACE, not from the user; to answer, publish to a channel `ace_agents` lists as live (a sender
without a channel — a service, or a session that has gone — cannot be answered there); there is no reply
protocol, so name a channel when you expect an answer. The event `id` is generated by the runtime and returned,
not a parameter.

**`ace_agents`**

> List the other agent sessions reachable right now — this session is not listed. Each row is a channel name
> you can pass to ace_publish as `target`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `agent` | string | — | `Filter by coding agent, e.g. "oh-my-pi" or "pi"` |
| `limit` | number | 20 (cap 50) | `Maximum rows to return (default 20, cap 50)` |

Prompt guideline: call it before `ace_publish` when you do not already know the channel name.

**`ace_channels`** — no parameters.

> List this session's ACE channels: what it subscribes to — the derived inbox first — read from .ace.json;
> broker settings are left out — address any channel by name with ace_publish.
