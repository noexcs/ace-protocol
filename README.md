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

Verified today: 360 tests (328 in the host-neutral core, 32 in the host plugin), `npm run verify:live` in
`packages/ace-runtime` (nine scenarios against a real Redis Streams broker: delivery, poison messages, reclaim
after a failed delivery, dedup, sender allowlists, manual activation, burst spooling, the agent directory
lifecycle and its crash sweep), `npm run verify:omp` in `packages/ace-omp` (the plugin inside a real
`omp --mode rpc` session: an event reaches the conversation, the turn settles, the entry is acknowledged), and
two live Pi sessions exchanging events.

A session can also publish itself to an **agent directory** on Redis and be found by its peers
(`registry` in `.ace.json`; RFC §22 item 1): `ace_agents` lists the sessions that are online, and `ace_publish`
takes a member as `target` — or a list of targets — to send one event to several peers at once. See
[the contracts](docs/ace-runtime-contracts.md).

## Quick start

```bash
cd packages/ace-omp
npm install --ignore-scripts   # links the core at packages/ace-runtime (build it once: npm run build)

# 1. describe where events come from (this repository's root has a working example)
cat > /tmp/ace-demo/.ace.json <<'JSON'
{
  "$schema": "/path/to/ace-protocol/packages/ace-runtime/schema/ace-config.schema.json",
  "sender": "agent-a",
  "subscribe": [ { "name": "inbox", "transport": "redis-streams",
                   "config": { "stream": "ace:in.a", "group": "agent-a" } } ]
}
JSON

# 2. run Pi with the extension (needs a broker; `brew services start redis` gives one on 6379)
cd /tmp/ace-demo && pi --extension /path/to/ace-protocol/packages/ace-omp/extensions/ace.ts

# 3. publish from anywhere
redis-cli XADD ace:in.a '*' message \
  '{"aceVersion":"0.1","id":"e1","sender":"ci","activation":"next_turn","body":"Build failed."}'
```

Inside the session, `/ace` shows the runtime status, and `ace_publish` sends events to configured
peers. [ace-omp's README](packages/ace-omp/README.md) documents `.ace.json` and the activation
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
