# Session concurrency frontier — October 9, 2026

## Scope and authority

Performance investigation in the OpenFork checkout, constrained by root and
package `AGENTS.md`, `docs/map/README.md`, and
`docs/handoff/ARCHITECTURE-OWNERSHIP-PLAYBOOK.md`. Production execution stays
V1; Core owns process-global event dispatch; the V2/new-layout UI is the primary
presentation. Do not move Tier-0 reads into Instance/Location just to reuse a
convenient implementation. Previous hosted T11/T12/T13 measurements belong to
distinct workloads and must not be presented as a current local-host benchmark.

## P0: global event type fan-out multiplies by unrelated Session listeners

**Observed source:** `packages/core/src/event.ts` invoked all registered
type listeners synchronously, before location/aggregate notification.
`packages/opencode/src/session/delegated-worker.ts:waitMany` registered five
such listeners per batch, even when all worker Session IDs were known. A
different Session's permission/question event consequently invoked each waiting
batch listener. A callback that suspended could delay the unrelated producer.

**Authoritative owner:** `EventV2` process-global runtime (Tier 0), not
renderer filters or per-wait application caches. No new persistence or location
graph is needed.

**Implemented:**

- `EventV2.listenSessionType(definition, sessionID, listener)` indexes listeners
  by event type and explicit `data.sessionID`; if the key is absent, it does
  not enumerate nonmatching listeners.
- `DelegatedWorker.waitMany` subscribes to exact Session IDs whenever none of
  the workers requires observing an open-ended descendant set. Nested
  delegation retains the previous broad type listeners, because descendants
  cannot be safely inferred from the known ID set.
- Synchronous callbacks retain per-session ordering, unsubscribes remove index
  entries, defect containment remains owned by `observe`, and no authorization
  scope is broadened.
- Negative invariant: **publishing an event for Session A invokes zero
  session-indexed callbacks registered only for Session B**.

**Reproducible evidence:** `packages/core/test/event-session-fanout-scaling.test.ts`.
On this Windows host, six alternating paired rounds of 600 events and 100
registered listeners each showed:

| Route | Six elapsed times (ms) | Median (ms) |
| --- | --- | ---: |
| Original global type subscriptions | 48.84, 46.19, 34.92, 34.10, 32.46, 31.22 | 34.51 |
| Session-indexed subscriptions | 6.45, 8.62, 4.59, 4.68, 4.50, 4.28 | 4.64 |

The comparison is **7.44x** on this synthetic dispatch workload. The work
executed by each subscriber was intentionally minimal; these measurements
are not end-to-end provider throughput or whole-app speedup. Both routes
verified exact, appropriate event delivery. A separate negative test confirmed
that an unrelated type listener could prevent a Session publish from settling.
Existing 6-session/6000-delta plus 6x2MiB durable boundary saturation tests
also passed.

## P1: worker batch completion scales without one Effect fiber per worker

**Root cause:** `DelegatedWorker.waitMany` previously reconstructed an
`Effect.raceFirst` tree of `BackgroundJob.wait({ id })` for every running
worker on each wake cycle. The race creates O(worker count) waiting branches,
even though the caller only needs a single terminal transition signal.

**Implemented at the authoritative owner:**

- `BackgroundJob.waitAny({ jobs: [{ id, generation }], timeout })` registers
  ONE interruptible Deferred per caller, indexed by the exact job IDs it is
  watching. Terminal settlement/cancellation awakens only relevant batches.
  A single batch still has O(N) registration/snapshot work but O(1)
  suspended waiting fibers, rather than O(N).
- Subscribe-before-status-check prevents missed completion transitions.
  Per-job generation matching prevents recycled IDs from hijacking a wait.
  `Effect.ensuring` unregisters subscriptions after completion, timeout and
  interruption. No process-global listener registry or timer per job.
- The V1 `BackgroundJob` InstanceState adapter delegates to the shared Core
  owner. `DelegatedWorker.waitMany` replaces its race tree with the indexed
  wait; permission/question wakes, nested delegation, completion semantics,
  deadline, and output snapshots retain their existing behavior.
- `snapshotMany` now passes its already-authenticated immutable worker
  origin through the snapshot/fallback pipeline, avoiding a redundant
  `Session.get` per worker. Pending-blocker membership uses a Map lookup
  rather than O(number of workers) linear search per pending request.
- `BackgroundJob.getMany(ids)` takes one synchronized-registry snapshot of
  multiple jobs, rather than separate `get` admissions for every worker.
  The V1 `InstanceState` adapter and `DelegatedWorker.snapshotMany` consume
  it only **after verifying worker identity**, and blocked workers still
  recheck their live state. Duplicate IDs are collapsed and missing IDs are
  not fabricated. Returned metadata is copied rather than aliased.

**Regression evidence:**

- `packages/core/test/background-job.test.ts`: 12/12 tests, including 100
  worker subscriptions, unrelated completion isolation, immediate completion,
  generation reuse, 50 interrupted waiters and multi-job snapshot integrity.
- `packages/opencode/test/session/delegated-worker.test.ts` and
  `test/oxp/delegated-worker-control.test.ts`: integration process exit 0.
- Core TypeScript project check passed. The concurrently edited OpenFork V1
  project currently reports unrelated CLI/HTTP/compatibility-test TypeScript
  errors, so **the whole V1 typecheck is not green** at this checkpoint.

**Reproducible benchmark:** `bun packages/core/script/background-wait-concurrency-bench.ts`
from repository root. It alternates the pre-change race tree and the indexed
wait for 8 paired rounds at 1/5/10/25/50/100 running jobs, using actual
`BackgroundJob` instances and in-process Effect fibers. Two independent runs:

| Workers | Legacy median ms (run 1 / 2) | Indexed median ms (run 1 / 2) | Ratio (run 1 / 2) |
| ---: | ---: | ---: | ---: |
| 1 | 0.236 / 0.420 | 0.229 / 0.394 | 1.03x / 1.07x |
| 5 | 0.417 / 0.652 | 0.204 / 0.277 | 2.05x / 2.35x |
| 10 | 0.603 / 0.752 | 0.191 / 0.197 | 3.16x / 3.82x |
| 25 | 0.579 / 0.992 | 0.134 / 0.194 | 4.31x / 5.12x |
| 50 | 1.428 / 2.409 | 0.174 / 0.258 | 8.20x / 9.35x |
| 100 | 2.127 / 4.703 | 0.168 / 0.311 | 12.65x / 15.10x |

These are local wait-and-wake microbenchmarks, NOT whole-application
provider throughput or time-to-first-token measurements. The workload
intentionally excludes SQL, renderer work and remote model latency.

**Follow-up paired batch-read benchmark:** the same reproducible script now
also runs 16 alternating rounds of 4-concurrent single-job `get` requests
versus a single `getMany`, asserting complete row cardinality. Two runs:

| Jobs | Separate get median ms (run 1 / 2) | getMany median ms (run 1 / 2) | Ratio (run 1 / 2) |
| ---: | ---: | ---: | ---: |
| 1 | 0.024 / 0.048 | 0.015 / 0.029 | 1.58x / 1.63x |
| 5 | 0.084 / 0.079 | 0.022 / 0.018 | 3.85x / 4.39x |
| 10 | 0.126 / 0.127 | 0.014 / 0.015 | 9.12x / 8.22x |
| 25 | 0.264 / 0.476 | 0.019 / 0.029 | 13.78x / 16.18x |
| 50 | 0.433 / 0.451 | 0.021 / 0.023 | 20.52x / 19.71x |
| 100 | 0.645 / 0.897 | 0.024 / 0.033 | 26.56x / 27.21x |

This is purely **process-local registry reading**; neither arm retrieves
Session metadata from SQL, performs permissions/telemetry queries or renders
the UI. The real `snapshotMany` pipeline still has O(workers) authorized
Session and execution-owner reads. Further improvement needs an
identity-preserving, durable-owner batch API rather than hiding that cost in
the renderer.

## Remaining architecture candidates (not yet repaired)

1. **Worker batch waiting: implemented, live saturation still unverified.**
   The per-worker race tree was replaced by a per-BackgroundJob-instance
   completion index as described above. The outstanding gate is measuring
   actual 25/50/100-session waiting latency and cleanup under provider,
   permission, cancellation and DB pressure.
2. **EventStream/PubSub subscriber memory.** `EventV2` contains unbounded
   global and per-type PubSubs. A stalled stream subscriber may retain an
   unbounded backlog. Native HTTP SSE already uses byte-bounded subscriber
   queues with overflow/repair semantics. The generic Stream API needs explicit
   loss/replay/error contracts before replacing unbounded hubs with dropping
   or sliding ones; never silently lose append-only events.
3. **V1 provider iteration history work.** `SessionPrompt` reloads effective
   history and context overlays each provider/tool iteration. The overlay is
   already moved onto the dedicated WAL reader and skips the no-overlay
   transformation. An additional revisioned, session-owned overlay snapshot
   could avoid repeated reads, but requires a transactional version/invalidation
   proof and fresh history after compaction, edits and resumption. Do not
   cache provider history blindly across turns.
4. **Shared SQLite writer.** Core has immediate write transactions and
   busy/snapshot-aware retries, but all active Sessions still share WAL writer
   capacity. Measure write occupancy, retry density and p99 admission under
   1/3/6/25+ real sessions before considering a single-writer actor or durable
   batching. Atomic projectors and mutation receipts must not be separated.
5. **Runtime-instance and provider initialization amplification.** Tier-0/1
   metadata reads must not bootstrap instance/config/plugin/tool/LSP/watcher
   services. Compare cold/warm startup under multiple simultaneously admitted
   sessions, collecting created-instance counts and provider-graph stages.
   The existing Tier-2 provider catalog split is not itself proof that first
   selected-model execution never waits for unrelated provider setup.
6. **Active renderer and SSE latency under mixed streams.** The existing
   1/3/6 Electron gates are valuable but do not prove 25/50/100-session
   first-visible-token and cancel-to-stop fairness. Correlate server queue,
   provider permit, event publication, SSE sequence, renderer commitment and
   foreground input responsiveness.

## Acceptance metrics for the next phase

- Distinguish **created Sessions**, **running provider streams**, **queued
  admissions**, **tool jobs**, and **visible renderer streams**.
- Benchmark 1/3/6/10/25/50/100 concurrency with fixed provider/account
  limits; report completed turns per second, p50/p95/p99 user-to-first-token,
  provider queue age, cancel-to-stop, output-integrity/replay gaps, SQLite busy
  rate, event-loop delay, memory, CPU and OS handles.
- Record foreground latency under 6 or 25 background Sessions, not only peak
  throughput. Reject designs that gain throughput through unbounded queues,
  speculative duplicate requests or dropped authority fences.
- Zero newly booted instances for Tier-0/1 reads; zero per-row history fetches
  for dense UI; zero unrelated Session callbacks on the indexed event path.

This investigation made no live-application reload, DB maintenance, process
termination, or broad worktree cleanup. Source changes require normal runtime
activation and real mixed-load measurement before claiming deployed gains.

## Follow-up: SQL batch ownership, governor fairness, event overflow and context (same day)

### A. Durable execution-owner snapshots

- Core `SessionExecutionOwner.snapshotMany(ids)` selects execution-generation
  fences and their `RuntimeOwner` heartbeat in one WAL-reader LEFT JOIN per
  bounded 400-ID page. No owner process probing, authorization inference,
  Instance startup or Location graph is introduced.
- V1 `DelegatedWorker.snapshotMany` consumes these snapshots after verifying
  each delegated worker's producer/principal. Existing V1 `Session.getMany`
  and `requireWorkers` were concurrently implemented in the checkout; we
  retain and reuse them rather than duplicating those semantics.
- Per-batch immutable ancestry lookup is memoized for nested permission/
  question blockers, without persisting potentially stale blocker state.
- Bounded-page, equivalence and missing-row regression tests are in
  `packages/core/test/session-execution-owner.test.ts`. Reproduction:
  `bun packages/core/script/session-owner-batch-bench.ts`.

**Isolated, file-backed SQLite fixture, eight paired rounds** (per-Session
snapshot, 4 concurrent calls vs one batch):

| Sessions | Separate median (ms) | Batched median (ms) | Ratio |
| ---: | ---: | ---: | ---: |
| 1 | 0.629 | 0.415 | 1.52x |
| 10 | 6.497 | 1.101 | 5.90x |
| 25 | 9.396 | 0.737 | 12.75x |
| 50 | 16.216 | 0.924 | 17.55x |
| 100 | 26.916 | 1.413 | 19.04x |
| 200 | 54.168 | 1.742 | 31.09x |
| 400 | 98.425 | 3.885 | 25.33x |

**Second ownership-path reduction: only decode the authority you need.**
The V1 `Session.Service.workerOriginsMany` API reads only Session ID and
producer-owned metadata, paging up to 400 IDs. `DelegatedWorker.requireWorkers`
uses it for each caller-authorized batch before consulting any live job or
owner state; fallback support for older partial Session services is retained.
The former `Session.getMany` adapter selected/decoded every Session column
including `summary_diffs`, `permission`, `revert` and `model` to learn one
delegation-origin object. This was especially wasteful under worker swarms
whose Session rows contain large diffs.

`bun packages/opencode/script/worker-origin-projection-bench.ts`, run from
repo root, uses an isolated disposable WAL fixture with ~48 KiB synthetic
summary diffs per Session, eight alternating paired rounds. It compares the
real V1 `fromRow` full decoder against the same canonical
`SessionMetadataOwnership.workerDelegation` validation on two columns:

| Sessions | Full row median (ms) | Origin projection median (ms) | Ratio |
| ---: | ---: | ---: | ---: |
| 1 | 0.507 | 0.184 | 2.76x |
| 10 | 1.366 | 0.279 | 4.89x |
| 25 | 2.770 | 0.378 | 7.33x |
| 50 | 5.455 | 0.765 | 7.13x |
| 100 | 9.569 | 0.994 | 9.62x |
| 200 | 14.193 | 1.572 | 9.03x |

This is a deliberately large-row, source-level SQLite projection experiment,
not representative of all live Session payload sizes or user-visible latency.

**Safety incident and recovery:** the FIRST version of the ownership benchmark
resolved OpenFork's default development SQLite database instead of overriding
the test graph. It inserted 400 identifiable synthetic Session and execution
owner rows and triggered an autonomous ChunkDB sealer pass that reported
compacting nine pre-existing records. We verified exact synthetic row
identities, dependency counts, and owning runtime; then removed all 400
benchmark Sessions, their 400 ownership rows, and the single unreferenced
synthetic runtime owner using guarded IMMEDIATE transactions with foreign keys
enabled. Post-cleanup verification found zero benchmark Sessions/owners.
The nine maintenance compactions were not undone; they must not be described
as restored. The benchmark now uses a disposable tempfile database with a
fail-closed path/reader assertion before any fixture write and deletes it on
exit. The numerical results above come ONLY from this corrected isolated run.

### B. Provider admission and retention

- WorkBuddy's account-local virtual-time ledger now uses a prototype-safe
  bounded Map instead of retaining each historical Session forever. Pending
  competitors remain pinned in the fairness ledger during pruning.
- `test/plugin/workbuddy-fairness-concurrency.test.ts` includes 320 independent
  admissions plus 100 simultaneous synthetic requests. Under concurrency=4,
  24 were admitted and 76 rejected explicitly by the finite queue, with no
  speculative duplicate transport; all accounting assertions passed.
- These are local governor tests only; the actual 25/50/100 provider-stream
  first-token, queue-age and fairness/p99 measurements remain an open gate.

### C. Bounded event subscribers, without hidden loss

- The opt-in `EventV2.subscribeBounded` helper uses the existing byte/count
  bounded subscriber queue plus event-type-indexed listeners. Overflow fails
  with an explicit `SubscriberOverflowError`; durable consumers must still
  use the sequenced aggregate `durable()` stream for lossless replay.
- The existing generic `subscribe()` / `all()` PubSub streams are STILL
  unbounded. They were NOT silently converted to sliding/dropping queues,
  because such a change would violate their existing delivery contract.
- `packages/core/test/event.test.ts` covers typed overflow and healthy
  unrelated publisher continuation; the entire EventV2 suite passed 59/59.

### D. Provider effective-context work

- When no context overlays are present, V1 avoids a second full history
  validation scan that would only fall back to its unchanged canonical array.
- Overlay caching is tied to the exact WAL reader handle, not the Session
  history, and invalidated using SQLite `PRAGMA data_version` from distinct
  writer connections. In-memory same-handle contexts bypass caching entirely.
- Each reader retains at most 64 cached Sessions of 64 rows / 128 KiB each,
  TTL 60 seconds. Sessions with fewer than four overlay rows take the canonical
  direct-read path, which never reuses stale rows. A short adaptive bypass
  also prefers direct reads under sustained write/version churn.
- `test/session/context-compiler-concurrency.test.ts` covers concurrent
  WAL-reader isolation, commits after exclusion/restoration/text edits, and
  the uncached-to-cached transition. `script/context-overlay-cache-bench.ts`
  compares baseline SQL/compile work to the version-guarded implementation in
  a disposable DB. Because the synthetic benchmark invokes slightly different
  Effect wrappers, its ratio is indicative, not a definitive latency delta.
- Cache performance is workload-conditional. After correcting the benchmark
  to equalize Effect.fn and result shapes, isolating each steady-state phase
  from the prior scenario's write storm, skipping cache for fewer than four
  overlays, and bypassing version checks after sustained writes, the latest
  six-round paired run measured:

  | Overlay rows | Quiet legacy / adaptive (ms per compile) | Quiet ratio | Write-churn legacy / adaptive (ms) | Churn ratio |
  | ---: | ---: | ---: | ---: | ---: |
  | 0 | 0.1249 / 0.1364 | 0.92x | 0.1030 / 0.1091 | 0.94x |
  | 1 | 0.1258 / 0.1082 | 1.16x | 0.1245 / 0.1330 | 0.94x |
  | 20 | 0.2649 / 0.1145 | 2.31x | 0.2230 / 0.2264 | 0.99x |
  | 50 | 0.2632 / 0.0543 | 4.84x | 0.2046 / 0.2071 | 0.99x |

  Churn means a distinct writer commits before EACH projection, so the
  version-guarded cache must fall back to canonical reads rather than returning
  an old overlay. It still has small overhead on the default zero-overlay
  path, so **no universal win is claimed**. Production tracing/real user
  history must gate deployment.

### E. V1 addressed Session metadata hydration (additional independent lane)

- The production V1 `Session` owner now exposes `getMany(ids)` over its existing
  WAL reader, deduplicating requested IDs and chunking into 400-ID pages. It
  uses the same `fromRow` decoder and preserves missing-row semantics. The
  method is optional in the transitional Interface so explicit partial service
  mocks and older test graphs retain their single-read behavior.
- `DelegatedWorker.requireWorkers` validates every returned producer-owned
  delegation origin against the exact requested producer and principal.
  `snapshotMany` and `waitMany` now reuse that batched admission; a missing
  or unauthorized member fails the entire request closed rather than returning
  a partial privileged batch. Single-worker APIs are unchanged.
- The worker-facing test double fallback is intentional: Effect's partial
  `Service.mock` may synthesize throwing methods for undeclared properties, so
  the adapter tests own-method presence rather than merely `typeof`.
- `test/session/session.test.ts` checks identical V1 decoding, duplicate IDs,
  absent IDs and the empty case. The real AppRuntime delegated-worker test checks
  an actual completed worker batch, incorrect principal rejection and missing
  worker rejection. The worker-control suite remains passing.
- Benchmark: `bun packages/opencode/script/session-metadata-batch-bench.ts`.
  It creates a disposable, path-verified database and measures identical V1
  row hydration using four concurrent single-ID reads versus an addressed
  SQL IN projection, alternating eight rounds in each of two independent runs.

  | Sessions | Individual median (ms), runs 1 / 2 | Batched median (ms), runs 1 / 2 | Ratio, runs 1 / 2 |
  | ---: | ---: | ---: | ---: |
  | 1 | 0.467 / 0.430 | 0.383 / 0.365 | 1.22x / 1.18x |
  | 5 | 1.406 / 1.877 | 0.385 / 0.479 | 3.65x / 3.92x |
  | 10 | 2.741 / 3.651 | 0.401 / 0.392 | 6.84x / 9.31x |
  | 25 | 5.366 / 5.294 | 0.531 / 0.654 | 10.10x / 8.09x |
  | 50 | 9.840 / 9.898 | 1.161 / 0.795 | 8.47x / 12.46x |
  | 100 | 13.088 / 17.461 | 1.070 / 0.969 | 12.23x / 18.01x |
  | 200 | 22.682 / 32.025 | 1.430 / 2.446 | 15.86x / 13.09x |

  Additional bounded-pagination regression (420 addressed Sessions,
  400-ID SQL pages, eight alternating rounds) completed without missing
  rows: 45.961 ms individual versus 2.915 ms batched (**15.77x**) on that
  isolated run. This explicitly exercises the second SQL page rather than
  extrapolating from the under-limit fixtures.

  These figures exclude provider inference, V1 `Session` service graph
  initialization, permission blockers and Electron presentation. Do not add
  the 12–18x SQL ratio to the earlier owner/job wait ratios: they measure
  different, overlapping portions of the same batch operation.

### F. Narrowed origin projection and atomic listener admission

- `Session.workerOriginsMany(ids)` is the latest producer-owned batch API.
  Unlike `Session.getMany` it selects **only id and protected metadata** on the
  WAL reader. Invalid, human-owned or absent rows never authenticate workers.
  `DelegatedWorker.requireWorkers` verifies every producer/principal and
  fails the whole batch if any addressed member lacks authority. The older
  `getMany` and single-`get` fallbacks remain for transitional test graphs.
- The isolated `script/session-metadata-batch-bench.ts` now compares three
  exact SQL projections (one row per query, all columns batched, minimal
  id+metadata batched) in 8 alternating rounds. Two runs of the third variant
  measured, at 100 IDs, full-row batched **1.156 / 0.833 ms** versus
  metadata-only **0.472 / 0.347 ms** (2.45x / 2.40x). At 420 IDs,
  the full-row path measured **3.322 / 5.629 ms** versus metadata-only
  **1.151 / 1.393 ms** (2.89x / 4.04x), including the second SQL page.
- `EventV2.listenSessionTypes(definitions, sessionIDs, listener)` installs a
  deduplicated, session-indexed subscription batch in one synchronous
  registration Effect, avoiding N×5 separate subscriptions when a worker
  `waitMany` observes multiple permission and question events. The
  `Effect.acquireUseRelease` call brackets listener installation and
  cleanup, including cancellation during acquisition. Nested-delegation
  subscriptions retain the original wider type-listener path.
- `script/session-event-listener-bench.ts` uses in-memory-only EventV2 and
  12 alternating paired rounds of the original separate registration versus
  the new batch. Two runs measured a **2.81x / 3.00x** faster setup at 100
  Sessions (500 type+Session keys), and **5.33x / 2.29x** at 200 Sessions
  (1,000 keys). These are registration costs, **not** SSE first-token latency.
- Core event subscription tests verify exact target routing, duplicate
  definitions/session IDs, post-unsubscribe silence and 2,000 unrelated
  publications against a 100-Session watcher with zero spurious deliveries.
  The complete EventV2 and runner-tool-publish suite passed **67/67**, the
  delegated-worker control + real V1 suite passed **32/32**, and Core
  TypeScript completed successfully after updating a complete test service
  mock for the added API.

### F. Nested-worker blocker ancestry, bounded by depth rather than candidates

- A new optional V1 `Session.parentIDsMany(ids)` projects only
  `session.id`/`session.parent_id` using the existing dedicated WAL reader,
  with deduplicated requests, empty/missing row behavior and 400-ID pages.
- For a group of nested workers with multiple pending permission/question
  sources, `DelegatedWorker.blockingRequestsBatch` fetches one breadth level
  at a time and memoizes the parent facts for **this projection only**. Each
  pending request still walks its own ancestry with a per-request seen set and
  the existing 64-depth cap, preserving the exact descendant blocker list.
  Partial mock services without the new method keep the legacy point-lookup
  path. This is not an authorization change.
- Real `Session.Service` integration verifies root/child/grandchild ancestry,
  duplicate and absent IDs, empty input, and >800 addressed IDs crossing
  multiple SQL pages. A mocked producer-provenance/Question test verifies
  that 120 distinct nested child blockers all remain visible to their parent
  worker with at most six batched ancestry calls across its recheck. The
  delegated worker control suite passed 23/23.
- Isolated SQLite **query-shape** benchmark:
  `bun packages/opencode/script/bench-worker-ancestry-read.ts`. It models
  the previous per-ID full-row query + per-call memoization versus the new
  two-column breadth-level IN queries on 12 shared ancestor nodes.

  | Descendant leaves | Old queries | Batched queries | Old / batched median (ms) | Ratio |
  | ---: | ---: | ---: | ---: | ---: |
  | 10 | 22 | 13 | 0.966 / 0.819 | 1.18x |
  | 100 | 112 | 13 | 4.970 / 0.825 | 6.02x |
  | 400 | 412 | 13 | 20.231 / 1.201 | 16.84x |
  | 1000 | 1012 | 15 | 47.429 / 5.734 | 8.27x |

  The benchmark is not a complete worker or provider latency claim.

### G. Rate-limiter admission precision and monotonic scheduler

- WorkBuddy's launch token bucket and per-Session fairness timestamps now
  use `performance.now()` rather than wall-clock time. Negative elapsed
  values are clamped, so operating-system time synchronization cannot
  freeze the scheduler or subtract previously earned launch permits.
- A queued launch now schedules according to `(1-tokens)/launchPerSec`,
  bounded below at 20 ms, not a full `1/launchPerSec` regardless of how
  close the bucket already is to a permit. Example: at 2 launches/sec with
  0.90 tokens remaining, the nominal wake is 50 ms rather than 500 ms.
  Admission, retry and upstream quotas remain unchanged.
- Deterministic helper regression and 320-generation/100-competitor
  saturation tests pass; a broader 60/60 WorkBuddy route, auth and recovery
  suite passes. This is an improvement in **possible admission oversleep**,
  not a measured live-provider TTFT reduction.

### H. Bounded Effect SQLite semaphore in BOTH native drivers

- Upstream issues #29395 and #47566 describe indefinitely waiting application
  semaphores and cross-process SQLITE_BUSY after busy_timeout. SQLite's native
  busy timeout starts only after a statement enters SQLite; it does not limit
  a fiber waiting on the in-process connection semaphore.
- Another parallel lane implemented bounded acquisition in the synchronous
  Bun client, including a fix for premature permit release on statements.
  This follow-up completes parity in the worker-backed Bun adapter:
  `SqliteWorkerOptions.acquireTimeoutMs` (30s production default, bounded
  test override), interruptible wait with `Effect.timeoutOption`, explicit
  typed `SqlError`, and scope finalization **only after acquisition**.
- New isolated `test/database/sqlite-worker-permit.test.ts` holds a real
  worker-backed SQL transaction, asserts the blocked statement fails within
  its test deadline, and proves the timed-out waiter never executes inside
  or releases that transaction. A follower is admitted only after rollback.
  The synchronous + worker SQL isolation regression group passes 6/6;
  Core `bun run typecheck` also passes.
- This bounds a failure mode; it does not remove cross-process SQLite
  single-writer contention or mean every transaction is safe to replay.

### I. Synchronous Bun statement-permit lifetime, across-session transaction isolation

- An audit against upstream's concurrent process deadlock report
  (https://github.com/anomalyco/opencode/issues/29395) uncovered an
  independent **transaction correctness defect**: the synchronous Bun driver
  acquired its single SQLite permit using
  `semaphore.withPermits(1)(Effect.succeed(connection))`. That releases
  the permit immediately after returning the connection, **before** SQL
  execution. A concurrent Session statement could then enter another
  fiber's uncommitted BEGIN IMMEDIATE transaction; its write would be
  rolled back with the unrelated owner.
- `packages/core/src/database/sqlite.bun.ts` now uses the same
  scope-retained `transactionAcquirer` for ordinary statements and
  explicit transactions. `export` and `loadExtension` also own their
  scoped admission. A timeout/failure cannot install a release finalizer for
  a permit it did not acquire.
- `boundedSqlitePermit` is a shared finite internal-acquisition deadline
  (default 30 seconds, explicitly overridden in tests), separate from
  SQLite's native busy timeout. Its timeout error is typed `SqlError`;
  it never retries or replays the underlying SQL operation. The Node
  adapter also uses the shared helper. The independently developed Bun
  worker adapter now shares it too. The ENTIRE wait+timeout must execute
  inside `restore(...)` from `Effect.uninterruptibleMask`, not only
  `restore(semaphore.take(1))`. A new cancellation test proved the narrower
  restoration still hangs interrupted Sessions until the 30s deadline.
  Scope finalizer installation remains uninterruptible/atomic after acquire.
- A NEW in-memory synchronous Bun regression tests (1) a committed
  unrelated insert surviving an owner's rollback, (2) timely semaphore
  timeout with no wrongful release, and (3) **50 concurrent statements**
  waiting behind a rolled-back transaction with all 50 independent writes
  subsequently committed, and (4) immediate interruption of a queued
  statement with a clean subsequent writer. The file passes 4/4.
  `test/database/sqlite-worker-permit.test.ts` separately verifies
  bounded timeouts AND interruption against a real worker-backed connection;
  that file passes 2/2. The two acquisition suites together pass 6/6,
  and Core TypeScript passes.
- This closes the *local adapter permit lifetime* error. It does **not**
  eliminate SQLite's one-writer cross-process WAL constraint, support
  blindly replaying writes on SQLITE_BUSY, or guarantee live 100-Session
  tail latency. See also current upstream contention:
  https://github.com/anomalyco/opencode/issues/47566

### J. Real Bun SQLite execution-lane benchmark (CPU-heavy queries)

- A disposable file-backed SQL benchmark was added at
  `packages/core/script/sqlite-driver-concurrency-bench.ts`. It runs the
  **same** deterministic recursive aggregate queries through the corrected
  synchronous Bun SQL client and the existing experimental worker-backed Bun
  client. Measurements exclude client startup, alternate run order, repeat
  four times, and validate identical result sums.
- A 2-ms parent JS timer probes whether the Electron/server event loop can
  make forward progress while the SQLite CPU work executes. This distinction
  matters as much as raw DB queries/second for foreground UX.

  | Simultaneous queries | Synchronous elapsed median (ms) | Worker elapsed median (ms) | Synchronous parent timer ticks | Worker parent timer ticks |
  | ---: | ---: | ---: | ---: | ---: |
  | 1 | 23.656 | 29.079 | 0 | 11 |
  | 6 | 146.184 | 146.042 | 0 | 57.5 |
  | 25 | 611.569 | 674.882 | 0 | 260.5 |

- The worker is **not a universal query throughput improvement**: it
  introduces RPC overhead and can be slower for many small operations. But
  this trace demonstrates the important architectural distinction: long
  native SQL operations in the synchronous mode completely block the parent
  event loop; the worker permits cooperative Session/event/UI progress during
  the same database work.
- This does **not** authorize enabling the experimental
  `OPENFORK_SQLITE_ASYNC_WORKER` mode by default yet. Packaging, native
  extension/Drizzle parity, request cancellation and teardown, 1/3/6/25/100
  full Session-load tests, and p95/p99 memory/latency comparisons must pass
  first. A separate low-priority scan-only worker lane could reduce risk
  but requires a portable (Bun/Node) layer-selection design and packaging
  certification.

### K. Bound provider queue-wait age without repeating upstream generations

- `WorkBuddyEntitlementGovernor` already bounded the number of queued +
  active requests at 24, but an upstream stream that held one of the
  account-local concurrency leases forever could strand pending generations
  in `requesting` without an admission deadline.
- A queued request now has a **180-second default maximum admission wait**
  (configurable via `GovernorOptions.maxQueueWaitMs`, finite/clamped).
  Only requests that remain queued after the synchronous pump get a timer.
  Timer expiry removes the pending request, unregisters its abort handler,
  increments `queueTimeouts`, and rejects with a **retryable** 503
  `AdmissionError(kind="queue")`. There is no transport attempt, no forced
  stream interruption and no speculative generation replay.
- A successful permit grant clears its watchdog BEFORE launching a physical
  generation; abort cancels only the queued request, also clearing its
  watchdog. The explicit retry path clears the original logical generation
  key. Metrics now expose `oldestQueuedMs` and `queueTimeouts` as
  in-process, non-sensitive observability data.
- `test/plugin/workbuddy-queue-watchdog.test.ts` holds one deliberately
  uncompleted response body, verifies second request times out (45ms test
  override), no extra provider attempt, abort cleanup, same-key explicit
  retry, and timer cancellation after normal admission. The targeted
  WorkBuddy regression suite passes 47/47.
- This fixes **indefinite pending admission**; it does not solve upstream
  streams that never settle after admission. Stream-idleness requires a
  separate transport-specific policy respecting provider reasoning latency
  and cancellation contracts.

### L. Renderer child-store persistence lifecycle and memory retention

- `packages/app/src/context/global-sync/child-store.ts` created three
  persisted VCS/project/icon stores per directory using
  `runWithOwner(globalOwner, persisted(...))`; each persistence store
  registers a Solid `onCleanup` observer and write-flush callback on the
  global provider root. Directory eviction disposed its separate query root,
  but not these three global observers. Repeated project switching retained
  observer closures after their directory stores were gone.
- All three cache persistences now live in **one explicit per-directory
  Solid root**, with a separate `cacheDisposers` map. Eviction disposes both
  query root and persistence root, flushing any dirty persistence state.
  Global provider shutdown explicitly invokes every remaining disposer.
  Partial cache creation failures also dispose already-registered observers
  before a clean retry.
- The child-store module also now imports `pathKey` directly rather than
  reexporting it through the heavier global-sync utilities module; its
  `NormalizedProviderListResponse` and `QueryOptionsApi` references are
  type-only imports.
- Solid headless unit tests stub the real JSX-dependent platform provider,
  consistent with the existing persistence test harness, then verify:
  eviction and re-creation of exactly three observers per child; 120
  directory switches that create 360 total observers while retaining
  **at most 90 at any time** (30 live directories × 3); all 360 observers
  cleaned at global shutdown; and a failure halfway through persistence
  creation does not strand its already-created observers.
- `bun test --conditions=solid --preload ./happydom.ts
  src/context/global-sync/child-store.test.ts` passes **9/9**; paired
  persistence tests pass **15/15**; App `bun run typecheck` passes.
  These are deterministic retention-count guarantees, not a measured
  renderer heap/GC or Electron long-session RSS improvement.

### M. Single-worker/batch blocker parity and depth-bounded small-group ancestry

- The singleton nested-delegation blocker path previously read whole Session
  rows per pending child and performed its own ancestry walk, bypassing the
  lightweight batch `parentIDsMany` projection. Both APIs now use one shared
  `blockingRequestsBatch` resolver, retaining the 64-hop/cycle guards.
- Blockers are matched by candidate Session but replayed in their **original**
  permission-first/question-second order, including interleaved Sessions and
  distinct pending requests. An unrelated sibling's blocker is never admitted.
- `Session.ancestorParentIDsMany` adds a **read-only, parameterized,
  depth-fenced** SQLite recursive closure (25 seed IDs per page, 64 levels,
  `UNION ALL` + `DISTINCT` output). The production resolver uses it for
  **1–25 unique pending blocker Sessions** and preserves breadth-level WAL
  batching for larger sets. Each SQLite statement materializes no more than
  25 × 64 ancestor rows, even with cyclic parent IDs. Parent results are
  per-projection only; no stale cache and no Session mutation.
- The disposable SQL-shape bench now includes 1/10/25/50/100/400/1000 leaves,
  plus a cycle and a 70-level chain cutoff. In the latest 8-round fixture:
  single leaf: breadth 0.808 ms / bounded recursive 0.203 ms (~3.97×);
  25 leaves: 0.682 / 0.386 ms (~1.76×);
  100 leaves: 0.774 / 1.475 ms (recursive loses);
  400 leaves: 1.385 / 7.113 ms (recursive loses).
  A separate `UNION` deduplicating recursive variant was explored and is
  **benchmark-only**, not production: it outperformed at moderate sizes but
  lacks the critical 64-level safety bound.
- The mock control suite passes 24/24, including single-vs-batch blocker order,
  unrelated branch filtering, proof that 120 descendants cause **zero
  full-Session descendant reads**, and selection of the recursive path for
  small groups versus breadth-level reads for 120 blockers. The real
  AppRuntime/InstanceStore delegated-worker integration suite also passed,
  including empty, missing, repeated and 27+seed paged recursive requests.
- These are **query-shape and targeted integration** results, not genuine
  25/50/100 concurrent provider Session measurements. No live runtime refresh,
  production DB edits, speculative generation retries, or global event fanout
  policy changes were performed.

### N. Actual 25/50/100 concurrently held fake-provider Sessions and SQLite lane A/B

- Added explicit opt-in `packages/opencode/script/bench-session-concurrency.ts`:
  durable V1 `DelegatedWorker.start`, local fake HTTP SSE provider, real
  `InstanceStore` + WAL/SQLite storage, all N response tails held until **N
  actual provider requests have arrived**, then `waitMany` terminal checks.
  The 30-second bounded overlap barrier prevents counting mere starts as true
  concurrent generation. It exercises Session admission/transport/settlement,
  not remote-provider inference or Electron rendering. Each invocation creates
  a unique temporary database, project, XDG data/cache/config/state and
  temporary directory **before dynamically importing AppRuntime**.
- Safety lesson: an **early incomplete harness** scoped only the project,
  inadvertently initialized the existing development database and its sealer.
  The benchmark process was promptly terminated. No live process was
  intentionally restarted, but no assertion is made about whether the brief
  development-db startup performed incidental maintenance. All subsequent
  runs enforce a fail-closed root+database guard and disable background
  ChunkDB sealer; no user credentials or remote providers are used. Bun on
  Windows sometimes retains a lock on the generated temp DB at teardown;
  the benchmark reports deferred cleanup, and the standalone process exits.
- A 25-Session candidate initially observed 0 actual provider hits when its
  time-based hold opened too early: this is **not** a passing concurrency
  result. A request-count barrier replaced it and enabled the confirmed
  results below. Measurements are single samples on a shared busy machine,
  so do not treat differences below a few percent as reliable wins.

  | N | SQLite lane / log policy | Confirmed overlapping requests | Terminal complete | Total (ms) | Completed/s | Timer lag max (ms) |
  | --: | --- | --: | --: | --: | --: | --: |
  | 25 | sync / INFO, full prechange log | 25 | 25 | 2421.6 | 10.32 | 994.4 |
  | 50 | sync / INFO, full prechange log | 50 | 50 | 3542.3 | 14.11 | 1287.0 |
  | 100 | sync / INFO, full prechange log | 100 | 100 | 6923.3 | 14.44 | 2499.3 |
  | 100 | sync / ERROR, full prechange log | 100 | 100 | 6159.1 | 16.24 | 2119.3 |
  | 100 | sync / INFO, bounded log | 100 | 100 | 6606.5 | 15.14 | 2553.3 |
  | 25 | async-worker / ERROR, bounded log | 25 | 25 | 2266.2 | 11.03 | 58.4 |
  | 50 | async-worker / ERROR, bounded log | 50 | 50 | 4392.2 | 11.38 | 99.6 |
  | 100 | async-worker / ERROR, bounded log | 100 | 100 | 8842.9 | 11.31 | 118.4 |

- The comparable quiet-log **100 Session** A/B reduced the observed maximum
  sampled 25-ms timer delay **2119.3 → 118.4 ms (~17.9x)** with the worker
  adapter, at a throughput cost **16.24 → 11.31 completed/s (~30.4% lower)**.
  The EventLoop probe is a coarse single-run scheduling sample, not a
  robust multi-run p95/p99 latency histogram or a renderer FPS benchmark.
  The async worker's 25/50/100 successful Session completions are important
  runtime compatibility evidence, **not** a release qualification: native
  packaging, process teardown, mixed workloads, SQLite lock contention,
  permissions/question blockers, cancellation, and memory still need gating.
- The INFO Session-create diagnostic formerly flattened/logged the entire
  `Session.Info` (large permissions, metadata, model details) per worker.
  It now emits a bounded scalar operational projection (IDs, directory,
  model/agent, permission count); the actual created Session/event remains
  complete. INFO total time at 100 Session improved 6923.3 → 6606.5 ms
  in single runs, but noise precludes claiming a stable end-to-end win.
- **Next architectural hypothesis:** a dedicated async, read-only SQLite
  read/scan lane with the proven synchronous short-write/transaction lane.
  This seeks worker-like event-loop responsiveness *without* imposing async
  RPC overhead on small frequent writes. Preserve snapshot/WAL consistency,
  transaction-scope permits, cancellation deadlines, and bounded reader
  admission. This is a research direction, not implemented/activated.
- Package-wide TypeScript `tsgo --noEmit` remains red on shared-worktree
  diagnostics in smoke ACP, support-bundle CLI, OXP server, HTTP handlers,
  and compatibility tests. The recently modified Session/worker/benchmark
  files produced no diagnostics in the last check; rerun after concurrent
  lane edits before marking any repository-wide green gate.

### Outstanding true end-to-end acceptance

No source benchmark here establishes that model inference, foreground
time-to-first-token, cancellation completion, browser/Electron rendering,
SQLite multi-host writer fairness, or end-to-end 25/50/100 Session throughput
improved by the microbenchmark ratios. The running OXP binary was not refreshed
or restarted. Preserve existing foreground/admission safety constraints and
test with controlled remote-provider traffic before declaring the campaign
complete.