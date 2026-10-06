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
| [`packages/ace-dsh/`](packages/ace-dsh) | The DeepSeek Harness host plugin: the same protocol on a second host, which needed no change to the core |
| [`oh-my-pi/`](oh-my-pi) | Upstream oh-my-pi checkout (gitignored) used for integration testing against its sources |

## Status

Feasibility experiment on **Pi** as the agent engine: an external event reaches a running Pi session,
drives a turn (or is queued/deferred per `activation`), and two Pi agents can talk to each other over
a real broker. **oh-my-pi / Pi is the verified reference host** — the plugin is
[ace-omp](packages/ace-omp/README.md); see [the runtime README](packages/ace-runtime/README.md) for
the host boundary.

A second host now exists: [`ace-dsh`](packages/ace-dsh/README.md) runs the same protocol inside
**DeepSeek Harness**, whose process hosts many sessions at once — so the runtime is one per agent, channels
are registered and withdrawn with the agent's own lifecycle, and tools are registered on the agent's scope
rather than globally. It needed no change to the core: the host-neutral modules already had the seam
(`AgentEngine`, `AgentRegistry`, `shutdownAce`), and its own tests cover the binding (61 tests, 6
bundled-artifact scenarios, 6 browser-half scenarios, plus 7 live scenarios against a real broker). It runs in
a desktop profile and has been exercised **across hosts**: a DSH session and an oh-my-pi session exchanged
events in both directions, each naming the other's channel, and a file stored on one host was fetched and
hash-verified on the other. DSH reads live channels only, so `.ace.json` `subscribe` (persistent channels) is
reported and ignored there.

Verified on 2026-10-06: 520 tests pass and 0 fail — 481 in the host-neutral core across 31 test files,
and 39 in the ace-omp host plugin across 3.

`npm run verify:live` in `packages/ace-runtime` covers 12 scenarios against a real Redis Streams broker
(delivery, poison messages, reclaim after a failed delivery, dedup, open inbound, manual activation, burst
spooling, the agent directory lifecycle and its crash sweep, dead-letter replay, and direct publish by
channel name); **9 of the 12 pass on this machine**, and the three that fail (`valid event`,
`poison message`, `reclaim after failure`, all reporting `pending=1`) fail identically on the commit before
the latest release, so they are not from it. `npm run verify:omp` in `packages/ace-omp` covers 5 scenarios
inside a real `omp --mode rpc` session (the two start-up assertions, the system-prompt policy reaching the
provider request, a `next_turn` event reaching the conversation and settling, and a `manual` event being
retained without starting a turn); 4 of 5 pass, and the one that fails needs a working model turn — the
provider configured on this machine does not answer (`stopReason=error`).

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
#    If the plugin is already installed or linked, start the host plainly instead — passing
#    `--extension` for the same file loads it twice, and the duplicate copy is inert, so `/ace`
#    commands would land on the copy that never started the runtime.
cd /tmp/ace-demo && pi --extension /path/to/ace-protocol/packages/ace-omp/extensions/ace.ts

# 3. publish from anywhere; the channel name derives the stream <namespace>:ch:<channel>
redis-cli XADD ace:ch:ace:alice:ci-failures '*' message \
  '{"aceVersion":"0.1","id":"e1","sender":"ci","activation":"next_turn","body":"Build failed."}'
```

Inside the session, bare `/ace` opens the channel manager (a framed view you step through with the arrow
keys and `esc`), and `/ace list`, `agents`, `stats`, `pending` and `help` write their report **into the
session record** — nothing is held while you read them, they scroll back like any other output, and a report
stays visible across turns. `ace_publish` sends events to peers addressed by their channel name. [ace-omp's README](packages/ace-omp/README.md) documents `.ace.json` and the activation
semantics on Pi; the [runtime README](packages/ace-runtime/README.md) documents the transports,
delivery guarantees, and the current limitations.

## Installing the host plugins

One protocol, one `.ace.json`, one broker: the plugin is per host and the core is shared, so a session on Pi
and a session on DeepSeek Harness can talk to each other with no translation.

### Pi / oh-my-pi — [`ace-omp`](packages/ace-omp/README.md)

```bash
omp plugin install https://github.com/noexcs/ace-protocol/releases/download/v0.2.18/ace-omp-0.2.18.tgz
omp plugin list          # → ace-omp, enabled, manifest ./extensions/ace.ts
```

The tarball carries the vendored core, so nothing is built on the installing machine. From a checkout instead:
`cd packages/ace-runtime && npm install && npm run build`, then in `packages/ace-omp`
`node ../../scripts/check-vendor-sync.ts --write && omp plugin link "$PWD"`.

- The extension is loaded **at session start**, so installing or updating it takes effect in a **new session**.
- **Link once.** Do not also pass `-e/--extension` for the same file: two copies of one module register the
  same command and tools in a single session. (The extension detects the duplicate and makes the second copy
  delegate, but the flag is still a pointless second load.)
- Plain **Pi** has no plugin registry, so there
  `pi --extension /path/to/ace-protocol/packages/ace-omp/extensions/ace.ts` is the only route — and, exactly as
  above, passing it twice is the same mistake.

**Use.** Five tools — `ace_publish`, `ace_agents`, `ace_channels` (what this session reads), `ace_store_file`
and `ace_get_file` — plus a command surface: bare `/ace` opens the channel manager, and `/ace list`,
`/ace agents [filter]`, `/ace pending`, `/ace activate <sender> <id>`, `/ace stats` and `/ace help` write their
report **into the session record**. Configuration is `<cwd>/.ace.json`, falling back to
`~/.omp/agent/ace.json` (or under `$XDG_CONFIG_HOME/omp`), with `$ACE_CONFIG` overriding both. Unlike DSH, this
host also **reads persistent channels**: `.ace.json` `subscribe` names topic/service channels, and the session
reads them alongside its own inbox. Activation is `immediate`, `next_turn` or `manual`, defaulting to the
`.ace.json` value; `manual` events are retained (24h) until `/ace activate` injects one.

### DeepSeek Harness — [`ace-dsh`](packages/ace-dsh/README.md)

```bash
# any profile the CLI manages:
dsh plugin --profile <profile> add \
  https://github.com/noexcs/ace-protocol/releases/download/ace-dsh-v0.1.0/ace-dsh-0.1.0.tgz
# then restart the host so the profile recomposes
```

`lib/index.js` is bundled — the vendored core is inlined — so the tarball is self-contained. The package
declares `dsh.bundle.patch`, so one entry is all a profile needs.

**The desktop application's own profile is managed by the app** (`dsh plugin --profile desktop` is refused), so
install there through the app's plugin manager, or by hand: add the tarball URL to
`~/.dsh/profiles/<profile>/package.json` under `dependencies` and the package name to `dsh.profile.bundles`,
then restart. From a checkout instead: `npm run sync:vendor && npm run build` in `packages/ace-dsh`, then
`dsh plugin --profile <profile> add file:$PWD/dist-package`.

**Use.** One runtime per agent. A session registers the channel named by its sender while it is live and
withdraws it when it ends, so a session with no `.ace.json` anywhere is completely inert — no connection, no
address, no tools. Six tools: `ace_publish`, `ace_agents`, `ace_store_file`, `ace_get_file`, plus this host's
own two, `ace_pending` and `ace_activate`, which replace the command surface a DSH client session cannot
dispatch. The composer's tool row carries a **channel chip** — green with the channel tail while the session is
registered, and honest `off` / `!` / `?` states otherwise — reading the host half's
`GET /api/ace.status`. Configuration is `<cwd>/.ace.json`, falling back to `$DSH_HOME/ace.json`
(`~/.dsh/ace.json`). This host reads **live channels only**: `subscribe` entries are reported and ignored.

### Not part of the protocol

`open_session` — a host capability that opens a new root session, with an optional first message and title —
has its own repository, [noexcs/dsh-open-session](https://github.com/noexcs/dsh-open-session). It depends on
nothing in ACE: it is a plain DSH host plugin, and it keeps working with ACE disabled.

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
