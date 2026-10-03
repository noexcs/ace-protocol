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
| [`packages/ace-runtime/`](packages/ace-runtime) | The runtime: protocol, transports, agent engines, Pi extension |
| [`pi/`](pi) | Upstream Pi checkout (gitignored) used for integration testing against its sources |

## Status

Feasibility experiment on **Pi** as the agent engine: an external event reaches a running Pi session,
drives a turn (or is queued/deferred per `activation`), and two Pi agents can talk to each other over
a real broker. Other agent hosts are planned, not started — see
[the runtime README](packages/ace-runtime/README.md) for the host boundary and the split plan.

Verified today: 225 tests, real Redis Streams broker, two live Pi sessions exchanging events.

## Quick start

```bash
cd packages/ace-runtime
npm install --ignore-scripts

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
cd /tmp/ace-demo && pi --extension /path/to/ace-protocol/packages/ace-runtime/extensions/ace.ts

# 3. publish from anywhere
redis-cli XADD ace:in.a '*' message \
  '{"aceVersion":"0.1","id":"e1","sender":"ci","activation":"next_turn","body":"Build failed."}'
```

Inside the session, `/ace` shows the runtime status, and `ace_publish` sends events to configured
peers. The [runtime README](packages/ace-runtime/README.md) documents `.ace.json`, the activation
semantics on Pi, transports, delivery guarantees, and the current limitations.

## Development

```bash
cd packages/ace-runtime
npm test          # unit + integration tests; no broker or credentials needed
npm run check     # biome + tsc --noEmit
npm run build
```

`pi/` is a checkout of the upstream Pi repository. Tests run against the published
`@earendil-works/*` packages (the builds users install); the checkout is here to read Pi's sources
and to run the live two-agent experiments in `docs/ace-v0.1.md`.
