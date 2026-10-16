# OpenFork SQLite contention: October 15 writer-admission and storage-forensics continuation

**State:** source-only remediation and disposable-file verification. No active OpenFork database was migrated, checkpointed, vacuumed, rebuilt, deleted or restored; no user Session or sidecar was restarted. The active OXP host reported `runtime.refreshable=false`. This document is a continuation of `sqlite-historical-reconciliation-2026-10-11.md`, not a replacement design.

## Authority and prior-art gate

Read root `AGENTS.md`, `packages/core/AGENTS.md`, `packages/opencode/AGENTS.md`, `FORK.md`, `docs/map/README.md`, `docs/map/architecture.md`, `docs/map/v1-v2.md`, `docs/architecture/sqlite-acp-concurrency.md`, `docs/architecture/swarm-runtime-ownership.md`, and the historical reconciliation before further changes.

The authoritative flow is **V1 Session producer -> Core durable Event writer/atomic projectors -> SQLite primary connection/worker -> materialized Core rows -> V1/fork HTTP -> new-layout UI**. RuntimeOwner, SessionExecutionOwner, Goal, ScheduledTask and Swarm already have durable owners and generation/lease fencing; do not replace them with a second queue, fresh Session graph, global scheduler, frontend history scan, or speculative auto-replay. Never retry COMMIT or an operation with unacknowledged external side effects.

Already implemented before this continuation: 75ms Bun primary busy timeout, retry-only-safe BEGIN/atomic operations, worker-backed primary and independent interactive/scans/control lanes, killable read-only analytics subprocesses, bounded backfill and WAL maintenance, 400-row credential usage cursor, V1 FTS-first search, cross-host process-global Swarm runtime graph, exact Session ownership generation/unknown-effect fences, and synthetic 1/3/6 host certification. Preserve these.

## Live incident and missing visibility

The October 15 18:52–18:53 UTC log had two V1 Sessions operating on the same worktree, with a separate Git index.lock collision. The primary SQLite connection held a permit for 7.4–11.4 seconds under `sqlOrigin=Session.updatePart` with 5–7 waiters. A native idle-stage observation suggested BEGIN/worker-admission rather than long SQL in the transaction body. The Git collision is concurrent evidence, not proved SQLite causation.

`packages/opencode/src/session/session.ts` publishes `SessionV1.Event.PartUpdated`. `packages/core/src/event.ts` pre-encodes the payload, then enters a single IMMEDIATE durable event transaction with atomic projection, sequence advancement and event insert. The old `durable.transaction` trace began inside the transaction callback, *after* connection/BEGIN admission, concealing external writer waits.

**Source repair:** while event tracing is enabled, the same EventTrace owner now records `durable.begin.wait`, `durable.begin.wait.<event type>`, and `durable.writer.total` alongside the existing transaction-body measurement. It logs only timing and event type, never IDs, SQL, arguments or model content. It does not alter writer ownership or retry semantics.

**Executable gate:** `packages/core/test/database-event-admission/durable-begin-trace.test.ts` holds a competing SQLite WAL writer, releases it on a timer, commits the durable Event and verifies six trace/settlement assertions. **1 passed, 0 failed**. It is a correctness test, not proof of production latency remediation.

## Startup maintenance isolation

The EventV2 service previously ran `reclaimOrphanedEventPayloads(db)` synchronously before admitting its runtime. This GC is bounded per pass (8 stale payloads by default) but can include multiple IMMEDIATE transactions and chunk deletion on the foreground connection across multiple hosts.

**Source repair:** in-memory fixtures retain synchronous cleanup; file-backed EventV2 now schedules one scoped, cancellable 30-second delayed best-effort pass using the **existing** cleanup algorithm, with DB-local `Flock` owner, `protectLiveProcess`, low-priority `makeSqliteMaintenanceQuietGate`, and asynchronous `Database.withBackfillDb`. This is garbage collection, not a runtime-admission dependency. No new payload format or replay semantics were introduced. It intentionally does not promise instant reclamation if another process owns the pass or the database remains busy. The ChunkDB sealer continues to own its existing cleanup passes independently.

## Read-only file-backed measurements

These were separate readonly SQLite handles, `PRAGMA query_only=ON` and `busy_timeout=0`. No active file was mutated.

| Database | SQLite pages | Free pages | Page size | Interpretation |
| --- | ---: | ---: | ---: | --- |
| `openfork-dev-fresh.db` | 30,509 | 0 | 8192 | ~249.9MB allocated SQLite pages at observation |
| `openfork-dev.db` | 1,145,273 | 0 | 8192 | ~9.38GB allocated, no freelist headroom |
| `openfork-main.db` | 1,263,979 | 0 | 8192 | ~10.35GB allocated, no freelist headroom |

Zero freelist pages does **not** establish a healthy database or disprove bloat in logical rows/indexes. It means `VACUUM` is not justified *solely* by a large free-page list. After dropping an index, SQLite may add those pages to the freelist without reducing the physical file size; reclaimed pages may be reused by future writes.

Fresh `dbstat` aggregate scan took 179ms; leading allocations were `oxp_invocation` 53,944,320 bytes, `usage_record` 23,838,720, `oxp_invocation_link` 18,063,360, and OXP link indexes of 18,784,256 bytes **each**. The old Dev database `dbstat` took 2,239ms; largest objects included `part` 972,193,792, `event` 814,284,800, `session_tool_output` 768,720,896, `event_payload_chunk` 276,725,760, `event_value` 206,880,768, and `oxp_invocation` 160,423,936 bytes. A broad dbstat scan of Main exceeded the low-impact diagnostic budget and was killed without returning a result. Do not repeat unbounded historical scans in the foreground or while active workloads are saturated.

## Verified duplicate OXP index and forward migration

Read-only `PRAGMA index_list/index_xinfo` confirmed **identical** four-column unique B-trees on `oxp_invocation_link(invocation_id,kind,ref,relation)`:

1. `sqlite_autoindex_oxp_invocation_link_1` — implicit composite PK, must remain;
2. `oxp_invocation_link_invocation_ref_idx` — explicitly declared redundant unique index.

Both have the same key order, binary collation, ascending direction and no predicate. Fresh allocation: 18,784,256 bytes **per** index; old Dev: 49,750,016 bytes **per** index. A metadata-only scan over all fresh database tables/indexes found **exactly this one pair** of full-key equivalent indexes. Do not infer that other prefix indexes are redundant without query-plan proof.

**Source repair:** `packages/core/src/oxp-activity/sql.ts` removes only the redundant explicit unique index, preserving the composite PK and separate `(kind,ref)` lookup index. The repository's canonical migration generator produced forward migration `20261015194010_oxp_link_redundant_unique.ts` (`DROP INDEX IF EXISTS`), updated `schema.json`, `schema.gen.ts`, and `migration.gen.ts`. Generator `--check` passed. Historical migration `20260919235500_oxp_parent_activity.ts` remains immutable.

**Executable gate:** `packages/core/test/database-oxp-index/duplicate-unique-migration.test.ts` verifies old dual-index shape, applies the new migration twice, proves only the named redundant index disappears, proves queries use the implicit PK index and still reject duplicate link keys. **1 passed, 0 failed; 9 assertions**.

Dropping an index in a live 9GB database requires **coordinated schema-bootstrap ownership**, deliberate low-load deployment, rollback backup and post-migration verification. The produced source has **not** been activated against live databases. Index-page savings are not a guarantee of immediate file-size shrink; the direct benefit is eliminating one B-tree mutation per link change and reclaiming its pages for reuse.

## Scheduled Task restart and liveness ownership (October 15 continuation)

The V1 host runner `packages/opencode/src/scheduled-task/runner.ts` had a startup-fence bug: it installed event-driven wake/arm handlers while its default 30-second startup grace had not finished, and neither `wake` nor `armImpl` checked `state.started`. A new manual poke or durable scheduling event could therefore dispatch a *live* run **before** `recoverStale({includeOwn:true})`, allowing startup reclamation to mark that running task abandoned. The fix refuses pre-start dispatch/arm (no extra queue); after exact recovery, `start()` performs the normal authoritative due scan. Targeted startup-fence test: **1/1 pass, seven assertions**.

`ScheduledTaskLease.recoverStale` previously loaded ALL matching leases and settled ALL their corresponding run rows inside one `BEGIN IMMEDIATE` transaction. The revised Core owner admits at most 64 candidate leases per transaction, preserving exact owner/lease/heartbeat conditional writes. The runner drains in cooperative pages, bounded to 64 pages per pass (up to 4,096 lease rows). Following an independent concurrent source refinement, startup repeats budgeted passes with a 100ms cooperative cooldown **before** opening admission; shutdown runs one bounded pass. A direct 70-stale-lease test observed **64 + 6** and zero duplicate recovery on the next scan: **1/1 pass, six assertions**. The full Core Scheduled Task suite after liveness-lane isolation passed **84/84**.

Crucially, the Scheduled Task heartbeat and release operations previously shared the foreground DB connection permit with potentially expensive Session SQL; this made an active lease heartbeat wait behind unrelated history even when WAL had no competing writer. `packages/core/src/scheduled-task/lease.ts` now routes those two exact owner-fenced operations through Core's already-existing lazy/memoized `controlDb` writer (falls back to primary for `:memory:` fixtures), with bounded `SQLITE_BUSY` retry. Heavy stale reclamation continues on the primary, preventing backlog drain from monopolizing liveness. A disposable file-backed test intentionally pinned the primary connection permit while calling `leases.heartbeat`: **1/1 pass, four assertions**; Core typecheck passed after the test's Scope typing correction.

The heartbeat supervisor previously exited permanently on the first failed heartbeat after its database busy-retry budget, even while external execution could continue. The runner now re-attempts with a bounded progressive delay (up to 30 seconds) and rate-limited warnings; a `false` heartbeat (lost exact ownership) is terminal for that supervisor and fences this generation from publishing a successful settlement. An executable TestClock regression transfers the durable lease during a suspended executor and verifies the old owner cannot write success afterward: **1/1 pass, three assertions**. This prevents stale *settlement*, not necessarily completion of already-dispatched external side effects.

**Open risks, not closed:** owner PID / host-graph liveness under PID reuse and same-process independent Session graphs; a lost lease does not yet provide proven containment/cancellation of already-started external tool effects; prolonged disk unavailability can still exhaust TTL despite heartbeat retries; an overloaded host may spend extra startup time draining an enormous stale backlog; no live packaged restart/crash matrix was performed. A broad host Scheduled Task run completed **65 pass / 1 failure** due to a pre-existing prompt-provenance architecture assertion in `test/scheduled-task/architecture.test.ts` (expected an obsolete literal type, while the current contract is a discriminated union), unrelated to this scheduler patch. The isolated startup-fence and lease-loss regressions passed.

## Scope of evidence and remaining release gates

- Existing `Flock` tests: **30/30 pass**.
- Prior new async maintenance-worker WAL contention regression: **1/1 pass**.
- Durable BEGIN/admission trace regression: **1/1 pass, six assertions**.
- Duplicate-index forward migration regression: **1/1 pass, nine assertions**.
- Scheduled Task startup race regression: **1/1 pass, seven assertions**.
- Bounded 70-lease recovery regression: **1/1 pass, six assertions**.
- File-backed control-lane heartbeat regression: **1/1 pass, four assertions**.
- Full Core Scheduled Task suite after heartbeat-lane change: **84/84 pass, 395 assertions**.
- Host lost-lease suppression regression: **1/1 pass, three assertions**.
- Full host Scheduled Task suite before lost-lease regression: **65 pass / 1 fail** due to unrelated provenance-architecture assertion; do not report it as green.
- Core `bun run typecheck`: completed without reported errors.
- Official migration-generator consistency check: completed without reported errors.
- Full desktop/app/sidecar packaged production certification: **not run**.
- Source changes do not hot-patch the currently running sidecar.

Next, in order: (1) classify admitted writer **wait** versus committed transaction body versus time pinned without native SQL, plus OXP writer/maintenance presence; (2) confirm old DB's retained payload/Part/event/index bytes by bounded readonly statistics rather than speculative vacuum; (3) profile database migration under isolated clone before rollout and test lifetime of retained WAL snapshots; (4) run 1/3/6 actual packaged ACP/Desktop hosts with 1/3/6+ V1 Sessions, ScheduledTask, Goal and managed Swarms, including crash/restart at BEGIN, tool effect, COMMIT, shutdown and recovery; (5) report throughput, p95/p99 admission and UI lag, worker count, RSS, WAL growth/checkpoint backlog, unknown-effect preservation, stale-owner fencing and duplicate run count. **Do not declare production remediation before that matrix is green.**

## Stability-first continuation — writer/checkpoint separation and exact Scheduled Task fences

The user explicitly prioritized stability and predictable tail latency **over throughput**. These changes reuse Core's existing control writer, maintenance worker, filesystem leases, EventTrace, Scheduled Task runner, and atomic run/lease tables. No additional queues or independent scheduler were introduced.

### Foreground COMMIT never owns automatic checkpoint I/O

SQLite's documented default `wal_autocheckpoint=1000` triggers PASSIVE checkpoint work from the same native connection that crosses the threshold during COMMIT. Since that thread/permit is also the durable Session event writer, it creates unbounded per-commit latency variance. The file-backed primary, control writer and maintenance connections now explicitly set `PRAGMA wal_autocheckpoint=0`; the database's existing process-elected async PASSIVE checkpoint loop stays enabled after startup and every five minutes. `:memory:` behavior remains unchanged. Dedicated disposable DB test verifies all three writable connection thresholds are 0; maintenance tests **2/2 passed**. With `synchronous=NORMAL`, SQLite documents that checkpoint ownership also affects where filesystem sync I/O occurs. Do not claim a measured production p99 win before packaged/live tests.

**Safety constraint:** disabling auto checkpoints increases reliance on the existing checkpoint owner's availability. A pinned WAL reader can still prevent checkpoint completion and grow the WAL; the code emits numeric-only warnings when PASSIVE reports a significant backlog. Never attempt aggressive `FULL`/`RESTART`/`TRUNCATE` on a live shared DB merely to shrink its file.

### Payload cleanup is staggered, budgeted, persistent and cold

The earlier single 30-second cleanup coincided with WAL checkpointing. File-backed EventV2 now defers orphan cleanup until two minutes after startup, performs at most 32 pages of eight stale payloads per pass on the isolated async maintenance connection, yields 250ms between pages, and demands 500ms external writer quiet before each candidate cleanup. More backlog retries after five minutes; idle stores check every six hours. In-memory test fixtures retain synchronous startup cleanup. A failed/busy/elected-out pass never enters a tight retry loop. Cancellable scoped fibers never continue after the owning runtime ends.

### Scheduled Task scheduling is bounded and independently authenticated

1. An overdue cursor can no longer install a zero-delay timer after a losing lease claim or during the 15-minute jitter allowance. A five-second overdue poll floor deliberately trades recovery promptness for bounded database/CPU pressure.
2. Queued manual-run discovery uses one bounded 64-row join, excludes still-held `overrun=queue` rows **before** limiting, and avoids the former N+1 lease queries. A new canonical migration `20261015201329_scheduled_task_pending_queue_index.ts` adds `(status,started_at,id)` to make queued discovery an index seek. Settled runs wake the next pass. A test with 70 held queued tasks followed by a ready task selected the ready one: **1 passed, two assertions**. Other due-task scans remain an audit target; do not blindly LIMIT them without fair pagination/jitter handling.
3. Startup dispatch and timer arms are fenced until stale-lease recovery completes. Recovery now uses small IMMEDIATE transactions (current batch 64), waits cooperatively between bounded groups, and repeats groups rather than silently abandoning the backlog after 4,096 rows. Transient native SQLITE_BUSY errors back off up to 30 seconds without admitting work. Non-busy faults fail closed. Startup does not force-steal another active graph's `PROCESS_OWNER_ID` lease: prior process generations have distinct random owners. The teardown's own-lease cleanup remains a separate live-owner review target.
4. After recording a run, its executor now refreshes exact lease proof on the existing isolated control writer **before** starting model/provider/tool execution. Heartbeats retain the prior bounded busy retry and supervisor backoff. A separate five-second scoped watchdog stops the execution effect at the 120-second unverified-lease safety margin; a definitive heartbeat `false` signals immediate containment. The executor races the lease-loss signal; stale success cannot be reported. Non-cooperative native/external effects may not stop instantly, and an already-dispatched side effect must remain unknown rather than being replayed.
5. `ScheduledTask.settleRun` now verifies an optional supplied lease token against the task, scheduled instant, exact lease, local process owner and attempt **inside its IMMEDIATE settlement transaction**. The only production runner always supplies this token. `ScheduledTask.skipSettled` now requires and checks the exact owned lease before deleting any lease or moving the recurrence cursor. Neither a delayed success nor a stale skip may mutate a successor owner's rows.

### Fresh executable receipts and caveats

- Core Scheduled Task suite after queued-page index: **85/85 passed**, 397 assertions. After the exact stale-settlement and stale-skip fences, the two targeted tests passed **2/2**, eight assertions; repeat the complete Core suite for final release.
- Host Scheduled Task runner group with the independent watchdog and exact owner checks: **15/15 passed**, 50 assertions. Focused revoked-heartbeat test: **1/1 passed**, three assertions.
- The dedicated scheduler startup live sibling-owner regression: passed; initial ready/lease fencing, backlog and index migration tests were also green in earlier runs.
- Core `bun run typecheck` and migration-generator `--check` passed after the schema/index changes. The full host typecheck had pre-existing unrelated errors earlier in this shared worktree; do not claim package-wide host cleanliness without fresh proof.
- Source state was altered in a shared dirty worktree while peers were editing unrelated surfaces. No reset, stage, commit, running Session interruption, or live DB manipulation was performed. OXP reports `runtime.refreshable=false`. All deployment claims await a packaged 1/3/6-host and 25/50/100-Session matrix, graceful and forced restarts, exact p95/p99 writer admission/wait attribution, and multi-gigabyte DB comparison against a **consistent isolated clone**.

## October 15 stability-over-throughput follow-on: bounded wake, foreign crash sweep, PID reuse

The `ScheduledTask.planDue` path independently accumulated every enabled overdue task into memory, then did a separate huge `IN (...)` lease read. With 100K backlogged cursors, a single wake could allocate 100K typed domain objects and queue excessive writer transactions even though dispatch itself used a two-run concurrency cap. It now uses an indexed `(enabled,next_run_at)` keyset candidate query, a left join to the lease table, and **at most 64 due candidates per scan**. Held owner leases are filtered *before* applying the limit; the ephemeral service-level `(next_run_at,id)` cursor advances through jittered/blocked rows and wraps at the end. This is only an execution-admission scan; the separate public `due()` query retains its existing semantics. No durable cursor or scheduler was added. The new 140-task executable test found **all 140 uniquely across three bounded pages** (144 assertions).

The runner's teardown previously swept every lease bearing module-wide `PROCESS_OWNER_ID` regardless of heartbeat age. Independent service graphs in the same process can share that owner string, so shutting down one graph could falsely abandon a sibling graph's active run. This blanket same-owner teardown reclamation is removed. Uncertain in-flight work remains fenced by exact token/attempt and expires normally; safe settlement releases ownership. This sacrifices immediate restart recovery rather than risk repeating external effects. Full service closure still interrupts scoped run fibers as far as the executor supports cancellation. **Outstanding release gate:** explicitly test nested same-process graph teardown under an uncancellable external tool.

Startup still performs bounded stale-foreign-lease reconciliation *before* dispatch. A separate single scoped background sweeper now handles **foreign process crashes while our host remains alive**: start 60 seconds after owner setup, skip while the local runner is dispatching or executing, reconcile at most one 64-lease IMMEDIATE page, and schedule the next pass in five seconds only if another page remains; otherwise every 60 seconds. Recoveries are guarded by exact owner/lease/heartbeat and terminal `abandoned` settlement. No successful tool execution is re-run automatically. Test: a host already started, then receives an expired held foreign run; advancing the clock 60 seconds abandons it without dispatching a tool (**1 pass, three assertions**).

Filesystem `Flock.protectLiveProcess` already refused to steal leases with a live PID after heartbeat age exceeded `staleMs`, correctly protecting a loaded peer whose JS event loop stopped refreshing mtime. However it had no PID-birth check: an unrelated Windows process could reuse that PID after a crash, making the orphan unreclaimable forever. A new **stale-only** process-birth probe compares the owning lock's recorded `createdAt` with the operating system's current PID creation timestamp, using PowerShell on Windows and `ps` on POSIX, with a three-second precision margin. The 3-second subprocess timeout and 5-second cached observation make the probe bounded; any failure/inconclusive process identity fails closed. A synthetic orphan lock with the current process's PID but an old acquisition timestamp was safely recovered, alongside pure ambiguity checks (**2 tests, 7 assertions**). This does not claim a defense against forged/compromised lock metadata; the lock directory is trusted.

### Regression summary after these changes

- Core scheduled-task suite **87/87** pass (404 expectations) before the latest 140-item keyset and foreign-sweep cases; both of those focused tests passed afterward.
- Host Scheduled Task runner group **15/15** pass (50 expectations) before the newest foreign stale-peer sweep; that focused test separately passed.
- SQLite three-lane stress (48 primary writes, 24 control reads, 12 analytical scans, 84 operations): **1 pass, 131.9ms** on a disposable database, no stranded permits.
- SQLite six independent WAL writer workers: **1 pass**, no failures, existing tests reused instead of recreated.
- Filesystem stale PID-reuse regression: **2 pass** and Core typecheck passes.
- An incorrectly broad exploratory database-test discovery was stopped without applying any schema/data changes to real OpenFork databases; **its partial results are not release evidence**. Subsequent stress tests used explicit name-pattern filtering.

SQLite official WAL documentation confirms that PASSIVE checkpointing never waits for readers to finish and may leave frames outstanding; large WAL and long-lived reader starvation remain possible even when checkpoint I/O is off the foreground thread. Also note that `SQLITE_FCNTL_PERSIST_WAL` cannot be assumed to eliminate the last-connection checkpoint, and a disposable close-time experiment did not reproduce the suspected long-close mechanism. Do not change persistence semantics on speculation.

### Adaptive checkpoint follow-on and acceptance

After disabling implicit foreground auto-checkpointing, a fixed 5-minute checkpoint interval may allow substantial WAL growth under 6+ active Sessions and Swarms. Core's database-lifetime checkpoint owner now uses an asynchronous filesystem `stat(<db>-wal)` observation every 30 seconds (not an SQLite statement or a foreground permit), and chooses a **one-minute** checkpoint interval when physical WAL size is at least 64 MiB, otherwise the existing **five-minute** interval. The first checkpoint is still after 30 seconds, never part of schema bootstrap. The existing cross-process `Flock` and low-priority worker stay authoritative; no second maintenance service was added.

The existing PASSIVE checkpoint now returns bounded numeric `WalCheckpointStatus` (`busy`, `log`, `checkpointed`, `pendingPages`) to its database-lifetime scheduler. If repeated checkpoints report unfinished WAL without moving the checkpoint end mark, later attempts back off to five minutes to avoid saturating a pinned reader. The policy never infers logical uncheckpointed bytes directly from the physical WAL size: a WAL file can remain large after complete recycling. The in-memory path returns `undefined` explicitly so all callers share the same Effect type. New policy plus file-backed checkpoint tests: **3 passed / 9 assertions**. Core `tsgo --noEmit` passed after fixing an initial void-return/type-union mistake found by those tests.

**Release risk:** a 64-MiB physical WAL does not itself mean 64 MiB pending; even PASSIVE checkpoint I/O on an isolated worker can consume disk bandwidth during interactive work. The 1/3/6-host large-DB benchmark must compare checkpoint I/O bytes, p99 Session COMMIT, WAL reuse and reader pin time. If the adaptive scheduling regresses foreground p99, prefer raising the WAL pressure threshold or adding a proven cross-process idle-window gate, not reverting to synchronous checkpoints.

### Follow-on: WAL-reuse pressure and bounded orphan-cleanup wait

Checkpoint pressure now distinguishes a physically large reused WAL from
uncheckpointed frames, using size/mtime markers across a successful PASSIVE
operation. A changed marker prevents claiming that a concurrent writer's new
frames were already handled. A recycled frame counter is not considered an
unchanging pinned reader. Maintenance scheduling uses monotonic time.

A real WAL reader-pin regression commits 128 BLOB rows, verifies partial
PASSIVE checkpoint progress while the old reader snapshot remains active,
allows the foreground to commit another row, then verifies full checkpoint
after the reader exits. Pressure, counter-recycle and reader tests:
3 passed, 22 assertions.

Orphan-payload cleanup now uses a per-page foreground-quiet admission budget
of 10 seconds. On timeout it returns deferred without acquiring a writer
reservation, exits the bounded cleanup loop, closes the worker and releases
the filesystem maintenance lease. It retries only on the regular five-minute
cooldown. A 35-ms timeout regression preserves both the payload and its
metadata, then reclaims them after quiet admission: 1 passed, 6 assertions.
The active runtime was neither refreshed nor given these source changes.

### Final isolated regression receipts and unresolved certification

After all source edits in this continuation:

| Scope | Result |
| --- | --- |
| Core filesystem locks including process-liveness and PID-reuse tests | **32 passed, zero failed, 65 assertions** |
| Core Scheduled Task domain, multi-process claim races, recovery and keyset pagination | **88 passed, zero failed, 548 assertions** |
| Host Scheduled Task runner, startup/teardown safety, revoked lease and periodic foreign recovery | **16 passed, zero failed, 53 assertions** |
| Adaptive checkpoint behavior plus foreground writer / in-memory regressions | **3 passed, zero failed, 9 assertions** |
| Six independent Bun WAL-writer workers | **1 pass** |
| Three-lane 84-operation SQLite stress | **1 pass, 131.9ms** |
| Core TypeScript (`tsgo --noEmit`) | **Pass** |
| Canonical schema migration generation consistency | **Pass** |
| Full host `packages/opencode` TypeScript | **Not green:** 16 errors across LLM protocol, CLI debug support bundle, global/session HTTP handlers, Session prompt contract and unrelated compatibility tests; **none** in the changed Scheduled Task runner in that run. These are shared-tree errors; do not claim host package-wide clean. |

No version bump, commit, stage, database operation against a live profile, runtime refresh, or production hot reload was performed. **Do not deploy this patch set solely on the isolated tests.** Still outstanding: a copied/isolated old 9–10 GiB DB startup+schema migration timing gate; 1/3/6 actual host crash/restart certification with real V1 Sessions, Swarm/Goal and scheduled runs; source-blind unknown-effect and non-cooperative tool containment; p95/p99 SQLite BEGIN/writer-lane admission; app responsiveness under high memory pressure and checkpoints; a durable WAL reader-pin remediation and crash-fault injection at COMMIT/ACK. Keep these as release blockers.

### Follow-up containment and refreshed receipts

The event `durable.begin.wait` trace now measures from **before the FIRST native writer admission attempt** until the transaction callback first executes, including all SQLite BUSY BEGIN retries, scheduler backoff sleeps and primary-connection permit admission. Earlier last-attempt-only timing understated contention. The actual transaction-body metric remains separate. A fresh real file-backed competing-writer regression passed **1/1, six assertions**; Core `tsgo --noEmit` exited 0.

The runner also revalidates its exact lease on the isolated control connection **after** durable `recordRunStart` and **before** external execution. Scoped heartbeat supervision now races blocked execution against lease-loss signal and has an independent 120-second no-confirmation watchdog with five-second checks. A late `settleRun` requires the exact task+lease+process+fire-for+attempt identity in the same writer transaction, while `skipSettled` requires an exact owned lease rather than removing another host's claim by `task_id`. Regression confirms a stale skip cannot remove a successor lease or advance the due cursor.

**Latest full Core Scheduled Task suite: 87/87 passing (404 assertions).** Latest focused host runner suite: **15/15 passing (50 assertions)**. Fresh Event BEGIN regression **1/1**, duplicate-index migration regression **1/1 (9 assertions)**, canonical generator `--check` exit 0, Core typecheck exit 0, scoped `git diff --check` exit 0 (line-ending warning only). The SQL unique-constraint error logged by a Core test is intentionally generated to assert the run's composite uniqueness protection; the suite itself has zero failures. No packaged-host or live database certification was run, and no runtime was refreshed.

**Unresolved stability risks:** due-cursor enumeration still materializes unbounded scheduled rows, unlike newly bounded manual queue admission; a full spool with thousands of overdue tasks could still create bursts of SQL/CPU without a fair paginated due cursor. The native host's all-source typecheck and unrelated prompt-provenance architecture assertion remain separate release gates. Noncooperative foreign tools can persist briefly after a lost-lease abort; database fencing prevents their late state mutation, not externally irreversible side effects. Long-lived WAL readers can continue to pin snapshots despite asynchronous PASSIVE checkpoints. Do not silently mark these as solved.

## October 15 later verified continuation: source concurrency and checkpoint pressure

**Supersession note:** the older unresolved warning immediately above about
unbounded `ScheduledTask.planDue` enumeration was subsequently addressed:
the Core planner now uses an indexed 64-candidate keyset page and joined lease
admission, with a rotating ephemeral cursor. A test finds all 140 due tasks
across three pages without duplicates. This is not a bound on all public
`due()` or maintenance scans.

SQLite's PASSIVE checkpoint can return pending frames under a pinned reader.
New maintenance logic suppresses redundant pressure passes for an unchanged
fully checkpointed WAL, detects log counter recycling rather than treating
it as perpetual starvation, and refuses to certify a clean file if its
size/mtime changed across the checkpoint. Clock intervals are monotonic.
Pinned reader, pressure, and recycle tests: **3 passed, 22 assertions**.

Orphan-event cleanup cannot hold its cross-process lock indefinitely while
waiting for an idle writer. It applies a **10-second whole-page quiet-admission
budget**, returns a marked deferred result on timeout, and exits the 32-page
sweep immediately. The next attempt observes a five-minute cooldown.
Successful, nondeferred cleanup retains the existing exact metadata/chunk
transaction and idempotent semantics. Dedicated regression: **1 passed,
6 assertions**; full event-payload test group: **5 passed, one skipped**.

### Isolated V1 delegated Session admission / real fake-provider overlap

The existing `packages/opencode/script/bench-session-concurrency.ts` was
executed with a wholly disposable database, temporary storage roots and local
fake HTTP provider. This is real V1 Session admission/provider overlap but
**not a packaged Desktop/ACP multi-process test**, and it does not model a
9+GiB database.

| Simultaneous Sessions | Admitted/completed | Session admission ms | Provider arrival p95 ms | Event-loop timer lag p95 ms |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1/1 | 74.7 | 263.4 | 57.9 |
| 3 | 3/3 | 67.6 | 179.9 | 3.9 |
| 6 | 6/6 | 131.9 | 301.6 | 3.8 |
| 12 | 12/12 | 324.5 | 797.1 | 15.3 |
| 25 | 25/25 | 566.5 | 1271.4 | 17.1 |
| 50 | 50/50 | 1017.4 | 2273.4 | 23.9 |
| 100 | 100/100 | 2105.8 | 5553.7 | 45.0 |

Every fake-provider request carried a unique Session marker, all 1/3/6/12/25/50/100
requests overlapped before release, no duplicate admission was detected,
and all Sessions reached a terminal completed state. At 100 Sessions the
maximum sampled timer lag was 100.9ms and throughput was 11.87 completions/s.
Cold-start and log effects mean do not infer linear speedup from the table.

An independent cancellation-mode run admitted 25 and 50 Sessions, then
cancelled every second Session while the provider held all SSE responses.
At 25: **12/12 cancellations acknowledged, 12 terminal cancelled, 13
completed**, with p95 timer lag 21.4ms and a 282.2ms cancellation phase.
At 50: **25/25 cancellations acknowledged, 25 terminal cancelled, 25
completed**, with p95 timer lag 26.2ms and a 424ms cancellation phase.
No cancelled Session resurrected as completed; both isolated commands exited
zero. All corresponding disposable benchmark directories were removed after
the owning benchmark process exited.

Re-run of existing **six independent Bun processes** on one temporary WAL
database: **one test passed, 20 assertions**, confirming 120 distinct
committed writes across the six hosts. This is a multi-process SQLite
certification component, not full multi-process OpenFork Session execution.

**Release blockers remain unchanged:** no active OpenFork database or installed
sidecar was migrated, checkpointed or refreshed. Actual multi-GiB clone
performance, full multi-process packaged Desktop/ACP/OXP runtime, mixed
Swarm/Goal/Session crash fault-injection, p99 writer-admission measurements
on the old database and unreplayable external tool fencing are still required.

## October 15 transaction replay edge-case audit — source changes and red/green proof

**New actual defect:** `EventV2.commitDurableEvent` previously wrapped its
entire IMMEDIATE transaction in `retrySqliteBusyCause`. That wrapper retries
on any native BUSY failure, including a failure from within the already
admitted transaction, projector, admission callback or a COMMIT with an
ambiguous acknowledgment. This violates the invariant that only a rejected
`BEGIN` is always safe to repeat. An injected `SQLITE_BUSY` defect in a
durable event's `admit` callback proved the bug **red**: its first callback
failed, the complete transaction was re-executed and the publish
inappropriately returned Success. After removing the outer retry (the native
adapter already retries rejected BEGIN exclusively), the same test passed:
**post-BEGIN BUSY returned Failure, callback invoked exactly once, and no
durable event row was inserted**. The existing independent competing-writer
BEGIN tracing test still passed; together **2/2, nine assertions**. Three
native BEGIN-contention tests passed, 16 assertions. Core typecheck passed.

The same generic wrapper surrounded `SessionExecutionOwner` transactions
performing recovery claims, ownership release and interrupt-generation CAS.
All those paths already use `behavior: "immediate"`; the wrapper now
delegates to the adapter's BEGIN-only retry, without recreating the
application transaction on post-BEGIN failure. Existing cross-process,
maintenance, recovery and execution-owner tests: **51 passed, 305
assertions**. This is important for fail-closed unknown outcomes: a
transaction with a lost acknowledgment is never assumed uncommitted.

`DatabaseMigration.apply` also enclosed the entire schema bootstrap and
migration journal chain in one retry wrapper. It now retries only its
initial standalone `sqlite_master` read; each schema, legacy-guard,
per-migration, and reconciliation transaction starts with
`BEGIN IMMEDIATE`. Every transaction must finish once or fail closed;
there is no global DDL/journal replay on a later BUSY. Migration tests:
**32 passed, 433 assertions**. The project-ID migration likewise no longer
repeats its multi-table Session/Memory/project identity changes after an
ambiguous transaction failure; project admission/contending ACP tests:
**2 passed, 14 assertions**.

An isolated fake-provider V1 Session smoke after these changes completed
**25/25** and **50/50**, preserving unique provider identities and complete
terminal outcomes. Session admission took 774ms (25) and 1065.4ms (50);
event-loop lag p95 was 24.4ms and 34.2ms respectively, and wall-clock
completion 4.65s and 3.84s. These differ from earlier cold-start and
concurrently-loaded runs; no comparative p99 claim is warranted. The
disposable benchmark directory was cleaned after its owning process exited.

Final post-patch V1 checks: 100 simultaneous Sessions admitted **100/100
distinct fake-provider requests**, with all responses overlapped and 100/100
completed. Admission was 2150.7ms; total 8386.7ms, 11.92 completions/s,
timer-lag p95 49.4ms and max 93.3ms. A separate 25-Session cancellation
case acknowledged 12/12 cancellations; all 12 remained cancelled, the
remaining 13 completed, and p95 timer lag was 17.2ms. Both exited zero.
Generated isolated fixtures were cleaned after the processes exited.

**Audit follow-up:** other callers of `retrySqliteBusyCause` remain. Atomic
single-statement CAS writes are generally retry-safe, but every
whole-transaction callback must be individually audited for post-BEGIN,
COMMIT, and external-effect replay. Do not globally remove bounded retries
from safely idempotent single statements. No live runtime was refreshed,
and the original large database remains untouched.

## Later continuation: contention priority, ChunkDB replay and seal-journal paging

The same post-BEGIN replay pattern was still present in the low-priority
`chunk-sealer.runPass` epoch-1 compressor/journal transactions and the
`chunk-prune.runSemanticPrunePass` metadata/bitmap/event-deletion
transaction. Both previously called `retrySqliteBusy(() =>
db.transaction(...))`. They now use the established foreground-quiet gate
**before** the bounded `BEGIN IMMEDIATE` and leave post-BEGIN failures
unreplayed. This preserves transactional durability and deliberately trades
background progress for interactive writer stability. Existing
semantic/compaction/sealer regressions: **17 passed, 101 assertions**.

Native SQLite BEGIN retry now has a single exported lane-aware policy in
`sqlite-busy.ts`, shared by the Bun synchronous, Bun worker and Node worker
drivers. Foreground primary retains its 15-second deadline, control owns a
3-second deadline, and maintenance gives up writer admission after 350ms.
This does NOT kill an active native write, nor retry a COMMIT. A real
contended WAL integration regression holds another writer reservation,
verifies the maintenance BEGIN returns Failure promptly **before entering its
transaction body**, releases the reservation and verifies a later
**explicit** pass commits exactly one row. Full BEGIN retry test file:
**5 passed, 23 assertions**. Core typecheck passed.

The seal-journal retention code still contained a misleadingly documented
**unbounded** `DELETE FROM ocdb_seal WHERE time_sealed < cutoff` on the
single SQLite WAL writer lane. It has been replaced by a **256-rowid
candidate keyset** and a single short IMMEDIATE delete + cursor-update
transaction. The cursor persists in the existing `ocdb_meta` table because
each background maintenance pass may acquire a fresh SQLite worker. The
delete revalidates the age predicate inside the writer transaction, so a
concurrent reseal does not lose its fresh audit row. No schema/index build
was introduced on opening an old multi-GiB database. SQL errors remain in
the typed Effect failure channel rather than being promoted to fatal
defects; the maintenance owner can defer a failed pass.

Disposable WAL regression seeded 600 expired and one fresh audit entries:
one pass deleted 256, a fresh SQLite connection resumed at the recorded
cursor and removed the remaining 344 in two more bounded passes, and
repeated cursor wrap preserved the fresh row. **1 passed, 5 assertions**.
Reopening and recovering the source cursor was tested; a crash between
BEGIN and COMMIT still requires packaged multi-process fault injection.
At 256 rows per ordinary sealer pass this is intentionally gradual;
monitor actual old audit-backlog drain time before adjusting cadence.

**Follow-on cursor race hardening:** the durable cursor UPSERT now includes a
compare-and-swap predicate against the value observed when the candidate
page was read. A competing host advancing its cursor during the foreground
quiet wait cannot have its progress rewound by an older maintenance pass.
The regression now injects a competing cursor update between the candidate
read and transaction entry, then checks the advanced marker and fresh
audit row survive; **1 passed, 7 assertions**. The Core typecheck remained
green. This CAS is a second fence alongside cross-process maintenance Flock;
row age is separately revalidated inside the DELETE.

No production DB was touched, restarted, vacuumed, checkpointed or migrated;
OXP's runtime remains non-refreshable. Source changes remain uncommitted
in a shared, already-dirty worktree, and are not deployed. Remaining release
blockers include copied old-DB p99 writer admission, real packaged
1/3/6-host crash injection and non-cooperative external effect containment.
