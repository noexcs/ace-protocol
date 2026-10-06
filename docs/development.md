# Development

How to build, test and verify this repository — and what the current verification actually shows, including the
scenarios that fail here and why. The README keeps the entry points; this file keeps the detail.

## Running the tests

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

cd ../ace-dsh                # the DeepSeek Harness host plugin
npm run sync:vendor          # copy the current core build into vendor/ (after any core change)
npm test                     # unit + integration tests, against the vendored core
npm run check                # biome + tsc --noEmit + the shared contracts
npm run verify:bundle        # the built artifact driven through a stub host
npm run verify:client        # the browser half loaded through a __ModuleLoader__ shim
npm run verify:live          # the binding against a real broker; no model needed
```

`pi/` is a checkout of the upstream Pi repository. Tests run against the published `@earendil-works/*` packages
(the builds users install); the checkout is here to read Pi's sources and to run the live two-agent experiments
in [`docs/ace-v0.1.md`](ace-v0.1.md).

## Verification status

Verified on 2026-10-06: **520 tests pass and 0 fail** — 481 in the host-neutral core across 31 test files, and
39 in the ace-omp host plugin across 3.

`npm run verify:live` in `packages/ace-runtime` covers 12 scenarios against a real Redis Streams broker
(delivery, poison messages, reclaim after a failed delivery, dedup, open inbound, manual activation, burst
spooling, the agent directory lifecycle and its crash sweep, dead-letter replay, and direct publish by channel
name); **9 of the 12 pass on this machine**, and the three that fail (`valid event`, `poison message`, `reclaim
after failure`, all reporting `pending=1`) fail identically on the commit before the latest release, so they are
not from it.

`npm run verify:omp` in `packages/ace-omp` covers 5 scenarios inside a real `omp --mode rpc` session (the two
start-up assertions, the system-prompt policy reaching the provider request, a `next_turn` event reaching the
conversation and settling, and a `manual` event being retained without starting a turn); **4 of 5 pass**, and the
one that fails needs a working model turn — the provider configured on this machine does not answer
(`stopReason=error`).

`packages/ace-dsh` adds, for its binding: **61 unit tests, 6 browser-half scenarios, 6 bundled-artifact
scenarios and 7 live scenarios** against a real broker, all passing. It was also exercised **across hosts**: a
DSH session and an oh-my-pi session exchanged events in both directions, each naming the other's channel, and a
file stored on one host was fetched and hash-verified on the other.

## History

ACE was first built inside the Pi fork [`noexcs/pi`](https://github.com/noexcs/pi), branch `ace-0.1-runtime`; that
branch keeps the development history, this repository is where the code lives now (see the `28fcff8` commit for
why it moved out of the fork).
