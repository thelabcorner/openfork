# Production Sealing Architecture — Scheduling, Cooling, Crash-Consistency, Backpressure, Reclaim, Metrics

**Author:** seal-v2, swarm `chunkdb-ideation` (architecture-planning phase)
**Lane:** Sealing strategy & scheduler (task `task_be6bdc3b15e342ffa619e67a714799b6`)
**Status:** DESIGN PROPOSAL — opinionated, concrete decisions + SQL/migration shapes + tradeoffs. No implementation code.
**Grounded in:** `packages/core/src/database/{chunk-sealer,json-codec,database}.ts`, `packages/opencode/bench/{chunkdb-bench,chunkdb-seal-parallel,chunkdb-readlatency}.ts`, and the settled chapters `architecture/{storage,readpath,migration}.md` + `PLAN.md`.
**Parent constraint:** blackboard `architecture/read-latency-first` — READ LATENCY IS THE CRITICAL RESOURCE; seal/compression/backfill may be async, slow, background, generous CPU/time budget **as long as it never affects the user**.

---

## 0. Scope and relationship to the OSES evolution

This proposal designs the **production cold-row sealer** — the fork's OCDB-framing of `event.data` (the only frame producer today, per `json-codec.ts` identity `toDriver`). It is the **v1 ship** (PLAN.md Phase 2/3 cutover experiment). The later OSES value-table promotion (`event_value` + segments, storage.md §6) reuses the *same scheduler, connection, crash-journal, and backpressure machinery* — only the BUILD/COMMIT payload changes (promote to `event_value` + write a segment instead of writing a frame blob). I therefore design the **scheduler/lifecycle shell** to be payload-agnostic and call out the one seam where the OSES sealer differs.

The `ocdb_seal` journal in this proposal is the **crash-consistency anchor + audit ledger** for the cold-row sealer. In the OSES phase it is superseded by `oses_seal` (same shape, additive columns) — §5 notes the forward-compat path.

---

## 1. Scheduling model (production decision)

**Decision: a forked background fiber, mirroring the existing WAL-checkpoint loop in `database.ts`, that runs bounded sealing passes on a periodic `Schedule.spaced` base interval, accelerated by an idle-window trigger, and gated at every batch by a read-pressure signal. The sealer uses its OWN persistent dedicated connection — never the shared `Database.Service` client.**

### 1.1 Why not the alternatives (the weighing)

| Option | Verdict | Reason |
|---|---|---|
| **Idle-trigger only** (seal when process idle) | Insufficient alone | Idle detection is heuristic; a perpetually-busy long session would never seal, letting cold bytes grow unbounded. Needs a guaranteed-progress backstop. |
| **Forked background Effect** (mirror WAL-checkpoint loop) | **ADOPTED as the shell** | `database.ts` already does `Effect.forkScoped(db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.ignore, Effect.repeat(Schedule.spaced(Duration.minutes(5)))))` — proven, non-blocking, fire-and-forget. The sealer is the same shape, just with bounded work + read-pressure gating per batch. |
| **Periodic `Schedule.spaced` only** | Insufficient alone | A fixed interval (e.g. 10 min) guarantees progress but wastes CPU during active use and under-seals during long idle stretches. Combine with idle-trigger. |
| **Event-count threshold only** | Insufficient alone | Good as a *secondary* accelerator (seal sooner when many cold bytes accumulate) but cannot be the sole trigger (count maintenance is itself work; threshold tuning is fragile). |

**Adopted hybrid:** periodic base interval **+** idle-window accelerator **+** read-pressure gate **+** (optional) event-count secondary trigger.

### 1.2 The loop (conceptual Effect shape)

```text
SEAL_INTERVAL        = 10 min   [PROPOSED, D5/D8-calibrated]   -- base periodic cadence
IDLE_TRIGGER_MS      = 30 s     [PROPOSED]                     -- idle (no interactive op) this long -> pass now
READ_PRESSURE_WINDOW = 5 s      -- rolling read-path p99 sample (readpath.md §8.2)
MAX_ROWS_PER_PASS    = 5_000    -- pass cannot run forever (prototype already caps)
BATCH_SIZE           = 128      -- rows per WAL tx (prototype)

Sealer.loop (forked at Database-layer init, forkScoped so it dies with the scope):
  repeat:
    wait until (periodic interval elapsed) OR (idle-window detected) OR (event-count threshold hit)
    runPass()                       -- see §3/§5: eligibility -> build -> commit batches
    PASSIVE checkpoint on sealer conn (§7)
    if freed > RECLAIM_THRESHOLD and deep-idle and read-pressure normal:
        incremental_vacuum(pages)   -- §7
  gated by read-pressure at every batch inside runPass (§4)
```

The fork lives in the **Database layer** (or a dedicated `Sealer` layer provided alongside it), exactly where the WAL-checkpoint fiber already lives — so the two maintenance fibers are co-located and share the same lifecycle/scope discipline. `Effect.ignore` wraps the loop (a thrown error in one pass must not kill the fiber — it logs + retries next interval; matches the checkpoint loop's `Effect.ignore`).

### 1.3 Idle-window detection

The process already has read/write activity signals (the adapter's codec-layer counters, readpath.md §8.2). "Idle" = no interactive read/write op completed in the last `IDLE_TRIGGER_MS`. The idle trigger makes sealing happen **exactly when it can't affect the user** — the purest expression of read-latency-first. The periodic interval is the safety net for systems that are never idle.

---

## 2. Connection model — dedicated, not shared

**Decision: the sealer runs on its OWN persistent dedicated connection, built via the same `sqliteLayer` factory as the shared client, with its own native connection + own single-permit semaphore. It is a THIRD connection class, distinct from (a) the shared `Database.Service` live-query client and (b) the ephemeral `withBackfillDb` connections used by FTS backfill / migration rebuild.**

### 2.1 Why (the adversarial B3 finding, storage.md §6)

The prototype's `ChunkSealer` runs on the **shared** `Database.Service` client. That client is `Semaphore(1)`-serialized with all live queries. A multi-MB frame commit on the shared client would **stall interactive writes/reads for the commit duration** (up to `busy_timeout = 5000 ms`). The dedicated connection decouples the sealer from the live-query semaphore: live queries proceed on the shared client; the sealer's writes are serialized only by SQLite's own WAL write lock (brief, and handled by `busy_timeout` + BACKOFF). This is the proven in-codebase fix — FTS backfill already uses `withBackfillDb` for exactly this reason.

### 2.2 Three connection classes (coexistence)

| Connection | Owner | Lifetime | Role |
|---|---|---|---|
| Shared `Database.Service` | live queries | process | hot reads/writes, projector, sync — **never the sealer** |
| `withBackfillDb` (ephemeral) | FTS backfill, migration rebuild | per-body | bulk read-only source / new-file sink |
| **Sealer (dedicated, persistent)** | **the sealer fiber** | **process** | **eligibility SELECT + frame UPDATE + ocdb_seal UPSERT** |

All three open the same file; SQLite serializes writers via the WAL lock. Each sets `busy_timeout = 5000` and **BACKOFFs + re-reads on `SQLITE_BUSY`** (storage.md §6) rather than blocking the others. The sealer's PRAGMAs mirror `withBackfillDb` (`WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`); **migrations are skipped** (already applied by the Database layer).

### 2.3 Forward-compat seam

The OSES sealer (Phase 2/3) uses the *same* dedicated connection + scheduler; only `runPass`'s BUILD/COMMIT body changes (promote to `event_value` + write segment + `oses_seal` instead of `UPDATE event SET data=frame`). The connection/scheduler/backpressure shell is reused verbatim.

---

## 3. Cooling window & eligibility refinement

**Decision: keep the 48h write-cooling as the base, but refine eligibility to a three-axis predicate — write-cold AND read-warm-excluded AND not-currently-active — plus idempotency skip via the journal. The 48h constant is [PROPOSED] and is the D5 calibration target.**

### 3.1 The refined eligibility predicate

```sql
-- on the SEALER dedicated connection
SELECT e.id, e.data
FROM event e
JOIN event_sequence es ON es.aggregate_id = e.aggregate_id
LEFT JOIN session se        ON se.id = e.aggregate_id
LEFT JOIN event_aggregate ea ON ea.aggregate_id = e.aggregate_id   -- carries last_read_ms (readpath.md §6.2)
LEFT JOIN ocdb_seal os      ON os.table_name = 'event' AND os.row_id = e.id  -- idempotency skip
WHERE e.seq <= es.seq                                  -- frontier rule (settled; sync fence authority)
  AND es.owner_id IS NULL                              -- not claimed/running
  AND (se.time_updated IS NULL OR se.time_updated <= :write_cutoff)   -- write-cold (48h [PROPOSED])
  AND (ea.last_read_ms IS NULL OR ea.last_read_ms <= :read_cutoff)    -- read-warm exclusion (1-2h [PROPOSED])
  AND e.aggregate_id NOT IN (/* in-memory active_sessions set */)     -- app-open sessions excluded absolutely
  AND typeof(e.data) = 'text'                          -- idempotent: skip already-framed (blob) rows
  AND length(e.data) >= 4096                           -- settled-size threshold (json-codec THRESHOLD)
  AND os.row_id IS NULL                               -- skip already-journaled (belt-and-suspenders)
ORDER BY e.aggregate_id, e.seq
LIMIT :batch_size;
```

### 3.2 The three axes

1. **Write-cold (existing 48h):** `session.time_updated <= now - 48h`. Keeps actively-written sessions hot. [PROPOSED] — D5 calibrates.
2. **Read-warm exclusion (NEW, readpath.md §6.3):** a session re-read in the last `READ_WARM_WINDOW` (1–2h [PROPOSED]) stays raw. Implemented via `event_aggregate.last_read_ms` (touched once per history-open, gated to seal-candidate aggregates so the hot write path stays 100% clean — readpath.md §6.2) **plus an in-memory `active_sessions` mirror** consulted synchronously by the sealer immediately before commit (closes the TOCTOU: sealer reads `last_read_ms` → user opens session → sealer seals anyway). Persisted `last_read_ms` covers crash/multi-process continuity.
3. **Active-session exclusion (NEW):** the app's currently-open sessions are excluded **absolutely** regardless of window — the renderer reads the projection, but a session-open durable replay reads the event store (readpath.md §0), so an open session's history must stay raw.

### 3.3 Re-touched / partial aggregates (idempotency)

- **Re-touched aggregate:** if a sealed aggregate gets a new append, the frontier moves (`event_sequence.seq` increases, `owner_id` set during the append). New events are hot TEXT (seq > sealed frontier / owner active) and are excluded by the frontier rule. Already-framed cold rows stay framed — the sealer never un-frames. The next pass continues sealing the remaining cold TEXT rows. **No special handling needed.**
- **Partial aggregate:** the sealer processes row-by-row, so an aggregate sealed in chunks across passes is naturally consistent. The `ORDER BY aggregate_id, seq` makes a pass make monotonic progress within an aggregate.
- **Idempotency:** `compressText` is deterministic (brotli q1, fixed params). Re-sealing the same row yields the same frame; the `ocdb_seal` UPSERT is `ON CONFLICT DO UPDATE` (idempotent). The `LEFT JOIN ocdb_seal` skip means a resumed pass never re-compresses an already-journaled row (saves CPU after a crash). The `typeof(e.data)='text'` clause is the primary idempotency guard (framed rows are blobs); the journal join is belt-and-suspenders + audit.

### 3.4 Index (carried from prototype, load-bearing)

```sql
CREATE INDEX IF NOT EXISTS idx_event_seal_candidates
  ON event (aggregate_id, seq)
  WHERE typeof(data) = 'text' AND length(data) >= 4096;
```
Measured 68× faster eligibility (8.9s → 0.13s). Inert for stock reads (only the sealer's WHERE uses it). The sealer layer creates it idempotently at init.

---

## 4. Backpressure — concretizing yield-between-batches for production

**Decision: the prototype's `Effect.yieldNow` between batches is concretized into a four-layer backpressure stack: (1) per-batch yield, (2) intra-batch yield for jumbo rows, (3) read-pressure gate before every batch, (4) bounded pass. The dominant user-visible risk is BUILD-phase CPU contention with the model stream (readpath.md §8.1, G11), so compression is OFFLOADED to a worker pool.**

### 4.1 Read-pressure gate (the primary control, readpath.md §8.2)

`READ_PRESSURE` = rolling read-path p99 over the last ~5s, sampled from the adapter's codec-layer counters (frames decoded + op p99). The sealer consults it **before each BUILD batch** (not only before commit — G11 measures the BUILD path too):

```text
READ_PRESSURE ladder (budget = §1.3 op budgets or 2× idle-baseline p99, whichever lower):
  normal   p99 < 0.5× budget   -> full batch, normal pacing
  slow     p99 ≥ 0.5× budget   -> halve batch size, double inter-batch delay
  suspend  p99 ≥ budget        -> finish current batch, skip next N passes
  resume   p99 < 0.5× budget for 30s -> back to normal
```

This is the **shared** pacing mechanism for sealer AND migration backfill (migration.md §3.2/§8.3). G11's budget is **< 1% read/render p99 regression + < 1% model-token inter-arrival** during a full-throttle seal (readpath.md §8.1) — the honest expression of "never affects the user."

### 4.2 Yield discipline

1. **Per-batch yield:** `Effect.yieldNow` after each 128-row batch (prototype already does this) — lets the event loop service interactive fibers.
2. **Intra-batch yield for jumbo:** if a single row's compress exceeds ~YIELD_CPU_BUDGET (e.g. 50ms) or the row is ≥ 1 MiB, `yieldNow` after that row. Prevents one giant row from monopolizing the worker/core.
3. **Bounded pass:** `MAX_ROWS_PER_PASS = 5_000` cap (prototype) — a single pass can't run forever and starve; remaining rows are picked up next interval.
4. **Byte-volume cap per tx:** see §5.2 (bounds commit latency for G8).

### 4.3 BUILD offloaded to a worker pool (addresses G11 CPU contention)

The benchmark `chunkdb-seal-parallel.ts` proves compression is CPU-bound and parallelizable: it distributes eligibility-selected rows to `worker_threads`, keeps all SQLite writes on the main thread (WAL = single writer), and byte-balances chunks (~16 MiB/chunk) so no worker stalls the batch. **Production decision:** the sealer's BUILD phase (parse + `compressText`) runs on a `worker_threads` pool (size = `availableParallelism()`, capped at 16, like the benchmark); the COMMIT phase (SQLite UPDATE + `ocdb_seal` UPSERT) stays on the dedicated connection. This directly attacks the G11 dominant risk — the model stream and interactive render keep their cores while sealing saturates the others. Fallback: if workers are unavailable (packaged runtime quirk), run BUILD single-threaded on the main thread (still gated by read-pressure).

Tradeoff: worker-pool adds serialization of rows to workers + a safety-timeout (benchmark uses 60s unref'd timeout to avoid hangs). Accepted — the G11 win is worth it, and the fallback keeps it robust.

---

## 5. Crash consistency & resumability via `ocdb_seal` journal

**Decision: each batch = ONE WAL transaction (frame UPDATE + `ocdb_seal` UPSERT atomic). The journal is the crash-consistency anchor (atomic with the frame) AND the idempotency/resume ledger. Partial-batch recovery is provided by SQLite's atomic tx; jumbo rows get their own single-row tx to bound commit latency (G8).**

### 5.1 Journal shape (formalized from prototype)

```sql
CREATE TABLE IF NOT EXISTS ocdb_seal (
  table_name   TEXT    NOT NULL,
  row_id       TEXT    NOT NULL,
  raw_bytes    INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL,
  time_sealed  INTEGER NOT NULL,
  codec        INTEGER NOT NULL DEFAULT 2,   -- 1=zstd 2=brotli 3=deflate (audit; json-codec registry)
  pass_id      TEXT,                          -- groups a pass's rows (resume/metrics)
  PRIMARY KEY (table_name, row_id)
);
```
Additive vs the prototype: `codec` (audit which codec sealed each row — needed if we flip zstd l1 per O3) and `pass_id` (groups rows per pass for resume/metrics). Both are cheap and backward-compatible.

### 5.2 Atomic batch + partial-batch recovery

```text
for each batch (≤ BATCH_SIZE rows, byte-volume ≤ BATCH_BYTE_CAP [PROPOSED ~4-8 MiB]):
  BEGIN IMMEDIATE on sealer conn
    for each candidate:
      frame = compressText(row.data)         -- BUILD (worker pool, off-main)
      if typeof frame == 'string': continue   -- worth-it guard failed -> leave raw
      UPDATE event SET data = frame WHERE id = row.id
      UPSERT ocdb_seal (table_name='event', row_id, raw_bytes, stored_bytes, time_sealed, codec, pass_id)
  COMMIT
  on SQLITE_BUSY: ROLLBACK, BACKOFF, re-read frontier, retry
```
- **Crash mid-batch:** the WAL tx rolls back atomically → neither `event` nor `ocdb_seal` is updated → on resume the row is still TEXT and re-sealed (idempotent). The journal can never drift from actually-sealed rows. This is the prototype's guarantee, kept.
- **Jumbo-row commit latency (G8 < 10ms):** a 24 MB row's frame commit may exceed 10ms. **Decision:** any single row whose `raw_bytes ≥ JUMBO_TX_THRESHOLD` (e.g. 1 MiB [PROPOSED]) is committed in its **own single-row tx** (not batched), bounding each commit's I/O. Rows below the threshold batch normally. This keeps G8 satisfiable for the common case; the jumbo class is rare (the 24 MB / 32.8 MB tails) and is the OSES jumbo-policy concern anyway (storage.md §5).
- **Resume:** the loop is stateless across restarts — eligibility re-selects from scratch, the `typeof='text'` + `LEFT JOIN ocdb_seal` clauses skip done work, and `pass_id` lets metrics attribute rows to a pass. No separate watermark table is needed for the cold-row sealer (unlike the migration rebuild's `oses_migration` — that is a different, bulk job).

### 5.3 Forward-compat: `ocdb_seal` → `oses_seal`

In the OSES phase the journal becomes `oses_seal` (storage.md §6: `INSERT oses_seal journal rows` inside the segment commit tx). The shape is the same atomic-anchor role; additive columns (`segment_id`, `ordinal`) record segment sealing. The scheduler/connection/backpressure shell is reused; only the COMMIT body and journal table name change. **Open question §9.5** covers whether to design `ocdb_seal` to upgrade into `oses_seal` or treat them as separate lifecycles.

---

## 6. When to VACUUM / compact / reclaim (WAL coordination)

**Decision: the sealer reduces LOGICAL bytes; true file shrink is a separate, idle-gated concern. Use `auto_vacuum=INCREMENTAL` (born-fresh OSES files) + periodic `PRAGMA incremental_vacuum` during idle windows; NEVER a full online `VACUUM` during active use (blocks, violates read-latency-first). Full shrink is deferred to the migration rebuild (builds a compact new file) or a `VACUUM INTO` + swap during a deep-idle maintenance window. WAL is checkpointed PASSIVE after each pass, TRUNCATE only during deep idle.**

### 6.1 Why not a full VACUUM online

A full `VACUUM` at 18 GB takes minutes and obtains a write lock that blocks live queries — a direct read-latency-first violation (G11). migration.md §7 already establishes "No VACUUM over 18 GB" for the reclaim path; the same logic applies to the live sealer. The sealer's `UPDATE event SET data=frame` frees pages *logically*; SQLite reuses them for future writes (the file stops growing as fast) even without a shrink.

### 6.2 auto_vacuum policy

| File origin | auto_vacuum | Reclaim mechanism |
|---|---|---|
| **Born-fresh OSES file** (migration rebuild, storage.md §4.4 / migration.md §3.1) | `INCREMENTAL` set at file creation (zero cost — no VACUUM needed to flip) | `PRAGMA incremental_vacuum(N)` during idle windows reclaims free pages from the file tail |
| **Existing legacy file** (auto_vacuum=0 today) | left as-is (flipping requires a one-time blocking VACUUM) | freed space reused internally; true shrink deferred to the migration rebuild or a scheduled `VACUUM INTO` |

`incremental_vacuum` only reclaims free pages at the **end** of the file, so it is most effective right after a large contiguous seal pass. It is non-blocking (brief lock) and safe to call repeatedly. For legacy `auto_vacuum=0`, `incremental_vacuum` is a no-op — accepted; the migration rebuild is the real shrink path (it builds a compact new file and swaps).

### 6.3 WAL coordination

- The sealer's writes go to the WAL (single writer). The WAL must be checkpointed so it doesn't grow unbounded.
- **After each pass:** `PRAGMA wal_checkpoint(PASSIVE)` on the **sealer** connection (non-blocking; safe to call even under contention). This is distinct from the shared client's existing 5-min `TRUNCATE` loop (database.ts) — keeping the sealer's checkpoint on its own connection avoids contending with live queries for the checkpoint lock.
- **Deep-idle only:** `PRAGMA wal_checkpoint(TRUNCATE)` (actually truncates the WAL file) — gated by read-pressure-normal + idle window, because TRUNCATE briefly blocks writers.
- **`incremental_vacuum`** runs only when `freed_bytes_this_pass > RECLAIM_THRESHOLD` (e.g. 64 MiB [PROPOSED]) AND deep-idle AND read-pressure normal — never during active use.

### 6.4 Full shrink path (deferred)

When a true file shrink is wanted on a legacy DB, use the migration-style **`VACUUM INTO` + swap** (migration.md §6 Mode B): build a compact copy on a scratch volume during idle, resumable byte-copy at swap time, then rename. This avoids blocking the live DB. This is a maintenance-window operation, not part of the per-pass sealer loop.

---

## 7. Metrics to emit

**Decision: emit a `Sealer` metrics group (counters + gauges + a per-pass histogram) via the process metrics sink, sampled each pass. These feed G8 (sealer commit p99 < 10ms) and G11 (< 1% read-p99 regression during full-throttle seal).**

| Metric | Type | Meaning |
|---|---|---|
| `sealer_passes_total` | counter | passes started |
| `sealer_rows_sealed_total` | counter | rows framed (excludes worth-it skips) |
| `sealer_bytes_raw_total` | counter | sum of `raw_bytes` sealed |
| `sealer_bytes_stored_total` | counter | sum of `stored_bytes` sealed → **compression ratio = stored/raw** |
| `sealer_rows_skipped_worthit_total` | counter | rows where framing gained nothing (left raw) |
| `sealer_rows_skipped_ineligible_total` | counter | rows filtered by eligibility (audit) |
| `sealer_pass_duration_ms` | histogram | per-pass wall time |
| `sealer_commit_p99_ms` | gauge/histogram | **G8** — per-batch commit latency (must stay < 10ms; jumbo single-row tx keeps it there) |
| `sealer_batch_count_total` | counter | batches committed |
| `sealer_journal_rows` | gauge | current `ocdb_seal` row count (resume/idempotency state) |
| `sealer_eligible_rows` | gauge | current eligible count (drives event-count trigger) |
| `sealer_crash_resume_total` | counter | passes that found pre-existing journal rows (resume after crash/restart) |
| `sealer_backpressure_suspends_total` | counter | **G11** — passes fully suspended by read-pressure |
| `sealer_backpressure_slow_total` | counter | batches throttled to half-size |
| `sealer_busy_retries_total` | counter | `SQLITE_BUSY` BACKOFF retries |
| `sealer_read_pressure_p99` | gauge | the READ_PRESSURE signal itself (for G11 diagnosis) |
| `sealer_incremental_vacuum_pages_total` | counter | pages reclaimed (§6.2) |
| `sealer_wal_checkpoints_total` | counter | PASSIVE/TRUNCATE checkpoints issued |
| `sealer_idle_windows_total` | counter | idle-triggered passes (vs periodic) |
| `sealer_worker_pool_size` | gauge | active compression workers (§4.3) |

Per-pass structured log line (debug): `{pass_id, rows, raw_bytes, stored_bytes, ratio, duration_ms, batches, vacuum_pages, backpressure}`.

---

## 8. Headline decisions (for the coordinator)

1. **Scheduler = forked background fiber** mirroring the WAL-checkpoint loop: periodic `Schedule.spaced(10 min)` base + idle-window accelerator (30s idle → pass now) + read-pressure gate + optional event-count trigger. `Effect.ignore` wraps it so one bad pass can't kill the fiber.
2. **Dedicated persistent connection** (third class, alongside shared client + ephemeral `withBackfillDb`): the sealer NEVER touches the shared `Database.Service` client (avoids Semaphore(1) stall). Same `sqliteLayer` factory, own semaphore, migrations skipped, `busy_timeout=5000` + BACKOFF.
3. **Eligibility = three-axis:** write-cold (48h [PROPOSED]) AND read-warm-excluded (`last_read_ms` + in-memory `active_sessions`, 1–2h [PROPOSED]) AND not-currently-active. Idempotency via `typeof='text'` + `LEFT JOIN ocdb_seal`. Re-touched/partial aggregates need no special handling (frontier rule + row-by-row).
4. **Backpressure = 4 layers:** per-batch `yieldNow` + intra-batch jumbo yield + read-pressure ladder (normal/slow/suspend/resume) consulted before every BUILD batch + bounded pass (5k rows). **BUILD (compress) offloaded to a `worker_threads` pool** to kill the G11 CPU-contention risk with the model stream; COMMIT stays single-writer on the dedicated connection.
5. **Crash-consistency:** one WAL tx per batch (frame UPDATE + `ocdb_seal` UPSERT atomic); journal is anchor + idempotency ledger; jumbo rows (≥1 MiB) get their own single-row tx to hold G8 < 10ms commit; resume is stateless (re-select + skip framed/journaled).
6. **Reclaim:** `auto_vacuum=INCREMENTAL` on born-fresh OSES files + idle-gated `incremental_vacuum`; **no online full VACUUM** (blocks, violates read-latency-first); true shrink deferred to migration rebuild or `VACUUM INTO`+swap maintenance window. WAL checkpointed PASSIVE after each pass, TRUNCATE only deep-idle.
7. **Metrics:** 18-signal `Sealer` group feeding G8 + G11, plus compression-ratio and resume counters.

---

## 9. Open questions (ranked, for the coordinator)

1. **Cooling-window calibration (D5).** Is 48h write-cooling + 1–2h read-warm the right pair? D5's corpus scan must calibrate both against real session re-access patterns. Also: how is the in-memory `active_sessions` set populated/maintained as the app opens/closes sessions, and is `event_aggregate.last_read_ms` touched granularly enough (readpath.md §6.2 gates it to seal-candidate aggregates — does that gate miss the first open of a non-candidate that later becomes a candidate)?
2. **Jumbo-row commit latency vs G8.** A 24 MB row's frame commit may exceed the 10 ms G8 budget. Decision needed: (a) commit jumbo rows (≥1 MiB) in their own single-row tx to bound latency (adopted here as provisional), (b) exclude jumbo from the cold-row sealer and leave to OSES jumbo policy, or (c) waive G8 for the jumbo class. Needs measurement of real commit latency at the 24 MB / 32.8 MB tail.
3. **Multi-process sealer lease.** The main app process owns the sealer fiber. But a CLI `opencode db` command or a second app instance could also try to seal the same file. Is the WAL write lock + frontier rule sufficient, or do we need an explicit single-writer lease (e.g. a `storage_meta` row or OS file lock) to prevent two sealers racing? Interacts with migration.md's cross-process Windows file-lock fence.
4. **auto_vacuum flip for legacy DBs.** Born-fresh OSES files get `INCREMENTAL` for free; existing legacy DBs (auto_vacuum=0) need a one-time blocking VACUUM to flip. Should we (a) accept no online shrink for legacy and rely on the migration rebuild, (b) flip during a maintenance window, or (c) ship INCREMENTAL only for new files and leave legacy as-is? Tradeoff: online shrink vs a one-time blocking op.
5. **`ocdb_seal` → `oses_seal` boundary (forward-compat).** This cold-row sealer is v1; OSES value-table promotion is later. Should `ocdb_seal` be designed to upgrade into `oses_seal` (same shape, additive columns, reused resume/crash logic), or are they separate lifecycles (the OSES sealer writes `oses_seal` from scratch and ignores `ocdb_seal`)? Affects whether v1-sealed rows need re-processing at the OSES cutover (the migration rebuild re-reads raw TEXT anyway, so likely separate — but worth a explicit call).

---

## 10. What this does NOT change (constraints honored)

- **Hot path untouched:** `commitDurableEvent` stays identity, fast, ref-free, hash-free, compress-free (contract.md §6 / storage.md §3 — [LOCKED]). The sealer never runs inside a hot write txn.
- **Read path:** a sealed cold row is read via `decompressFrame` (json-codec `fromDriver`, fail-closed) — zero hot-path cost; interactively-read history stays raw via the cooling/recency rules (readpath.md §6), so point reads rarely decompress.
- **Sync fence:** `event_sequence` is the frontier authority, byte-identical; the sealer only touches `seq <= es.seq AND owner_id IS NULL`.
- **Three legacy states:** pristine TEXT / OCDB-framed / OSES read through one row-level branch (storage.md §8) — the sealer only *produces* OCDB-framed rows; it never breaks the branch.
