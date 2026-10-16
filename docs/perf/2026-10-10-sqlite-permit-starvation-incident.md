# SQLite permit starvation — October 10, 2026

Status: **source mitigation + diagnostics validated; live-holder root cause and desktop deployment not established**.

## Evidence and ownership

The 2026-10-10 19:57Z Electron/sidecar incident displayed 30-second `SQLite connection permit unavailable` errors across Session part hydration, swarm lease reconciliation, runtime ownership heartbeat, OXP invocation inspection, Goal focus, and interactive Usage context. The persistent `openfork/log/openfork.log` also records timeouts beginning at 19:20:47Z, so this is not a single failed SQL read. The in-process permit wait is upstream of SQLite execution; `SQLITE_BUSY`-only retry or longer acquire timeout cannot release a connection retained by a stalled owner.

OpenFork keeps a scoped single-permit primary writer, a query-only interactive WAL reader, and a lazy query-only analytics/scan connection. The parent Effect/Drizzle transaction intentionally holds its permit until committed/rolled back, including asynchronous pauses. Premature permit release would allow unrelated Sessions into an uncommitted transaction; retain that ownership invariant.

A **read-only** inspection of the existing live `openfork-dev.db` observed a 7,004,471,296-byte database. `SessionUsage.windows` executes a historical `MIN(json_extract(message.data,'$.time.created'))` query filtered by provider/role. SQLite's EXPLAIN reports use of existing `idx_message_provider_id`, but that index does not eliminate role and timestamp extraction for matching rows. It can be expensive on large history; the timeouts do not prove this query owned the connection.
Read-only PRAGMA inspection confirmed `journal_mode=wal`, `locking_mode=normal`, `page_size=8192`, and `auto_vacuum=incremental`. These settings alone do not establish absence of database corruption or explain in-process semaphore starvation.

Separate log evidence shows repeated snapshot Git `index.lock` failures, external provider idle-timeout errors and renderer LoAFs. They are not established as the SQLite permit's cause.

## Changes in canonical shared checkout

- `packages/core/src/database/sqlite-permit-tracker.ts` is a connection-local ownership tracker. It captures acquisition generation, held duration, pending wait count, active SQL operation class/duration (or idle), and explicit connection lane. No SQL text, values, Session identity, or callsite are retained.
- `packages/core/src/database/sqlite-acquire-timeout.ts` optionally enriches the already-existing 30-second timeout with a dynamically sampled holder state, preserving timeout/cancellation semantics.
- `sqlite.node.ts`, `sqlite.bun.ts`, and `sqlite.bun-worker.ts` attach tracker acquisitions/finalizers and execution tracking. The existing permit stays held until SQL acknowledgement/transaction scope exit.
- `sqlite-worker-client.ts` and `database.ts` propagate static lane labels: `primary`, `interactive`, `scan`, `scan-pool`, `maintenance`.
- `packages/core/src/session/usage.ts`: both history `rows` and monthly `windows` move from the primary writer to the lazy dedicated analytics connection. In-memory tests deliberately continue to use the same connection.
- `packages/core/test/database/sqlite-permit-tracker.test.ts`: regression for diagnostic structure/privacy, idle owner state and cancellation.
- `packages/core/test/session/usage.test.ts`: new file-backed integration regression holds an uncommitted primary writer transaction and checks that usage history/windows finish **before** releasing it.

## Validation

From `packages/core` (not the root, which intentionally disables automatic Bun root tests):

```
bun run typecheck
bun test test/database-reader.test.ts test/session/usage.test.ts test/database/sqlite-permit-tracker.test.ts test/database/sqlite-synchronous-transaction-isolation.test.ts test/database/sqlite-worker-permit.test.ts test/database/sqlite-bun-worker.test.ts
```

Observed: Core TypeScript passed; **19 tests, 100 expectations, 0 failures**, including real file-backed WAL isolation. Existing tests verify worker and synchronous permit ownership across interrupted/timed-out statements and 50 competing writers. The test output intentionally includes `SQLITE_READONLY` messages for negative query-only connection assertions; those cases passed.

### Disposable runtime Session-concurrency verification

The repository's isolated, real V1 delegated-Session fake-provider harness was run with `OPENFORK_BENCH_LOG_LEVEL=error` after these source changes. Every scenario verified **N unique concurrent provider-visible Session requests and N completed Session terminal states**. The harness creates isolated temporary `OPENCODE_DB` and XDG roots *before imports*, without touching the live database:

| N | Completed/s | Total ms | Provider overlap admission ms | Timer lag p95 ms | Timer lag max ms |
|---:|---:|---:|---:|---:|---:|
| 25 | 13.67 | 1828.2 | 881.9 | 334.1 | 334.1 |
| 50 | 15.88 | 3148.0 | 1272.0 | 697.6 | 697.6 |
| 100 | 16.05 | 6231.0 | 2531.4 | 1122.1 | 1122.1 |

These are **single runs** on a shared workstation and cannot be claimed as statistically significant before/after performance gains. The p95 event-loop lag is still hundreds of milliseconds under load; the renderer and provider TTFT were not measured. Both harness processes reported an existing Windows `EBUSY` while removing a disposable benchmark folder. No forced deletion or live-DB cleanup was attempted.

No live database rows were changed; the 7 GB database inspection was query-only. No running Electron/sidecar process was restarted. No release build was deployed; a source-level pass cannot establish production remission.

## Next causal isolation gate

After the normal operator-controlled build/reload (respect `packages/app/AGENTS.md`: never restart a live desktop/server as a debugging shortcut), inspect the *first* connection timeout's appended `[permit lane=... owner=... heldMs=... pending=... sql=... sqlMs=...]` rather than sampling only cascading failures.

- `sql=idle`, large `heldMs`: trace an asynchronous await, child Effect/Fiber dependency or other non-SQL work within the parent transaction, and split non-durable I/O outside the transaction.
- SQL class active and `sqlMs` large: profile the specific statement/query plan, row materialization/worker RPC and competing disk/WAL activity; shorten/partition the offending read.
- `lane=primary`: inspect write transactions and any residual historical queries on the primary connection. `lane=interactive`: inspect context-history/UI hydration and bounded read admission. `lane=scan*`: throttle/decompose reporting, but keep it isolated from primary/interactive.
- Test at 1/3/6/25 simultaneous real Sessions, plus 50/100 isolated fake-provider runs, with foreground p95/p99 responsiveness, throughput, cancellation latency, SQL queue/hold distributions and no dead sessions. See `docs/perf/2026-10-10-session-concurrency-lanes.md`; existing all-worker/read-worker experiments did **not** meet the throughput/cancellation promotion gates. Do not enable experimental worker flags globally in response to this incident.

An uninstrumented permanent-cure claim would be unjustified. The objective is now to identify and eliminate the owning operation, not extend the semaphore deadline.

## Follow-up: recursive permit prevention and CPU/fairness investigation

The direct owner of the *original* 30-second stall remains unproven: the October 10 log predates the owner/fiber instrumentation, and the current running log contains no `permit lane=` incidents. Do not relabel the waiting `SessionUsage.windows` query as the owner.

### Concrete correctness improvement

- The shared connection-local permit tracker now records the owning Effect fiber ID in addition to generation/lane/duration. When that **same fiber** tries to acquire the **same connection** again before releasing it, the tracker fails immediately with a structured SQLite error. This avoids forcing a provably impossible self-acquisition to consume the full 30-second budget; it lets the outer scope unwind and rollback. Different fibers continue to wait normally. This is a targeted deadlock-class prevention, **not** an automatic repair of arbitrary cross-fiber dependency cycles.
- The timeout now includes the last completed SQL class, duration, time since last SQL, and statement count. No SQL text, values, database path, or Session identity are retained.
- Production-path tests prove a failed second `SqlClient.reserve` leaves the outer reservation intact and that a subsequent query succeeds after scope cleanup. Both synchronous Bun and worker-backed Bun adapters pass. Same-fiber, peer-fiber, timeout, interrupt and transaction-isolation invariants remain intact.

### Measured event-loop execution-lane tradeoff

The pre-existing isolated `script/bench-session-concurrency.ts` harness now accepts **benchmark-only** `OPENFORK_BENCH_EFFECT_YIELD_OPS` (16–16,384) to override Effect's `Scheduler.MaxOpsBeforeYield` only for the exercised Session effect graph; production defaults are unchanged. Effect v4's documented default operation budget is 2,048. The fresh CPU profile `CPU.20261010.151751.236800.0.001.md` (13.74 s, 1,346 samples) shows substantial native `Map`/allocation, Effect scheduling and TypeScript module loading. Because this includes cold initialization, it is not isolated evidence of a specific warm SQL or renderer hotspot.

| Concurrent Sessions | Effect ops/yield | Completed/s | Timer lag p95 ms | Provider arrival spread ms |
|---:|---:|---:|---:|---:|
| 25 | 2,048 | 12.68 | 356.5 | 37.6 |
| 25 | 512 | 11.97 | 64.4 | 144.8 |
| 25 | 128 | 11.82 | 25.3 | 389.8 |
| 50 | 2,048 | 10.30 | 901.6 | 269.3 |
| 50 | 512 | 13.61 | 112.5 | 229.4 |
| 50 | 128 | 12.46 | 47.1 | 1,242.6 |
| 100 | 2,048 | 13.77 | 1,323.8 | 471.9 |
| 100 | 512 | 9.45 | 163.3 | 575.4 |
| 100 | 128 | 11.80 | 83.4 | 2,466.7 |

These are **single A/B runs** on a shared machine, neither randomized nor repeated; throughput and provider-arrival distribution differ. The 100-Session budget-128 case yields a ~15.9× lower observed timer-lag p95 at a ~14.3% loss of completed/s and >5× wider provider-arrival spread in these runs. The 512-case loses ~31% throughput at 100 Sessions. This is a demonstrable responsiveness/throughput/fairness tradeoff, not a Pareto improvement or justification for a new production default. Longer series, steady-state prewarmed repeats, live mixed foreground/background Sessions, request cancellation and native Electron validation are required.

The original 2.8–4.1-second renderer layout stalls described in `docs/perf/2026-10-01-performance-regression-investigation.md` remain separate from the sidecar's measured timer lag. A read-only local CDP probe at `127.0.0.1:9222` timed out, so this investigation did not acquire live Electron flame charts, layout attribution or Solid lifecycle measurements. Do not claim those renderer warnings are fixed.

### Cancellation regression on current source, isolated test DB

With the default scheduler and half the sessions cancelled, 25/50/100 Sessions admitted 25/50/100 distinct provider requests. All requested cancellation acknowledgements succeeded (12/12, 25/25, 50/50); resulting terminal states were 13+12, 25+25 and 50+50 completed+cancelled. Measured cancellation batch durations were 92.7, 102.3 and 297.0 ms; these are again single isolated runs and do not establish p99 cancellation in the Electron process.

### Final source gates and renderer attribution boundary

- The final six focused Core suites passed **22/22 tests / 119 assertions** after the same-fiber prevention and extended diagnostics. `packages/core: bun run typecheck` passed. Scoped `git diff --check` succeeded (only Windows line-ending normalization warnings).
- `packages/opencode: bun run typecheck` remains **red: 25 diagnostics** in other concurrently modified CLI, HTTP, compatibility and test files, including `script/smoke-acp-sqlite-worker.ts`, `src/cli/cmd/debug/support-bundle.ts`, and session HTTP handlers. No diagnostic references the modified `script/bench-session-concurrency.ts`. Do **not** present the package as fully green.
- The existing Electron/renderer campaign has stronger, distinct evidence than the isolated server lag series: `docs/perf/investigation-2026-10-01/implementation-renderer-ledger.md` lines 128–134 attributes a 59.5 ms renderer update to Solid lookUpstream/get/cleanNode/runTop/unwrap plus session timeline projections, and line 134 records O(history) command eligibility scans on several status/idle recomputations. Those probes did not capture the largest 422 ms gap. Lines 144–158 document separate startup/historical-renderer LoAFs and a 567 ms maximum LoAF under an isolated held usage scan. The present run did not launch the full Electron fixture or attach a live CDP session, so these remain measured prior leads, **not** patched/root-caused by the SQLite reentrancy guard.

## Further live incident: executing-versus-queued SQL attribution (15:32–15:38 America/Chicago)

The user provided a fresh live console excerpt: a foreground SQLite permit had `owner=8042 heldMs=103671 pending=5 sql=SELECT sqlMs=103671` as credential-list, limit-recovery and OXP activity queries timed out. The renderer's own periodic event/frame reductions were nearly idle. A later deployed development run in `/openfork/log/openfork.log`, `run=6b264c25`, logged a **different** owner (`lane=primary owner=747 ownerFiber=210923`) with one outstanding `SELECT` (`statements=1`) from the first 2-second contention warning through at least 156 seconds. Neither run provides an SQL fingerprint or reliable native-worker execution stage; do not conflate their owner generations or claim the blocked waiter SQL is the owner.

Live Windows process inspection, without restart, reported PID 208120 and 31 threads. The top-running thread accumulated ~2,765 ms CPU across a nominal 2-second measurement period, while most other threads were waiting. Timing/sampling noise and lack of native call stack prevent proving that exact thread was the SQLite worker, but this is consistent with an active CPU-intensive native SQL operation and not consistent with an idle-only permit owner.

### Validated analytical query ownership issue

`packages/opencode/src/fork/credentials.ts:ForkCredentials.usageByCredential` contained a long-running `SELECT` over `message`, extracting provider/role/time/cost from message JSON, joining `fork_message_credential` by message ID and grouping through CASE expressions over three time windows. It previously executed on the **primary writer**.

Read-only inspection of the **7,005,339,648-byte** live SQLite DB (no heavy aggregation executed) showed:

- `EXPLAIN QUERY PLAN` for the same grouped-query shape: `SEARCH message USING INDEX idx_message_provider_id (<expr>=?)`, then `SEARCH fork_message_credential USING INDEX sqlite_autoindex_fork_message_credential_1 (message_id=?) LEFT-JOIN`, then `USE TEMP B-TREE FOR GROUP BY`.
- The provider-ID expression index helps but no usable global created-time range index exists for this query. Filtering `json_extract(message.data,'$.time.created')` can still visit/parse historical Go messages before the cutoff. Creating indexes against the live 7GB store was **not** attempted.
- The query's class and timing make it a **strong concrete candidate**, not a positive identification of owner 8042 or 747.

Implemented: `usageByCredential` now uses `Database.scanDb()`, preserving SQL and usage parity while removing analytical work from the primary connection. Small credential `list`/`active` and requested message-attribution reads use the independent WAL `readDb`. The only available `:memory:` handle continues to alias the primary. A file-backed integration regression holds `BEGIN IMMEDIATE` on the writer and proves all these reads finish before release; ordinary per-credential and unattributed usage aggregation parity tests still pass.

### Multiplicative scan defect and single-flight repair

`packages/opencode/src/fork/usage-cache.ts` implemented a 15-second generation-invalidated L2 cache, but every simultaneous miss called `compute()` independently. `ForkCredentials.recordUsage` bumps the generation on each assistant settlement, allowing a burst of concurrent quota polls to launch duplicate multi-minute grouped scans. The new process-global L2 gate owns **exactly one** detached Effect computation; all waiters join a shared Deferred. It retains TTL/invalidation semantics, does not cache failed computations or a superseded generation, and survives first-caller cancellation without interrupting peers. Generation invalidation while a scan is active joins the existing scan instead of spawning a second one. This is an admission/correctness improvement; the scan itself still needs a faster indexed or incrementally materialized algorithm.

New isolated tests prove 64 simultaneous callers launch one scan, generation changes do not fork it, a cancelled first caller does not poison it, a failed computation retries, and a held writer does not block scan/interactive read lanes. The full focused `ForkCredentials`, `ForkUsage`, and cache suite passes **27 tests / 1,288 assertions**.

### Native SQLite worker observability without IPC fanout

The older permit tracker recorded the **newest** submitted statement, which is not proof that statement has begun executing on Node's serial native worker. The tracker now maintains an ordered, bounded-in-practice set of outstanding statements and reports the oldest query class, deterministic short SQL-shape hash, length, and in-flight count (no SQL text, parameters, or table names retained). The Node worker uses a two-word `SharedArrayBuffer` + `Atomics` to publish its current request ID and `executing` / `replying` / `idle` stage. Parent-side `activitySnapshot()` reads these fields synchronously even while the worker is blocked inside `DatabaseSync.prepare().all()`; it adds **zero per-query stage messages**. A permit warning/timeout now includes `workerStage`, `workerSql`, and `workerPending`. This disambiguates native execution from queued RPCs and large result transmission on the **next built deployment**.

Fresh isolated regression checks prove a native worker reports `executing WITH` while processing a four-million-row recursive CTE, and an actual Node SqlClient permit timeout identifies the executing WITH request rather than a queued `SELECT`. Both pass. No running desktop/server process was restarted to deploy this instrumentation.

### Remaining high-priority work

1. Use the new owner `sqlHash`, in-flight count, and native `workerStage` telemetry **after a user-managed rebuild/restart** to identify the actual repeating SELECT. Neither old owner can be retrospectively identified from the logs.
2. `ForkCredentials.backfillSingleCredentialUsage` still invokes an unbounded `INSERT OR IGNORE ... SELECT FROM message` on the foreground writer upon first single-credential use. This is a **separate critical write-path hazard**, even though it cannot explain the current tracker reporting a standalone `SELECT`. Replace it with a persistent, versioned, incremental historical attribution migration that honors existing one/multiple-credential parity before calling the entire path production-safe.
3. Consider the existing indexed scalar `usage_record` materialization (`provider_id`, `created_at`, `cost_usd`, `account_id`) as a candidate for future fast Go aggregation. Do not substitute it until coverage against legacy `message` and vault-specific `fork_message_credential` attribution is proven and exact usage parity tests exist.
4. Benchmark normalized CPU time, disk traffic and throughput with cloned databases and multiple concurrent sessions. Avoid creating a new covering index on the live 7GB DB or restarting the running application.

### Final source-validation checkpoint

- Core: `bun test test/database-reader.test.ts test/session/usage.test.ts test/database/sqlite-permit-tracker.test.ts test/database/sqlite-node-worker-activity.test.ts test/database/sqlite-synchronous-transaction-isolation.test.ts test/database/sqlite-worker-permit.test.ts test/database/sqlite-bun-worker.test.ts` → **26 passed, 148 assertions, zero failed**. `bun run typecheck` passed. The deliberate read-only SQLite errors from negative assertions are expected.
- V1/Opencode: `bun test test/fork/credentials.test.ts test/fork/usage-cache.test.ts test/fork/usage-aggregation.test.ts` → **27 passed, 1,288 assertions, zero failed**. Latest `bun run typecheck` still fails on **25 unrelated outstanding errors** in concurrently edited CLI, HTTP and compatibility-test files; no TypeScript diagnostic refers to the modified `src/fork` or `test/fork/usage-*` surfaces.
- Combined selected validation: **53 tests, 1,436 assertions, zero failures**. `git diff --check` for touched tracked paths returned exit 0; Windows CRLF normalization warnings only.
- All source changes are local and uncommitted in the concurrent shared checkout. No deployed binary was updated, running service restarted, SQLite production table/index mutated, or historical 7GB aggregation executed.
