# ace-codex

ACE (Agent Context Event Protocol) 0.1 **bridge** for [Codex](https://github.com/openai/codex). It makes external
events — CI results, alerts, peer agents — an *active* input to a live `codex app-server` session instead of
something the agent has to be told about by a human.

Protocol semantics come from [`ACE-RFC-Draft-0.1.md`](../../docs/ACE-RFC-Draft-0.1.md); the ACE side (validation,
activation resolution, transports, the `AgentEngine` seam, the delivery observer, the pending store for `manual`
events) is **reused from [`ace-runtime`](../ace-runtime/README.md)** — this package only adds the Codex driver.

```text
External World
    |
    v
+--------------+ raw message +-----------------------------+ AceMessage +--------------+
| Transport    | ---------------> | ACE Runtime            | ---------> | CodexEngine  |
| InMemory /   |   decode ->       | validate -> resolve     | (reused    | (this pkg)   |
| Redis Streams|   validate ->     | activation -> dispatch  |  from       +-----+-----+
+--------------+                   | (ace-runtime)          |  ace-      |  idle:    |
                                    +-----------------------+  runtime)   |  running:|
                                                                           +-----+----+
                                                                                 |
                                    turn/start  /  turn/steer (non-experimental)
                                                                                 v
                                                                       codex app-server
```

## Why a bridge, not an in-process plugin

The Pi / oh-my-pi host exposes an **in-process extension API** (`ExtensionAPI`): a plugin is loaded into the host's
runtime and calls `steer` / `followUp` directly. Codex has no equivalent. Its only documented surface for an
*external* process to drive a live session is the **`codex app-server`** endpoint — a JSON-RPC-ish protocol served
over `stdio`, `ws`, or `unix`. The installable, uninstallable artefact is therefore the bridge itself: a small
process that owns (or attaches to) a `codex app-server`, and turns ACE events into `app-server` turn methods. There
is no host source tree to patch and nothing to uninstall but the process. This is the honest "plugin form" for Codex.

The protocol is newline-delimited JSON (no `jsonrpc` field). We deliberately do **not** build on `codex mcp-server`,
which is no longer present on `main`.

## Capability matrix

Method names and their experimental status are cited to the Codex source
(`codex-rs/app-server-protocol/src/protocol/common.rs`, verified against a local checkout of the version this was
tested on, `codex-cli 0.153.0`). A variant is *gated* only if it carries a `#[experimental(...)]` attribute; none of
the methods the bridge calls do.

| ACE activation / op | Agent state        | `app-server` method(s)              | Gate                  | Engine path                                          |
|---------------------|--------------------|-------------------------------------|-----------------------|------------------------------------------------------|
| `next_turn`         | idle               | `turn/start`                        | non-experimental      | start a new turn                                     |
| `next_turn`         | running            | *(held locally)*, then `turn/start` | non-experimental      | FIFO; re-fires when the thread goes idle             |
| `immediate`         | idle               | `turn/start`                        | non-experimental      | start a turn (nothing running to steer)              |
| `immediate`         | running            | `turn/steer` (+ `expectedTurnId`)   | non-experimental      | fold into the active turn; fails if the turn moved   |
| `manual`            | (any)              | *(none — no RPC)*                   | n/a                   | held in the ACE runtime's pending store (see below)  |
| interrupt           | running            | `turn/interrupt`                    | non-experimental      | abort the active turn (failure surfaces via `onRunError`) |
| resume / rejoin     | (start)            | `thread/start` / `thread/resume`    | non-experimental      | new thread, or rejoin a durable UUIDv7 thread        |

Citations (line numbers from the 0.153.0 snapshot):

- `thread/start` — `common.rs:551` (`ThreadStart`, no `#[experimental]`)
- `thread/resume` — `common.rs:557` (`ThreadResume`, no `#[experimental]`)
- `turn/start` — `common.rs:1043` (`TurnStart`, no `#[experimental]`)
- `turn/steer` — `common.rs:1055` (`TurnSteer`, no `#[experimental]`)
- `turn/interrupt` — `common.rs:1061` (`TurnInterrupt`, no `#[experimental]`)
- the hold/queue family — `common.rs:629-660` (`ThreadQueueAdd` / `List` / `Update` / `Delete` / `Reorder` /
  `Start`), **each** carrying `#[experimental("thread/queue/…")]`. This family is the one that is gated.

The bridge requests **no** experimental capability on `initialize`, so it only ever uses the non-experimental rows.

### Why `manual` never touches the experimental queue

Codex's own hold-without-injecting mechanism is the gated `thread/queue/*` family: `thread/queue/add` stores a queued
submission, a later `thread/queue/start` begins a turn from it. We do not use it. The ACE runtime already has a
**pending store** for `manual` events (RFC §8 activation: `manual` means "hold, inject only on an explicit call");
`ace-runtime` exposes it through `runtime.activatePendingEvent(sender, id)`, the same call the Pi/oh-my-pi
extension's `/ace activate` command makes. The bridge therefore re-dispatches an activated `manual` event as a plain
`next_turn`. This keeps the whole Codex integration on non-experimental methods and makes the `manual` semantics
identical across hosts, at the cost of not being able to *inspect* a held Codex queue. It is an intentional design
choice, not a gap: the ACE runtime is the source of truth for pending events, and it already owns the spool and
dead-letter state.

### Ack policy (stated precisely)

An injected ACE event is acknowledged **only once the Codex server echoes the injected text back as a `userMessage`
item** — i.e. the `item/started` / `item/completed` notification whose `userMessage` item's text contains the rendered
event. That is the broker's ack point, and it is what proves the text reached the conversation.

- `turn/completed` **alone does not ack** an event (a turn can complete having seen other input); it only closes the
  engine's "running" window so a held `next_turn` can fire.
- A `next_turn` event *held* while a turn runs is acked when its **own, later** turn surfaces the text.
- If the echo is never observed within `deliveryTimeoutMs` (default 30 s), the engine rejects the injection, and the
  ACE runtime keeps the event pending for redelivery (the broker's normal reclaim path).

## Install

The package is a workspace member; `ace-runtime` is consumed by `file:` dependency, and TypeScript runs under Bun as-is
(no build step required to run the bridge).

```sh
# from the repo root (or the package dir)
cd packages/ace-codex
bun install          # links ../ace-runtime, installs ws + dev deps
```

The package declares a `bin` entry, so after install the launcher is on `PATH` as `ace-codex-bridge` (or run it with
`bun bin/ace-codex-bridge.ts`). To *uninstall*, remove the process / delete the directory; nothing is patched into Codex.

## Configure

`.ace.json` is read from the bridge's working directory — the same directory the Codex thread runs in — and declares a
`username`, one or more `servers` (each a broker URL, the namespace it owns, and an optional `subscribe` list of the
channel names this session reads **on that server**), exactly as for the Pi host (see `ace-runtime` for the full key
set). A channel **name is the address**: a short subscribe entry is completed to `<namespace>:<username>:<name>`
under its own server's namespace (a full name passes through), and its Redis stream key and consumer group are
derived from that name — there is no separate stream/group config, and no `publish` list to declare. A minimal example:

```json
{
  "username": "alice",
  "servers": {
    "lan": { "url": "redis://192.168.2.11:6379", "namespace": "ace", "subscribe": ["from-ci"] }
  },
  "defaultActivation": "next_turn"
}
```

`subscribe: ["from-ci"]` on the `lan` server means the channel `ace:alice:from-ci`. A subscription always belongs to
the server that carries it, so a short name is completed under *that* server's namespace and there is nothing to
qualify.

### Agent directory (auto-registration)

Whenever servers are configured, the bridge **registers itself in the agent directory on every one of them, and
unregisters on stop** — no extra step. On each server it registers the channel named by this session's **sender**:
`<namespace>:<username>:codex:<threadId>` (the thread id is the Codex UUIDv7 the session started or resumed with).
The sender name *is* the address — the stream key (`<ns>:ch:<name>`) and the consumer group (the channel name itself)
are derived from it, so nothing here can disagree with what a peer computes — and the bridge reads that channel back
through a derived `session-inbox` subscription. A peer that discovers the channel through the directory can send it a
direct ACE event, delivered and acked like any other channel. An unreachable server is skipped with a warning and the
rest of the session still runs; `registration()` and `sessionInbox()` expose the first server that came up.

Bridge connection is configured by flags or `ACE_CODEX_*` env vars (flags win). The bridge does **not** read Codex's own
`codex.json` — it is a thin driver and mixing in Codex internals would couple it to them.

| Flag | Env var | Meaning |
|------|---------|---------|
| `--listen <stdio\|ws\|unix>` | `ACE_CODEX_LISTENER` | how to reach the app-server (default `stdio`) |
| `--command <executable>` | `ACE_CODEX_COMMAND` | executable to spawn for `stdio` (default `codex`) |
| `--endpoint <url\|path>` | `ACE_CODEX_ENDPOINT` | `ws://…` URL or `unix` socket path for non-stdio |
| `--cwd <dir>` | `ACE_CODEX_CWD` | working dir + `.ace.json` location + thread `cwd` |
| `--model <model>` | `ACE_CODEX_MODEL` | pin a model for new threads |
| `--thread <id>` | `ACE_CODEX_THREAD_ID` | resume this durable thread id (UUIDv7) |
| `--timeout <ms>` | `ACE_CODEX_DELIVERY_TIMEOUT_MS` | delivery-observation timeout (default 30000) |
| `--client-name <name>` | `ACE_CODEX_CLIENT_NAME` | `initialize.clientInfo.name` |
| `--client-version <ver>` | `ACE_CODEX_CLIENT_VERSION` | `initialize.clientInfo.version` |

## Launch

Three ways to point it at a `codex app-server`:

```sh
# 1. stdio (default): the bridge spawns and owns the Codex session.
ace-codex-bridge --cwd /path/to/your/agent

# 2. attach to an already-running server over a websocket
codex app-server --listen ws://127.0.0.1:8080
ace-codex-bridge --listen ws --endpoint ws://127.0.0.1:8080 --cwd /path/to/your/agent

# 3. attach over a unix domain socket
codex app-server --listen unix:///tmp/codex.sock
ace-codex-bridge --listen unix --endpoint /tmp/codex.sock --cwd /path/to/your/agent
```

To resume a durable session across restarts, pass `--thread <id>` with a previously seen thread id; the bridge calls
`thread/resume` and reattaches (a second connection to a running thread is allowed by the server).

Programmatic use: `createBridge({ config, cwd, logger })` returns a bridge with `ready`, `threadId()`, `start()`,
`stop()` and the underlying `engine` (see `src/bridge.ts`).

## Tests

- **Unit (no Codex required)** — `vitest`, driven by a scripted **fake app-server** peer and an in-memory **fake registry** (both broker-free):
  - envelope framing (newline-delimited JSON, request ids, error mapping);
  - request / notification routing;
  - mode mapping — idle → `turn/start`, busy → `turn/steer` (including `expectedTurnId` mismatch), `manual` → held by the
    runtime with **no RPC** (asserts `turn/start` and `thread/queue/add` both stay at 0);
  - ack mapping — the `userMessage` echo is the ack point, `turn/completed` alone is not, and the delivery timeout rejects;
  - **agent-directory registration** — the bridge registers the channel named by its sender
    (`<ns>:<username>:codex:<threadId>`) on every server with the right `cwd`, derives the `session-inbox` subscription
    from that channel name (stream `<ns>:ch:<name>`, group = the channel name) *and* starts a reader for it, delivers +
    acks an event published straight to the channel's stream, isolates a server whose registration fails (skipped with a
    warning; the rest of the session still runs), stops in the order `runtime.stop()` → `unregister()` → `close()`, and
    still starts (unregistered) when its only server is unreachable.
- **Live smoke** — `scripts/smoke.ts` talks to a **real** `codex app-server` (spawned over stdio) *only if* a `codex`
  binary is present; otherwise it prints why and exits `0` (skip), so CI without Codex is not blocked. It verifies the
  non-experimental path end to end: `initialize` handshake, `thread/start`, a `turn/start` that streams
  `turn/started` / item echo / `turn/completed`, and a best-effort `turn/steer` into the running turn. When a Redis
  broker is reachable (default `ACE_LIVE_REDIS_URL`, else `redis://127.0.0.1:6379`) it additionally runs the
  **agent-directory** live check: the session's sender channel appears in the directory (zset + entry hash), a direct
  publish to that channel's derived stream is consumed and acked (leaves the group's pending list), and shutdown removes
  the entry and the stream. It skips with a printed reason when `codex`, `redis-cli`, or the broker is missing.

```sh
bun run test     # vitest run
bun run smoke    # live (skips cleanly when codex is absent)
bun run check    # biome check --error-on-warnings . && tsc --noEmit
```

## Current state and open gaps (2026-10-05)

**Inbound only.** The bridge drives a real session through Codex's **app-server** (`turn/start`,
`turn/steer`) — an officially documented interface (`developers.openai.com/codex/app-server`) whose
CLI subcommand is marked `[experimental]`. The bridge spawns `codex app-server` itself and reads
`.ace.json` from `--cwd`; `codex mcp` plays no part in this path.

**No tool surface yet.** A Codex session cannot call `ace_publish`: the bridge registers no tools at
all, and the host offers **no native tool extension point** — Codex plugins bundle skills, app
integrations and MCP servers, and hooks may intercept MCP tool calls — so the tool surface has to be
an **MCP server** (the host supports `codex mcp add`). Until it exists, this host only *receives*.

**Open gaps**

1. **Add the MCP tool surface**, sharing the runtime's tool spec instead of copying it. Codex's shared
   local app-server daemon (`codex agents`) makes a single-process shape plausible: one MCP server
   that both exposes the tools and connects to the daemon to inject events.
2. **Reconcile the protocol shape with the official reference.** This package's notes describe
   newline-delimited JSON with no `jsonrpc` field, while the published app-server reference describes
   JSON-RPC 2.0. The bridge speaks `codex-cli 0.153.0` correctly (verified live), but this difference
   is the most likely breakage point on a version bump.
3. **The subcommand is experimental**, so the wire protocol may change without notice: pin the tested
   version, and fail loudly on a shape we do not recognize.

**Verified locally**: biome/tsc clean; vitest 39/39. The live half runs through `scripts/smoke.ts` (and skips cleanly
without a `codex` binary): the plumbing checks drive `initialize` / `thread/start` / `turn/start` / `turn/steer`; the
directory check confirms the session's sender channel (`<ns>:<username>:codex:<threadId>`) is registered (zset + entry
hash), an `XADD` to that channel's derived stream is received, injected as a `next_turn`, and acknowledged after the
observation (the PEL empties), and shutdown removes both the entry and the stream. **Not verified against a real
broker**: registration failure and stop-while-`register`-in-flight — both covered by in-memory unit tests only.

## Not verified here

- The `ws` / `unix` listeners are exercised only by the live smoke when a `codex` binary is present; the unit tests
  cover the transport-agnostic framing over the in-memory / stdio peer. `stdio` is fully unit-tested.
- `thread/resume` (rejoin of a *running* thread) is wired but not asserted by the unit suite (it needs a live server
  with a durable thread); the smoke covers new-thread start and mid-turn steer.
- Method-name citations are line numbers from a local `codex-cli 0.153.0` source snapshot; they may drift in later Codex
  releases, but the *methods* and their non-experimental status are the stable contract.
