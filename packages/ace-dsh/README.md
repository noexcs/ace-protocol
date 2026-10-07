# ace-dsh — ACE 0.1 for DeepSeek Harness

External events — CI results, alerts, another agent — as an **active** input to a running DeepSeek Harness
session, instead of something the session polls for.

```text
External world ──► Redis Streams ──► ACE runtime ──► this plugin ──► agent inbox ──► LLM
                    (transport)      validate → activation → followup/steer/retain
```

This is the second host implementation of [ACE 0.1](../ace-runtime). The protocol, the validation, the
activation rules, the transports, the deduplication, the file transfer and the entire model-facing tool
text come from the core (`ace-runtime`), vendored here as a build copy. What this package adds is the
host binding: which live agent a call belongs to, when a channel is registered, and how an event reaches
a session's conversation on **DeepSeek Harness** rather than on Pi.

Because it speaks the same wire protocol and the same channel naming, a session here and a session on
`oh-my-pi` can talk to each other over one Server with no translation: `ace_agents` lists both, and
`ace_publish` addresses either.

## Status

Verified on 2026-10-06 without a model turn:

- `npm test` — **61 tests, 5 files**, all passing. The core runs for real; only the Server is faked.
- `npm run verify:live` — **7 of 7 scenarios** against a real `redis-server` on 6379: the directory, a
  published event reaching the peer's conversation, `manual` retention and activation, the self-echo, a
  non-conforming message being dropped, teardown withdrawing the address and the stream, and an
  unreachable server leaving the session not-live rather than half-live.
- `npm run verify:bundle` — **6 of 6 scenarios** against the artifact that is actually installed: the tool
  surface, the channel chip's status route, the listing rule, delivery through the host's own `defineTool`,
  and teardown.
- `npm run verify:client` — **6 of 6 scenarios** for the browser half, loaded through a `__ModuleLoader__` shim
  against a Slots fake whose contract is the real one (registering into an undeclared seat throws): the entry
  activates without the seat, the contribution lands when the owner declares it, a broken slots service cannot
  fail the entry, and the chip's five states render as documented.
- Installed and exercised inside one desktop profile, without a model turn: a session registered a channel,
  a published event arrived in its conversation, and the registration was withdrawn when the session ended.
- Not yet verified against a live model turn.

## What one session gets

| | |
|---|---|
| **Its own channel** | `<namespace>:<username>:dsh:<sessionId>` — registered in the Server's directory while the session is live, withdrawn when it ends. That name *is* the address a peer publishes to. |
| **Its own inbox** | The same channel, read in a consumer group named after it — so two sessions are two readers, never one queue split between them. |
| **Six tools** | ACE's four (`ace_publish`, `ace_agents`, `ace_store_file`, `ace_get_file`) plus this host's two (`ace_pending`, `ace_activate`), registered on the agent's own scope. A session with no configuration sees none of them. |
| **A channel chip** | In the composer's tool row: a green dot with the channel's session tail while the session is registered. See [the chip](#the-channel-chip). |
| **`/ace`** | Status, live peers, held events, and `activate`. Its reports are written into the session record like any other output. |
| **The trust policy** | `ACE_TRUST_POLICY` joins the system prompt: an `<ace_event>` block is external text from a *claimed* sender, and the policy says how to read it and when to ask the user. |

### The channel chip

The one piece of state a person needs at a glance — *is this session reachable right now* — is shown in the
composer's tool row, left of the model selector: a green dot with the channel's session tail (`ACE · 2fb362`,
the same short label ACE's own reports use) while the session is registered. Hovering shows the full channel;
clicking re-reads immediately, and the chip re-reads every 15 seconds.

It never overclaims. Five states, because "not registered" and "could not tell" are different facts:

| | |
|---|---|
| `ACE · <tail>` (green) | registered; the directory holds this channel |
| `ACE off` (grey) | the route answered and the host reports no channel for this session |
| `ACE !` (amber) | the route could not be read at all — a missing route, a refused request |
| `ACE ?` (amber) | the seat passed no session id, so nothing could be asked |
| `ACE …` (amber) | a read is in flight |

It is a **client half** in this same package (`src/client.js` → `lib/client.js`, declared under `dsh.client`),
registered into the `conversation.input.left` seat. It reads
`GET /api/ace.status?session=<id>` — an exact Fetch route the host half registers on **Connection**, so the
request passes Connection's Host/Origin fence and browser-session check before the handler runs, and only the
asked-for session's channel is ever returned. A profile without Connection (headless, SDK) registers no route
and the plugin still loads; the chip then reads as off, which is the honest reading.

> Adding a client half to a package that is **already installed** needs one application restart: the host
> caches each plugin's package metadata (its `dsh.client` declaration) until restart, so a corrected
> declaration is not re-read from a reload alone. Later client-side edits take a page refresh.


### Activation

| `.ace.json` / message | What happens to the session |
|---|---|
| `immediate` | `steer()` into the running turn; `followup()` when the session is idle, which starts a turn |
| `next_turn` | `followup()` — queued for the next turn, waking the session when it is idle |
| `manual` | Retained in memory; nothing is delivered until `/ace activate <sender> <id>` |

The receiver's own subscription can override what the sender asked for; the core owns that precedence
(RFC §8), this host only executes the result.

## Configuration

`.ace.json` in the session's working directory — the same file ACE uses everywhere:

```json
{
  "username": "you",
  "servers": { "local": { "url": "redis://127.0.0.1:6379", "namespace": "ace" } },
  "defaultActivation": "next_turn"
}
```

Resolution order: `$ACE_CONFIG`, then `<cwd>/.ace.json`, then `$DSH_HOME/ace.json`. It is read **once**,
when the session is created, so an edit takes effect in the next session.

**Live channels only.** A session reads the channel its own sender names, and nothing else. `subscribe`
entries in `.ace.json` (`"subscribe": ["ci-failures"]`) name *persistent* channels — topics and services
with no live session behind them — and this host does not read them: they are reported by `/ace` and in
the session log, never silently dropped. Direct messages always work without any `subscribe`.

A session with no configuration file anywhere is completely inert: no Server connection, no directory
entry, no tools, no prompt section.

## Session lifecycle

One process runs many sessions, so the runtime is **per agent** and lives exactly as long as the agent.

**Registering** — on `agent/created` (awaited and rollback-covered, so a session that fails cannot leave a
registration behind):

1. resolve `.ace.json` from the session's own working directory — no file, no further work;
2. create each server's consumer group **at the tail** (`ensureStream`);
3. publish the directory entry (`put`) — the order matters: an event published the instant a peer sees the
   address is still pending for the consumer that starts a moment later;
4. start reading (`runtime.start()`).

A server that cannot be reached is skipped and reported; a session with no server at all still exists and
answers `no agent directory` rather than taking the agent down.

**Unregistering**:

- `agent/disposed` stops the reader first, then removes the directory entry and drops the stream, then
  closes the clients. That order is `shutdownAce`'s, from the core: dropping the stream first would leave
  the reader waking up on a deleted group. The agent's scoped registrations unwind on their own; this
  teardown is the Server's half.
- A plugin unload or HMR reload stops every session it opened — otherwise a reload would leave a reader
  consuming a channel the new plugin instance knows nothing about. Sessions that were already live when
  the plugin loaded are registered at that point instead, because no `agent/created` will fire for them.
- A process killed without any of this needs nothing: a directory entry is a lease (90s) that a live
  session renews every 30s, and an expired entry is pruned — together with its stream — by whoever reads
  the directory next.

## Install

The plugin is installed into a profile as a single tarball; it is not part of any shipped bundle.

```bash
# any profile the CLI manages:
dsh plugin --profile <profile> add \
  https://github.com/noexcs/ace-protocol/releases/download/ace-dsh-v0.1.2/ace-dsh-0.1.2.tgz
# then restart the host so the profile recomposes
```

`lib/index.js` is bundled (the vendored core is inlined), so the tarball is self-contained.

**The desktop application's profile is managed by the app** — `dsh plugin --profile desktop` is refused — so
install there through the app's plugin manager, or by hand: add the URL to the profile's `package.json`
`dependencies` and the package name to `dsh.profile.bundles`, then restart.

A profile composes `dsh` bundles; the package's `dsh.bundle.patch` inserts one entry:

```yaml
- insert:
    - id: ace-dsh
      name: 'ace-dsh'
```

## Development

```bash
npm install                  # host packages pinned to the running host's exact version
npm run sync:vendor          # the core build this package imports by relative path
npm test                     # unit + integration tests, no Server and no model needed
npm run verify:live          # two real sessions against a real Redis (redis-server, no model needed)
npm run check                # biome + tsc
```

| Path | What it is |
|---|---|
| [`src/index.ts`](src/index.ts) | The Cordis plugin: lifecycle, per-agent registration, tool/command/prompt binding |
| [`src/session.ts`](src/session.ts) | One agent's ACE session: registration order, directory, transports, teardown |
| [`src/engine.ts`](src/engine.ts) | `AgentEngine`: activation → `followup` / `steer` |
| [`src/tools.ts`](src/tools.ts) | The four tools, over the core's own validation and result text |
| [`src/command.ts`](src/command.ts) | `/ace` |
| [`src/dsh.ts`](src/dsh.ts) | The host seam, as structure rather than an import |
| [`test/support/harness.ts`](test/support/harness.ts) | An in-memory Server and a fake agent: the core runs for real, the Server is faked |
| [`vendor/ace-runtime/`](vendor/ace-runtime) | The core build this package imports (regenerate with `npm run sync:vendor`) |

## Differences from the Pi host (`ace-omp`)

| | `ace-omp` (Pi) | `ace-dsh` (DeepSeek Harness) |
|---|---|---|
| Runtime scope | One process, one session; a module global | One process, many sessions; one runtime per agent |
| Tools | Registered globally, re-registered once config is known | Registered on the agent's own scope, only when a config exists |
| Consumer group | Inbox group = channel name; configured subscriptions use the group written in the file | Inbox group = channel name (there are no configured subscriptions) |
| Delivery wait | Waits until the event appears in the conversation before acknowledging, because a queued `followUp` on an idle session could sit forever | No wait: `followup`/`steer` admit to the durable inbox and that admission is the commit point |
| Persistent channels | Read (`subscribe`) | Not read; reported |
| File transfer | Yes | Yes |
| Human face | An interactive `/ace` panel (arrow keys, `esc`) | `/ace` reports into the session record |
| At-a-glance state | A footer status line (`ctx.ui.setStatus`) | A composer chip, fed by an exact Fetch route on Connection |

## Known limitations

- **No connection sharing.** Each session opens its own clients, as the core's registry and transports do.
  A deployment with many live sessions pays one connection each.
- **Dead letters are written; the burst spool is not.** An entry the reader gives up on (its
  `reclaimAttempts` budget spent) is appended to `<cwd>/.ace/dead-letter.<timestamp>.jsonl` — the same directory
  and format the Pi host uses — before it leaves the pending list, so the loss is recoverable
  (`npm run replay:dead-letters`) and countable in `/ace stats`. Bursts beyond `deliveryQueueLimit` are not
  spooled to a file the way the Pi host spools them; they stay in the pending list.
- **Configuration is read once**, at session creation. There is no `/ace reload`.
- **`/ace` is registered but not dispatched by the client.** The command exists in the host's catalog (and its
  reports are correct when invoked), but typing `/ace …` in the composer reaches the model as plain text
  instead — a client-side command-routing gap, not a host one. The tools are the working surface meanwhile.
- **One quarantine directory for fetched files**, derived from the session's working directory (the core's
  `quarantinePath`), not a per-plugin setting.
