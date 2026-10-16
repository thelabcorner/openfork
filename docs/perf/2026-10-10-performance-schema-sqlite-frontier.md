# OpenFork performance frontier: schema projection and SQLite lane tradeoff

**Date:** October 10, 2026. **Scope:** live shared OpenFork checkout, measured with the existing opt-in isolated V1 delegated-Session harness. No running OpenFork instance/sidecar was restarted and no live database was intentionally read or modified.

**Subsequent incident update:** The results and conclusion of the original
25/50-Session experiment remain historical evidence. The analytical scan lane
has subsequently become worker-backed by default, but the interactive reader
remains opt-in, in order not to silently accept the measured reduction in
high-concurrency Session throughput. Both file-backed readers use native
read-only handles. See
`docs/research/sqlite-primary-permit-incident-2026-10-10.md` for the later
500-second SELECT forensic incident and the new reader scheduling tests.

## Source and ownership evidence

- Repo root `AGENTS.md`, `packages/core/AGENTS.md`, `docs/map/README.md`, and `docs/perf/session-concurrency-frontier-2026-10-09.md` were inspected before source changes. V1 executes production sessions; V2 is the preferred UI. Core owns the SQLite write/read/scan lanes. This campaign made **no changes** to Core Database, authorization, provider selection, session execution, or caching of mutable tool/plugin definitions.
- `packages/core/src/database/database.ts` owns short synchronous primary writes, a dedicated interactive `readDb`, and a lazy scan connection plus the optional leased scan pool. `OPENFORK_SQLITE_ASYNC_READ_WORKER=1` is a **controlled experiment**, not a production default.
- During an isolated 25-session CPU-profile run, startup/import work, Effect scheduling, TypeScript module work, and native directory enumeration appeared prominently. This combined cold-start / fake-provider profile is not a clean attribution of warm Session CPU, and does not prove any single subsystem causes the event-loop stalls.

## Applied low-risk optimization: avoid pointless JSON-schema cloning

`packages/opencode/src/tool/json-schema.ts` converts pre-materialized JSON Schemas for provider tool manifests. The old path always performed a second recursive object-tree clone in `inlineLocalReferences`, even when the normalized schema contained no local `$ref`. The new `resolveLocalReferences` first checks for local references and **reuses the already fresh normalized tree** when no inlining is needed. It still drops unused `$defs`/ `definitions` and routes genuine references through the original recursive inlining, unmodified.

This is a pure tool-schema projection optimization, not a tool registry or authorization change. No schema-by-object-identity cache was added: plugin/custom schema objects can change between resolves, and per-request tool definitions/execute callbacks remain live.

**Focused tests:** the existing named-reference tests pass, and the dedicated `test/tool/json-schema-reference.test.ts` adds four new cases. A duplicate targeted case was removed from the concurrently edited `parameters.test.ts` file without touching another agent's Task attachment cases. Before removal the full `parameters.test.ts` run passed **65/67**; two remaining failures were the `websearch` wire snapshot and `Task` missing-prompt expectation, neither affected by the schema fast-path change. Those are not represented as a green suite.

**Additional reference integrity gate:** `bun test test/tool/json-schema-reference.test.ts` passed 4/4 with 10 assertions, covering repeated named references, recursive local-reference cycles, external references, and immutable outputs across mutable source updates.

**Single-process microbenchmark**, 64 independently named string properties, 200 warmups followed by 8 measured rounds of 1,000 `ToolJsonSchema.fromJsonSchema(schema)` calls, directly under Bun in `packages/opencode`:

| Code | Eight-round median, ms / 1,000 calls | Representative full round samples (ms) |
| --- | ---: | --- |
| Before | 74.90 | 74.90, 66.07, 58.21, 64.59, 55.85, 88.31, 83.53, 91.73 |
| After run 1 | 37.49 | 42.31, 37.49, 33.70, 34.13, 33.10, 192.56, 36.57, 42.07 |
| After run 2 | 34.45 | 35.49, 30.91, 30.72, 34.59, 30.57, 32.06, 34.45, 47.96 |

The observed median ratio is roughly **2.0x–2.2x for this narrow reference-free shape**. A noisy 192.56-ms outlier warns against treating this as deterministic production latency. It does **not** establish a whole-app throughput, TTFT, or memory improvement. No production threshold/benchmark gate has yet been added.

## Fresh integrated fake-provider concurrency experiment

Command: `bun script/bench-session-concurrency.ts N` from `packages/opencode`. The script creates and verifies an independent temporary SQLite database and isolated application storage BEFORE importing OpenFork runtime modules; a local fake HTTP provider holds all distinct Session request tails until the overlap barrier has reached N. A second lane uses `OPENFORK_BENCH_SQLITE_READ_WORKER=1`. All four scenarios confirmed N unique overlapping provider requests, N terminal completed Sessions, no externally hosted provider calls.

| Sessions | Interactive reader | Completed/s | Total ms | Provider arrival p50 ms | Sampled event-loop lag p95 ms | Maximum lag ms |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 25 | Synchronous | 10.83 | 2307.5 | 1413.8 | 850.4 | 850.4 |
| 25 | Worker-backed | 8.38 | 2984.4 | 1770.0 | 100.5 | 190.9 |
| 50 | Synchronous | 14.64 | 3414.5 | 2026.4 | 1265.1 | 1265.1 |
| 50 | Worker-backed | 10.47 | 4776.5 | 2832.9 | 89.3 | 236.3 |

Reader offloading improved **maximum sampled event-loop lag** 77.6% at 25 and 81.3% at 50, but lost completed throughput 22.6% at 25 and 28.5% at 50. The 50-session synchronous value above is a second run with **ERROR logging matched** to the worker run (an additional INFO-log sync run yielded 13.27/s and 1361.8-ms maximum lag). All are **single-run, shared-machine measurements**, not a robust distribution of repeated matched pairs. This confirms a latency-throughput tradeoff in these runs and does not support activating async reads by default. The benchmarks are local fake-provider runtime tests and exclude real account quotas, remote inference, Electron rendering, interactive foreground typing, and multi-host writers.

**Reconciliation with parallel work:** `docs/perf/2026-10-10-session-concurrency-lanes.md` independently reports an ERROR-log 50-session read-worker run *faster* than its synchronous comparison (15.72 vs 13.62 completed/s) as well as a large read-worker loss at 100 sessions. That is a material contradictory 50-session result, so a universal 50-session throughput regression is **not proven**. That lane also tested and rejected four Session-affine read workers and measured a cancellation-ack latency regression. The next A/B must randomize repeated matched runs, including cancellations, before choosing an execution-lane default.

The existing benchmark can leave its disposable temporary DB directory on Windows with an EBUSY-on-cleanup warning; no production DB maintenance, rollback, deletion, or user storage cleanup was performed in response.

## Current validation and next decision

- `bun run typecheck` in `packages/opencode` remains **red on concurrently changed paths**, including support-bundle CLI, session global API/session-read contracts, history types, and compatibility/test fixtures. The output contained **no diagnostics in the two files edited by this campaign**. This is not a whole-package green gate.
- No code was changed in the synchronous SQLite driver, worker driver, isolated provider harness, Electron app, Session metadata producers, OXP surface, or existing context menus; these have active parallel work.
- The next major architectural experiment is a **hybrid, read-workload-specific async scan** with fast synchronous write/short interactive read admission, and *positive foreground p99* plus *nonregressing provider throughput* as simultaneous Pareto gates. Study actual SQL-call timing/bytes, consider scan ownership first, preserve WAL snapshot fences and transaction scope. Generic “send every read to a worker” is rejected by measured throughput regression.
- The next measurement gate should run 1/3/6/25/50/100 genuinely concurrent Sessions, mixed foreground/background sessions, cancellations and permission/question blockers, Electron renderer responsiveness, SQLite busy/retry density, WAL checkpoint interaction, memory and actual p95/p99 event-loop delay. Compare repeated paired runs; prove no implicit workspace Instances for Tier-0/1 reads, no session-history loads for dense rows, and no lost/replayed provider generations.

**Bottom line:** Real source optimization and targeted tests were completed, and larger concurrency measurements refuted an attractive but throughput-regressing default policy. No “monumental” end-to-end improvement or release certification has been established.
