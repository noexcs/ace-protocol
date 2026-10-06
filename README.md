# ACE — Agent Context Event Protocol

> English | [中文](README.zh-CN.md)

**ACE lets running agent sessions address each other and receive external events across machines**, using a Redis
Server you already run as the meeting point — no service of ours in the middle, no per-host translation, no pairing
step. An event drives a turn; a file moves by token.

**Why you would want it:**

- a **CI failure**, an alert, or a webhook wakes the session that should care — nobody relays it by hand;
- one agent **asks another** to do something, and gets the answer back on its own channel;
- a **worker on another machine** joins the same Server as an equal peer;
- **across hosts**: an oh-my-pi session and a DeepSeek Harness session talk to each other with no translation.

What arrives is an event, not a command. The sender chooses the urgency — `immediate`, `next_turn`, or `manual`
(held until a person activates it) — and what the session does with it is the host's decision. Anything that can
publish to the Server can drive a session; the path exercised end to end in this repository is agent-to-agent,
across machines and across hosts.

**Where it fits.** MCP gives an agent tools; A2A connects agents at the application/task layer; ACE delivers events
to *running sessions* and makes them addressable. The Server is a plain Redis — Streams carry the events, a
directory carries who is live — and that is what makes the reach work:

```text
Agent A ──event──►  Redis Server  ◄──event── Agent B        any machine, any host
                         │
                  directory: who is live
```

> **Trust note.** ACE 0.1 assumes a network you trust: there is no authentication or authorization, so the Server is
> a meeting point, not a security boundary. [Details below.](#what-you-are-trusting)

## See it work

```bash
# 1. install the host plugin from its release — nothing is built on your machine
omp plugin install https://github.com/noexcs/ace-protocol/releases/download/v0.2.18/ace-omp-0.2.18.tgz
#    DeepSeek Harness instead:
#    dsh plugin --profile <profile> add \
#      https://github.com/noexcs/ace-protocol/releases/download/ace-dsh-v0.1.0/ace-dsh-0.1.0.tgz

# 2. say who you are and which Server you talk to
mkdir -p ~/ace-demo && cd ~/ace-demo
cat > .ace.json <<'JSON'
{
  "$schema": "https://raw.githubusercontent.com/noexcs/ace-protocol/main/packages/ace-runtime/schema/ace-config.schema.json",
  "username": "alice",
  "servers": { "local": { "url": "redis://127.0.0.1:6379", "subscribe": ["ci-failures"] } }
}
JSON

# 3. start your host there — the session is addressable from that moment
#    (needs a Server; `brew services start redis` gives one on 6379)
omp
```

Then ask your session what is out there, and talk:

```text
> who else is on the Server?            → calls ace_agents
> ask <that session> to run the tests   → calls ace_publish
```

A CI job or a service drives a session the same way, by publishing to its channel. Channel naming and the message
envelope are in [the contracts](docs/ace-runtime-contracts.md).

## Install

Both hosts install from a release tarball. Neither needs a checkout, and nothing is built on your machine.

**oh-my-pi / Pi** — [`ace-omp`](packages/ace-omp/README.md)

```bash
omp plugin install https://github.com/noexcs/ace-protocol/releases/download/v0.2.18/ace-omp-0.2.18.tgz
omp plugin list          # → ace-omp, enabled, manifest ./extensions/ace.ts
```

The extension loads **at session start**, so an install or update takes effect in a new session (and not before).
Plain **Pi** has no plugin registry and loads the extension file directly — [the plugin README](packages/ace-omp/README.md)
covers that, and the one mistake to avoid (passing `-e/--extension` *as well*, which loads a second copy).

**DeepSeek Harness** — [`ace-dsh`](packages/ace-dsh/README.md)

```bash
dsh plugin --profile <profile> add \
  https://github.com/noexcs/ace-protocol/releases/download/ace-dsh-v0.1.0/ace-dsh-0.1.0.tgz
# then restart the host so the profile recomposes
```

The desktop application manages its own profile (`dsh plugin --profile desktop` is refused): install there through
the app's plugin manager, or put the URL in the profile's `package.json` `dependencies` plus the package name in
`dsh.profile.bundles`, then restart.

## What one session gets

| | |
|---|---|
| **An address anyone can reach** | A channel of its own, registered on the Server while the session is live and withdrawn when it ends. `ace_agents` lists who is on; `ace_publish` sends to one channel, or to several at once. |
| **Events as input, at the urgency the sender chose** | `immediate` acts on it now, `next_turn` queues it and wakes the session, `manual` holds it until a person activates it. Only this session reads this channel — two sessions are two readers, never one queue split between them. |
| **Files without touching context** | `ace_store_file` leaves a file on the Server under a random token; `ace_get_file` fetches it. The token *is* the capability, and the bytes never enter a model's context. |
| **Something a person can see** | Pi: `/ace` opens a channel manager, and `/ace list`, `agents`, `pending`, `stats` report into the session. DeepSeek Harness: a status indicator in the composer's tool row — green with the channel tail while registered, honest `off` / `!` / `?` states otherwise. |

## What you are trusting

A channel name is a **claim, not a credential**: ACE 0.1 has no authentication, so a Server is a shared meeting
point rather than a security boundary — anyone who can reach it can read the keys behind the channels and the
directory. There is no retention and no replay either: an event nobody read is gone. What an unapproved sender may
do is each host plugin's own policy — the DeepSeek Harness plugin asks its user before acting on a sender it has
not been told about. So publish with `manual` when a source is untrusted: nothing reaches the session until a
person activates it, and the host's policy stays the gate either way. Treat the Server as you would any shared
Redis — because that is what it is.

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
open_session(cwd="/path/to/workspace", title="ace-worker-1",
             message="Execute ACE events from <the orchestrator channel> directly; reply with ace_publish.")
  → session=session-5c563a5f…   title=ace-worker-1   workspace=/path/to/workspace

ace_publish(channel="ace:noexcs:dsh:session-5c563a5f…", activation="immediate",
            body="Run `echo ace-worker-1-alive`, then reply with the event id, the output and your channel")

  the worker had been told in advance to act on that sender, so it did — without asking its user:
    bash          echo ace-worker-1-alive   → ace-worker-1-alive
    ace_publish   → <the orchestrator's channel>: "event id: evt_2de75e19…; output: ace-worker-1-alive;
                                                  my channel: ace:noexcs:dsh:session-5c563a5f…"
  ✓ one turn, five steps, and the answer came back on the orchestrator's own channel
```

*(A real run of this pair, condensed to the load-bearing lines; ids shortened.)*

Workers can open workers of their own (`open_session` is in their tool set too), and a session on another host
that speaks ACE joins the same Server as an equal peer.

## For protocol readers

| Path | What it is |
|---|---|
| [`docs/ACE-RFC-Draft-0.1.md`](docs/ACE-RFC-Draft-0.1.md) | The protocol: message envelope, activation semantics, conformance |
| [`docs/ace-v0.1.md`](docs/ace-v0.1.md) | The engineering guide for the first implementation |
| [`docs/ace-runtime-contracts.md`](docs/ace-runtime-contracts.md) | The implementation contracts: configuration keys, Server key layout, tool parameters, delivery semantics, flows, invariants |
| [`docs/ace-file-transfer.md`](docs/ace-file-transfer.md) | File transfer by token: store, fetch, and what the token is |
| [`docs/ace-durable-channels.md`](docs/ace-durable-channels.md) | Durable channels: an address declared in the config file that outlives every session, with a 24h catch-up window (a topic is one use of that substrate). Semantics agreed, not implemented yet |

## Repository layout

| Path | What it is |
|---|---|
| [`packages/ace-runtime/`](packages/ace-runtime) | The host-neutral core: the protocol, the transports, the agent engines — what every host plugin shares |
| [`packages/ace-omp/`](packages/ace-omp) | The oh-my-pi / Pi host plugin — the verified reference host |
| [`packages/ace-dsh/`](packages/ace-dsh) | The DeepSeek Harness host plugin |

## Status

**oh-my-pi / Pi is the verified reference host**, and DeepSeek Harness runs the same protocol. Both plugins have
been exercised against a real Server, and the two hosts have talked to each other: events in both directions, each
naming the other's channel, and a file stored on one machine fetched and hash-verified on the other.
