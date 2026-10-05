# ace-runtime

ACE (Agent Context Event Protocol) 0.1 runtime on top of [Pi](../../packages/coding-agent). It makes external
events — CI results, alerts, other agents — an *active* input to a running agent instead of something the agent
has to poll for.

Protocol semantics come from the [`ACE-RFC-Draft-0.1.md`](../../docs/ACE-RFC-Draft-0.1.md) draft; engineering
decisions from [`ace-v0.1.md`](../../docs/ace-v0.1.md); implementation-level contracts — configuration keys,
Redis keys and fields, tool parameters, delivery semantics, flows and invariants — from
[`ace-runtime-contracts.md`](../../docs/ace-runtime-contracts.md).

```text
External World
      │
      ▼
┌──────────────┐   raw message    ┌───────────────────────────────┐   AceMessage   ┌─────────────┐
│  Transport   │ ───────────────► │          ACE Runtime          │ ─────────────► │PiExtension  │
│ InMemory /   │                  │ decode → validate → resolve   │                │  Adapter    │
│ Redis Streams│ ◄─────────────── │ activation → dispatch         │                └──────┬──────┘
└──────────────┘  ack/retry/…     └───────────────────────────────┘                       │
                                                │                                 ┌───────▼──────┐
                                     manual ────┘ stored events                   │  Pi session  │
                                                                                 │  context →   │
                                                                                 │  agent turn  │
                                                                                 │  → LLM       │
                                                                                 └──────────────┘
```

The four layers stay separate: **ACE protocol ≠ ACE runtime ≠ transport ≠ agent engine**. Nothing here maps MQ
metadata to ACE fields, and nothing here teaches Pi about ACE: Pi only sees context text.

## Install

**This package is the library, not the plugin.** `ace-runtime` has no `omp.extensions` entry: it is what the
plugin vendors and what a programmatic consumer imports. The installable oh-my-pi plugin is
[`ace-omp`](../ace-omp), whose `package.json` declares `"omp": {"extensions": ["./extensions/ace.ts"]}` and
which carries this package's build in its `vendor/` — see that README for the layout. Install it:

```bash
# 1. the released plugin tarball — one command: no clone, no registry, no auth
omp install https://github.com/noexcs/ace-protocol/releases/download/v0.2.16/ace-omp-0.2.16.tgz

# 2. from a checkout, for development: the install is a symlink, so your edits are what sessions run
git clone --depth 1 https://github.com/noexcs/ace-protocol
cd ace-protocol/packages/ace-omp && bun install && npm run build   # or: cd ../ace-runtime && npm run build
omp plugin link "$PWD"                    # same as: omp install "$PWD"; registers it as `ace-omp`
```

A plugin is loaded **at session start**, so a running session keeps the code it started with: the restart
after an install or an update is what loads the new one.

Then it behaves like any other plugin:

```bash
omp plugin list                 # installed? enabled? which manifest?
omp plugin disable ace-omp      # stop loading it
omp plugin uninstall ace-omp
omp plugin doctor               # when a plugin misbehaves
```

#### When the host has no `bun`

`omp install` runs Bun for package work (`~/.omp/plugins/bun.lock`), so on a machine without it the command
fails before any download: `Error: Executable not found in $PATH: "bun"`. Either install Bun (`npm i -g bun`)
or skip the plugin system and link the plugin's entry into the host's extension directory. This needs only
`curl`, `tar` and `npm`, and the entry resolves its vendored core through the directory it is linked to, so
keep that directory around:

```bash
curl -LO https://github.com/noexcs/ace-protocol/releases/download/v0.2.16/ace-omp-0.2.16.tgz
mkdir -p ~/ace-omp-0.2.16 ~/.omp/agent/extensions
tar xzf ace-omp-0.2.16.tgz -C ~/ace-omp-0.2.16 --strip-components=1
cd ~/ace-omp-0.2.16 && npm install --ignore-scripts
ln -sfn "$PWD/extensions/ace.ts" ~/.omp/agent/extensions/ace.ts     # or ~/.pi/agent/extensions/
```

Restart the session after installing or updating: a running session keeps the code it started with. If a
session also passes `--extension`/`-e` for the same file, the extension refuses the second runtime — two
runtimes on one consumer group would silently split every channel's events — and logs one line saying so.

**Updating**: reinstall from the newer tarball URL, or `git pull` in a linked checkout (the link is live), or
re-unpack into the directory the `~/.omp/agent/extensions/` symlink points at — then restart. A release tag
lags `main`, so check the tag against the revision you want.

The tarball also serves programmatic consumers: `dist` through `main`/`exports["."]` for `import
"ace-runtime"`, and `./extension` for a host that wants the entry path without plugin discovery. `npm pack`
rebuilds `dist` (its `prepack`) and produces the tarball a release carries.

### On a fresh WSL box

```bash
sudo apt update && sudo apt install -y redis-server && sudo service redis-server start
redis-cli ping                              # PONG

# read-only access needs no login (the repository is public); a release tag lags `main`, so check the tag
# (ace-omp is the plugin; ace-runtime below it is the library it vendors)
omp install https://github.com/noexcs/ace-protocol/releases/download/v0.2.16/ace-omp-0.2.16.tgz
cat > .ace.json <<'JSON'
{ "username": "ana",
  "servers": { "local": { "url": "redis://127.0.0.1:6379", "subscribe": [ "inbox" ] } } }
JSON
omp                                          # the installed plugin loads the extension itself

# in another terminal, once the session printed "listening"
# A channel name is the address; its stream is derived as `<namespace>:ch:<channel>`.
redis-cli XADD ace:ch:ace:ana:inbox '*' message \
  '{"aceVersion":"0.1","id":"e1","sender":"ace:ana:ci","activation":"next_turn","body":"hello from WSL"}'
```

Publish **after** the session says `listening`: a consumer group starts at the stream's tail, so an event
published before the subscription exists is skipped.

### Two agents, two machines (LAN)

One machine can host the broker for both sessions: expose Redis on that machine and point every
`.ace.json` at its LAN address. Each side names the channel it reads, and a peer is reached by
publishing to the channel that peer's own sender names:

```jsonc
// mac/.ace.json
{ "username": "ana",
  "servers": { "lan": { "url": "redis://<lan-ip>:6379", "subscribe": [ "from-wsl" ] } } }

// wsl/.ace.json
{ "username": "ana",
  "servers": { "lan": { "url": "redis://<lan-ip>:6379", "subscribe": [ "from-mac" ] } } }
```

```bash
# on the machine that hosts Redis (macOS + Homebrew), make it reachable
CONF=$(brew --prefix)/etc/redis.conf
cp "$CONF" "$CONF.bak"                                   # keep a way back
sed -i '' 's/^bind .*/bind 0.0.0.0 ::1/; s/^protected-mode .*/protected-mode no/' "$CONF"
brew services restart redis
redis-cli -h <lan-ip> ping                               # PONG = the network path works

# on each machine, from its own directory (install once: see "Install")
omp                                                      # the plugin loads the extension; cwd holds .ace.json

# then, from either side, once the other side printed "listening": publish to the channel name
redis-cli -h <lan-ip> XADD ace:ch:ace:ana:from-mac '*' message \
  '{"aceVersion":"0.1","id":"e1","sender":"ace:ana:pi","senderDescription":"agent=pi | cwd=/home/u/ace","activation":"next_turn","body":"hello from WSL"}'
```

Each session also auto-subscribes the channel its own sender names (`<namespace>:<username>:<coding-agent>:<sessionId>`),
so `ace_agents` lists the peer under exactly that channel name and `ace_publish` addresses it directly — a channel
name is the whole address, derived to a stream as `<namespace>:ch:<channel>` on both sides. Nothing about an
address is configured, advertised or stored in the entry.

> **Exposing Redis has teeth.** `protected-mode no` plus no password means anyone on the network can
> read and write the whole database, and Redis can write files on the host. On a network you do not
> own, add `requirepass <secret>` and use `redis://:<secret>@<lan-ip>:6379` (or
> `redis://:${REDIS_PASSWORD}@…` with the variable exported), and restrict the port to your subnet.
> To undo: restore the two lines from the backup and restart.

### Releasing

Two packages are shipped together: the library (`ace-runtime`) and the plugin (`ace-omp`) that vendors it.
Bump both to the same version, pack both, and attach both to one release:

```bash
for p in ace-runtime ace-omp; do (cd packages/$p && npm version minor --no-git-tag-version); done   # or patch
cd packages/ace-runtime && npm run build && cd ../..
node scripts/check-vendor-sync.ts --write      # the plugin's vendor/ must carry the new build
for p in ace-runtime ace-omp ace-claude-code ace-codex; do (cd packages/$p && bun run check && bun run test); done
cd packages/ace-runtime && npm pack && cd ../ace-omp && npm pack && cd ../..
git commit -am "chore(release): <version>" && git tag -a v<version> -m "ace <version>"
git push && git push origin v<version>
gh release create v<version> packages/ace-runtime/ace-runtime-<version>.tgz \
  packages/ace-omp/ace-omp-<version>.tgz --title "ace <version>" --notes-file <notes.md>
```

`npm publish` is optional and only for the library (`ace-runtime` is a valid npm package; `ace-omp` is not
published — it is installed from the release tarball or a linked checkout).

## Usage

```typescript
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { AceRuntime, type EndpointConfig, InMemoryTransport, PiExtensionAdapter } from "ace-runtime";

const { session } = await createAgentSession({ sessionManager: SessionManager.inMemory() });
const transport = new InMemoryTransport();
// `PiExtensionAdapter` drives any host with `sendUserMessage`; a Pi `AgentSession` is one, and
// `isStreaming` is the idle probe. Its `onRunError` listener reports failed turns.
const adapter = new PiExtensionAdapter({ pi: session, isIdle: () => !session.isStreaming });
adapter.onRunError((error) => console.error("[ACE] agent run failed:", error));
const subscription: EndpointConfig = {
	name: "build-events",
	transport: "memory",
	activation: "default",
	config: {},
	options: {},
};

const runtime = new AceRuntime({
	engine: adapter,
	subscribe: [subscription],
	transports: { [subscription.name]: transport },
});

await runtime.start();
await transport.publish({
	aceVersion: "0.1",
	id: "evt_123",
	sender: "build-service",
	activation: "next_turn",
	body: "Build failed for project foo.",
});
await session.waitForIdle();
await runtime.stop();
```

A runnable version is [`examples/basic.ts`](examples/basic.ts):

```bash
ACE_MODEL=tailscale-zcs/Qwen3.8-27B npm run example:basic
```

Set `ACE_EVENT` to publish your own message instead of the demo event (`manual` events are then activated
explicitly, so all four activation values are observable from the command line):

```bash
ACE_EVENT='{"aceVersion":"0.1","id":"e1","sender":"ci","activation":"immediate","body":"Deploy failed."}' \
  ACE_MODEL=tailscale-zcs/Qwen3.8-27B npm run example:basic
```

## Host plugins

The Pi / oh-my-pi plugin — install, `.ace.json`, injection semantics, bursts and redelivery, the
agent directory, `/ace` commands and the tool surface — now ships as its own package:
[`packages/ace-omp`](../ace-omp), documented in [`ace-omp/README.md`](../ace-omp/README.md).

This package is the host-neutral core: protocol and validation, activation, the event dispatcher,
spools and pending stores, the transports, the agent directory, the tool text and parameter schemas
for `ace_publish`, `ace_agents`, `ace_channels`, `ace_store_file` and `ace_get_file`, and the
`AgentEngine` contract the hosts implement.

## Transports

`Transport` is the only seam between a broker and ACE: `start(handler)` / `stop()`. Broker metadata
(topic, subject, stream, group, entry ID, offset, consumer) stays inside the adapter and never becomes an
ACE field (RFC §4). Two adapters ship today.

### `InMemoryTransport`

In-process, for tests and examples: `start(handler)`, `stop()`, `publish(raw)`. Nothing is durable, nothing is
acknowledged.

### `RedisStreamsTransport`

Consumes from a Redis Stream consumer group (RFC §4, §17). Its settings come from the subscription config:

```typescript
const subscription: EndpointConfig = {
	name: "build-events",
	transport: "redis-streams",
	activation: "default",
	// every broker-specific setting lives in `config`; raw client options go to `options`
	config: { stream: "ace:build-events", group: "coding-agent" },
	options: {},
};
const transport = new RedisStreamsTransport(subscription, {
	onError: (error) => console.error("[ACE] redis streams error:", error),
});
const runtime = new AceRuntime({ engine: adapter, subscribe: [subscription], transports: { [subscription.name]: transport } });
```

| Key | Default | Meaning |
|---|---|---|
| `stream` | required | Stream the consumer group reads |
| `group` | required | Consumer group; created at the stream tail (`$`) if missing |
| `url` | `redis://127.0.0.1:6379` | Broker URL |
| `consumer` | `ace-<pid>` | Consumer name inside the group |
| `field` | `message` | Stream entry field carrying the ACE message JSON |
| `count` | `16` | Entries per `XREADGROUP` |
| `blockMs` | `1000` | `XREADGROUP` block window; also bounds how fast `stop()` returns |

Delivery model — what `group` selects (measured against a real broker):

| Configuration | Every entry goes to | Use it for |
|---|---|---|
| Different groups on one stream | every group once (broadcast) | several agents that must each see all events |
| One group, several consumers (`consumer` defaults to `ace-<pid>`) | exactly one consumer of that group (work sharing) | splitting a queue across workers |
| No group (`XREAD`) | every reader independently, no ack, no PEL | not used by this adapter |

A session that consumes a stream it also publishes to receives its own messages — give each direction its own
stream (see [Talking to another agent](#talking-to-another-agent)) or filter by `sender` in the agent. A group is
created at the stream tail (`$`) when it does not exist yet, so a fresh group only sees new events.

Acknowledgement policy:

| Situation | Result |
|---|---|
| Handler resolves (event accepted, including `manual` events stored) | entry is `XACK`ed |
| Invalid ACE message | logged by the runtime, then `XACK`ed — a poison message never blocks the stream |
| Handler rejects (injection or transport failure) | entry stays in the group's PEL |

Delivery is decoupled from reading through a **per-subscription serial queue**: the read loop hands each
entry over and keeps reading, so a delivery that waits on the host — a queued `aside` event surfaces at the
next step boundary, with no wall clock — no longer stops this subscription from reading new entries or from
reclaiming a peer's stranded ones. Deliveries still run one at a time in read order, and an entry is
acknowledged only after its handler resolves. The queue holds at most
`REDIS_STREAMS_DELIVERY_QUEUE_LIMIT` (256) entries; at the bound the loop waits for a slot instead of
growing the queue or dropping an entry. An entry this consumer has accepted but not yet settled is skipped
by reclaim — it is waiting, not stranded, so it is never delivered twice or counted against
`reclaimAttempts` while its first delivery is still in hand. `stop()` stops reading, drains the queue — so
an entry already read is still delivered and acknowledged — and only then closes the client.

Producers publish the ACE envelope as JSON in the payload field:

```bash
redis-cli XADD ace:build-events '*' \
  message '{"aceVersion":"0.1","id":"evt_1","sender":"ci","activation":"next_turn","body":"Build failed."}'
```

`examples/redis-streams.ts` runs this consumer against a real broker:

```bash
redis-server --port 6399 --daemonize yes --save '' --dir /tmp/ace-redis
ACE_MODEL=tailscale-zcs/Qwen3.8-27B ACE_REDIS_URL=redis://127.0.0.1:6399 ACE_EXIT_AFTER=1 \
  npm run example:redis
```

Tests never need a broker: the adapter is split into a narrow `RedisStreamsClient` interface, a `redis`-backed
client, and the transport, so the test suite drives a fake client.

## Layout

| Path | Role |
|---|---|
| `src/protocol/` | ACE 0.1 envelope, activation values, validator, decoder, [JSON Schema](schema/ace-message-0.1.schema.json) |
| `src/runtime/` | endpoint (subscribe/publish) configuration, activation resolution, dispatcher, manual-event store, burst spool, dedup window, metrics, `AceRuntime` |
| `src/transport/` | `Transport` boundary, `InMemoryTransport`, `RedisStreamsTransport` (+ client interface / node-redis adapter) |
| `src/agent/` | `AgentEngine` interface, `PiExtensionAdapter` (drive the host), and `event-rendering.ts` (the injected block and trust policy) |
| `src/logger.ts` | log lines that never carry a message body |
| `extensions/` | `ace.ts`: Pi extension that injects events into the session it runs in |
| `test/` | protocol, runtime, adapter and transport unit tests, plus real-Pi-session integration tests |
| `scripts/verify-live.ts` | `npm run verify:live`: the runtime against a real broker (reclaim, dedup, open inbound, burst spooling, manual, shutdown order) |
| `scripts/verify-omp.ts` | `npm run verify:omp`: the extension inside a real `omp --mode rpc` session (event reaches the conversation, turn settles, entry acknowledged) |
| `schema/` | normative ACE 0.1 JSON Schema |

## Protocol summary

An ACE 0.1 message is exactly five fields; unknown fields are allowed and ignored (RFC §15).

| Field | Meaning |
|---|---|
| `aceVersion` | protocol version; this runtime accepts `"0.1"` only |
| `id` | message identity, unique per sender; `(sender, id)` identifies a message (RFC §5.2) |
| `sender` | sender identifier; not required to be an agent |
| `activation` | `immediate` \| `next_turn` \| `manual` \| `default` |
| `body` | opaque string; ACE never interprets it (RFC §6) |

Effective activation (RFC §8) — the receiver can always override the sender:

```text
subscribe.activation != default  → subscribe.activation
message.activation != default → message.activation
otherwise                     → runtime default (next_turn)
```

`default` is a delegation value, never an executed action, so a runtime default is typed as
`immediate | next_turn | manual`.

## Activation semantics across hosts

| Effective activation | Agent idle | Agent running |
|---|---|---|
| `next_turn` | body enters context, turn starts | queued, processed after the current run's pending work |
| `immediate` | body enters context, turn starts | queued at the earliest public processing point |
| `manual` | retained in memory, no turn | retained in memory, no turn |

The in-session adapter asks the host to deliver the message, and the hosts disagree about what a delivery
mode means, so the adapter owns that mapping instead of trusting the host:

| activation | agent | upstream Pi | oh-my-pi (`omp`) |
|---|---|---|---|
| `next_turn` | idle | no delivery mode — the prompt path starts the turn | `aside` (starts a turn) |
| `next_turn` | running | `followUp` (after the run's pending work) | `aside` (next step boundary; never interrupts a tool batch) |
| `immediate` | idle | no delivery mode (prompt path) | no delivery mode (prompt path) |
| `immediate` | running | `steer` | `steer` |

oh-my-pi queues `steer`/`followUp` **without starting a turn**, so an event injected into an idle session
waits in a queue that nothing drains — while the broker entry is acknowledged. That is silent loss, measured on
omp 18.5.0, which is why the adapter never passes those modes to an idle agent, and why on oh-my-pi it waits
until the injected text appears in the conversation before the transport may acknowledge the entry
(`AceDeliveryObserver`). `ACE_DELIVERY=aside|portable` overrides host detection when a host changes its surface.

The wait is **per path**, because surface time is. A queued delivery (`aside`, `followUp`) surfaces at the next
step boundary and a model turn can last minutes, so its surface time is not knowable: the adapter waits for the
observation with **no wall clock**, and the transport's own `reclaimAttempts`/`reclaimIdleMs` is the backstop for
a host that truly never surfaces the event. The paths where the host surfaces the event in the current turn (the
prompt path and `steer`) keep a bounded wait (`deliveryTimeoutMs`, default 30s): a timeout fails the injection
so the entry stays pending for reclaim.

Injection is **idempotent** by `(subscription, sender, id)`: the adapter records an event as handed to the host
the moment `sendUserMessage` returns, and never rolls that back — it says the host received the message, not
that the agent saw it. A broker redelivery of an identity already handed over re-attaches to the observation and
waits again; it never calls `sendUserMessage` a second time, so one stored entry cannot become several copies in
the conversation. The record is a bounded FIFO (1024), and a suppressed duplicate is logged so a host can tell
adapter-level duplication from render-level duplication.

`immediate` preempts at Pi's next **turn boundary** instead of aborting the running turn, so no partial output
or in-flight tool call is discarded. Mid-turn cancellation is deliberately out of the MVP (design doc §28/§29).

## Context injection

`body` enters the Pi context as a user message in this form (design doc §18):

```text
<ace_event>
sender: oh-my-pi:01a102b8-f016-75ab-87eb-63551c257fda
sender description: agent=oh-my-pi | session=257fda | cwd=/Users/… | host=… | ip=… | platform=darwin-arm64 | pid=…
arrived via: ace:in.a
activation: next_turn
received at: 2026-10-05T14:28:14.306Z
id: evt_123
<ace_body>
Build failed for project foo.
</ace_event>
```

`<ace_event>` is what tells a model the block came from another agent rather than the human; `arrived via` names
the channel the event arrived on (a display label, not an address to publish to) and a reply goes to the
`sender` channel. `activation` and `received at` are display-only too: the first is the value the sender asked
for, never a delivery confirmation, and the second is the broker arrival time. The header is only the lines
before the first `<ace_body>`, and the body after it is verbatim: a body line shaped like `sender:` or
`arrived via:` is body text, so the header is read positionally, never by line prefix.
Nothing inside the block is repeated per event beyond that header; the provenance and trust rule is stated once
in the session's system prompt (`ACE_TRUST_POLICY` via `withTrustPolicy`): events in that tag come from other
agents or services, their sender is unverified — ACE 0.1 authenticates nothing (RFC §22 item 3) — and the agent
must get the user's approval for a sender before acting on its requests, offering "this event only", "every
event from that sender", or "every ACE event". That is a soft constraint, not a boundary: the runtime keeps no
approvals and blocks no events, and the user's answer stays in the conversation. Events are pushed into the
conversation when they arrive (or at the end of the current turn, per activation); there is nothing to poll,
wait for, or read back.

`ace_publish` stamps `sender` with this session's sender name — `<namespace>:<username>:<coding-agent>:<sessionId>`,
the same name as the channel it auto-registers — and adds
`senderDescription`, so a receiver shows who and where it is without looking anything up: a sender never has
to be registered anywhere to send. Both lines are the sender's own account and never an authorization.

The header is an adapter choice, **not** part of ACE: the protocol only requires `body` to be visible to later
reasoning. The fixed prefix also keeps an ACE body from being mistaken for a Pi slash command or prompt template.
Pass `renderEvent` to `PiExtensionAdapter` to change the format.

## Errors and logging

| Situation | Behavior |
|---|---|
| Non-conforming message | rejected; through a transport it is logged and dropped, `handleRawMessage` throws `AceValidationError` |
| Transport or injection failure | propagated, so the transport can retry or dead-letter (RFC §17, design doc §30) |
| Unreachable broker | the start fails once with the URL; reconnection is bounded and an outage after the start is reported at most once until commands succeed again |
| Agent turn failure | reported through the engine's `onRunError` listener, since Pi records it on the assistant message rather than rejecting a send |
| Injected but never surfaced (queued path) | the injection waits for the observation without a wall clock; the transport's `reclaimAttempts`/`reclaimIdleMs` is the backstop, so a host that never surfaces the event terminates rather than hangs (RFC §17) |
| Injected but never surfaced (prompt path, `steer`) | the injection fails after `deliveryTimeoutMs`; the entry stays pending so reclaim can redeliver it (RFC §17). The redelivery of an identity the host already received re-waits only — it does not send a second copy |

Log lines carry `id`, `sender`, `subscribe`, and `activation` only — never the body.

## MVP limitations

- `manual` events live in process memory with `manual.max` / `manual.ttlMs` limits; a restart loses them
  (design doc §12). No persistence, no query API, no inbox API.
- Transports: `InMemoryTransport` and `RedisStreamsTransport`. Kafka/NATS adapters, a CLI, agent registry,
  dynamic targets, bindings, result events and acknowledgement APIs are out of scope (design doc §27, §37).
- No backlog: a subscription's consumer group is created at the stream's tail (`XGROUP CREATE … $`), so events
  published before the agent subscribed are skipped rather than replayed. Replay stays an infrastructure
  capability (RFC §17); the runtime consumes from now on.
- The agent directory is not part of ACE 0.1 (RFC §22 item 1) and carries no authentication: an entry
  states its own identity, and a peer's registration only decides where *that peer* is reached — this
  session still publishes to the broker it was configured with. An entry's identity **is** its channel
  name, so a peer discovered through the directory is addressed by publishing to that channel.
- Dedup and metrics are per process and per subscription: two runtimes reading one group each keep their own window,
  and identities are not shared across processes.
- A reclaimed entry that fails `reclaimAttempts` times is recorded in the dead-letter file and then acknowledged, so
  it stops blocking the group. Putting it back is a human decision: `npm run replay:dead-letters [--dry-run] [file]`.
- Spool files are written, never read back: retention is by `maxFiles` / `retentionMs`, and opening the file is the
  agent's job (the summary names it).
- Reconnection is bounded: a failed read retries with `retryDelayMs` doubling up to `maxRetryDelayMs` and reports the
  outage once, but a broker that is down at start fails the start rather than waiting for it.
- `sender` and `sessionId` are claims: the broker's own permissions decide who may write a channel (see the security
  notes), but the runtime cannot verify that a peer is who it says it is.
- `AceRuntime` registers transports by subscription name and rejects a transport instance shared by two subscriptions,
  because every message would then be dispatched twice. Two subscriptions may use the same transport kind with different settings.
- The extension engine's `waitForIdle()` resolves immediately: a session shutdown must not block the interactive UI
  on a live turn.

## Implementation notes

- `AgentEngine` is `inject(message, mode)` + `isRunning()` + `waitForIdle()`. The design doc's separate
  `startTurn()` is folded into `inject` because Pi starts a turn atomically with the injected message when the
  agent is idle; splitting them only adds a race window.
- The validator is hand-written; `test/protocol/validator.test.ts` checks it against `schema/` so the two cannot
  drift.
- `RedisStreamsTransport` depends on the `redis` package only inside `redis-streams-node-client.ts`; the transport
  talks to the narrow `RedisStreamsClient` interface, which is what tests substitute.
- `.ace.json` is validated when it is read (kind, activation, transport settings), so a broken configuration fails
  at session start with a message instead of mid-stream. `/ace` deliberately registers no argument completions:
  an open completion popup swallows the first Enter in the TUI.
- The Pi host is driven through the public `@earendil-works/pi-coding-agent` SDK; Pi itself is not modified. Only
  `packages/ace-omp/extensions/ace.ts` imports Pi (enforced by `test/architecture/host-boundary.test.ts`); the
  core package imports no host SDK — `PiExtensionAdapter` is typed structurally against `sendUserMessage`.

## Development

```bash
npm test           # unit + integration tests (faux model, fake Redis client, no network)
npm run verify:live   # the same runtime against a real broker (needs redis-server; no model needed)
npm run verify:omp    # the extension inside a real oh-my-pi session (needs omp + a model; one small turn)
npm run replay:dead-letters   # put dead-lettered events back on their streams (--dry-run to look first)
```

CI (`.github/workflows/ci.yml`) runs the tests, `check`, the build and `verify:live` against a Redis service on every
push and pull request; `verify:omp` runs locally because it needs an `omp` binary and a model.

```bash
npm run check      # biome + tsc
npm run build
npm run example:basic   # in-memory transport, needs ACE_MODEL
npm run example:redis   # Redis Streams consumer, needs ACE_MODEL + a broker
```
