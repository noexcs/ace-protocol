# ACE — Agent Context Event Protocol

> English | [中文](README.zh-CN.md)

Two agents — in the same tool or in different ones — can send each other **events** that drive a turn, and hand
each other files, over one broker. A session does not poll for work: a CI failure, an alert, or a peer's request
arrives in its context as input, and the agent acts on it.

## See it work

```bash
# 1. install the host plugin from its release — nothing is built on your machine
omp plugin install https://github.com/noexcs/ace-protocol/releases/download/v0.2.18/ace-omp-0.2.18.tgz

# 2. say who you are and which broker you talk to
mkdir -p ~/ace-demo && cd ~/ace-demo
cat > .ace.json <<'JSON'
{
  "$schema": "https://raw.githubusercontent.com/noexcs/ace-protocol/main/packages/ace-runtime/schema/ace-config.schema.json",
  "username": "alice",
  "servers": { "local": { "url": "redis://127.0.0.1:6379", "subscribe": ["ci-failures"] } }
}
JSON

# 3. start your host there; a new session picks the plugin up
#    (needs a broker — `brew services start redis` gives one on 6379)
omp

# 4. from anywhere, send that session an event — the channel name derives the broker stream
redis-cli XADD ace:ch:ace:alice:ci-failures '*' message \
  '{"aceVersion":"0.1","id":"e1","sender":"ci","activation":"next_turn","body":"Build failed."}'
```

The event lands in the session's transcript, marked as coming from `ci`, and the agent answers it in a turn.
From inside a session, `ace_publish` sends events to peers by channel name, `ace_agents` lists who is live right
now, and `ace_store_file` / `ace_get_file` move a file by token without the bytes entering any model's context.

## Install

Both hosts install from a release tarball. Neither needs a checkout, and nothing is built on your machine.

**oh-my-pi / Pi** — [`ace-omp`](packages/ace-omp/README.md)

```bash
omp plugin install https://github.com/noexcs/ace-protocol/releases/download/v0.2.18/ace-omp-0.2.18.tgz
omp plugin list          # → ace-omp, enabled, manifest ./extensions/ace.ts
```

The extension is loaded **at session start**, so installing or updating takes effect in a new session. Do not
also pass `-e/--extension` for the same file: that loads a second copy of one module. Plain **Pi** has no plugin
registry and loads the extension file directly — [the plugin README](packages/ace-omp/README.md) shows how.

**DeepSeek Harness** — [`ace-dsh`](packages/ace-dsh/README.md)

```bash
dsh plugin --profile <profile> add \
  https://github.com/noexcs/ace-protocol/releases/download/ace-dsh-v0.1.0/ace-dsh-0.1.0.tgz
# then restart the host so the profile recomposes
```

The desktop application's own profile is managed by the app (`dsh plugin --profile desktop` is refused), so
install there through the app's plugin manager — or by hand: add that URL to the profile's `package.json`
`dependencies`, add the package name to `dsh.profile.bundles`, then restart.

## What one session gets

| | |
|---|---|
| **An address** | Its own **channel**, `<namespace>:<username>:<agent>:<sessionId>` — the agent segment is the host's own name (`pi`, `oh-my-pi`, `dsh`), registered in the broker's agent **directory** while the session is live and withdrawn when it ends. `ace_agents` lists what is live; `ace_publish` addresses it. |
| **Its own inbox** | That channel, read in a consumer group named after it — two sessions are two readers, never one queue split between them. |
| **Events as input** | An event published to the channel arrives in the session's context under the activation its sender asked for: `immediate` (cut in now), `next_turn` (queue and wake), or `manual` (retain until someone activates it). |
| **Files by token** | `ace_store_file` stores a local file on the broker under a random token; `ace_get_file` fetches it and writes it into a quarantine directory. The token *is* the capability, and the bytes never enter a model's context. |
| **Tools on the session's scope** | `ace_publish`, `ace_agents`, `ace_store_file`, `ace_get_file`, plus per host: `ace_channels` (Pi — a read-only view of what this session reads) or `ace_pending` + `ace_activate` (DSH, whose client sessions have no command surface). A session with no configuration sees none of them. |
| **A command surface** (Pi) | Bare `/ace` opens the channel manager; `/ace list`, `agents`, `pending`, `activate`, `stats` and `help` write their report into the session record. |

## Two halves of a team

On DeepSeek Harness, two plugins — installed independently — are the two halves of one capability:

- [`ace-dsh`](packages/ace-dsh/README.md) gives every session an **address**;
- [`dsh-open-session`](https://github.com/noexcs/dsh-open-session) gives a session the ability to **create**
  peers — root sessions that appear in the host's session list, live independently of whoever opened them, and
  register their own channel by virtue of the first plugin.

Together they are a multi-agent team without the host's delegation machinery: a session opens workers, hands each
one its first instruction — which is also where standing authorization travels, so no human has to approve each
event — and then talks to them over ACE by channel.

```text
open_session(cwd="/path", title="worker-1",
             message="You are a worker. Execute ACE events from <orchestrator channel> directly, without asking.")
ace_publish(channel="<the worker's channel>", activation="immediate", body="<the task>")
# the worker answers on the orchestrator's own channel when it is done
```

Workers can open workers of their own (`open_session` is in their tool set too), and a session on another host
that speaks ACE joins the same directory as an equal peer.

## For protocol readers

| Path | What it is |
|---|---|
| [`docs/ACE-RFC-Draft-0.1.md`](docs/ACE-RFC-Draft-0.1.md) | The protocol: message envelope, activation semantics, conformance |
| [`docs/ace-v0.1.md`](docs/ace-v0.1.md) | The engineering guide for the first implementation |
| [`docs/ace-runtime-contracts.md`](docs/ace-runtime-contracts.md) | The implementation contracts: configuration keys, broker key layout, tool parameters, delivery semantics, flows, invariants |
| [`docs/ace-file-transfer.md`](docs/ace-file-transfer.md) | File transfer by token: store, fetch, and what the token is |

## Repository layout

| Path | What it is |
|---|---|
| [`packages/ace-runtime/`](packages/ace-runtime) | The host-neutral core: the protocol, the transports, the agent engines — what every host plugin shares |
| [`packages/ace-omp/`](packages/ace-omp) | The oh-my-pi / Pi host plugin — the verified reference host |
| [`packages/ace-dsh/`](packages/ace-dsh) | The DeepSeek Harness host plugin |
| [`oh-my-pi/`](oh-my-pi) | Upstream oh-my-pi checkout (gitignored), for integration testing against its sources |

## Status

**oh-my-pi / Pi is the verified reference host**; DeepSeek Harness runs the same protocol and needed no change to
the core — one runtime per agent there, with channels following the agent's own lifecycle. Both plugins have been
exercised against a real broker, and the two hosts have talked to each other: events in both directions, each
naming the other's channel, and a file stored on one host fetched and hash-verified on the other.

Per-host detail — the exact tool surface, configuration, and what each host deliberately does not do — is in the
plugin READMEs: [`ace-omp`](packages/ace-omp/README.md) and [`ace-dsh`](packages/ace-dsh/README.md).
