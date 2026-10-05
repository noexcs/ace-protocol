# ACE — Agent Context Event Protocol

External events — CI results, alerts, other agents — as an *active* input to an agent's context,
instead of something the agent has to poll for.

```text
External World ──► Transport ──► ACE Runtime ──► Agent Engine ──► Agent Context ──► LLM
                  (MQ adapter)    parse → validate → resolve activation → dispatch
```

This repository holds the protocol drafts, the runtime implementation, and the Pi integration used to
verify the design end to end.

| Path | What it is |
|---|---|
| [`docs/ACE-RFC-Draft-0.1.md`](docs/ACE-RFC-Draft-0.1.md) | The protocol: message envelope, activation semantics, conformance |
| [`docs/ace-v0.1.md`](docs/ace-v0.1.md) | The engineering guide for the first implementation |
| [`docs/ace-runtime-contracts.md`](docs/ace-runtime-contracts.md) | The implementation contracts: configuration keys, Redis key layout, tool parameters, delivery semantics, flows, invariants |
| [`packages/ace-runtime/`](packages/ace-runtime) | The runtime: protocol, transports, agent engines, Pi extension |
| [`pi/`](pi) | Upstream Pi checkout (gitignored) used for integration testing against its sources |

## Status

Feasibility experiment on **Pi** as the agent engine: an external event reaches a running Pi session,
drives a turn (or is queued/deferred per `activation`), and two Pi agents can talk to each other over
a real broker. Other agent hosts are planned, not started — see
[the runtime README](packages/ace-runtime/README.md) for the host boundary, and
[ace-omp](packages/ace-omp/README.md) for the Pi / oh-my-pi plugin.

Verified today: 565 tests (441 in the host-neutral core across 31 test files, 20 in the ace-omp host plugin
across 3, 65 in the ace-claude-code plugin across 9, 39 in the ace-codex bridge across 4), `npm run verify:live` in `packages/ace-runtime` (12 scenarios against a real Redis Streams broker:
delivery, poison messages, reclaim after a failed delivery, dedup, open inbound, manual activation, burst
spooling, the agent directory lifecycle and its crash sweep, dead-letter replay, and direct publish by channel
name), and `npm run verify:omp` in `packages/ace-omp` (3 scenarios inside a real `omp --mode rpc` session: the
system-prompt policy reaches the provider request, a `next_turn` event reaches the conversation and is
acknowledged, and a `manual` event is retained without starting a turn).

A session's channel is its address: a live session registers the channel named by its sender and can be found
by its peers in the **agent directory** on Redis (RFC §22 item 1). `ace_agents` lists the channels that are
online (its `agent` filter matches the coding agent a session runs, from its self-description), and
`ace_publish` takes a channel name as `channel` — a `<server>:<channel>` prefix picks the server when several
are configured, and the prefix is matched by configured name even when that server is down, in which case the
call fails instead of publishing elsewhere — or a list of channels to send one event to several peers at once
(each name must be a non-empty string). An event published to a channel this session reads comes back into its
own context marked `self: yes` — unless the activation is `manual`, which stores it instead of injecting it,
so the echo follows the same activation rule as any other delivery. See
[the contracts](docs/ace-runtime-contracts.md).

A file moves between sessions without entering any model's context: `ace_store_file` stores a local file on
every server the session is live on, under a random token and a TTL, and reports only where the copy
landed (`stored_on=`) plus the effective `name=`, the requested `ttl=`, and the `stored_at=`/`expires_at=`
instants; `ace_get_file` fetches it by that token from the first of its own servers that has it, returns
`name=` and the same `stored_at=`/`expires_at=` from the blob's metadata, and writes it into a quarantine
directory. The token is the capability — the store publishes no event, so the
model relays the line itself. See
[the file-transfer design](docs/ace-file-transfer.md).

## Quick start

```bash
cd packages/ace-omp
npm install --ignore-scripts   # links the core at packages/ace-runtime (build it once: npm run build)

# 1. say who you are and which servers you talk to (this repository's root has a working example)
cat > /tmp/ace-demo/.ace.json <<'JSON'
{
  "$schema": "/path/to/ace-protocol/packages/ace-runtime/schema/ace-config.schema.json",
  "username": "alice",
  "servers": { "local": { "url": "redis://127.0.0.1:6379", "subscribe": ["ci-failures"] } }
}
JSON

# 2. run Pi with the extension (needs a broker; `brew services start redis` gives one on 6379)
cd /tmp/ace-demo && pi --extension /path/to/ace-protocol/packages/ace-omp/extensions/ace.ts

# 3. publish from anywhere; the channel name derives the stream <namespace>:ch:<channel>
redis-cli XADD ace:ch:ace:alice:ci-failures '*' message \
  '{"aceVersion":"0.1","id":"e1","sender":"ci","activation":"next_turn","body":"Build failed."}'
```

Inside the session, `/ace` shows the runtime status, and `ace_publish` sends events to peers addressed by
their channel name. [ace-omp's README](packages/ace-omp/README.md) documents `.ace.json` and the activation
semantics on Pi; the [runtime README](packages/ace-runtime/README.md) documents the transports,
delivery guarantees, and the current limitations.

## Development

```bash
cd packages/ace-runtime      # the host-neutral core
npm test                     # unit + integration tests; no broker or credentials needed
npm run check                # biome + tsc --noEmit + the shared contracts
npm run verify:live          # the runtime against a real broker (redis-server); no model needed
npm run build

cd ../ace-omp                # the Pi / oh-my-pi host plugin
npm test                     # the plugin's tests, against the built core
npm run check                # biome + tsc --noEmit + the shared contracts
npm run verify:omp           # the plugin inside a real oh-my-pi session (needs omp + a model)
```

`pi/` is a checkout of the upstream Pi repository. Tests run against the published
`@earendil-works/*` packages (the builds users install); the checkout is here to read Pi's sources
and to run the live two-agent experiments in `docs/ace-v0.1.md`.

ACE was first built inside the Pi fork [`noexcs/pi`](https://github.com/noexcs/pi), branch
`ace-0.1-runtime`; that branch keeps the development history, this repository is where the code lives
now (see the `28fcff8` commit for why it moved out of the fork).
