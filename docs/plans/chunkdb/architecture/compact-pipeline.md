# Background Ingest + Compaction Pipeline — Client-Side-Only

**Author:** seal-v2, swarm `chunkdb-ideation`
**Lane:** Background write / compact pipeline (NEW DIRECTION — overrides cold-sealer-only framing)
**Status:** DESIGN PROPOSAL — opinionated, concrete decisions + SQL/pipeline shapes + tradeoffs. No implementation code.
**Hard constraint:** blackboard `constraint/client-side-only` — ChunkDB is a CLIENT-SIDE-ONLY storage optimization inside `opencode.db`. No SSE/wire/V1-API change. The `EventStore` adapter presents **byte-identical** data to all readers (renderer projection, sync/history, V2 replay, desktop). WIRE ALWAYS CARRIES FULL VALUES; refs are storage-local. **Writes may be slower + background; reads must be fast.**
**Real DB:** 16.75 GiB / 1,377,243 events (live).
**Grounded in:** `constraint/client-side-only`; my `sealing.md` (§2 3rd-conn, §4 worker-thread + 4-layer backpressure, §5 crash, §6 reclaim); `storage.md` (§1 event_value dedup + placeholder-splice, §3 hot-tail reconciliation, §6 sealing lifecycle, §4 geometry); `readpath.md` (§5 point-read accelerator, §6 read-recency, §8 G11); schema-v2 handoff (ocdb_seal final shape, ocdb_control lease, epoch gate); ops-v2 handoff (migration/backup exclusion via ocdb_control); adversarial G11 seal-no-impact gate.

---

## 0. What this pipeline is (and is not)

This is the **production OSES compaction pipeline**, reframed as a client-side background job that runs **in-place on the live `opencode.db`** (no file-swap — that was migration-arch's removed lane; client-side-only means we transform the live file in the background). It reuses the scheduler/connection/backpressure/crash/reclaim shell from `sealing.md` verbatim; the **unit of work changes from "frame one `event.data` column" to "build a segment + promote value-table entries for a hot prefix"**.

**Redundancy eliminated by THIS pipeline (within the event store):**
- **Per-aggregate exact-value dedup** of `info.summary` (message.updated.1 + session.updated.1) via `event_value` + placeholder-splice — the dominant class: 35–65% of event bytes, 50–98% of message.updated bytes (corpus ground-truth-v2). This covers the coordinator's "repeated info.summary" AND "session.summary_diffs third copy" (session.summary lives in session.updated.1 events — same dedup path).
- **LZ compression** (OCDB frame v2, brotli q1 / zstd l1) of the post-dedup remainder (unique part.updated text + shells).

**Redundancy explicitly OUT of scope for this pipeline (stated boundary):** the coordinator's list also names *event ↔ session_message projection duplication* and *message.data summary mirrors last event*. Those are **projection-table** redundancies (separate `session_message` / `message` / `part` tables), owned by the OPCL/projection lane (opcl-arch, removed). They are excluded here for two settled reasons: (1) the adapter must present **byte-identical** data and the projection tables serve readers **independently** — cross-layer value refs "break projection-read independence" (codec.md NOT-VIABLE); (2) client-side-only + wire-carries-full-values means the projection tables cannot reference event-store values without changing their readers. This pipeline eliminates the event-store's OWN redundancy; the projection redundancy is a separate pipeline. **Open Q5** asks the coordinator to route that ownership.

---

## 1. Fast ingest path + the ingest/compact boundary

**Decision: ingest is UNCHANGED from today — `commitDurableEvent` writes identity JSON TEXT to the `event` table (hot tail), no compression, no dedup, no framing. The user's write returns after a fast TEXT insert. The boundary between ingest and compaction is the per-aggregate `sealed_seq` frontier in `event_aggregate`.**

### 1.1 Ingest (unchanged, fast)

```text
commitDurableEvent(event):
  INSERT INTO event (id, aggregate_id, seq, type, data)        -- data = JSON.stringify (identity toDriver, json-codec.ts)
  UPDATE event_sequence SET seq = :seq [, owner_id = NULL]      -- sync fence authority, byte-identical
  -- NO compression, NO dedup, NO framing. Hot path stays identity, fast, ref-free, hash-free.
```

This is exactly today's path (json-codec `toDriver` is IDENTITY). The user never waits on compaction. G3 (≤ +5% write p95/p99) is untouched — the compactor never runs inside the publish txn.

### 1.2 The boundary: `sealed_seq` frontier

```sql
-- event_aggregate gains (storage.md §3; already in the OSES schema):
sealed_seq    INTEGER NOT NULL DEFAULT 0,   -- high-water mark of compacted history
hot_count     INTEGER NOT NULL DEFAULT 0,   -- events still in the hot tail
hot_raw_bytes INTEGER NOT NULL DEFAULT 0,
value_count   INTEGER NOT NULL DEFAULT 0,   -- distinct values promoted (audit)
value_bytes   INTEGER NOT NULL DEFAULT 0
```

- **Hot row** = `event.seq > event_aggregate.sealed_seq` → read from `event` (raw TEXT).
- **Sealed row** = `event.seq <= sealed_seq` → read from `event_segment` (decompressed + splice).
- The compactor advances `sealed_seq` **only inside its commit tx**, atomically with deleting the compacted hot rows. So the boundary is a single moving frontier per aggregate; ingest appends above it, compaction consumes below it.

### 1.3 Why DELETE the hot rows (atomic segment swap)

After building a segment for hot prefix `[sealed_seq+1 .. cutoff_seq]`, the compactor **deletes those hot rows from `event`** and stores them in `event_segment` + `event_segment_blob`. The `event` table becomes the **hot tail only** — it shrinks as compaction proceeds. This is the OSES design (storage.md §3) and is what makes the file actually shrink (reclaim, §5). Reads route by `seq` vs `sealed_seq`; the adapter (readpath-v2's lane) handles both homes transparently.

---

## 2. Background compactor — passes, unit of work, reuse

**Decision: the compactor is the generalized OSES sealer from `storage.md` §6, reusing my `sealing.md` §2 (3rd dedicated connection) + §4 (worker-thread compression + 4-layer backpressure). The unit of work is a SEGMENT (16–32 KiB; Tier P 16 KiB point-read / Tier R 32 KiB replay, storage.md §4.2 / readpath.md §2.2). One segment = one atomic COMMIT (the swap).**

### 2.1 The loop (reuses sealing.md §1 shell)

```text
Compactor.loop (forked fiber at Database-layer init, forkScoped, Effect.ignore-wrapped):
  repeat (periodic Schedule.spaced(10min) + idle-window accelerator(30s) + read-pressure gate):
    for each eligible aggregate (cooling predicate, §3):
      claim ocdb_control('maintenance', kind='compactor', holder=me, expires=now+LEASE)  -- ops-v2 §3.3
      BUILD window: read hot prefix [sealed_seq+1 .. cutoff_seq] bounded to WINDOW_EVENTS
          parse each event (already needed for elision/dedup)
          dedup-extract sub-values -> event_value / event_value_pending / inline (storage.md §1.3)
          build frames (16-32 KiB, Tier P/R), compress via WORKER POOL (sealing.md §4.3)
          encode container: ID stream, type_set, frame directory, payload index (ref lists), frames
      for each segment in window:
          COMMIT (one WAL tx): event_value inserts + segment blob + event_id_registry
                                + oses_seal journal + UPDATE event_aggregate (sealed_seq, hot_*, value_*)
                                + DELETE event rows [segment seq range]
          Effect.yieldNow; consult READ_PRESSURE ladder (sealing.md §4.1) before next BUILD batch
      release ocdb_control lease (or refresh if more work)
```

### 2.2 Unit of work = segment (not column)

- A segment holds ~200–500 events at 16–32 KiB (Tier P 16 KiB for point-read classes, Tier R 32 KiB for replay text). An aggregate's hot prefix may be huge (BIG_AGG = 18,416 events; heavy session = 2.5 GiB) → many segments. The BUILD window can process a large window (many segments) but **COMMITs per segment** (or a small batch) to bound commit latency (G8 < 10 ms, §3.2).
- **Worker pool** (sealing.md §4.3, proven by `chunkdb-seal-parallel.ts`): compression (CPU-bound brotli/zstd) runs off-main-thread on `availableParallelism()` workers (capped 16), byte-balanced chunks (~16 MiB/chunk) so no worker stalls; SQLite writes stay single-writer on the dedicated connection. This attacks the G11 dominant risk (BUILD CPU contention with the model stream).

### 2.3 Initial bulk compaction + incremental

The live 16.75 GiB / 1.37M events are **mostly cold** (old sessions). The compactor's **first run is a bulk compaction** of the entire existing cold hot tail; thereafter it is **incremental** (only new hot rows since `sealed_seq`). The eligibility predicate (§3) naturally selects old cold aggregates first, so the bulk happens gradually across idle windows — paced by G11, never blocking reads. Estimated CPU ≈ 5–15 min for 16.75 GiB (span-walker ~50–150 MB/s × 2 passes for dedup, migration.md §3.2) spread over hours/days of idle windows. Wall-clock is irrelevant (background, user never waits).

---

## 3. Crash consistency for the new structure

**Decision: each segment COMMIT is ONE WAL transaction containing the full swap — INSERT segment + value rows + registry + `oses_seal` journal + advance `sealed_seq` + DELETE hot prefix range — atomically. The `oses_seal` journal is the resume anchor + idempotency ledger. Crash mid-BUILD leaves hot rows intact (BUILD is off the tx). Crash mid-COMMIT rolls back atomically (reader sees pre- or post-swap, never partial). Resume is stateless: re-read from `sealed_seq+1`, skip `oses_seal`-recorded ranges.**

### 3.1 Atomic swap (the crash model)

```sql
-- one WAL tx on the dedicated compactor connection:
BEGIN IMMEDIATE;
  INSERT OR IGNORE event_value (...) ; UPDATE event_value SET refs=refs+1 ... ;   -- dedup promotion
  DELETE FROM event_value_pending WHERE ... ;                                    -- consumed
  INSERT event_segment (aggregate_id, first_seq, last_seq, type_set, crcs, value_set, frame_dir);
  INSERT event_segment_blob (aggregate_id, first_seq, blob);                      -- compressed frames
  INSERT event_id_registry (aggregate_id, frame_idx, event_offset, event_len, ...);
  INSERT oses_seal (aggregate_id, first_seq, last_seq, segment_id, raw_bytes, stored_bytes, time_sealed, codec, frame_version)
         ON CONFLICT (aggregate_id, first_seq, last_seq) DO UPDATE ...;          -- idempotent
  UPDATE event_aggregate SET sealed_seq = :cutoff_seq, hot_count -= :N, hot_raw_bytes -= :raw,
                             value_count = ..., value_bytes = ... WHERE aggregate_id = :agg;
  DELETE FROM event WHERE aggregate_id = :agg AND seq BETWEEN :first_seq AND :last_seq;  -- the swap
COMMIT;   -- on SQLITE_BUSY: ROLLBACK, BACKOFF, re-read frontier, retry
```

- **Crash mid-BUILD:** nothing inserted (BUILD is off the tx) → hot rows intact, no segment, no `oses_seal`. On resume, the prefix is still hot and re-built. Zero corruption.
- **Crash mid-COMMIT:** WAL rolls back the whole tx → either all-hot (pre-swap, event rows present) or all-sealed (post-swap, segment present). **Never partial** — a reader never sees a `seq` that is neither in `event` nor in a segment.
- **`oses_seal` journal** records every committed segment by `(aggregate_id, first_seq, last_seq)`. It is the crash-consistency anchor (atomic with the swap) AND the resume ledger (skip already-committed ranges) AND audit (raw/stored bytes, codec, frame_version — schema-v2 final shape).

### 3.2 Idempotency + resume

- `event_value` uses `INSERT OR IGNORE` + `UNIQUE(aggregate_id, sha256)` → re-promotion of an already-promoted value is a no-op (refs unchanged). The pending ledger (`event_value_pending`) makes cross-seal recurrence visible (corpus repeats span thousands of events).
- On resume, the compactor reads `sealed_seq` (advanced only for committed segments) and `oses_seal` to find the highest committed `last_seq` → starts the next window at `sealed_seq+1`, never re-compacting committed ranges. No separate watermark table needed (unlike the migration rebuild's `oses_migration` — that was a bulk file-swap job; this in-place compactor is stateless across restarts).
- **Jumbo commit latency (G8 < 10 ms):** a segment whose blob is ≥ `JUMBO_TX_THRESHOLD` (e.g. 1 MiB [PROPOSED]) is committed in its **own single-segment tx** to bound commit I/O. Rare (the 24 MB / 32.8 MB tails); OSES jumbo policy (storage.md §5) handles them.

---

## 4. Read / view consistency during swap

**Decision: reads see a consistent snapshot with NO blocking and NO partial views, via (a) WAL snapshot isolation (a reader's tx sees pre- or post-swap, never mid) and (b) frontier-based routing (`seq` vs `sealed_seq`) in the adapter. The segment-swap is coordinated with readpath-v2's adapter through the `sealed_seq` frontier — NOT a lock.**

### 4.1 No lock, no blocking

- The swap is one WAL tx. A reader in a tx (even one begun before the swap) sees the **pre-swap snapshot** until its tx ends (WAL MVCC-style snapshot). New readers see post-swap. There is **no reader/writer lock contention** on the swap itself — the compactor's commit is a normal short WAL write, serialized only briefly with other writers (handled by `busy_timeout` + BACKOFF on the dedicated connection).
- **No partial view:** because `sealed_seq` advances atomically with the `DELETE event`, there is no window where a `seq` is missing from both homes. The adapter's routing (`seq > sealed_seq` → `event`; else → segment) is always total.

### 4.2 Coordination with readpath-v2's adapter

- readpath-v2 owns the read path: hot from `event`, sealed from `event_segment` (decompress frame → splice value refs → JSON.parse → rehydrate → schema decode). The compactor's only contract with the read path is: **advance `sealed_seq` only inside the commit tx**, and **write segments that are decodable standalone** (frame directory + payload index + value_set, storage.md §2 / readpath.md §3.2). The adapter's point-read accelerator (readpath.md §5) and decode cache (readpath-v2 handoff §4) consume sealed segments without any compactor coordination beyond the frontier.
- **Read-recency (readpath.md §6):** the compactor's eligibility excludes read-warm / active aggregates (§3), so interactively-read history stays hot (raw TEXT) — decompression is rare, and when it happens it's bounded to one Tier-P frame (tens of µs). The compactor and the read path never contend for the same rows.

---

## 5. Reclaim — in-place, no online full VACUUM

**Decision: the compactor runs IN-PLACE on the live `opencode.db`. After deleting compacted hot rows, freed pages are reused internally (legacy `auto_vacuum=0`) or reclaimed via `PRAGMA incremental_vacuum` (born-fresh `INCREMENTAL` files). NO online full `VACUUM` (blocks, violates read-latency-first). WAL is checkpointed PASSIVE after each pass, TRUNCATE only deep-idle. True file shrink is deferred to a maintenance-window `VACUUM INTO`+swap or the migration rebuild.**

### 5.1 In-place reclaim

| File origin | auto_vacuum | Reclaim |
|---|---|---|
| **Born-fresh OSES file** (migration rebuild, if it ships) | `INCREMENTAL` at creation | `PRAGMA incremental_vacuum(N)` during idle + read-pressure-normal reclaims tail free pages |
| **Live legacy file (today, 16.75 GiB)** | `0` | freed pages reused internally; `incremental_vacuum` is a no-op; true shrink deferred to a maintenance-window full VACUUM or migration rebuild |

- Flipping legacy `auto_vacuum=0` → `INCREMENTAL` requires a **one-time blocking VACUUM** (deferred to a maintenance window; not done online). Until then, the compactor still reduces **logical** bytes (the file stops growing as fast; future writes reuse freed pages). This is the same tradeoff as `sealing.md` §6 — accepted; the migration rebuild (if it ships) is the real shrink path.
- **`incremental_vacuum` trigger:** after a pass that freed > `RECLAIM_THRESHOLD` (e.g. 64 MiB [PROPOSED]) AND deep-idle AND read-pressure normal — never during active use. Non-blocking (brief lock), safe to repeat.

### 5.2 WAL coordination

- Compactor writes go to WAL (single writer). After each pass: `PRAGMA wal_checkpoint(PASSIVE)` on the **compactor** connection (non-blocking; distinct from the shared client's existing 5-min TRUNCATE loop, so it doesn't contend for the checkpoint lock). `TRUNCATE` (actually truncates WAL) only during deep-idle + read-pressure-normal.
- The compactor claims `ocdb_control('maintenance', kind='compactor')` so a concurrent backup/restore (ops-v2 §3) or epoch flip (schema-v2 §2) cannot run mid-compaction — the lease is the single exclusion point (sealing.md Q3 / ops-v2 §3.3 / schema-v2 Q4 all resolved here).

---

## 6. Metrics (extends the Sealer group to Compactor)

Reuse the 18-signal `Sealer` group from `sealing.md` §7, renamed `Compactor`, plus:

| Metric | Meaning |
|---|---|
| `compactor_hot_tail_rows` | current `event` table size (ingest/compact boundary pressure) |
| `compactor_segments_built_total` | segments committed |
| `compactor_events_compacted_total` | events moved hot→sealed |
| `compactor_dedup_ratio` | `value_bytes` promoted / raw bytes (the 35–65% headline) |
| `compactor_value_promoted_total` | `event_value` rows created |
| `compactor_pending_ledger_size` | outstanding first-occurrence candidates |
| `compactor_initial_bulk_done` | bool — first full pass complete |
| `compactor_sealed_seq_gauge` | per-aggregate frontier advancement |
| `compactor_commit_p99_ms` | **G8** (<10 ms per segment) |
| `compactor_backpressure_suspends_total` | **G11** (<1% read-p99 + <1% token) |
| `compactor_crash_resume_total` | resumes after crash/restart |
| `compactor_incremental_vacuum_pages_total` | reclaim |

---

## 7. Headline decisions (for the coordinator)

1. **Ingest unchanged + frontier boundary:** `commitDurableEvent` writes identity TEXT to `event` (hot tail); user never waits. Boundary = `event_aggregate.sealed_seq`; compactor DELETES compacted hot rows (atomic swap), `event` becomes hot-tail-only.
2. **Compactor = generalized OSES sealer** reusing `sealing.md` §2 (3rd dedicated connection) + §4 (worker-thread compression + 4-layer backpressure). Unit of work = **segment** (16–32 KiB, Tier P/R). One segment = one atomic COMMIT.
3. **Crash model:** per-segment one-WAL-tx swap (INSERT segment+value+registry + `oses_seal` + advance `sealed_seq` + DELETE hot range). `oses_seal` = resume anchor + idempotency ledger. Crash mid-BUILD → hot intact; crash mid-COMMIT → atomic rollback; resume stateless from `sealed_seq+1`. Jumbo segments get own single-tx commit (G8 <10 ms).
4. **Read consistency:** WAL snapshot isolation + frontier routing (`seq` vs `sealed_seq`) — no lock, no blocking, no partial views. Coordinates with readpath-v2's adapter through the frontier only; segments are decodable standalone.
5. **Reclaim:** in-place on live file; `incremental_vacuum` if `INCREMENTAL` (born-fresh) else internal reuse + deferred full VACUUM; PASSIVE checkpoint after pass, TRUNCATE deep-idle; no online full VACUUM. `ocdb_control` lease excludes backup/restore/epoch-flip during compaction.
6. **Redundancy scope:** this pipeline eliminates event-store redundancy (event_value dedup of repeated info.summary + session.summary + LZ compression). Cross-table projection redundancy (event↔session_message, message.data↔event) is OPCL/projection-lane scope, excluded here (cross-layer refs break projection read-independence; client-side-only + byte-identical adapter).

---

## 8. Open questions (ranked, for the coordinator)

1. **Initial bulk-compaction pacing/expectation.** The live 16.75 GiB / 1.37M events need a full initial compaction. G11 paces it either way, but should it run continuously in idle windows (gradual, days, file stays large meanwhile) or be front-loaded at a maintenance window (faster shrink, more CPU at once)? Affects user-visible disk-growth expectation. [seal-v2 + benchmark]
2. **Segment commit granularity vs G8.** One segment per COMMIT (bounds commit <10 ms, adopted) vs batch a few segments per tx (better throughput, larger commit). Needs measurement of real per-segment commit latency at the 24 MB / 32.8 MB tail. [seal-v2 + readpath]
3. **Hot-tail retention floor.** Beyond read-recency (readpath.md §6) keeping read-warm/active hot, is there a minimum hot-tail window (e.g. never compact the most-recent N events of any aggregate) for fast recent reads, or is read-recency sufficient? [seal-v2 + readpath-v2]
4. **event_value dedup thresholds** (SIZE_THRESHOLD ≥1 KiB, JUMBO_PROMOTE ≥1 MiB, promote-on-second) — provisional; the D2/D3/D4 corpus scan locks them. The pipeline ships with provisional values pending that scan. [oses + benchmark — storage.md open Q1]
5. **Cross-table redundancy ownership — RESOLVED (schema-v2 + ops-v2).** The coordinator's listed cross-table redundancies (event↔session_message duplication, message.data↔event mirroring, session.summary_diffs third copy) are NOT in the event-store compactor's scope (cross-layer refs break projection read-independence; client-side-only + byte-identical adapter). They are owned by **ops-v2's epoch-2 file-swap rebuild** (client-side at startup fence). **Event-store dedup is UNCONDITIONAL in epoch 2** (repeated `info.summary` + `session.summary` → shared `event_value` = the 35–65% win). **Cross-table projection collapse is CONDITIONAL**: the epoch-2 rebuild performs it only if the OPCL routing-column promotion (rewriting `message.data`'s json_extract consumers to native cols/refs) lands in the same cut; otherwise cross-table stays an accepted V1-API cost (schema-v2 topology target vs the v1 exclusion). **Staging:** epoch 1 = this live compactor's incremental event-store dedup (ships first, non-breaking); epoch 2 = ops-v2's file-swap rebuild does the event-store dedup unconditionally + the cross-table collapse conditionally. Both land in the SAME `event_value`. readpath-v2 defers projection-side dedup to Stage 3 (routing-gated). So my pipeline correctly handles only the event-store portion; the cross-table collapse is a later epoch-2 step (gated on OPCL). [schema-v2 + ops-v2]

---

## 9. Cross-lane coordination (explicit)

- **schema-v2:** compactor writes `oses_seal` using schema-v2's final journal shape (`column_name, codec, frame_version, reseal_needed`, PK `(table_name,row_id,column_name)` — here `table_name='event_segment'`, `row_id` = segment key). The framing_epoch flip (schema-v2 §2) happens inside the compactor's held `ocdb_control` lease on its first segment — answering schema-v2 Q4 (no separate mechanism). `reseal_needed` (codec/threshold change) triggers a re-compact pass under the same G11 backpressure.
- **readpath-v2:** read consistency during swap is frontier-based (§4), no lock; the adapter reads hot-from-`event` / sealed-from-`event_segment`. The compactor's only read-path contract is atomic `sealed_seq` advancement + standalone-decodable segments. readpath-v2's decode cache + point-read accelerator consume sealed segments without further coordination.
- **ops-v2:** the compactor claims `ocdb_control('maintenance', kind='compactor')` so backup/restore/migration cannot run mid-compaction (ops-v2 §3.3). Backup coherence (TRUNCATE checkpoint on compactor conn + copy `.db` only) matches `sealing.md` §6.3. ops-v2 consumes the `Compactor` metrics group.
- **adversarial G11:** the 4-layer backpressure (sealing.md §4) paces the compactor's BUILD (worker-pool CPU) AND COMMIT, holding G11 (<1% read-p99 + <1% model-token inter-arrival during full-throttle compaction).

---

## 10. Epoch staging (resolved by schema-v2 / ops-v2)

The cross-peer sequencing is now settled (schema-v2 handoff + ops-v2 handoff):

- **epoch 0** = legacy (today's 16.75 GiB DB).
- **epoch 1** = v1 cold framing of `event.data` (schema-v2's prior deliverable) + **this live compactor's incremental event-store dedup** (repeated `info.summary` within events → `event_value`). Ships first, non-breaking, delivers the headline 35–65% win. This `compact-pipeline.md` IS the epoch-1 production pipeline.
- **epoch 2** = ops-v2's client-side file-swap rebuild at the startup fence. **Event-store dedup is unconditional** (repeated `info.summary` + `session.summary` → shared `event_value`). **Cross-table collapse is conditional** on the OPCL routing-column promotion landing in the same cut; otherwise cross-table stays an accepted V1-API cost. Both epochs land in the SAME `event_value` table.

So my live compactor is the incremental step; the full cross-table collapse is a later epoch-2 file-swap owned by ops-v2/schema-v2. The `ocdb_control` lease (ops-v2 §3.3) coordinates both: `kind='compactor'` for my live pipeline, `kind='migration'` for the epoch-2 rebuild — mutually exclusive, so they never run concurrently on the same DB.
