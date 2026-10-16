# OpenFork SQLite incidents — historical reconciliation (2026-10-11)

## Purpose and scope

This is the cross-incident index assembled from prior user/assistant engineering history **and inspected repository documents**. It is not a certificate of production remission. Do not call the problem solved merely because the newest Core regressions pass. This repo is a shared dirty worktree; preserve existing contributors' changes. No live sidecar, user database or installed JetBrains ACP executable was restarted/rewritten to create this document.

The critical distinction is **long SQL execution**, **queued worker RPCs**, **Effect-owned connection permit waits**, **native WAL writer contention**, and **renderer/provider stalls**. One diagnostic class is not proof of another. Native worker and query fingerprints are not SQL text.

## Reference chronology

### October 1: excess OXP history and maintenance
Historical investigation reported 121,486 OXP invocations and about 870.5 MiB logical rich JSON detail, including duplicated successful outcome bodies, in a roughly 10.6 GiB working DB. Corrective source work limited Core detail to 4 KiB and recorder detail to 3 KiB, stopped recording raw successful output, used compact redacted failures, and introduced bounded OXP invocation-detail retention (16,384 rows / 14 days, low-priority gated maintenance, batched work). See `docs/perf/investigation-2026-10-01/implementation-server-ledger.md`. These figures refer to a *historical observed database*, not necessarily the October 10 ~7.05GB file. Retention source tests are not evidence that old rows were pruned from the live DB.

### October 7: ACP/Desktop native SQL deadlock
See `docs/architecture/sqlite-acp-concurrency.md`.
- Separate Bun/Desktop/JetBrains ACP hosts share the same SQLite WAL DB: readers coexist, but one writer reservation; synchronous 5s Bun busy waits could block the very JS event loop that must commit a writer transaction.
- Short 75ms native `busy_timeout`, bounded idempotent/busy snapshot retries and removal of redundant unchanged-project UPSERTs repaired source-mode ACP `initialize→session/new→session/close`.
- `sqlite.bun-worker.ts` introduced worker-backed native SQL. Production opt-in `OPENFORK_SQLITE_ASYNC_WORKER=1` was explicitly conditional on **compiled Windows ACP** certification; original JetBrains installed binaries remained untouched.
- Six-process WAL stress wrote 120/120 rows. Source-mode ACP passed. Packaged multi-host performance/crash certification remains distinct.

### October 9–10: writer storm and false ownership
See `docs/perf/2026-10-09-concurrency-lane-integration.md` and `docs/research/sqlite-primary-permit-incident-2026-10-10.md`.
- GoalAutomation `requeueClaim` performed unconditional updates for sessions without claims; TurnCheckpoint began with unconditional stale-row UPDATE; checkpoint creation INSERT and `BEGIN IMMEDIATE` also collided. Repair used indexed negative preflight, precise owner/reservation CAS, immutable checkpoint insert retry, whole-failed-BEGIN-only bounded jitter. *Never retry an uncertain COMMIT or arbitrary external effects.*
- 25/50/100 fake-provider concurrent completion gates and exact cancellation passed after this repair. The 100-session test still had event-loop timer spikes up to ~13.9s: **correct outcomes are not responsiveness certification**.
- Fixed a separate dangerous SessionExecutionOwner owner-generation inference: raw acquisition did not register local live generation, causing a live Session to appear orphaned to Swarm retirement. Guard all recovery with exact generation plus authoritative quiescence, not age.
- Goal/run recovery, Session context history/usage reads, Swarm retirement, heartbeat, provider quotas, and OXP activity share DB pressure; side effects and transaction ownership must stay exact.

### October 10: native permit starvation forensic evidence
See `docs/perf/2026-10-10-sqlite-permit-starvation-incident.md` and `docs/research/sqlite-primary-permit-incident-2026-10-10.md`.
- Live initial 30s acquire timeouts across Session, Swarm, RuntimeOwner, OXP, Goal and usage were waiting **victims**, not necessarily failing SQL's root cause.
- Owner 8042 held the primary permit >103s with an outstanding SELECT; a separate run had owner 747/fiber 210923 held >156s. Do not conflate holder generations. Later fingerprint `c2b111a6` length 1065 ran >325s and at another observation >531s; interactive `0bbba6a9` length 1001 ran >46s. Exact SQL never persisted; cannot reconstruct it from 32-bit hash/length.
- Core permit tracker now records owner generation/fiber, lane, in-flight operation and native worker executing-vs-queued status. Same-fiber recursive acquisition fails immediately. Node SharedArrayBuffer stage avoids diagnostic message fanout.
- Independent worker-backed **control DB** protects heartbeat, Session acquire/release/interrupt and recovery when primary/interactive reads are pinned.
- Observed production DB at that point ~7.05GB, 8KiB pages, WAL, `sqlite_stat1` missing; `PRAGMA optimize` made maintenance responsible for planner statistics.
- `ForkCredentials.usageByCredential` grouped historical message JSON with `fork_message_credential` on the primary. Moved to analytics lane; small credential reads moved to interactive lane; `ForkUsageCache` upgraded to generation-aware process-global single-flight (64 simultaneous clients one expensive scan). These were **strong concrete candidates**, not authenticated original holder SQL.
- CRITICAL OPEN: `ForkCredentials.backfillSingleCredentialUsage` still performed unbounded `INSERT OR IGNORE … SELECT FROM message` on the **foreground writer** at first single-credential use. This write-path hazard is distinct from long SELECT fingerprints. Requires resumable versioned incremental migration with semantics preserved for multi-credential/legacy records.

### October 10 separate scheduler/renderer findings
Effect scheduler `MaxOpsBeforeYield` 2,048→128 reduced synthetic 100-session p95 timer lag 1,324→83ms, but throughput dropped 13.77→11.80/s and provider arrival spread widened; benchmark-only, not promoted. Separate all-async-worker configurations earlier improved timer lag p95 ~98% at 25/50/100 but reduced 100-session completed/s from 17.76 to 12.49. These are different experimental workload states and cannot be compared as before/after production speedup. Renderer Solid lifecycle and session-history O(N) reactivity had independent frame gaps; do not diagnose every UI freeze as SQLite.

### October 11: identify three long-read families
See `docs/research/sqlite-search-scan-isolation-2026-10-11.md`, `docs/research/sqlite-zen-free-production-plan-crosscheck-20261011.md`.
- FTS-first V1 part search (existing concurrently owned work): synthetic selective 165.882→0.903ms (~183.7x); shared reader leased at Core SessionInspection search/recall and OXP session search. The original `c2b111a6` fingerprint was **not** authenticated to that exact SQL text. OFXP supervision adapter is a remaining separate audit boundary.
- Memory recall had direct interactive reader paths; they were migrated to scan leases with a real file-backed WAL pinned-primary test. Existing fixtures that lack pooled reader support remain compatible.
- Native origin-tagged `Usage.ZenFree.snapshot` `e3be8ca2` took ~4.072s with other scan readers waiting, over 90-day message-part history. Another contributor's provider-index-first join, no ad-hoc startup CREATE INDEX, and 30s singleflight yielded synthetic requests 139.416→6.405ms (~21.8x) and error lookup 9.849→2.639ms (~3.7x). Production-SQL EXPLAIN and 20-way shared-query regression passed.
- Even a fast query can share an overloaded single scan-worker permit. Do not equate these improvements with elimination of all read-starvation sources.

### October 11: killable read-only native subprocess architecture
See `docs/research/sqlite-reliability-overhaul-2026-10-11.md`.
- Node and Bun read-only scan/interactive operations now route through OS-killable process with per-statement deadline and explicit cancel. Primary/control writers remain acknowledgment-preserving native workers; writing transactions can neither be killed at arbitrary COMMIT nor blindly replayed.
- Analytical pool defaults two independent readers with a bounded lease-admission deadline. File-backed Bun primary and interactive native SQLite are asynchronous by default. Note: this changes prior conservative opt-in policy and REQUIRES new packaged-ACP 1/3/6 host and 25/50/100 session throughput/tail-latency acceptance before product rollout.
- Bun standalone `--compile` required child `BUN_BE_BUN=1`; real Electron 42.3.3 child required `ELECTRON_RUN_AS_NODE=1`. Smoke tests passed on Windows. Bun `node:sqlite` authorizer callback's `SQLITE_DENY` could hang; Bun uses constrained SQL admission and native read-only; Node uses SQLite parser-level authorizer.
- New Windows RED→GREEN regression: two consecutive timed-out child generations then close could leave an earlier child owning the file (`EBUSY`). Track all children until actual IPC/process close, not merely the newest generation; eight post-fix cycles and deletion passed.
- Additional 48 primary writes +24 control reads +12 scan workload on disposable WAL fixture completed with correct 48-row/sum checksum (~145–272ms representative), and cyclic malformed IPC input no longer strands its connection. Standalone warm IPC p50 0.070ms killable subprocess vs 0.048ms Bun worker; overhead is accepted for bounded native cancellation.
- Reader PRAGMA allowlist, timeout/admission, native read-only, and SQL guard regressions passed. No post-deployment live production verification.

## Latest unresolved activity-link incident
Connected OXP diagnostic status retained two live `phase=activity_recording, activityOperation=link, errorName=EffectDrizzleQueryError` events (Oct 11). Their generic wrapper did not include a trusted root native SQLite code. It may be busy contention, constraint/FK, cancelled work, or another failure: **not proven**. Existing private-safe `oxp/diagnostics.ts` implementation and tests are concurrently owned/untracked; do not overwrite. OXP recorder safe-operation diagnostics and bounded busy retries already exist. OXP activity initial links are atomic at begin and subsequent `linkMany` is bounded/idempotent; terminal settlement + late links being atomically bound is still a separate boundary.

## Remaining engineering priorities ordered by correctness and reach

1. Prove exact failure code and command on disposable file-backed OXP activity link under genuine competing writer, malformed/stale invocation, concurrent session shutdown. Keep diagnostics privacy preserving. Never infer SQLITE_BUSY from a wrapper.
2. Eliminate `ForkCredentials.backfillSingleCredentialUsage` unbounded foreground `INSERT … SELECT`: durable cursor+bounded slices+fair maintenance ownership, verified attribution/count/cost semantics across 0/1/multi credentials and legacy data, cancellation/restart/retry/duplicate tests.
3. Reconcile new default async primary/reader with **older throughput regression**, packaged Windows JetBrains ACP startup/cancellation, writer ownership, and shared process/global lifetime. Do not accept read-only killability tests as equivalent to writer-transaction certification.
4. Find actual past query family if it recurs: compare qualified `sqlOrigin`, shape, native worker execution stage and live plan vector; hash alone never authenticates SQL. Audit OFXP supervision and any remaining long interactive/primary read paths.
5. Control database footprint and maintenance: OXP invocation detail retention, quota aggregation materialization, ChunkDB sealer/backfill/checkpoint/ANALYZE as low-priority gated and bounded work. Do not perform destructive vacuum/rebuild/index creation against active ~7GB DB without ownership + offline safety.
6. New built backend activation only through approved host lifecycle. Concurrent 1/3/6 ACP hosts plus 25/50/100 Sessions, p95/p99 permit/SQL hold and cancellation, worker RSS/CPU, verified durable outcomes, provider TTFT and UI responsiveness. Existing OXP tool host reports `runtime.refreshable=false`.

**Status:** A substantial source-level repair corpus exists with extensive synthetic verification; the recurring live incident has NOT been independently certified resolved.

## Current source validation — original credential backfill is still live

Directly inspected `packages/opencode/src/fork/credentials.ts:119-158` after historical recall. The original high-risk `backfillSingleCredentialUsage` **still exists**, using a single unbounded `INSERT OR IGNORE INTO fork_message_credential ... SELECT FROM message` on the primary writer. Both `list()` and `active()` call it, so a seemingly trivial credential/quota UI read can first execute the historical writer scan. In addition, `singleCredentialUsageBackfillChecked = true` is set **before** reading the candidate credential and before the SQL succeeds: an interrupted/busy/error execution can mark this *process-local* preflight done even when historical attribution was not completed. This is a concrete two-part next priority: eliminate foreground unbounded work *and* make durable completion/error retries correct. Do not change by simply moving this DML to a killable reader or retrying a partially acknowledged statement.

During today's new exploratory file-backed OXP link stress test (`packages/core/test/oxp-activity-file-backed-contention-20261011.investigation.ts` (kept outside automatic test discovery until validated)), a Windows `EBUSY` fixture-cleanup exception masked the underlying test outcome; that experimental suite is **RED/NOT VERIFIED**. The existing OXP activity tests remain green. Separate this test fixture lifecycle failure from the unknown live `EffectDrizzleQueryError` cause before attributing it to native WAL writer contention.

## October 15 continuation — cumulative load, maintenance, and safe recovery

This is a continuation of the same incident family, **not** a fresh SQLite
architecture or a replacement for the October 7–12 fixes. Source authority
remains repository `AGENTS.md`, `packages/core/AGENTS.md`, `FORK.md` and
`docs/map`. V1 remains the supported execution path. Existing bounded
`BEGIN` retries, killable read-only analytics, shared control writer, 400-row
credential-attribution cursor, FTS-first search, Session ownership generations
and crash-safe Swarm reconciliation must be reused.

### Corrections to this historical snapshot

- The earlier unbounded credential-attribution backfill **was subsequently
  repaired** in `packages/opencode/src/fork/credentials.ts`. See
  `docs/research/sqlite-delegations-20261011/lane-a.md` for its atomic
  rowid/cursor slices and passing restart/concurrent-writer regressions. It is
  now a live-backend verification gate, not an implementation TODO.
- The 1,065-byte `c2b111a6` query was later source-matched to the V1 FTS
  CROSS JOIN relevance plan and replaced with an FTS-first plan, with memory
  recall moved off the primary writer. See
  `docs/perf/sqlite-fts-recall-primary-permit-20261011.md`. That is a
  source-level fix; the older live deployed fingerprint was never rechecked
  after an approved backend activation.
- Source-only packaged ACP tests subsequently passed 1/3/6-host lifecycle,
  writer reservation and crash/restart cases. See
  `docs/research/sqlite-bun-worker-begin-retry-2026-10-11.md`. Those tests
  do **not** certify real provider-backed concurrent Swarms or the current
  multi-gigabyte database.

### New verified source changes

The October 15 inspection found database-bootstrap, WAL-checkpoint,
planner-optimize, ChunkDB sealer, search cold-seed, OXP detail retention, and
OXP attribution-backfill filesystem leases that did **not** opt in to the
already-existing `Flock.protectLiveProcess` safeguard. A delayed heartbeat
could therefore misclassify a live, overloaded host as stale and initiate a
competing maintenance/bootstrap owner. These owners now request live-process
protection; a genuinely dead PID remains reclaimable. This protection is
same-host only: uncertain foreign-host liveness still requires conservative
lease design, and process PID reuse needs separate review.

The primary `Database.layerFromPath` also performed a startup synchronous
`PRAGMA wal_checkpoint(PASSIVE)` under its DB-local schema-bootstrap lease.
That startup path has been removed. The existing checkpoint loop now starts
after 30 seconds, uses the already-existing async maintenance worker, and then
continues at five-minute intervals. The file-backed
`Database.withBackfillDb` maintenance connection defaults to the existing
async worker instead of synchronous Bun SQL on the sidecar event loop;
diagnostic `asyncWorker:false` remains possible. PASSIVE checkpoint return
values are inspected: busy or >=16,384 uncheckpointed pages produces
numeric-only telemetry instead of an apparently silent success.

The process-global V1 usage-limit recovery deadline runner also performed
small indexed due/claim/cancel reads and writes against the foreground
`Database.db`. It now reuses `Database.controlDb()` when available (the
already-existing connection isolated from long primary SELECT permits);
injected legacy fixtures fall back to `db`. It does not add a recovery
scheduler, loosen Session ownership or change claim backoff.

Focused evidence: `bun test --root ./test/util flock --only-failures`
executed from `packages/core` passed 30 tests. The new
`test/database-maintenance/async-worker-contention.test.ts` runs a real
file-backed WAL writer held open by a main-thread timer; the background
maintenance INSERT completed after that timer released the writer (1 pass,
0 failures). These tests do not establish an old-DB speedup or a redeployed
OpenFork sidecar.

### Remaining correct release gates

1. Compare the **same** active host and system workload against
   `openfork-dev-fresh.db`, `openfork-dev.db` and `openfork-main.db`,
   without manually checkpointing, VACUUMing, or mutating those live files.
   At inspection, the main files were ~75.7MB, ~9.38GB and ~10.35GB
   respectively, and `openfork-dev.db-wal` was ~1.50GB. Database size and
   WAL growth alone do not identify a lock holder.
2. Correlate producer-level admission/recovery with native SQL worker activity:
   foreground/reader/scan/control lane, statement shape and origin, writer
   transaction lifetime, WAL page backlog and oldest open snapshot; report
   p50/p95/p99, event-loop lag, queue depth and duplicate worker owners.
3. Stress genuine V1 Session + Swarm + Goal + Scheduled Task recovery across
   1/3/6 host counts and process kills during startup, BEGIN, running tool,
   COMMIT and shutdown. Preserve unknown external side effects; do not blindly
   replay an unacknowledged write or tool operation.
4. Profile the previously observed 2.15–2.32GB per packaged ACP process and
   post-shutdown finalizer spike. Ensure memory/CPU/worker-process counts and
   steady-state throughput are not regressed by asynchronous SQL.
5. Build, verify and activate a candidate through an approved host lifecycle
   before claiming production remediation. OXP status currently reports
   `runtime.refreshable=false`; no running host was replaced here.

### Newly correlated October 15 live log — primary writer admission

The live `/openfork/log/openfork.log` window
`2026-10-15T18:52:17Z`–`18:53:04Z` adds a distinct observable root:

- Two concurrently running V1 Sessions used the same project worktree. Their
  Git snapshot staging also reported `index.lock` contention. That filesystem
  contention is real but **not proven to cause** the SQLite incident.
- At `18:52:27Z` and `18:52:31Z`, `lane=primary` held by
  `sqlOrigin=Session.updatePart` reported `sql=TRANSACTION`, SQL length 15,
  5 queued waiters, and held time approximately 7.4–11.4 seconds. Native
  `workerStage=idle` at those observations did **not** report a long SELECT:
  this was BEGIN/transaction-admission pressure or a stalled worker transition,
  and precise external writer attribution remains unproven. Later reports for
  a separate owner generation showed `workerStage=executing` and 5–7 waiters.
- The resulting victims included a `session_telemetry` UPSERT,
  `session_limit_recovery` reads, Session existence lookups and a
  `RuntimeOwner.heartbeat` failure. A 30-second connection-permit timeout
  measured in a downstream request is therefore not evidence that *that*
  request's SQL was slow.
- Current `Session.updatePart` emits
  `SessionV1.Event.PartUpdated`; the durable event owner in
  `packages/core/src/event.ts` pre-encodes payloads, then takes a single
  `BEGIN IMMEDIATE` writer transaction with bounded `BEGIN` retry and
  atomic projections. Preserve this correctness model. The likely unclosed
  performance boundary is foreground streaming-event admission competing with
  other WAL writers while holding the primary permit. Do **not** introduce
  multiple uncoordinated writing connections for these events, bypass
  `BEGIN IMMEDIATE`, or replay unknown COMMIT outcomes.

This evidence strengthens the reason to route deadline/heartbeat control
operations through the existing control lane, but does not yet establish
whether a peer writer, another long transaction, or storage stalls occupied
the WAL reservation. The old database must be benchmarked via read-only
forensic observation or an isolated consistent clone, not altered live.

### Validation boundary for this continuation

- Core `bun run typecheck`: exit 0. Maintenance async-worker regression:
  1/1 pass. Existing filesystem-lock suites: 30/30 pass.
- OpenFork host `bun run typecheck`: exit 2 on current shared-tree errors
  including unrelated support bundle, protocol handler, session prompt, and
  compatibility-test types. Do not claim a clean host-wide typecheck.
- An attempted host test selection unexpectedly started unrelated Session
  suites and encountered a `checkpoint-tool` fixture hook timeout; the
  broad run was terminated. **No `limit-recovery-runner` targeted green
  assertion is claimed from this attempt.**
- `git diff --check` for scoped tracked changes exited 0. The connected OXP
  runtime remains live/unrefreshed, so there is **no measured deployed effect**.

## October 15 additional executed continuation

See [durable writer-admission, storage inventory and OXP index results](./sqlite-20261015-admission-storage-oxp-index.md). This source-only pass separated BEGIN admission from transaction-body timing, moved file-backed orphan-event cleanup off startup/primary SQL, ran readonly page and dbstat investigations (including an aborted high-cost Main scan), and used the **canonical** migration generator to remove one proven duplicate OXP link unique index without altering primary-key uniqueness. The new real-WAL admission test (6 assertions) and migration test (9 assertions) both passed. No live database migration or runtime restart was performed.
