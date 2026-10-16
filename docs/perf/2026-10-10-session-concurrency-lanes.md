# OpenFork concurrent Session execution: evidence and SQLite lane trade-offs

Date: 2026-10-10. Status: **isolated source-runtime evidence, not desktop release certification**.

**Later SQLite incident follow-up (same day):** The historical concurrency
table below is retained without rewriting its measurements. The independent
analytical `scanDb` is now always worker-backed, since it is specifically
intended for expensive queries, whereas the high-frequency interactive
`readDb` keeps its existing opt-in worker choice. Both file-backed readers
now open native read-only handles. An explicit per-DB test override
`layerFromPath(filename, { asyncReadWorker: true })` replaces process-global
environment mutation in isolated reader tests. A focused 3.5M-recursive-row
microbenchmark reduced median observed 25-ms timer delay from 596 ms to 25 ms
(95.8%) but raised median SELECT latency from 595 to 746 ms. That improvement
in event-loop responsiveness does **not** reverse the documented 100-Session
throughput loss from enabling workers on every interactive read. See
`docs/research/sqlite-primary-permit-incident-2026-10-10.md`.

## Ownership and safety

- Production execution is V1. The isolated harness at `packages/opencode/script/bench-session-concurrency.ts` starts actual durable delegated Sessions and holds N fake HTTP provider response tails until **all N requests have arrived**, rather than counting only admitted Session rows.
- The harness sets its own `OPENCODE_DB`, XDG roots, config, home and temporary files before importing the runtime. It uses no production credentials, model provider, user SQLite database, desktop host, or live runtime reload. The upgraded harness gives every provider-visible Session turn a unique marker and checks that N *distinct* Session markers reached the fake HTTP server while its SSE tails were held. It also records server-side request receipt times and admission p50/p95/span, which are **not** first-token times.
- Primary SQLite owns the transaction-scoped single permit. WAL permits the separate query-only reader and lazily allocated scan connection to read the most recent committed state without entering the writer's uncommitted transaction.
- The baseline was **synchronous Bun SQLite**. `OPENFORK_SQLITE_ASYNC_WORKER=1` enables the optional worker driver for connections whose per-layer settings do not override it. `OPENFORK_SQLITE_ASYNC_READ_WORKER=1` opts the interactive `readDb` into the asynchronous worker; the heavy scan lane now always uses a worker. The latter choice is scoped to each connection through `sqliteLayer({ asyncWorker })`, not a global toggle for unrelated databases.
- The benchmark CLI maps `OPENFORK_BENCH_SQLITE_WORKER=1` and `OPENFORK_BENCH_SQLITE_READ_WORKER=1` to the corresponding runtime flags before imports.
- Nested-worker blockers are sourced from pending Permission/Question owners. Session ancestry uses a minimal `id,parent_id` projection with bounded recursion for <=25 seeds and breadth batching above that threshold. Avoid full Session hydration and avoid introducing a cache of mutable blocker/owner state.

## Single-run measurement: 25/50/100 *overlapping* local HTTP provider requests

Command, from `packages/opencode`: `bun script/bench-session-concurrency.ts 25 50 100`. Use `OPENFORK_BENCH_LOG_LEVEL=error` to suppress high-volume INFO logs when comparing drivers. Each row completed N/N Session workers, with N/N simultaneous provider requests gated before the fake HTTP provider responses were released. Throughput is completed Sessions / total scenario wall time.

| Driver | Sessions | Admission ms | Provider overlap-admission ms | Total ms | Completed / s | Timer lag p50 ms | Timer lag p95 ms | Max lag ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| synchronous | 25 | 454 | 979.9 | 2255.4 | 11.08 | 46.8 | 762.4 | 762.4 |
| synchronous | 50 | 877.4 | 1663 | 3671.8 | 13.62 | 53.2 | 1410.5 | 1410.5 |
| synchronous | 100 | 1196.8 | 2133.5 | 5571.5 | 17.95 | 159.5 | 1982.3 | 1982.3 |
| all-worker | 25 | 416.3 | 1115.6 | 2276.4 | 10.98 | 0.9 | 16.3 | 73.9 |
| all-worker | 50 | 784.4 | 1679 | 3794.3 | 13.18 | 0.8 | 25 | 53.9 |
| all-worker | 100 | 1826.2 | 3564 | 8040.8 | 12.44 | 1 | 28.9 | 249.1 |
| read-worker only | 25 | 566.7 | 1108.3 | 2448 | 10.21 | 4.3 | 109 | 130.9 |
| read-worker only | 50 | 651.4 | 1485.8 | 3180.2 | 15.72 | 2.4 | 138.8 | 200.4 |
| read-worker only | 100 | 1168.5 | 4009.4 | 6949.9 | 14.39 | 3.6 | 46.4 | 447.1 |

**Comparability caveat:** The first synchronous 25-Session run used default INFO logging; 50/100 and the worker-lane runs used ERROR logging. These are single runs and include initialization, host scheduling, provider streaming, shutdown and native worker startup. They cannot isolate a single SQL mechanism or establish stable confidence intervals. The 25 ms interval timer measures event-loop responsiveness only; quantiles become coarse when synchronous work starves timer sampling. Values do **not** represent HTTP first-token latency, UI frame rate, SQLite cross-process lock latency or external provider throughput.

### Stronger distinct-Session gate and preparation fairness

The harness was upgraded to stamp a unique Session marker into every initial user turn and to timestamp fake-provider request receipt before holding the SSE response. This ensures 100 hits really originated from 100 independent Sessions, and provides arrival p95/spread rather than relying only on aggregate throughput.

| Driver | Sessions | Unique Session provider requests | Total ms | Completed/s | Provider arrival p95 ms (since admission start) | First-to-last provider arrival ms | Timer lag p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| synchronous | 100 | 100/100 | 5629.9 | 17.76 | 3005.8 | 265.2 | 1850.7 |
| read-worker only | 100 | 100/100 | 8005.8 | 12.49 | 5712.3 | 4417.2 | 89.8 |
| all-worker | 100 | 100/100 | 9370.2 | 10.67 | 5823.3 | 3698.0 | 61.9 |
| four Session-affine read workers (rejected) | 100 | 100/100 | 9207.7 | 10.86 | 6512.6 | 5265.4 | 98.3 |

The fourth variant was implemented as an isolated experiment: lazy bounded pool of query-only WAL worker connections, stable Session-affine routing in the V1 prompt history setup, and a new 134-assertion isolation test. The isolation test passed; the performance result did **not** improve upon a single worker reader (12.49/s vs 10.86/s, first-to-last provider arrival 4417.2 vs 5265.4 ms). The pool implementation, its test and extra configuration were **reverted without changing shared historical worktree modifications**. Keep the failed hypothesis here, not as dormant production complexity. Other bottlenecks in prompt preparation/serialized metadata reads remain plausible; the current results do not establish the causal owner.

All-worker materially improves event-loop responsiveness but loses throughput at 100 concurrent Sessions. Read-worker-only improves observed throughput at 50 vs synchronous and observed responsiveness at 25/50/100, but likewise loses throughput at 100. **Neither flag is promoted to production default**.

## Cancellation and correctness evidence

The synchronous baseline cancellation A/B (`OPENFORK_BENCH_CANCEL=1`) held all provider streams until 25/50/100 overlapped, then cancelled alternating Sessions:

| Sessions | Cancellation acks | Cancellation batch ms | Completed | Cancelled |
| --- | ---: | ---: | ---: | ---: |
| 25 | 12/12 | 85.5 | 13 | 12 |
| 50 | 25/25 | 138 | 25 | 25 |
| 100 | 50/50 | 263 | 50 | 50 |

No cancelled Session was projected back to running/completed in terminal verification. Focused `packages/opencode` delegated-worker tests: **33/33**, including mixed blocker precedence and ancestry batching. Focused `packages/core` database reader, SQLite Bun worker, synchronous transaction-isolation and permit tests: **13/13**. Core `bun run typecheck` succeeded. The `packages/opencode` typecheck has unrelated dirty-tree compiler diagnostics in CLI support bundle, OXP, HTTP handlers, and compatibility tests; do not claim package-wide green.

The explicit hybrid reader-worker flag also passed the Database-level WAL/reader/scan tests (**4/4**). In a separate read-worker cancellation run, 25/50/100 requests still reached the fake provider and finished in correct terminal states with 12/25/50 acknowledged cancels, respectively. However, the cancellation batches took **479.1 / 491.0 / 542.9 ms**, versus **85.5 / 138 / 263 ms** in the synchronous single runs. This is a potentially important control-plane latency regression and independently blocks promotion of the read-worker flag until repeatable tail-latency evidence, profiling and fixes are available.

The worker `snapshotMany` path now projects activity *after* any necessary blocked-state recheck, so it does not attach an earlier owner/activity view to the revalidated job state. This is a correctness/freshness change with no independently measured throughput claim.

## Decision ledger and remaining closure gates

1. **Correctness first:** retain scoped connection permit through execution and rollback, no cross-Session transactional writes, no premature release on timeout/cancellation, and query-only isolation on worker reader/scan lanes. Repeat integration tests against the explicit hybrid flag.
2. **Repeatable A/B:** benchmark 1/25/50/100, multiple cold and warm runs per driver, randomized order, consistent log level and provider fixture, CPU/process memory, first-token timing, and per-Session admission distribution. Record median/p95 and variance rather than selecting best single runs.
3. **Queue architecture:** measure per-lane wait/hold time, query counts, bytes crossing worker RPC, compiler/serialization overhead, transaction duration, and SQLite WAL/checkpoint contention. Prioritize eliminating surplus query/transaction work before worker fanout or enlarging queue caps. Never weaken transaction ownership to improve throughput.
4. **UI/transport:** run the actual Electron renderer + sidecar + SSE + V1 runtime with 1/3/6/25 concurrent visible streams. Verify p95 input-to-paint, frame stalls, bounded event fanout, zero metric-only history hydration and teardown convergence. The isolated test does not certify the renderer.
5. **Cross-process/operational:** load separate Desktop/ACP hosts against a disposable shared WAL database, test writer collision/SQLITE_BUSY, lock timeout, crash/restart recovery, provider abort, cancellation fences, and explicit request supervision. No test should connect to the live user's runtime.
6. **Benchmark hygiene:** Windows SQLite handles have sometimes delayed deletion of disposable benchmark folders with `EBUSY`; cleanup is an open operational item, never delete arbitrary host temp paths.

**Promotion gate:** A new default requires robust results showing materially lower p95 lag *and* no unacceptable 100-Session throughput regression, plus full cancellation/transaction/electron compatibility evidence. Preserve the ability to revert the isolated reader-worker experiment without a database migration.