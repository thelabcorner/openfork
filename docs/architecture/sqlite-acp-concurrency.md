# OpenFork SQLite / ACP concurrency contract

Date: 2026-10-07. Status: source-runtime implementation verified; packaged Windows ACP worker rollout **not yet certified**.

> **October 15 source contract update:** The historical opt-in text below
> describes the original October 7 rollout. The authoritative
> `packages/core/src/database/database.ts#layerFromPath` now uses the existing
> worker by default for **file-backed primary and interactive reader** SQLite
> connections, with explicit diagnostic opt-outs
> `OPENFORK_SQLITE_ASYNC_PRIMARY=0` and
> `OPENFORK_SQLITE_ASYNC_READ_WORKER=0`. It preserves in-memory synchronous
> fixtures. This is not a claim of installed Desktop/ACP deployment. The earlier
> Bun 1.4.3 compiled-worker build and 1/3/6-process evidence are documented in
> `docs/research/sqlite-bun-worker-begin-retry-2026-10-11.md`; source-level
> packaging does not certify a running installed host. Source and tests outrank
> this historical narrative.

## Failure mechanism

OpenFork Desktop and independently launched JetBrains ACP processes can share the same file-backed SQLite WAL database. WAL has concurrent readers but one writer. Before the October remediation, Bun's primary native SQLite connection could synchronously wait 5 seconds on an opposing writer while the lock owner was a separate Effect graph in the *same JavaScript process*. The blocked main event loop could not schedule the owning transaction's commit. Increasing retries or native `busy_timeout` amplifies the stall rather than fixing it.

A 75 ms Bun native timeout plus idempotent bounded retry on the affected project paths restored the production ACP `initialize -> session/new -> session/close` lifecycle. That workaround remains the deployed/default baseline.

## Implemented corrective architecture

### Avoid writes during project admission

`packages/opencode/src/project/project.ts` uses the read-only SQLite lane to inspect durable project identity. Repeated `fromDirectory` calls for an unchanged project do not UPSERT the project, update nonexistent global-session matches, or issue a directory-link INSERT OR IGNORE. True registration still has an atomic upsert with a conflict WHERE guard, preserving user-owned name/icons/commands/initialization metadata. Global-session migration is read-gated without losing the late-migration case. Project discovery events are emitted on a real row change.

### Bounded contention

`packages/core/src/database/sqlite-busy.ts` classifies native busy primary and snapshot codes through bounded wrapper traversal, then supports bounded, jittered retries of *caller-supplied idempotent operations*. `SQLITE_BUSY_SNAPSHOT` must replay a **whole fresh transaction**; it is never repaired by replaying one statement on a stale snapshot. No generic automatic retry of arbitrary statements or high-level transactions is allowed. Foreground priority and short dedicated-connection maintenance slices are still required.

### Asynchronous native execution

`packages/core/src/database/sqlite-bun-worker.ts` is a dedicated Bun worker owning exactly one SQLite connection, with a bounded statement cache. `sqlite-bun-worker-client.ts` carries typed RPCs and tracks pending requests, worker termination, and scoped close. `sqlite.bun-worker.ts` implements Effect SQL connection permits, cancellation acknowledgements, transaction rollback, blob/bigint handling, and error classification without blocking the parent event loop. Worker native execution is synchronous **inside the worker only**.

The new path is currently selected by setting `OPENFORK_SQLITE_ASYNC_WORKER=1` before launching the Bun runtime. **Absent the flag, `sqlite.bun.ts` deliberately keeps the existing driver.** `packages/opencode/script/build.ts` explicitly includes the new worker entrypoint for Bun standalone compilation.

## Tests and limits

- `test/database/sqlite-contention-policy.test.ts`: native error classes and safe retries.
- `test/database/sqlite-bun-worker.test.ts`: exact bytes, bigints, Effect transaction isolation, parent event-loop progress under a 5-second native busy policy and a lock released by a parent timer.
- `test/database/sqlite-bun-service.test.ts`: real Core Database layer, schema migration, WAL, query-only reader and bounded native-lock retries.
- `test/database/sqlite-bun-peers.test.ts`: 6 independent Bun processes, 20 writes each, one shared WAL file, no duplicate/missing records.
- `test/database/sqlite-bun-standalone.test.ts`: Windows-only packaged executable certification gate. The standalone executable test still requires a successful CI/local execution before the new driver can be enabled by default.
- `packages/opencode/test/project/project-noop-admission.test.ts`: no new WAL commits for an unchanged project, preservation of edited metadata.
- `packages/opencode/test/project/project-acp-busy.test.ts`: real secondary connection and delayed release during project admission.
- `packages/opencode/script/smoke-acp-sqlite-worker.ts`: real Bun source-mode CLI host with the async worker, isolated temporary database, protocol-only NDJSON, and `initialize -> session/new -> session/close`. On October 7 it passed for the OpenFork checkout (~7.8s) and PresGen v2 checkout (~9.6s); this is **not** certification of the compiled JetBrains binary.

**Not yet established:** packaging/launcher certification with the new driver enabled; production-scale memory and startup measurements for 1/3/6 ACP and Desktop hosts; actual JetBrains GUI-launched `initialize/session/new/session/close` with the opt-in worker; cancellation/worker-crash and concurrent migration stress in a packaged binary; process-wide ownership consolidation.

## Release gate and future ownership

1. Keep default native driver and existing installed JetBrains ACP paths unchanged while the worker is under verification. Do not replace live executable files or production databases to claim success.
2. Run the Windows packaged executable test, then a real `openfork.exe acp` protocol-only NDJSON lifecycle on an isolated database; repeat against the production database with no destructive maintenance.
3. Measure cold start, `session/new` p50/p95/p99, lock-conflict count, primary event-loop delay, worker RSS, and session correctness at 1, 3, and at least 6 concurrent IDE/desktop hosts.
4. After worker acceptance, consider one user-scoped OpenFork runtime endpoint for Desktop and ACP adapters instead of instantiating full independent runtime/service/maintenance graphs. Keep authorization, version/storage-epoch handshake, graceful fallback, and crash recovery explicit. This is a separate architecture migration, not something the worker alone proves.

## Strict invariants

- No workspace runtime or model-provider bootstrap for Tier-0/Tier-1 durable reads.
- No main-thread blocking on native WAL write contention when async storage is enabled.
- One pending connection permit through transaction completion or acknowledged rollback; no releasing permits when a request merely enters the worker queue.
- No blanket replay after partial side effects, and no timeout escalation masking stale snapshots.
- Retry solely the underlying failed `BEGIN` for arbitrary IMMEDIATE
  transactions, **not** the encompassing `db.transaction` callback.
  A transaction-body error or ambiguous COMMIT must not silently repeat
  event admission/projector writes, Session ownership generations, DDL or
  identity migration. Atomic idempotent single-statement CAS is a
  separate, explicitly reviewed retry category; the October 15 durable
  event red/green regression demonstrates the distinction.
- No default-driver switch or JetBrains installation mutation before real packaged-ACP proof.
- No destructive Git reset/clean/stash of unrelated worktree changes.

## October 15 stability-over-throughput maintenance and recovery addendum

For the active source implementation, see
[`sqlite-20261015-admission-storage-oxp-index.md`](../research/sqlite-20261015-admission-storage-oxp-index.md).

- All primary, control, and maintenance **writer** connections disable native
  WAL auto-checkpoint on COMMIT. One file-local elected low-priority worker
  performs PASSIVE checkpoints; the primary connection has neither startup
  nor close-finalizer TRUNCATE checkpoint.
- The checkpoint owner observes WAL size/mtime at 30-second intervals and
  increases eligibility to once per minute for WAL files at least 64 MiB,
  unless the log is demonstrably unchanged since complete checkpointing or
  checkpoint progress is stalled by a pinned reader. Normal cadence remains
  five minutes. It cannot infer pending frames from WAL file size alone.
- A checkpoint result carries numeric busy/log/checkpointed/pending metadata.
  Logical progress detection must distinguish a recycled WAL log from a pinned
  reader. Checkpoint maintenance uses an isolated async SQLite worker.
- Cross-process filesystem maintenance leases protect a confirmed live owner
  against heartbeat delay and conservatively detect provably reused PIDs.
  If PID identity is ambiguous, maintenance must fail closed.
- Orphan-event cleanup starts after foreground admission, uses bounded
  per-payload IMMEDIATE transactions and a **whole-page quiet wait budget**:
  under unrelenting foreground writes it releases its maintenance lock rather
  than waiting forever for a quiet interval. It resumes at the next cooldown.
- Scheduled Task recovery never replays unknown external effects; run
  execution and settlement are fenced by exact lease ID, process owner, attempt,
  and scheduled instant. Dead foreign-process leases may be reconciled in
  bounded maintenance pages, but a sibling same-process graph's live lease must
  never be swept merely because it shares a process-level owner string.

**Required production evidence remains open:** copied historical multi-GiB
database; actual packaged 1/3/6 desktop/ACP hosts; crash-injection at
tool-effect, BEGIN, COMMIT/ACK, checkpoint, and recovery boundaries; Session,
Goal, Swarm, Scheduled Task coordination; and measured p95/p99 admission and
user-facing latency. A green unit test is not a deployed remediation.
