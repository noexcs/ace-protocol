# ace-runtime

ACE (Agent Context Event Protocol) 0.1 runtime on top of [Pi](../../packages/coding-agent). It makes external
events — CI results, alerts, other agents — an *active* input to a running agent instead of something the agent
has to poll for.

Protocol semantics come from the [`ACE-RFC-Draft-0.1.md`](../../docs/ACE-RFC-Draft-0.1.md) draft; engineering
decisions from [`ace-v0.1.md`](../../docs/ace-v0.1.md).

```text
External World
      │
      ▼
┌──────────────┐   raw message    ┌───────────────────────────────┐   AceMessage   ┌────────────┐
│  Transport   │ ───────────────► │          ACE Runtime          │ ─────────────► │ PiAdapter  │
│ InMemory /   │                  │ decode → validate → resolve   │                │            │
│ Redis Streams│ ◄─────────────── │ activation → dispatch         │                └─────┬──────┘
└──────────────┘  ack/retry/…     └───────────────────────────────┘                      │
                                                │                                 ┌──────▼──────┐
                                     manual ────┘ stored events                   │ Pi session  │
                                                                                 │ context →   │
                                                                                 │ agent turn  │
                                                                                 │ → LLM       │
                                                                                 └─────────────┘
```

The four layers stay separate: **ACE protocol ≠ ACE runtime ≠ transport ≠ agent engine**. Nothing here maps MQ
metadata to ACE fields, and nothing here teaches Pi about ACE: Pi only sees context text.

## Usage

```typescript
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { AceRuntime, type EndpointConfig, InMemoryTransport, PiAdapter } from "ace-runtime";

const { session } = await createAgentSession({ sessionManager: SessionManager.inMemory() });
const transport = new InMemoryTransport();
const adapter = new PiAdapter({
	session,
	onRunError: (error) => console.error("[ACE] agent run failed:", error),
});
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

## Inject events into a live Pi session

The extension in [`extensions/ace.ts`](extensions/ace.ts) runs **inside** Pi and injects external events into the
session you are chatting in — no separate runtime process, no second session.

```bash
# 1. every MQ setting lives in .ace.json (code holds the mechanisms, not the addresses)
cat > .ace.json <<'JSON'
{
  "$schema": "/path/to/ace-runtime/schema/ace-config.schema.json",
  "sender": "agent-a",
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

# 2. start Pi with the extension
pi --extension /path/to/ace-runtime/extensions/ace.ts

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
| `sender` | Sender identifier this session publishes under (RFC §5.3); required once `publish` channels exist. Charset `[A-Za-z0-9._@:-]`, max 128 |
| `defaultActivation` | `immediate` \| `next_turn` \| `manual`; the RFC §8 fallback when neither subscription nor message decides |
| `subscribe[]` | Channels this agent receives events from; `name` is the key its transport is registered under |
| `publish[]` | Channels the `ace_publish` tool may send to; `name` is the target the model passes |
| `*.transport` | Transport kind; `redis-streams` is the only one implemented (RFC §4.1 names the others) |
| `subscribe[].activation` | Receiver override for this channel (RFC §8); `default` delegates to the message. Not allowed on `publish` |
| `*.description` | Who sits on the other end; shown to the model in the `ace_publish` description |
| `*.enabled` | `false` keeps the channel configured but starts nothing for it (default `true`) |
| `subscribe[].allowedSenders` | Glob patterns (`*`, `?`) of accepted senders (RFC §18); absent means any sender, an empty list is an error |
| `subscribe[].spool` | Spill bursts to a file beyond these thresholds: `{ afterEvents, windowMs }`, both ≥ 1 |
| `spool` | Where burst files go (`{ dir, retentionMs?, maxFiles? }`); defaults to `<cwd>/.ace/spool` when a subscription sets thresholds |
| `manual` | Retention for `manual` events (`{ max?, ttlMs? }`, defaults 100 events / 24h) |
| `*.config` | Transport settings, validated against the kind; unknown keys are errors |
| `*.options` | Raw options handed to the transport's client library; never validated |
| `config.stream` … | redis-streams subscribe: `stream`, `group`, `url`, `consumer`, `field`, `count`, `blockMs`, `reclaimIdleMs`, `reclaimAttempts`, `retryDelayMs`, `maxRetryDelayMs`; publish: `stream`, `url`, `field` |

`.ace.json` is the only source of MQ configuration — there is no environment fallback for addresses, streams, or
groups. `ACE_CONFIG` selects a different config file path, `ACE_LOG=1` also logs runtime lines in modes without a
UI.

Secrets stay out of the file: `${VAR}` in any string is resolved from the environment when the file is read
(`"url": "redis://:${REDIS_PASSWORD}@broker:6379"`), `$$` writes a literal `${`, and an unset variable fails the
load instead of silently becoming an empty string.

### Bursts, allowlists, redelivery

Three per-subscription policies keep a busy channel from flooding a conversation:

- **Allowlist** — `allowedSenders: ["ci.*", "agent-?"]`: only matching senders are injected, everything else is
  dropped and acknowledged before it reaches the agent.
- **Burst spooling** — `spool: { afterEvents, windowMs }`: the first `afterEvents` events of a window are injected
  normally, the rest are appended to a JSONL file under `spool.dir`, and the agent gets **one** summary event naming
  the file, the senders and the window. 200 CI failures cost one turn instead of 200.
- **Redelivery** — `reclaimIdleMs` / `reclaimAttempts`: an event whose handler failed stays in the group's pending
  list, is claimed back after `reclaimIdleMs`, and is retried up to `reclaimAttempts` deliveries before the runtime
  reports and acknowledges it rather than retrying forever.

Deduplication is identity-based: `(sender, id)` is remembered for `dedupCapacity` events, and **only handled events
are remembered** — a redelivery after a failure is retried, never mistaken for a duplicate.

When an entry is dropped after `reclaimAttempts`, the transport hands its last copy to the dead-letter sink first:
one JSONL line per event (raw payload, broker id, attempts, reason) in `dead-letter.<timestamp>.jsonl`, in the same
directory as the burst files and with the same retention (`retentionMs` / `maxFiles`). The entry is acknowledged
**only once that line is fsynced**; a sink that cannot write leaves the entry pending — visible in the group's PEL —
and reports the write error once. No summary event is injected: the agent already failed to receive it
`reclaimAttempts` times, so feeding it back would loop. `/ace` and `/ace stats` count what was recorded.

[`schema/ace-config.schema.json`](schema/ace-config.schema.json) describes the file, so editors validate and
autocomplete it after adding a `$schema` line:

```json
{ "$schema": "./node_modules/ace-runtime/schema/ace-config.schema.json", "subscribe": [ … ] }
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
  sender:    agent-a                          sender:    agent-b
       │  ace_publish ──► ace:to-b ──────────────►  injected into B's conversation
       │  ◄────────────── ace:to-a ◄──── ace_publish (B replies)
```

`ace_publish` takes `body` (the event text the peer's agent reads), optional `activation`
(`default` \| `next_turn` \| `immediate` \| `manual`), optional `target` (an output name, needed only when several
are configured — the address itself never travels in the message, RFC §4.1), and an optional `id` for correlation.
The tool result reports the published id, sender, and target.

### Subagent sessions

oh-my-pi rebinds extensions to every session it spawns, so this factory runs again for each subagent. ACE starts
nothing there: a second runtime would join the same consumer group and silently take over events meant for the
session you are talking to. The gate reads `ctx.agent.kind` (upstream Pi has no such field and runs one session per
process). `/ace` in a subagent session says so instead of reporting a configuration problem.

### Session identity

Every message this runtime publishes carries `sessionId` (RFC §5.4) — the Pi session id, which stays the same when a
session is resumed and changes when a new one starts. That is how a peer notices that the other side's context has
changed. Only the tail is shown (`sender: agent-a (session e7f1a9)`) because the leading characters of a uuidv7 are a
timestamp that concurrent sessions share.

The label is display-only: the protocol field keeps the full value, and neither the field nor the label is
authorization (a peer can claim any `sessionId`, exactly like any `sender`). `/ace` prints the current label.

### `/ace` commands

| Command | Effect |
|---|---|
| `/ace` | origin of the configuration, agent state, number of retained `manual` events |
| `/ace stats` | pending `manual` count, sender, and every burst window that is currently buffering |
| `/ace pending` | list retained `manual` events (`sender/id: body`) |
| `/ace activate <sender> <id>` | inject a retained event as `next_turn` |

The status line shows the runtime's last action (`ace: injecting id=… sender=… agent=running`).

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
| `src/agent/` | `AgentEngine` interface and `PiAdapter` |
| `src/logger.ts` | log lines that never carry a message body |
| `extensions/` | `ace.ts`: Pi extension that injects events into the session it runs in |
| `test/` | protocol, runtime, adapter and transport unit tests, plus real-Pi-session integration tests |
| `scripts/verify-live.ts` | `npm run verify:live`: the runtime against a real broker (reclaim, dedup, allowlist, spool, manual) |
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

The SDK adapter calls Pi directly (`prompt()` / `steer()` / `followUp()`). The in-session extension asks the
host to deliver the message, and the hosts disagree about what a delivery mode means, so the adapter owns that
mapping instead of trusting the host:

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
(`AceDeliveryObserver`; `deliveryTimeoutMs`, default 30s). A host that never surfaces the event leaves it in the
group's pending list for redelivery instead of losing it. `ACE_DELIVERY=aside|portable` overrides host
detection when a host changes its surface.

`immediate` preempts at Pi's next **turn boundary** instead of aborting the running turn, so no partial output
or in-flight tool call is discarded. Mid-turn cancellation is deliberately out of the MVP (design doc §28/§29).

Pi only drains its steering and follow-up queues from a *live* agent loop. An event queued after that loop's last
poll would sit there until some unrelated run drained it, so `PiAdapter` records every queued event, watches for
the conversation message Pi emits when it injects it, and starts a new run for anything still undelivered once
the session settles. Events therefore reach the model exactly once, in order.

## Context injection

`body` enters the Pi context as a user message in this form (design doc §18):

```text
[ACE Event]
sender: agent-a (session e7f1a9)
id: evt_123

Build failed for project foo.
```

The header is an adapter choice, **not** part of ACE: the protocol only requires `body` to be visible to later
reasoning. The fixed prefix also keeps an ACE body from being mistaken for a Pi slash command or prompt template.
Pass `renderEvent` to `PiAdapter` to change the format.

## Errors and logging

| Situation | Behavior |
|---|---|
| Non-conforming message | rejected; through a transport it is logged and dropped, `handleRawMessage` throws `AceValidationError` |
| Transport or injection failure | propagated, so the transport can retry or dead-letter (RFC §17, design doc §30) |
| Unreachable broker | the start fails once with the URL; reconnection is bounded and an outage after the start is reported at most once until commands succeed again |
| Agent turn failure | reported through `PiAdapter`'s `onRunError`, since Pi records it on the assistant message rather than rejecting `prompt()` |
| Injected but never surfaced (extension, oh-my-pi) | the injection fails after `deliveryTimeoutMs`; the entry stays pending so reclaim can redeliver it (RFC §17). The retry may duplicate an event that the host did deliver late — at-least-once, and the event id in the injected header makes the duplicate visible |

Log lines carry `id`, `sender`, `subscribe`, and `activation` only — never the body.

## MVP limitations

- `manual` events live in process memory with `manual.max` / `manual.ttlMs` limits; a restart loses them
  (design doc §12). No persistence, no query API, no inbox API.
- Transports: `InMemoryTransport` and `RedisStreamsTransport`. Kafka/NATS adapters, a CLI, agent registry,
  dynamic targets, bindings, result events and acknowledgement APIs are out of scope (design doc §27, §37).
- No backlog: a subscription's consumer group is created at the stream's tail (`XGROUP CREATE … $`), so events
  published before the agent subscribed are skipped rather than replayed. Replay stays an infrastructure
  capability (RFC §17); the runtime consumes from now on.
- Dedup and metrics are per process and per subscription: two runtimes reading one group each keep their own window,
  and identities are not shared across processes.
- A reclaimed entry that fails `reclaimAttempts` times is recorded in the dead-letter file and then acknowledged, so
  it stops blocking the group. There is no replay command yet: reading the file is a human (or script) decision.
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
- The Pi engine is the public `@earendil-works/pi-coding-agent` SDK; Pi itself is not modified. Only
  `src/agent/pi-adapter.ts` and `extensions/ace.ts` import Pi (enforced by `test/architecture/host-boundary.test.ts`).

## Development

```bash
npm test           # unit + integration tests (faux model, fake Redis client, no network)
npm run verify:live   # the same runtime against a real broker (needs redis-server; no model needed)
npm run verify:omp    # the extension inside a real oh-my-pi session (needs omp + a model; one small turn)
```

CI (`.github/workflows/ci.yml`) runs the tests, `check`, the build and `verify:live` against a Redis service on every
push and pull request; `verify:omp` runs locally because it needs an `omp` binary and a model.

```bash
npm run check      # biome + tsc
npm run build
npm run example:basic   # in-memory transport, needs ACE_MODEL
npm run example:redis   # Redis Streams consumer, needs ACE_MODEL + a broker
```
