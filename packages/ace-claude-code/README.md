# ace-claude-code

ACE (Agent Context Event Protocol) 0.1 for **Claude Code**: an installable plugin that turns broker
events (CI results, alerts, other agents) into *turns* in a live session, using the host's own
[message channels](https://code.claude.com/docs/en/channels-reference) instead of re-hosting the model.

It reuses [`ace-runtime`](../ace-runtime/README.md) wholesale — `resolveAceConfig`,
`createTransports`, `subscriptionEndpoint`, `AgentRegistry`, `AceRuntime`, spooling, dead-lettering,
dedup and metrics. The one thing it does not
reuse is the delivery observer: `ace-runtime`'s matches a fed text by *equality*, which fits Pi (the
host echoes the exact string it was given) but cannot work here, because Claude Code wraps our block in
its own `<channel>` tag — so the plugin ships its own `ChannelObserver`, a substring matcher. Nothing
re-implements the protocol; it is the *Claude Code agent engine* plus the host shims the channel
requires (a `notifications/claude/channel` push, an observation hook, and the substring observer).

Protocol semantics come from [`ACE-RFC-Draft-0.1.md`](../../docs/ACE-RFC-Draft-0.1.md); engineering
decisions from [`ace-v0.1.md`](../../docs/ace-v0.1.md); config keys and delivery invariants from
[`ace-runtime-contracts.md`](../../docs/ace-runtime-contracts.md). This plugin inherits all of them.

```text
External World
      │
      ▼
┌──────────────┐   raw message    ┌───────────────────────────────┐
│  Transport   │ ───────────────► │          ACE Runtime          │  (ace-runtime, unchanged)
│ Redis Streams│ ◄─────────────── │ decode → validate → resolve   │
└──────────────┘  ack / redeliver │ activation → dispatch         │
                                  └───────────────┬───────────────┘
                                       inject ────┘  manual: hold in pending store
                                             │
                                             ▼
                                  ┌─────────────────────────────┐
                                  │   ClaudeCodeEngine          │  renders <ace_event>
                                  │  push + wait-observed-ack   │
                                  └──────────────┬──────────────┘
                                             │  notifications/claude/channel
                                             ▼
                                  ┌─────────────────────────────┐
                                  │      Claude Code (host)     │  wraps in <channel source=… ace="event">
                                  │  idle → starts a turn;      │
                                  │  busy → queues to next turn │
                                  └──────────────┬──────────────┘
                                                 │  self-started prompt carries the block
                                                 ▼
                                  ┌─────────────────────────────┐
                                  │  UserPromptSubmit hook       │  extracts the <ace_event> block
                                  │  → .ace/ack-observed.jsonl  │
                                  └──────────────┬──────────────┘
                                                 │  polled
                                                 ▼
                                   runtime acks the broker only once observed
```

## Install

The plugin is a directory; Claude Code loads it as one unit. There is no build step — the MCP server
and the hook are TypeScript run as-is by Bun (the `start` script runs `bun install` first, so the
host can launch it on a clean checkout).

The `start` script and its launch command (`bun run --cwd "${CLAUDE_PLUGIN_ROOT}" --shell=bun --silent start`)
were run against a real MCP `initialize`/`tools/list` handshake: the server answered as `ace`,
declared the `claude/channel` capability, and listed the four tools. See [Verification](#verification)
for the exact output.

### For one session (no install, nothing persisted)

Pass the plugin root to Claude Code. It loads in place for that session only and registers as
`ace-claude-code@inline` (verified with `claude --plugin-dir <dir> plugin list` → `Status: ✔ loaded`):

```bash
cd /path/to/ace-protocol/packages/ace-claude-code   # or anywhere you keep a copy
claude --plugin-dir "$PWD"
```

Uninstall: close the session. Nothing is written to any settings file.

### Persistent (every session)

To have it load every session without the flag, the plugin must be listed in a marketplace (that is
how Claude Code installs plugins by name and how the host tracks an install for uninstalling it). A
marketplace root is any directory holding `.claude-plugin/marketplace.json`; each plugin entry says
where to fetch it. If the plugin is a subdirectory of your marketplace repository, list it with a
relative source:

```json
{
  "name": "ace",
  "owner": { "name": "you" },
  "plugins": [
    {
      "name": "ace-claude-code",
      "source": "./packages/ace-claude-code",
      "description": "ACE 0.1 channel for Claude Code — broker events become turns in a live session"
    }
  ]
}
```

Then, once, on the machine:

```bash
# add the marketplace (a GitHub repo, a git URL, or a local directory)
claude plugin marketplace add <owner>/ace-plugins          # or: /path/to/ace-plugins
# install — in a session: /plugin install ace-claude-code@ace
# or from your shell (user scope by default):
claude plugin install ace-claude-code@ace

# uninstall later — from your shell, or /plugin → Installed tab → Uninstall:
claude plugin uninstall ace-claude-code@ace
```

This repository ships the plugin at `packages/ace-claude-code`; it does not itself host a marketplace,
so the one-session `--plugin-dir` path above is the simplest way to use it, and a marketplace is needed
only when you want it (or teammates) to load it persistently.

### The channel flag (research preview)

Channels are a [research preview](https://code.claude.com/docs/en/channels#research-preview) and a
custom channel is not on the approved allowlist, so it will not register without the development flag.
From the session directory, load the channel with:

```bash
claude --dangerously-load-development-channels plugin:ace-claude-code@inline --plugin-dir /path/to/ace-claude-code
```

(`--plugin-dir` loads the plugin; the flag lets the *channel* register. The id `ace-claude-code@inline`
is what `--plugin-dir` registers — confirm yours with `claude --plugin-dir <dir> plugin list`.) Once
the plugin is on the allowlist (an official listing, or an organization's
[`allowedChannelPlugins`](https://code.claude.com/docs/en/channels#restrict-which-channel-plugins-can-run)),
the flag is not needed.

The flag is per-entry: it only allows `plugin:ace-claude-code@inline`, and it skips the allowlist —
the `channelsEnabled` organization policy still applies.

## Configure

Every session whose working directory holds a `.ace.json` starts ACE — the same rule as the Pi host.
The file is read by the reused `resolveAceConfig`, so it accepts exactly the
[contract's keys](../ace-runtime/README.md#configuration): `username`, `servers` (each with an optional
`subscribe[]`), `defaultActivation` and `manual`. It holds **local deployment information only** — who this user
is and which servers this machine talks to; channels, subscriptions and presence live on a server. The
two JSON Schemas under [`schema/`](schema/) are byte-identical to `ace-runtime`'s, so the same file
works on both hosts.

A channel **name** is the address. A `subscribe` entry belongs to the server that carries it: a short name is
uploaded as `<namespace>:<username>:<name>` under *that server's* namespace, a full name passes through. Its
stream key is derived from the name
(`<namespace>:ch:<name>`), and this session's own inbox is the channel named by its sender
(`<namespace>:<username>:<codingAgent>:<sessionId>`). There is no `publish` list: `ace_publish` takes
any channel name as its `target`.

[`example/.ace.json`](example/.ace.json) is a working default: user `claude` on one server `local`
(`redis://127.0.0.1:6379`, namespace `ace`), subscribing to the channel `inbox` — uploaded as
`ace:claude:inbox`. Copy it to your project and change the `url` to your broker:

```bash
cp example/.ace.json /path/to/your/project/.ace.json
```

Broker settings (url, namespace, credentials) live in `servers`; the stream, group and field are
transport details derived from the channel name, not part of the ACE message. `$VAR` interpolation
from the environment is supported, so a broker password never has to be committed.

### Agent directory (automatic)

Registration is not a configuration block: a session with one registers the channel named by its
sender on **every** server in `.ace.json`. The shared directory is then what lets peers address a live
session by name:

- **Identity** comes from `CLAUDE_CODE_SESSION_ID`, which the host injects into the server process.
  Without it there is no sender name to register under, so the plugin logs
  `no session id was injected (CLAUDE_CODE_SESSION_ID) …` to stderr and starts anyway, reading only
  the configured channels.
- **The channel name is the address.** The session's inbox *is* the channel named by its sender
  (`<namespace>:<username>:<codingAgent>:<sessionId>`): the runtime registers that channel in the
  directory and appends a derived subscription named `session-inbox`, so somebody is reading what the
  directory advertises. `ace_channels` lists it alongside the configured channels, and the
  `ace_publish` description names it — the string a peer passes as `target`.
- **One registration per server.** A session on several servers gets one channel per server, named in
  that server's namespace; the derived local inbox labels are prefixed with the server name so nothing
  collides.
- **A down server is skipped, not fatal.** An unreachable broker is reported to stderr and that
  server's channel is not registered or read; the rest of the session still runs.
- **Shutdown order matters.** The reader stops first; then each directory entry is removed and the
  session's channel stream dropped; then each registry client closes, and the publish writers last.
  Removing the entry first would leave the reader waking up on a deleted group, reporting `NOGROUP` on
  the way out.

With no `.ace.json`, the server still connects and exposes the tools, but they report
"ACE is not running in this session" until one exists — no broker connection is attempted. With a
`.ace.json` present, the runtime is live only when its broker is reachable: `AceRuntime.start()`
awaits the subscribe transport's `connect()`, which throws once its bounded reconnect budget is spent,
so a down broker leaves the tools reporting not running (the server logs the reason to stderr and the
session stays inert until the broker is back and the session restarts).

One platform caveat: the plugin resolves `.ace.json` and the `.ace/` state from the host-injected
`CLAUDE_PROJECT_DIR`, which the host sets for both the hook and the MCP server process — but that
injection is **not guaranteed on every platform**. When it is missing, the server falls back to its
own working directory (the plugin root, since it is launched with `--cwd ${CLAUDE_PLUGIN_ROOT}`) and
prints a warning to stderr, so a mis-resolved state path is visible rather than silent.

## Capability matrix

Which ACE activation modes work through the channel, and how:

| Activation | On this host | What the plugin does |
| --- | --- | --- |
| `next_turn` | **Yes** | Pushed as a channel notification. The host injects it and **starts a turn when the session is idle**; while busy it is queued and delivered on the next turn, grouped with any others. |
| `immediate` | **No — collapsed to `next_turn`** | The channel cannot splice text into a model request already in flight. The plugin pushes `immediate` byte-for-byte the same as `next_turn` (proven in `test/engine.test.ts`), so it reaches the model at the next step boundary (when running tools finish) or on the next turn — the host's own delivery behavior, the closest the channel gets. |
| `manual` | **Hold; released on explicit activation** | A `manual` event is **not pushed**. The runtime stores it in its pending store and the host never sees it. It is released only when `ace_activate` is called, at which point it is injected as a `next_turn` channel event. |

`manual` release is tool-driven: `ace_pending` lists the held events, `ace_activate {sender, id}`
releases one. There is no host UI button; the model (or you, by asking it) makes the call.

The agent directory is orthogonal to activation. A session with a session id registers the channel
named by its sender on each server, serves the derived `session-inbox` subscription on that channel's
stream, and disappears again — entry and stream both — when the session closes. Events that arrive on
that inbox are subject to the activation rules above exactly like events on any configured channel.

### Gating (research preview)

- **Research preview / Anthropic auth only.** Channels require Anthropic auth (a claude.ai account or a
  Console API key). They are unavailable on Amazon Bedrock / Google Cloud Agent Platform / Microsoft
  Foundry. Team and Enterprise must set `channelsEnabled` and, for a custom channel, list it in
  `allowedChannelPlugins`.
- **Allowlist.** A custom channel is not on the approved allowlist, so it registers only with
  `--dangerously-load-development-channels plugin:<id>` (above) or after an official listing.
- **Fire-and-forget delivery.** "Claude Code doesn't acknowledge notifications. The `await` on
  `mcp.notification()` resolves when the message is written to the transport, not when Claude has
  processed it. If the session hasn't loaded your server as a channel, or the organization policy
  blocks it, Claude Code drops the events silently and returns no error." —
  [channels-reference](https://code.claude.com/docs/en/channels-reference#send-events). So "handed to
  the host" ≠ "the model read it," and a blocked channel fails silently. The plugin's acknowledgement
  story below is what stands in for the missing host ack.
- **The wrapper is the host's.** The host sets the `<channel source="…">` tag; the server controls only
  the `ace="event"` attribute (from `meta`) and the body. For this plugin the tag is
  `<channel source="plugin:ace-claude-code:ace" ace="event">`.

## Acknowledgement

The ACE contract acks a message **only after it is observed in the conversation** — a broker message is
acknowledged, not just received. The channel gives no such signal, so the plugin reconstructs it from the
one host surface that sees every turn: the `UserPromptSubmit` hook.

The loop, end to end:

1. The runtime renders the event to an `<ace_event>` block and **pushes it and then waits** —
   `ClaudeCodeEngine.inject` registers an observation for that exact text and resolves only when it is
   seen, or throws after `ackTimeoutMs` (default 30s, below the transport's 60s reclaim so a timed-out
   event is redelivered rather than stranded).
2. The host injects the channel event as a **self-started prompt** carrying the block. The
   `UserPromptSubmit` hook ([`hooks/hooks.json`](hooks/hooks.json) → [`src/hook-observe.ts`](src/hook-observe.ts))
   runs on that prompt, extracts every `<ace_event>` block, and appends them to
   `.ace/ack-observed.jsonl` (capped to a 256 KiB tail). It always exits 0 — a failed write just means
   the event is not acknowledged this pass.
3. The MCP server's poller re-reads the trail every 250 ms and feeds each observation to the plugin's
   `ChannelObserver`. It resolves a pending injection when its **exact rendered text appears as a
   substring of the prompt the hook saw** — which is what holds on this host, where the event is a run
   *inside* the host's `<channel …>` wrapper and may sit among several events in one batched prompt.
   (The core `AceDeliveryObserver` cannot do this: it resolves only when a fed text is *equal* to a
   rendered event, and the wrapper guarantees the whole prompt is never equal to one.)
4. Only then does the runtime acknowledge the broker. A timed-out observation releases its waiter (by
   the exact text it was observed with, so a context-rendered `channel:` header cannot strand the key)
   so the transport redelivers.

**Proven** (run in `test/` and `scripts/smoke.ts`, no host): the hook extracts a block from a
host-wrapped prompt and writes it to the trail and exits 0; `ChannelObserver` resolves a pending event
from a host-wrapped prompt and from a batched prompt, resolves nothing for an unrelated prompt, stops
resolving once the engine releases it, and still resolves when a body contains a literal `</ace_event>`
(the case a block-extraction matcher truncates and misses); the engine resolves on observation and
throws on timeout; the trail read/offset/cap round-trips.

**Not proven here** `[UNVERIFIED]`: the host-side premise — that a channel-injected event surfaces in a
`UserPromptSubmit` hook's `prompt` field, and that the host wraps the block **verbatim**. The channel
docs say channel messages "inject directly in this session" and are processed in order, but they do not
spell out the exact text a `UserPromptSubmit` hook sees for a channel event. If the host rewrites the
block's bytes rather than wrapping them, the rendered text is no longer a substring of the prompt, the
observation times out, and the event is redelivered — never acknowledged for something the model may
never have read. Until a live channel run confirms the hook sees the block verbatim, the acknowledgement
is *at least* "acknowledged when the rendered text is seen in a subsequent prompt, else redelivered
after the timeout" — never weaker than the transport's reclaim.

## Tools

The plugin exposes four tools to the model (all broker settings are left out of the model-facing text;
they are the operator's, not the agent's):

| Tool | Purpose |
| --- | --- |
| `ace_channels` | List this session's channel names (with their activation) and the derived `session-inbox` when it is registered. Display only — never an authorization. |
| `ace_publish {body, target, activation?}` | Publish a valid ACE 0.1 event from this session to a channel name (`<server>:<channel>` picks the server; a short name is completed with the server's namespace and user). Carries the session as `sender` (`<namespace>:<username>:<codingAgent>:<sessionId>`) and `sessionId`. |
| `ace_pending` | List the `manual` events this session is holding, as `sender/id`. |
| `ace_activate {sender, id}` | Release one held `manual` event; it is injected as a `next_turn` channel event. |

The model is told, in the channel `instructions` it receives on connect, that blocks of the form
`<channel source="plugin:ace-claude-code:ace" ace="event">…</channel>` are external input, not the user
typing — that is what lets it tell an ACE event apart from a real prompt.

## Verification

The gates for this package (`npm run check`, `npm test`, `npm run smoke`):

- `biome check --error-on-warnings .` — 17 files, 0 diagnostics, no warnings.
- `tsc --noEmit` — clean.
- `vitest --run` — **50/50 pass**, no host or broker: the event→notification mapping, the ack trail
  (extract/append/read/cap), the `ChannelObserver` substring matching (wrapped, batched, no-match,
  released, and the `</ace_event>`-in-body edge), the engine's observe/timeout/release logic, the
  agent-directory wiring (the channel named by the sender, the derived `session-inbox`, per-server
  isolation, the stop→unregister→close→writers order, skip-on-unreachable, the no-session-id degrade,
  and publish-target resolution), tool behavior, and config resolution over the shipped example.
- `bun run scripts/smoke.ts` — drives the **real** server over an MCP stdio handshake (the SDK `Client`
  the host uses), verifies the `claude/channel` capability, the four tools, the `instructions`, inert
  `ace_channels`, the hook→trail path, and `claude plugin validate`. The resolved-`ace_channels` half
  needs a live broker (the runtime's `start()` awaits the subscribe transport's `connect()`), so the
  smoke probes the example config's Redis URL and **skips that half with a reason** when no broker is
  up; the live channel is likewise gated: it probes whether the host **accepts** the development flag
  (both channel flags are hidden from `--help`, so the probe parses instead of grepping) and prints the
  exact command either way.

Run it:

```bash
cd packages/ace-claude-code
bun install
bunx biome check --error-on-warnings . && npx tsc --noEmit   # check
npx vitest --run                                              # test
bun run scripts/smoke.ts                                      # smoke
```

The live end-to-end — publish an ACE event to a subscribed channel's stream (or send this session a
direct event at the channel named by its sender) and watch it appear in a running session as a
`<channel … ace="event">` block that starts a turn — needs a channel-capable
Claude Code (the development flag, or an allowlist entry) and Anthropic auth. Both halves of the
*broker* side were exercised for real: the smoke starts the runtime over a live Redis (including the
agent-directory half: registration, a direct delivery, the ack, and the shutdown cleanup). The *host*
half — the channel actually injecting the block and starting a turn — was not performed
`[UNVERIFIED]`, because it needs Anthropic auth, and this plugin is not on the approved channel
allowlist. Note the earlier version of this section claimed the development flag was missing here:
that came from grepping `--help`, which **hides** both channel flags. Probed by parsing, Claude Code
2.1.289 on this machine accepts them.

## Current state and open gaps (2026-10-05)

**What the tools are.** MCP tools served by one stdio MCP server (`src/server.ts`,
`@modelcontextprotocol/sdk`): `ace_publish`, `ace_channels`, plus `ace_pending` /
`ace_activate` for `manual` events. The host offers **no native tool extension point** — a plugin may
contribute `skills`, `commands`, `agents`, `hooks`, `mcpServers`, `lspServers`, `outputStyles`,
`workflows`, themes/monitors/evals, `settings` and `channels`, and only `mcpServers` can add a
model-callable tool. MCP is therefore not a preference here, it is the only mechanism.

**What the channel is.** An orthogonal, separate mechanism: a channel is *an MCP server that pushes
events into a running session* (research preview). This plugin binds it via
`"channels": [{ "server": "ace", "displayName": "ACE" }]`. Tools and channel happen to live in the
same server, but they are two independent surfaces — the channel is never a substitute for the tools,
and the tools never deliver events.

**Open gaps**

1. **The manifest declares `channels` but not `mcpServers`.** Today the `ace` server is reachable
   only through the channel path, so on a build where the channel does not register (not on the
   approved allowlist and started without the development flag, or an organization that has not
   enabled channels) the tools most likely disappear with it. Adding an `mcpServers` entry should make
   the tool surface independent of the channel gate. Unverified: whether one server name may appear in
   both `channels` and `mcpServers`, and how the host merges them — one real run settles it.
2. **The tool text is copied, not shared.** The texts duplicate the runtime's tool spec; the
   core-spec subduction batch in `docs/ace-plan.md` removes that.
3. **The host does not acknowledge channel notifications** ("fire-and-forget"), so the broker ack is
   reconstructed from the `UserPromptSubmit` hook observation — see [Acknowledgement](#acknowledgement).

**Verified on 2.1.289**: `claude --plugin-dir <pkg> plugin list` → `ace-claude-code@inline`,
`Status: ✔ loaded`; biome/tsc clean; vitest 41/41; `scripts/smoke.ts` green including the live
registry half (registration, direct delivery, ack, shutdown cleanup). Both
`--dangerously-load-development-channels` and `--channels` **parse** on this build — they are hidden
from `--help`, which is why the smoke probes by parsing rather than grepping the help text.
**Not verified**: a host-driven turn (needs Anthropic auth plus the development flag) and the host
injecting `CLAUDE_CODE_SESSION_ID` under a real spawn.

## What is and is not modified

Nothing outside `packages/ace-claude-code/` is touched: `ace-runtime` and the rest of the repository are
used, not modified. The vendored `vendor/ace-runtime/` is a byte-identical copy of the `dist/` that
`ace-runtime` builds — the compiled barrel imports only `redis` and Node builtins, the Pi adapter's
`@earendil-works/*` imports being type-only and erased at compile — so the vendored `package.json`
declares just `redis` as a runtime dependency. It is wired in as a `file:` dependency so the host never
needs to resolve the workspace. No host source file is patched; the plugin is installed by the host's
own mechanism and removed by the host's own command.
