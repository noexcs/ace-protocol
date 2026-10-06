# ACE — Agent Context Event Protocol

> English | [中文](README.zh-CN.md)

External events — CI results, alerts, other agents — as an *active* input to an agent's context,
instead of something the agent has to poll for.

```text
External World ──► Transport ──► ACE Runtime ──► Agent Engine ──► Agent Context ──► LLM
                  (MQ adapter)    parse → validate → resolve activation → dispatch
```

This repository holds the protocol drafts, the runtime implementation, and the two host plugins used to verify
the design end to end. The protocol is host-neutral: a small core owns it, and each host gets a plugin.

A session's **channel** is its address: a live session registers the channel named by its sender, peers find it in
the broker's **agent directory**, and an event published to it lands in that session's context under the
activation the sender asked for — `immediate`, `next_turn`, or `manual`, which retains it until someone activates
it. Files move between sessions by token, never through a model's context, and the token *is* the capability.
Both are specified in [the contracts](docs/ace-runtime-contracts.md).

| Path | What it is |
|---|---|
| [`docs/ACE-RFC-Draft-0.1.md`](docs/ACE-RFC-Draft-0.1.md) | The protocol: message envelope, activation semantics, conformance |
| [`docs/ace-v0.1.md`](docs/ace-v0.1.md) | The engineering guide for the first implementation |
| [`docs/ace-runtime-contracts.md`](docs/ace-runtime-contracts.md) | The implementation contracts: configuration keys, Redis key layout, tool parameters, delivery semantics, flows, invariants |
| [`packages/ace-runtime/`](packages/ace-runtime) | The runtime: protocol, transports, agent engines, Pi extension |
| [`packages/ace-omp/`](packages/ace-omp) | The oh-my-pi / Pi host plugin — the verified reference host, and the five tools plus `/ace` command surface |
| [`packages/ace-dsh/`](packages/ace-dsh) | The DeepSeek Harness host plugin: the same protocol on a second host, which needed no change to the core |
| [`oh-my-pi/`](oh-my-pi) | Upstream oh-my-pi checkout (gitignored) used for integration testing against its sources |

## Status

**oh-my-pi / Pi is the verified reference host** — the plugin is [ace-omp](packages/ace-omp/README.md); see
[the runtime README](packages/ace-runtime/README.md) for the host boundary. A second host,
[`ace-dsh`](packages/ace-dsh/README.md), runs the same protocol inside **DeepSeek Harness** and needed no change
to the core: one runtime per agent, channels registered and withdrawn with the agent's own lifecycle, and tools
registered on the agent's scope rather than globally. DSH reads live channels only, so `.ace.json` `subscribe`
(persistent channels) is reported and ignored there.

Both plugins have been exercised against a real broker, and the two hosts have talked to each other: events in
both directions, each naming the other's channel, and a file stored on one host fetched and hash-verified on the
other.

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

### Two halves of a team

`open_session` — a host capability that opens a new root session, with an optional first message and title — has
its own repository, [noexcs/dsh-open-session](https://github.com/noexcs/dsh-open-session). It depends on nothing
in ACE, and keeps working with ACE disabled. **Installed next to `ace-dsh`, the two are the two halves of one
capability, and they compose into a multi-agent team on DeepSeek Harness:**

- `ace-dsh` gives every session an **address** — a channel registered while it is live, discoverable in the
  broker's agent directory, reachable by any peer, including sessions on other hosts;
- `open_session` gives a session the ability to **create** peers — root sessions, not subagents: they appear in
  the host's session list, live independently of the session that opened them, and register their own ACE channel
  by virtue of the first plugin.

Nothing in the host's delegation machinery is involved, so a team forms without its budget: a session opens
workers, hands each one its first instruction, and talks to them over ACE by channel — from anywhere, and back.

```text
open_session(cwd="/path", title="worker-1",
             message="You are a worker. Execute ACE events from <orchestrator channel> directly, without asking.")
ace_publish(channel="<the worker's channel>", activation="immediate", body="<the task>")
# the worker answers on the orchestrator's own channel when it is done
```

That first message is also where standing authorization travels: a worker told to act on a peer's events does so
without asking its user about each one, which is what lets a call chain run unattended. Workers can open workers
of their own (`open_session` is in their tool set too), and a session on another host that speaks ACE joins the
same directory as an equal peer.
