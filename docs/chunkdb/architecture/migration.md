# Migration & Epoch Architecture at 18 GB Scale

**Author lane:** migration-arch (swarm `chunkdb-ideation`) — Migration, epoch cutover & rollback architect.
**Phase:** Architecture (IDEATION + DESIGN, minimal implementation code).
**Baseline:** `openfork` branch; sanctioned corpus = 18 GB snapshot (`D:\opencode-backup\opencode-db-snapshot-20260812\opencode - Copy.db`, 1,377,243 events, pristine TEXT) + live 1.87 GB DB (pristine TEXT). Source files never modified; all facts below measured read-only / on temp clones.
**Supersedes for this lane:** `docs/chunkdb/ideation/migration.md` where they conflict. The size-gate and the epoch-flip mechanics are **re-derived**: the in-place shadow-store protocol is demoted to a disk-constrained fallback; the primary path at real scale is **rebuild-to-new-file + swap**, which also *eliminates* the in-file epoch-flip transaction.
**Inputs folded in:** `event-destructuring-real-corpus.md` (the correction — aggregate exact-value dedup via `event_value` is the dominant storage move), `corpus/ground-truth-v2`, all peer lane decisions from the ideation phase (startup fence per contract-arch, `event_sequence` read-only per oses-arch, plain-TEXT reverse-export target per codec-arch, G9 kill-point contract per benchmark-arch).

---

## 0. What changed since the ideation phase

| Prior ideation (migration.md) | Architecture at 18 GB scale |
|---|---|
| In-place shadow store in the SAME file (A–E), epoch flip = guarded `UPDATE storage_meta` tx | **File-swap rebuild**: build a new file, swap on success. The epoch flip becomes two renames with a tiny recovery window. In-place shadow remains only as a disk-constrained fallback. |
| "Decode OCDB frames" as a backfill step | Detection of three legacy states (pristine TEXT / OCDB-framed / OSES) is a first-class preflight; the 18 GB snapshot and the live DB are **pristine TEXT** (no `ocdb_seal`, no framed rows) — that is the primary path. |
| Backfill = encode OSES rows | Backfill = **value-table dedup (`event_value`) + segments**; the dedup is the real Pareto move (35–65% of event bytes eliminated *before* compression). |
| Reverse export = re-inflate to legacy rows | Reverse export = **re-inflate value-refs** (value_id → bytes) **and decode sealed segments** back into legacy rows; the primary rollback is "restore the old file" while the window is open. |
| Synchronous startup conversion below ~25k/256 MiB | Confirmed untenable for 18 GB — re-derived: synchronous *file* rebuild at startup fence for small DBs; **background file rebuild + catch-up + swap-at-startup** for large DBs. |

---

## 1. The three legacy states — detection and migration path

### 1.1 State inventory

| State | Marker | Where it comes from | Migration path |
|---|---|---|---|
| **Pristine TEXT** | `event.data` all `text`; **no `ocdb_seal` table**; no `storage_meta` | stock v1.18.18 / fork without sealer run (BOTH measured DBs — verified) | Full rebuild (primary design, §3) |
| **OCDB-framed** | `ocdb_seal` table present (the sealer writes the frame and its journal row in ONE tx — a journal row is inseparable from a frame); `EXISTS` blob probe hits | fork `chunk-sealer.ts` ran | Rebuild with `decompressFrame` first (§3.3) |
| **OSES** | `storage_meta` row `epoch='oses-v1'` (new-file format); `event_value`/segment tables present | a prior cutover | No-op (already migrated); future OSES→OSES upgrades are normal migrations |

### 1.2 Cheap detection (preflight, ordered so the common case is near-free)

1. `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ocdb_seal','storage_meta','event_value','oses_segment')` — **instant, index-free**. This alone distinguishes all three states in practice:
   - `storage_meta` + `oses_segment` → OSES → no-op.
   - `ocdb_seal` → framed.
   - none of them → pristine TEXT (the 18 GB snapshot and the live DB).
2. Belt-and-suspenders blob probe only when the table probe says pristine: `SELECT 1 FROM event WHERE typeof(data)='blob' LIMIT 1` (early exit; a full miss scans 18 GB ≈ seconds on NVMe — one-time, acceptable at migration time). Rationale: `ocdb_seal` presence is authoritative for "did the shipped sealer run"; the probe catches hand-framed DBs or a sealer variant that did not journal.
3. Never rebuild/alter on a read that fails — all probes open the DB **read-only** first.

### 1.3 State taxonomy for the migration decision

```
preflight
 ├─ OSES already            → no-op (report epoch)
 ├─ pristine TEXT or framed → decide path by SIZE (§2) → REBUILD (or fallback)
```

---

## 2. Size-gated protocol re-derived — the file-swap verdict

### 2.1 Why the old gate dies

The ideation-phase gate ("synchronous startup-fence conversion below ~25k events / 256 MiB; shadow protocol for the multi-GB tail") is untenable at 18 GB for two reasons:

1. **A synchronous conversion of 18 GB inside a startup fence violates the load-to-ready budget by hours** (contract-arch's startup-latency gate). The shadow/backfill path must run as a **background, multi-session maintenance job**, not a startup op.
2. **In-place shadow at 18 GB is a disk trap on two axes simultaneously**: the file grows to ~legacy + shadow (≈ 24–28 GB in one file) *and* the retained-legacy rollback window keeps ~18 GB resident until a reclaim that requires a VACUUM over 18 GB.

### 2.2 The verdict: rebuild-to-new-file + swap

For an 18 GB single-user desktop DB the correct protocol is:

```
REBUILD: stream the legacy file (read-only) → build a NEW file at opencode.db.new
         with the OSES physical design INCLUDING event_value dedup + segments.
         Progress lives in the NEW file's own oses_migration table. The legacy
         file is NEVER mutated. The app keeps writing the legacy file the whole time.
CATCH-UP: poll the legacy frontier; replay post-copy events into the new file until
          lag ≈ 0. (Read-only on legacy: WAL gives snapshot-per-tx isolation from
          the app's writes — readers never block the app's writer.)
SWAP (at next startup fence, before the Database layer opens any file):
          rename opencode.db → opencode.db.pre-oses
          rename opencode.db.new → opencode.db
          (small recovery window, §4.4)
ROLLBACK WINDOW: opencode.db.pre-oses retained (the OLD file IS the rollback
          artifact — zero reverse export needed while it exists).
RECLAIM: delete opencode.db.pre-oses after the policy window (§7). No VACUUM.
```

**Why file-swap wins over in-place shadow at this scale** (the weighing the task asked for):

| Axis | In-place shadow (same file) | File-swap rebuild |
|---|---|---|
| Correctness of the authority | Legacy + shadow in one file; reader must merge; mixed-state queries possible | The legacy file is byte-for-byte untouched; the new file is born with exactly one physical format |
| Crash safety | Epoch-flip tx with mid-flip windows (K9.2-0..6) | Legacy file never mutated; swap = two renames + 3-line recovery; no in-file epoch tx at all |
| Rollback | Reverse export REQUIRED to go back (the old rows were overwritten-era) | Restore the `.pre-oses` file (trivial) while the window is open; reverse export only needed after reclaim |
| Disk during migration | 18 GB + shadow inside the file → file swells to ~25 GB; reclaim needs VACUUM over 18 GB | 18 GB (old) + ~4–6 GB (new) ≈ same total, but the old file can be **moved or compressed** and needs no VACUUM |
| Reclaim economics | Heavy (DROP + VACUUM on a huge file) | Delete one file (or move to backup). §7 |
| Read path during migration | App must read merged shadow (adapter complexity in production) | App reads legacy until the swap — the adapter change happens exactly at the swap, not during a long dual-state window |
| Windows process interplay | Epoch UPDATE needs a WAL write-lock fence | Renames fail cleanly if another process holds the file open (Windows file locking IS the fence); recovery handles the gap |

**When in-place shadow stays:** only when free disk cannot hold `legacy + expected_new + WAL + margin` (the file-swap needs ~1.4–1.6× free disk; in-place needs ~0.3–0.5× extra *in-file* space but the same total disk once rollback is counted). In-place shadow keeps the ideation-phase design (migration.md §2.2/§3) with its K9.x kill points. It is the fallback, not the default.

### 2.3 The re-derived gate (three tiers)

```
Tier S  (small):      events < ~25k OR legacy bytes < ~256 MiB
         → synchronous FILE rebuild at the startup fence (not in-place conversion):
           fast enough to fit the load-to-ready budget; same swap mechanics.
Tier M  (mid):        256 MiB ≤ legacy < ~2 GiB (benchmark the crossover)
         → background rebuild + catch-up + swap (primary mechanics below),
           completes in minutes-to-an-hour across a session or two.
Tier L  (large):      legacy ≥ ~2 GiB (THE 18 GB case)
         → background rebuild + catch-up + swap; multi-session job; the primary
           target of this document.
Disk-constrained:     free < legacy + expected_new + WAL + margin
         → in-place shadow fallback (ideation design) OR refuse-and-prompt
           ("make N GiB free to migrate").
```

The Tier S/Tier M crossover constant and the Tier-M/L disk formula are **benchmark-gated** (benchmark-arch lane; pinned in `bench/gates.json` at corpus v1). What is *not* benchmark-dependent is the protocol shape: **all three tiers share the file-swap mechanics**; only the pacing (sync-at-startup vs background) differs. That is the main simplification this re-derivation buys: one protocol, three paces.

---

## 3. The rebuild (Tier L primary path)

### 3.1 Architecture of the pass

- **Source connection**: `Database.withBackfillDb(legacyPath)` — the fork's dedicated read connection; each chunk runs in a SHORT read transaction (snapshot isolation; never holds a read snapshot across the app's writes; never blocks the app's WAL checkpoint).
- **Sink connection**: a second dedicated connection on `opencode.db.new` (WAL on the NEW file; it has no competing writer, so no lock contention at all).
- **The new file is born complete**: built with the **empty-DB path** of `DatabaseMigration.apply` (`schema.up` + `migration` table seeded with every migration marked done) — so when the app later opens it after the swap, `applyOnly` is a no-op. `storage_meta` starts with `epoch='oses-v1'` + `PRAGMA user_version` mirror set at build time. **`PRAGMA page_size` is set at file creation, before any table exists (O7 + oses-arch storage.md §4.4, D7-gated):** page_size ∈ {8, 16, 32} KiB costs zero migration overhead here — no VACUUM over 18 GB — because the file is born fresh; a 16 KiB page holds a whole 16 KiB frame (segment-BLOB fetch ~8 pages → 1) and 32 KiB pages align with the 32 KiB frame lock (SQLite max 65536). The **pristine legacy file keeps its 4 KiB pages** — page_size applies only to the born-fresh OSES file. Sequencing: open the empty file → `PRAGMA page_size=<D7-selected>` → `schema.up` + seeded migrations. The D7 sweep (benchmark-arch) correlates page_size ∈ {4, 8, 16, 32} KiB with the frame lock; the rebuild applies the selected value (cache-budget interaction with `-64000` re-validated).
- **Progress**: `oses_migration` rows **in the new file** (§3.4). Crash → reopen `opencode.db.new`, resume from the watermark. The legacy file is never touched, so every crash is trivially recoverable.
- **Read-only discipline (corpus D8 contract, benchmark-arch §8c):** the rebuild's SOURCE scans are read-only by construction; the value-inventory scans (pass 1, §3.3) and any D2/D3 dedup-sizing scans run **read-only against the sanctioned S0.1 snapshot** (bounded sampling per corpus rules). Every MUTATING pass — rebuild, catch-up, reverse export, kill-sweeps — runs on a **temp clone** of the artifact set, never on S0.1 or the live DB. This is the standing rule for this lane, matching the ideation G9 harness contract.

### 3.2 Chunking, pacing, and windowing

```
Per batch (the unit of atomicity + resumability):
  1. read up to BATCH_BYTES (proposed 64–256 MiB) of source events in (aggregate, seq) order
     (short read tx on the legacy connection);
  2. for each event: decode (TEXT or OCRB frame — pristine corpus needs no decode);
     run the value extractors (§3.3);
  3. write into the new file inside ONE tx: event_value promotion rows + segment rows +
     oses_migration watermark advance;
  4. yield (Effect.yieldNow) + retryOnLock (mirrors SessionSearch.backfillParts).
```

- **Aggregate-major order** — required by the value-table two-pass (§3.3) and by segment locality (no cross-aggregate segments).
- **Routing rides the rebuild (opcl-arch §5):** because the rebuild streams every `message`/`part` row exactly once, the native routing columns (`role`/`provider_id`/`cost`/`part_type`) are written inline, equality is validated inline, and `idx_message_provider_id` is simply **not carried into `opencode.db.new`** — the separate in-place ALTER+backfill on the legacy file collapses into the rebuild pass. The rebuild writes **identity TEXT rows** (decoding framed input first if the source is OCDB-framed); cold projection rows are framed by the background sealer **after** the swap, keeping the rebuild single-purpose and the sealer the sole frame producer.
- **Pacing knobs** (all pinned by benchmark): `BATCH_BYTES`, `MAX_BYTES_PER_PASS`, and an idle-window scheduler. The pass is gated by an explicit maintenance flag and runs in the sealer's style: bounded work per pass, `Effect.yieldNow` between batches, suspend when interactive p99 breaches (research §32.3 adaptive control). On the packaged Electron runtime there is no OS-level nice — background-ness is expressed in-process, exactly as the fork sealer already does.
- **Estimated wall-clock for the 18 GB snapshot** (NVMe, ~2 GB/s seq read; REVISED per adversary R9): the value pass is NOT native `JSON.parse` throughput — the span-walker (offset-splice scanning of candidate sub-values) runs ~50–150 MB/s, and the rebuild walks the corpus **twice** (pass-1 hash inventory + pass-2 promote). Source scan ≈ 10 s ×2; span-walking ≈ 2×(18 GB / ~100 MB/s) ≈ 6 min; hashing ≈ 1 min; brotli of the post-dedup remainder ≈ minutes. **Total ≈ 5–15 min CPU, spread over idle windows (wall-clock hours across sessions).** For the OCDB-framed legacy state, add `decompressFrame` per row (≈ zlib inflate rate) to every pass — a framed input leg is part of the D8 rehearsal (§10.8) so this number is measured, not guessed. Memory stays flat (hash-only pass-1 per aggregate, §3.3).
- **Catch-up loop**: after the initial copy reaches the frontier at time T0, the pass enters catch-up: poll `event_sequence` (or `max(rowid)` on `event`) on the legacy file, replay events with `seq > last_copied` into the new file. When lag ≈ 0 and a startup fence is available, final catch-up + swap (§4).

### 3.3 Value-table dedup — order of operations vs segment building

Per aggregate, two passes over the source (aggregates are disjoint, so total re-read ≤ 2× legacy bytes):

**Pass 1 — hash inventory (cheap):** stream the aggregate's events; for each type-aware candidate sub-value (§ the extractor registry below), stream-hash (sha256) and tally `{hash → count, first_size}`. Memory is bounded by *distinct* candidate count, not bytes (only hashes+counts are kept — the 2.5 GB aggregate has ~225 distinct values ≈ ~20 KB of hash table). No DB writes.

**Pass 2 — emit (write):** re-read the aggregate; for each event, if its candidate sub-value's hash is in the **promoted set** (`count ≥ 2 AND size ≥ 1 KiB`), replace the sub-value with a `value-ref` (`value_id` uvarint; `aggregate_id` implicit) and write/update the `event_value` row (`aggregate_id, value_id, sha256, raw_len, bytes, refs`); build the segment microframes from the ref-substituted payloads; commit segment + `event_value` + watermark in ONE tx.

**Ordering rule:** for an aggregate, value promotion **precedes** segment building (segments are never written with speculative refs). `event_value` rows for non-promoted candidates are never created — the two-pass design avoids the "materialize-then-prune" waste entirely. `refs` is incremented per event that references the value; on segment seal the refcount is fixed.

**Seal-time-only dedup (contract-arch §3, aligned):** value promotion happens ONLY at the seal boundary — never in the hot write path. Hot writes stay identity + ref-free (no hashing inside `commitDurableEvent`'s publish tx; `part.updated` is never a candidate — 0% repeats, unique text). In this architecture the REBUILD is the bulk-seal boundary: every legacy event passes through the pass-1/pass-2 promotion exactly once, and post-swap the live hot tail writes identity rows that the ongoing OSES sealer promotes at its own seal time. The `VALUE_DEDUP` gate is epoch-independent and reversible.

**Exactness guards (fail-closed, replay-safe):**
- on emit: re-serialized sub-value must hash to the stored `sha256` — else abort the batch;
- on decode: rehydrate from `event_value`, deep-equal against the schema-encoded value — preserves `isDeepStrictEqual(stored.data, encoded)` (event.ts replay semantics) exactly;
- reverse export re-inflates the same way (§5).

**Value-ref mechanics and schema (oses-arch storage.md — FROZEN for the D2/D3/D4 window):**
- `event_value` schema is `(aggregate_id, value_id, sha256, raw_len, bytes, refs, time_promoted)`, `PRIMARY KEY (aggregate_id, value_id)`, `UNIQUE (aggregate_id, sha256)`, cascade FK → `event_sequence`. The rebuild writes this table verbatim.
- A value-ref is a **positional placeholder-splice**: the payload's sub-value bytes are replaced by a 4-byte JSON `"null"` placeholder, and the per-event ref-list `(offset, len, value_id)` lives in the payload index. Decode splices the stored bytes back → exact original JSON text → JSON.parse → schema decode. Frames stay valid JSON (codec path unchanged); missing/corrupt value = fail-closed. The rebuild's pass 2 substitutes placeholders + writes ref-lists; reverse export re-splices.

**Extractor registry (type-aware, configurable):** per `versionedType`, an ordered list of JSON-path extractors. v1 corpus (ground truth + oses-arch ruleset): `message.updated.1` and `session.updated.1` → `["info","summary"]` (the byte king: 95–100% of message.updated payloads; sessions show 50–98% eliminable), with `SIZE_THRESHOLD ≥ 1 KiB`, `JUMBO_PROMOTE ≥ 1 MiB`, promote-on-second via the persistent `event_value_pending` ledger. A discovery scan of `info.metadata`, `tool.input`, `tool.result` (§10.3) runs before the v1 registry is locked.

### 3.4 `oses_migration` progress (in the NEW file)

Extends the ideation design (migration.md §3) with the fields the rebuild needs:

```sql
CREATE TABLE oses_migration (
  name              TEXT PRIMARY KEY,          -- 'rebuild', 'catchup', 'reverse-export'
  phase             TEXT NOT NULL,             -- 'building'|'verified'|'swapped'|'exporting'|'done'
  aggregate_cursor  TEXT,                      -- last aggregate id processed
  sequence_cursor   INTEGER,                   -- last seq within that aggregate
  watermark_rowid   INTEGER NOT NULL DEFAULT -1, -- source rowid high-water (fork idiom)
  rows_done         INTEGER NOT NULL DEFAULT 0,
  raw_bytes_done    INTEGER NOT NULL DEFAULT 0,
  stored_bytes_done INTEGER NOT NULL DEFAULT 0,
  value_count       INTEGER NOT NULL DEFAULT 0,  -- event_value rows created
  verified_count    INTEGER,                     -- set by final verification
  verified_crc      TEXT,                        -- aggregate hash (id,seq,type,crc32(data))
  time_started      INTEGER NOT NULL,
  time_updated      INTEGER NOT NULL,
  time_completed    INTEGER
);
```

Invariants (unchanged from ideation, now trivially satisfied): progress advances in the same tx as the work; shadow/rebuild inserts are idempotent (`INSERT OR IGNORE` keyed on `(aggregate_key, seq)` / value `sha256`); a crash leaves the legacy file untouched and the new file resumable from the watermark.

---

## 4. Epoch flip = the swap (re-derived)

### 4.1 No in-file epoch transaction

The ideation design flipped an in-file `storage_meta` row inside a guarded `UPDATE ... WHERE value='legacy'` tx (with K9.2-0..6 mid-flip kill points). In the file-swap design the **new file is born `oses-v1`**; the "flip" is making it live. `storage_meta`/`user_version` still exist (external-tool visibility + future fail-closed gating), but there is no window in which a live file's epoch is in an intermediate state. **The K9.2 mid-flip windows are eliminated by construction.**

### 4.2 The swap procedure (startup fence, before the Database layer opens any file)

**Files:** `opencode.db` (live legacy), `opencode.db.new` (rebuild target: absent / partial / complete+verified), `opencode.db.pre-oses` (legacy renamed away; only exists mid-swap).

**Swap-pending marker (NEW-R7):** the rebuild sets a single `oses_migration` row `phase='verified'` in the NEW file **only after** VERIFY passes at a quiescent final catch-up. The marker is what distinguishes "rebuild complete, swap eligible" from "rebuild in progress". It is checked **read-only** on `opencode.db.new` before any rename.

**Pinned startup ordering (recovery first → swap decision → resume):**

```
0. PRE-FLIGHT (read-only probes, no mutation):
     exists(opencode.db)? exists(opencode.db.new)? exists(opencode.db.pre-oses)?
     if .new exists: read-only SELECT oses_migration.phase — verified marker set?
1. CRASH-WINDOW RECOVERY (interrupted swap):
   a. !exists(opencode.db) AND exists(.new) AND marker=verified
                                     → rename .new → opencode.db   (swap crashed
                                       after rename 1; .new was verified before it)
      !exists(opencode.db) AND exists(.new) AND NO marker
                                     → if .pre-oses exists: restore .pre-oses → opencode.db;
                                       else ABORT with a clear data-dir message (opencode.db
                                       is gone and .new is not a verifiable replacement).
   b. !exists(opencode.db) AND exists(.pre-oses) AND !exists(.new)
                                     → rename .pre-oses → opencode.db   (restore)
   c. exists(opencode.db) AND exists(.pre-oses)
                                     → TRULY UNEXPECTED (a stray process recreated the live
                                       file mid-swap, or a backup-restore raced): ABORT, log,
                                       NEVER delete or rename anything; prompt the user.
2. SWAP DECISION — only when the marker is present (the NORMAL completed-rebuild path):
   both opencode.db and .new present AND marker=verified:
   (2a) FINAL CATCH-UP: quiescent startup, no writers — replay legacy events with
        seq > last_copied into .new (resumable, watermark in .new; typically small —
        the background pass kept lag ≈ 0).
   (2b) RE-VERIFY: per-aggregate count/crc at the new frontier; failure → abort swap,
        CLEAR the marker, keep legacy, resume rebuild.
   (2c) RENAMES: rename opencode.db → opencode.db.pre-oses;
                 rename opencode.db.new → opencode.db.
   (2d) STALE-WAL cleanup for the pre-oses name (checkpointed at clean shutdown).
   Crash inside 2a/2b: no renames done; next startup re-enters 2 and resumes.
   Crash inside 2c: recovery 1a/1b completes or restores.
3. REBUILD-IN-PROGRESS (both present, marker ABSENT): open opencode.db (legacy) and
   RESUME the background rebuild — NOT an abort. The rebuild writes .new toward the
   frontier and sets the marker when verified; the swap happens at the next startup.
4. POST-SWAP: app opens the new file (all migrations seeded → no-op); report
   "storage upgraded, old file retained for rollback".
```

**Release-coupling gate (opcl-arch §5, HARD, applies to step 2):** the swap is only offered by a binary carrying the routing rewrite (native `role`/`provider_id`/`cost`/`part_type` + rewritten `SessionUsage`/fork-credentials/search.ts). If the current binary still runs `CREATE INDEX IF NOT EXISTS idx_message_provider_id` at layer construction, it would recreate the expression index in the new file and the silent-NULL path re-emerges the moment any projection row is framed. **Same release as the swap, no exceptions.**

### 4.3 Cross-process fence on Windows

Renames fail cleanly while another process holds the file open (Windows file locking). The swap therefore **fails safe by construction**: a stray `opencode db` shell or a second instance holding `opencode.db` makes the renames (step 2c) fail with a clear message ("close other programs using opencode.db"), and recovery (step 1) never deletes. On POSIX the same guarantee comes from the startup-fence contract + recovery checks. This is a *stronger* fence than the ideation WAL-write-lock approach and requires no app-level coordination.

### 4.4 Fault-injection kill points (adapting the G9 contract)

The new-file protocol replaces the K9.x sets as follows (same `STORAGE_FAULT_KILL` hook mechanism, benchmark-arch contract preserved):

| Kill point | Where | Post-restart invariant |
|---|---|---|
| K-RB-0..5 | rebuild chunk boundaries (same sub-boundaries as ideation K9.1-0..5, now on the NEW file) | legacy untouched; new file resumes from watermark; zero duplicate `(aggregate_key, seq)`/`sha256` |
| K-CC-0..3 | catch-up loop (poll → replay → commit) | resumes; replay idempotent |
| K-SW-0 | PRE-SWAP READY state (marker set, before final catch-up 2a) | no renames; marker still set; next startup re-enters the swap decision |
| K-SW-1 | during final catch-up (2a) | resumable (watermark in .new); no renames |
| K-SW-2 | after re-verify (2b), before rename 1 (2c) | no renames; marker still set; next startup re-swaps |
| K-SW-3 | between rename 1 and rename 2 (2c) | recovery 1a completes the swap (.new was verified before rename 1); legacy on disk as .pre-oses |
| K-SW-4 | after rename 2, before stale-WAL cleanup (2d) | swap complete; recovery no-op; cleanup idempotent |
| K-SW-5 | marker check (step 0, read-only) | no mutation; decision is pure |

Invariant across all: **never both files live as `opencode.db`; never neither; no committed event lost; the legacy file is never mutated.** This is the G9.2 guarantee, re-expressed at file granularity.

---

## 5. Reverse export — re-derived for value-refs and segments

### 5.1 When is reverse export actually needed?

- **Primary rollback (window open):** restore `opencode.db.pre-oses` — a file copy/rename. **No reverse export.** This is the design's headline: file-swap makes the *most common* downgrade a file operation.
- **After the window closes (or the old file was moved/compressed):** `opencode storage rollback` must regenerate a legacy-format file from the OSES file. This is the tested tool, designed now.

### 5.2 The tool (`opencode storage rollback --to-legacy`)

```
1. PREFLIGHT: source epoch == 'oses-v1'; destination name does not exist; no live writers.
2. Build a NEW legacy file (opencode.db.legacy) — again "born complete":
   schema.up + seeded migrations (migration.ts empty-DB path); storage_meta absent/legacy.
3. Per aggregate, in (aggregate, seq) order, in bounded chunks (fork watermark idiom):
   a. hot rows: read `event` (the OSES hot tail is the existing table);
   b. sealed history: read segment rows, decode microframes in order, unpack packed event IDs
      (zigzag-delta per oses-arch) back to canonical `evt_` IDs — reject noncanonical escapes
      (never synthesize);
   c. RE-INFLATE value-refs: for every value-ref in a payload, fetch bytes from `event_value`
      (value_id, sha256-verified) using contract-arch's **byte-level splice** rehydration helper
      (splice the stored bytes into the event JSON text → exact original text → JSON.parse),
      deep-equal the rehydrated sub-value (fail-closed); a per-aggregate value cache
      (aggregate_id, value_id) kills the 1,284× repeat BLOB reads during the export;
   d. write legacy `event(id, aggregate_id, seq, type, data)` rows with data as PLAIN JSON TEXT
      (codec-arch decision: never frames) and upsert `event_sequence.seq` to the frontier
      (the ONLY writer that touches event_sequence, per oses-arch).
4. Decode any OPCL-framed projection payloads (message.data/part.data) back to TEXT for pre-OPCL target releases; `search_text` survives. **No `idx_message_provider_id` rebuild on the projection side** (opcl-arch §5): after the routing rewrite there are no json_extract consumers left, so projection reverse-export is decode-to-TEXT only — and an old target release's own `CREATE INDEX IF NOT EXISTS` self-heals the index at its layer construction (or the index never needs to exist for rewritten binaries).
5. Verify FTS triggers fire correctly on the restored projection rows (search_text is payload-shape-independent; confirm row counts).
6. VERIFY (gate, in the final tx): per-aggregate count + crc equality vs the swap manifest
   (verified_crc from §3.4); `PRAGMA integrity_check` + `foreign_key_check`; FTS row counts.
   A partial/inconsistent export is REJECTED — no flip-back.
7. COMMIT + rename into place; report.
```

Fault injection: K-RE-0..8 (preflight → fence → per-chunk read/decode/re-inflate/write → OPCL → index → verify → commit), all resumable/idempotent; verification rejection of partial exports is the same discipline as ideation G9.4. **This is tested code, shipped and fault-injected before any cutover release** — unchanged principle, re-derived target.

---

## 6. Disk-space model at 18 GB scale — two modes (adversary R8)

The rebuild writes `opencode.db.new`, whose **only writer is the rebuild** — it does not have to live on the DB volume. That splits the disk model into two modes:

```
MODE A — same-volume rebuild (default when the DB volume has headroom):
  free on DB volume ≥ legacy_file (18 GB)
                       + expected_new_file (≈ 4–6 GB; estimate §6.1)
                       + rebuild_WAL_high_water on .new (≈ 0.5–1 GB; §6.2)
                       + safety margin (proposed 10%, min 4 GiB)
  ⇒ ≈ 26–30 GB free to migrate in place. .pre-oses rollback = the old file (no extra).

MODE B — cross-volume rebuild (TIER-L DEFAULT when DB-volume free is tight; R8):
  build .new on a user-selected scratch/backup volume (its only writer is the rebuild;
  no WAL contention, no pressure on the live volume during the multi-session build):
    free on scratch volume ≥ expected_new_file + rebuild_WAL_high_water + margin
                             (≈ 5–8 GB — small and disposable);
    free on DB volume     ≥ legacy_file + transient .new-during-copy + WAL + margin
                             (the .new file is only resident on the DB volume during the
                              final copy at swap time — minutes, not days).
  At swap time (step 2, quiescent startup): (1) FULL checkpoint .new → single
  self-contained file; (2) resumable byte-copy .new to the data dir (copy manifest +
  sha256 verify); (3) renames as §4.2. The multi-hour rebuild therefore never taxes the
  user's main volume, and the hardest user-facing gate (≈26–30 GB free) collapses to
  "WAL headroom + one file copy" on the DB volume.
```

**Free-disk decision at swap time:** choose A vs B by `fs.statfs` at rebuild start (mode B if DB-volume free < Mode-A bound and a scratch volume is available/selectable); the swap-time copy (2) re-checks and can defer to the next startup if the transient headroom is not there. **Refuse/pause semantics:** the rebuild preflights and re-checks free space per batch on whichever volume it writes; below the bound → pause (watermark preserved), log, resume when headroom returns. Never let the rebuild push any volume to zero while the app is live. The "compression means migration needs less disk" trap is worse at this scale: the 18 GB legacy must coexist with the build regardless of how small the new file ends up. In-place shadow remains only when BOTH modes are unavailable (no scratch volume AND insufficient DB-volume free).

### 6.1 The post-dedup estimate (before committing to a rebuild)

The 18 GB number is dominated by repeated `summary.diffs`. A cheap estimator pass (read a bounded per-aggregate sample, run pass-1 hashing on it, project the 40–70% elimination band from the ground truth) turns the `expected_new_file` constant from a guess into a per-DB number. If the estimate says the new file would not be materially smaller, the rebuild is not worth running — surface that to the user. This is the disk-model analog of the size gate.

### 6.2 WAL/checkpoint at bulk scale on the packaged Electron runtime

- **Legacy file (app's live writer):** unchanged policy (`wal_autocheckpoint = 1000`, synchronous=NORMAL). The rebuild's READ connection never triggers checkpoints there and never holds a read snapshot across the app's writes.
- **New file (rebuild's sink):** the only writer is the rebuild → **raise `wal_autocheckpoint` on that connection** (proposed 10 000 pages) and run explicit `PRAGMA wal_checkpoint(PASSIVE)` between batches. The commit that crosses the threshold inherits checkpoint work — benchmark it (ideation §8 stands; the interactive-path prohibition on FULL/RESTART stands).
- **Swap time:** the old file was checkpointed at clean shutdown; residual `-wal/-shm` cleaned in step 3 of §4.2.
- **Packaged runtime constraint:** the rebuild is a background, gated, pass-limited job (sealer idiom, `Effect.yieldNow`), never a startup-blocking operation at Tier L. The 18 GB scan is spread over idle windows across sessions; the only synchronous work at startup is the final bounded catch-up + swap when lag ≈ 0 (fits the load-to-ready budget because the background pass keeps lag small).

---

## 7. Rollback window + reclaim economics at 18 GB

| Question | Answer |
|---|---|
| What is retained? | The entire old file (`opencode.db.pre-oses`, 18 GB). No in-file legacy tables to keep — file-swap moves the retention problem to the filesystem where it is cheap. |
| How long? | Release policy: 2 minor releases / 90 days after the swap (stored in `storage_meta key='reclaim_after'` at build time). Same policy constant as ideation §6. |
| Disk pressure of the window | 18 GB held on disk. Mitigations: (a) **compress** the old file (diff-patch corpora compress ~4× with brotli → ~4–6 GB, still restorable by decompress+rename); (b) **move** it to a user-chosen backup volume; (c) shorten the window via config (privacy/disk-conscious users). The compressed/moved state does NOT support in-place restore without a decompress step — document that. |
| Reclaim | Delete (or move) `opencode.db.pre-oses` when `now ≥ reclaim_after` and the window is expired. **No VACUUM over 18 GB** — the new file was built compact. This is the decisive reclaim-economics win over in-place shadow. |
| Reverse export after reclaim | Only then does `opencode storage rollback` (§5.2) become the downgrade path. If the old file was compressed rather than deleted, restoring it remains the cheaper option. |
| Backup semantics | Unchanged from ideation §9: `VACUUM INTO` (gated on the sqlite_version/compile_options probe folded into the codec capability probe) or checkpointed copy + integrity_check. Both the legacy file and the new file are single self-contained SQLite files. |

---

## 8. Old-client compatibility at the swap boundary

- **Old binary + untouched legacy file:** unchanged (until the swap).
- **Old binary + new (OSES) file:** the new file keeps the `event` table as the OSES hot tail and `event_sequence` byte-identical, so an old binary opens it, runs its (already-applied) migrations, reads `event` — and sees **only the hot tail**; sealed history is invisible to it. This is silent truncation, not a crash: the old-binary exposure window opens exactly at the swap. Mitigations (unchanged, now cleaner): the swap happens only in releases whose previous-version support contract is expired; the `.pre-oses` restore is the downgrade path; upgrade notes state the boundary explicitly.
- **New binary + unknown epoch:** fail closed at Database-layer construction (`MIN_READER_EPOCH` check), never open unknown representation read-write (ideation §4.2 stands).
- **`opencode db` shell:** path unchanged (`opencode.db`); after the swap the shell sees the new file's routing columns (readable) and opaque BLOBs (payloads need the codec) — as before; and it can no longer open the DB mid-swap on Windows (file-lock fence).

---

## 9. Open questions (architecture-phase)

1. **Tier M/L crossover and the disk formula** must be pinned by benchmark on the real corpus: at what `legacy bytes` does background+swap beat synchronous startup rebuild on wall-clock *and* disk? (benchmark-arch owns the numbers; the protocol shape is fixed regardless.)
2. **Catch-up capacity under a live busy writer:** the rebuild's replay must keep lag small while a heavy session streams `message.part.updated`. Measure the steady-state catch-up rate (source read + dedup + encode) vs the app's durable-write rate. If a user session can out-run the pass, define the escape: suspend catch-up during active streaming and swap at the next quiescent startup (correct, just later) — acceptable for a single-user desktop.
3. **`event_value` sizing vs the value table in OSES v1:** value-table promotion is the Pareto move per the ground truth, but the threshold constants (≥ 1 KiB, ≥ 2 recurrences) and the extractor registry (`info.summary` + discovery of `metadata`/`tool.*`) need the whole-DB aggregate scan (destructuring doc §6.1–6.3) before the v1 registry is locked. Does the value table ship in OSES v1 or v1.1? (Recommendation: v1 — it is the byte story of this corpus.)
4. **Compressed `.pre-oses` restore semantics:** if the rollback artifact is brotli-compressed, restore = decompress + rename. Confirm this is acceptable as the *only* rollback path when compressed (or keep an uncompressed flag for high-disk users).

---

## 10. Must-benchmark section (migration lane)

**Artifact source:** all rehearsal benchmarks run against benchmark-arch's corpus **D8** — the 18 GB-scale rehearsal pair (pre/post snapshots + logical stream + kill-sweep clones), plus the T0 sanctioned snapshot (read-only, bounded-sampled). Numbers below are claims that must carry a corpus id@version; none are accepted without one.

1. **Rebuild throughput on the 18 GB snapshot**: bytes/s source read (TEXT), **span-walker throughput (~50–150 MB/s expected — the R9 number to confirm, not native JSON.parse)**, hashing rate, brotli encode rate of the post-dedup remainder, per-batch tx duration, and wall-clock across idle windows. Anchors the Tier L pacing constants.
2. **Whole-DB dedup fraction — the D2/D3/D4 bounded scan (corpus lane; read-only vs S0.1, per §3.1).** The concrete measurement asks (oses-arch storage.md, answered by this scan and consumed by my §6.1 estimator): (1) whole-DB elimination fraction — bounded per-aggregate scan of `message.updated` + `session.updated`, distinct-vs-total bytes; (2) distinct-value histograms per path → `SIZE_THRESHOLD` / `JUMBO_PROMOTE`; (3) other-path scan (`info.metadata`, `tool.input`, `result` — ≥ 1 KiB, ≥ 2×?); (4) per-aggregate distinct-value byte totals (table size + the ≥ 4 GiB-aggregate / ≥ 64 MiB-single-value externalization gate); (5) first-copy waste fraction (single-occurrence rate of recurring values). Output calibrates `expected_new_file` and locks the v1 extractor registry.
3. **Catch-up steady state** vs a simulated busy writer (corpus op-stream at S3/S4 intensity): does lag shrink monotonically, and what is the worst-case lag at swap trigger?
4. **Swap recovery fault-injection**: kill at K-SW-0..5 on D8 kill-sweep clones; assert the pinned-ordering outcomes (recovery 1a/1b, swap-decision 2, resume 3) and the "never both/neither" invariant.
5. **New-file WAL behavior during bulk build** on the packaged Electron runtime: `wal_autocheckpoint` raise vs per-batch PASSIVE checkpoint; WAL log-pages growth and the crossing-commit cost (ideation §14.3 metric).
6. **Reverse-export re-inflation throughput** (hot rows + segments + value-refs → legacy TEXT) and its fault-injection matrix (K-RE-0..8), on a seeded multi-GB OSES file from the D8 post-snapshot.
7. **Disk formula validation (both modes)**: measure actual peak volume usage during a Tier L rebuild on a D8 clone — Mode A (same-volume) and Mode B (cross-volume) — and calibrate the safety margin (proposed 10% / min 4 GiB). **The Mode B final-move IS the user-facing gate (R8-confirm):** the D8 rehearsal must validate the cross-volume final-move at scale — the swap-time FULL checkpoint + resumable byte-copy of a multi-GB `.new` (manifest + sha256 verify), including mid-copy failure/resume and sha256-mismatch abort, on real filesystem timings. The multi-hour rebuild is invisible to the user; this one copy is the only user-visible I/O of the whole migration, so its wall-clock, resume behavior, and failure handling are rehearsal-gated, not assumed.
8. **PARTIALLY-OCDB-FRAMED INPUT LEG (adversary R1-D3; the population reality for users who ran the fork sealer):** clone the snapshot, run the fork sealer over a bounded sample, and rehearse the rebuild's `decompressFrame`-first path end-to-end — throughput (inflate-rate per row added to both passes), correctness, and the framed-leg `expected_new_file`. Rebuild/catch-up estimates are currently pristine-TEXT-only and must not be published as universal. 

---

## 11. Headline migration decisions (summary)

1. **Rebuild-to-new-file + swap replaces the in-place shadow protocol as the primary path.** The legacy file is never mutated; the "epoch flip" is two renames with a 3-rule recovery; the K9.2 mid-flip transaction windows are eliminated by construction. In-place shadow survives only as the disk-constrained fallback.
2. **One protocol, three paces**: synchronous file rebuild at the startup fence (small), background rebuild + catch-up + swap (mid), background multi-session rebuild + catch-up + swap (large — the 18 GB case). The gate is about *pacing*, not about a different mechanism.
3. **The rebuild IS the value-table backfill**: per-aggregate two-pass (hash inventory, then emit with `event_value` promotion + segments), type-aware extractor registry led by `message.updated.1 → info.summary`, exactness-guarded (`sha256` on emit, deep-equal on decode) to preserve replay semantics.
4. **Rollback window = the old file.** While `.pre-oses` exists, downgrade is a file restore (no reverse export). Reverse export (re-inflate value-refs + decode segments → plain JSON TEXT, fault-injected, atomic-with-verification) is required only after the window closes. Reclaim = delete the file; no VACUUM over 18 GB.
5. **Detection is a cheap preflight**: sqlite_master probe distinguishes pristine TEXT / OCDB-framed / OSES instantly; both measured DBs are pristine TEXT and take the primary rebuild path.

---

## 12. Round-2 adversarial strengthening (revision record)

First revision to this chapter (adversary R2 + coordinator routing; the chapter previously had none):

- **NEW-R7 — swap-pending marker + pinned startup ordering (correctness/UX hole, FIXED in §4.2):** recovery rule (c) previously fired identically for "rebuild in progress" (abort correct) and "rebuild complete, swap pending" (must swap), making the normal completed-rebuild startup abort forever. Fix: `oses_migration.phase='verified'` in the new file is the **swap-pending marker**, set only after VERIFY at a quiescent final catch-up; startup ordering is now pinned — (0) read-only pre-flight incl. marker check → (1) crash-window recovery (1a complete swap / 1b restore / 1c truly-unexpected abort) → (2) swap decision **only when the marker is present** (final catch-up 2a → re-verify 2b → renames 2c → stale-WAL 2d) → (3) marker-absent = rebuild-in-progress = RESUME, not abort. Kill points re-mapped to K-SW-0..5 incl. the pre-swap ready state (K-SW-0).
- **NEW-R8 — cross-volume rebuild (user-facing disk gate, FIXED in §6):** `.new`'s only writer is the rebuild, so it need not live on the DB volume. **Mode B (cross-volume) is now the Tier-L default** when DB-volume free is tight: build on a scratch/backup volume (~5–8 GB), FULL-checkpoint + resumable byte-copy to the data dir at swap time, then the same renames. The ≈26–30 GB same-volume bound (Mode A) remains for headroom-rich volumes; the free-disk decision runs at rebuild start and re-checks at swap. In-place shadow remains only when both modes are unavailable.
- **NEW-R9 + R1-D3 — rebuild cost revision + framed-input leg (FIXED in §3.2/§10.8):** the "JSON.parse+hashing ≈ 1–3 min" estimate was stale — the span-walker runs ~50–150 MB/s (not native parse) and the corpus is walked TWICE (pass 1 + pass 2) → revised to **≈ 5–15 min CPU spread over idle windows**. D8 rehearsal gains a **partially-OCDB-framed input leg** (clone + fork-sealer sample → `decompressFrame`-first path end-to-end, incl. inflate cost per row added to both passes); pristine-TEXT-only numbers must not be published as universal.

### 12.1 Round-3 optimization (O7 + R8-confirm)

- **O7 — page_size at rebuild creation (FIXED in §3.1, refined by oses-arch storage.md §4.4):** the new file is born fresh, so `PRAGMA page_size` is set at file creation before any table exists — zero migration cost, no VACUUM over 18 GB. Sequencing pinned: open empty file → `PRAGMA page_size=<D7-selected>` → `schema.up` + seeded migrations. Range is **{8, 16, 32} KiB** (D7 sweep correlates page_size ∈ {4, 8, 16, 32} KiB with the 32 KiB frame lock); a 16 KiB page holds a whole 16 KiB frame (segment-BLOB fetch ~8 pages → 1), 32 KiB aligns with the frame lock. The **pristine legacy file keeps its 4 KiB pages** — page_size applies only to the born-fresh OSES file. Page size is a storage/readpath parameter; the rebuild merely applies it at creation (cache-budget interaction flagged).
- **R8-confirm — cross-volume final-move is the user-facing gate (FIXED in §10.7):** D8 rehearsal must validate the Mode B final-move at scale — FULL checkpoint + resumable byte-copy of a multi-GB `.new` (manifest + sha256 verify), mid-copy failure/resume, sha256-mismatch abort — on real filesystem timings. The multi-hour rebuild is invisible; this one copy is the only user-visible I/O of the migration and is rehearsal-gated, not assumed.
