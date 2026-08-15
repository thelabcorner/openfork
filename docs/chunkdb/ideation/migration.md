# Migration, Epoch Cutover, Rollback & Compatibility Ideation

**Author lane:** migration-arch (swarm `chunkdb-ideation`) — Migration, epoch cutover & rollback architect.
**Baseline:** `openfork` branch (fork of `v1.18.18`, latest commit `fc19430c2c`).
**Status:** IDEATION ONLY. No implementation code. Schema sketches are design artifacts for the implementers.
**Sibling docs:** `docs/chunkdb/architecture-research.md` (the shared research doc this ideation extends and corrects).

---

## 0. What the fork already has (ground truth this ideation must build on)

Before proposing anything, three fork-owned facts that the research doc did not know about:

1. **A resumable backfill idiom already exists and is in production on this branch.**
   - `20260812000001_session_search_v1_fts.ts` adds `part.search_text`, the `part_fts` FTS5 external-content virtual table with AI/AD/AU triggers, and a single-row cursor table `part_search_backfill(id, watermark_rowid, done)`.
   - The DDL migration is deliberately **DDL-only**; the data pass is `SessionSearch.backfillParts` (`packages/core/src/session/search.ts`): chunked `rowid > watermark` scans, one short transaction per chunk, **watermark advanced inside the chunk transaction**, `Effect.yieldNow` between chunks, `retryOnLock` (exponential backoff 250 ms·2ⁿ capped 30 s + jitter) for WAL writer contention.
   - It runs on a **dedicated second SQLite connection** — `Database.withBackfillDb(filename, ...)` (`packages/core/src/database/database.ts`) — so it never takes the shared in-process client semaphore, and it is gated by an explicit flag (`SessionSearch.automaticBackfillEnabled()`) forked at projector layer construction.
   - This is the exact skeleton OSES shadow backfill should inherit. **Do not invent a new pattern.**

2. **A chunked cold-row sealer prototype already mutates `event.data` in place.**
   - `packages/core/src/database/chunk-sealer.ts` (fork-owned, "t6 slice") frames `event.data` rows ≥ 4096 code units into **OCDB frame v2** BLOBs (`json-codec.ts`: magic `OCDB`, version byte, codec byte, rawLen, CRC32; `toDriver` is identity, `fromDriver` decodes TEXT | frame v2 fail-closed). It journals every mutation into `ocdb_seal(table_name, row_id, raw_bytes, stored_bytes, time_sealed)` and uses a partial expression index `idx_event_seal_candidates ON event(aggregate_id, seq) WHERE typeof(data)='text' AND length(data)>=4096`.
   - **Consequence:** on the `openfork` branch, the "legacy `event` table" today is *not* plain JSON TEXT. Large rows are already binary frames. Any OSES shadow backfill must **decode OCDB frames back to JSON** before re-encoding into OSES, and OSES reclaim must decide the fate of `ocdb_seal` + `idx_event_seal_candidates`. This is a correction to every "legacy event row" assumption in the research doc's migration sections.

3. **A runtime-created JSON expression index that silently breaks if `message.data` becomes BLOB.**
   - `packages/core/src/session/usage.ts` runs `CREATE INDEX IF NOT EXISTS idx_message_provider_id ON message (json_extract(data,'$.providerID'))` at layer construction (not in a migration) and queries `message.data` with `json_extract` for `providerID`, `role`, `cost`, `time.created`.
   - If OPCL converts `message.data` to a framed BLOB, `json_extract` on a BLOB returns NULL for every row: the index becomes an all-NULL index and `SessionUsage.rows/windows` **silently return nothing** — no error, no migration failure. This is the concrete instance of the research doc's §21.4 "migrate to native routing column before BLOB writes", and it must be called out as a *silent* break, not a loud one.

---

## 1. Corrections to the research doc vs the real `openfork` code

| Research doc claim | Reality on `openfork` | Correction for the implementation plan |
|---|---|---|
| §9.1 "migration layer creates/uses a `migration` table" | True, but `apply()` has a third path: **empty DB → `schema.up()` + seeds every migration as completed** (`migration.ts:24-38`). | Every new OSES/OPCL table must land in **both** the drizzle `schema.gen` (fresh installs) **and** a migration file (upgrades) — otherwise fresh DBs diverge from migrated DBs. The drizzle-kit generator (`packages/core/script/migration.ts`) does this for you; use it, don't hand-write `migration.gen.ts`. |
| §25.2 proposes a new `oses_migration` table | The repo already has a `data_migration` table (`20260511000411_data_migration_state.ts`) that is **unused / vestigial** — and the fork's own FTS work did *not* use it; it used the watermark-cursor idiom above. | Follow the `part_search_backfill` + `withBackfillDb` + `retryOnLock` idiom, extended with a `phase` column. Do not resurrect `data_migration`. |
| §9.3 "a migration used json_extract" (session_usage) | Verified. **Plus** the runtime-created `idx_message_provider_id` and `SessionUsage` json_extract queries (see §0.3). | OPCL batch conversion must be preceded by: native routing columns, `SessionUsage` rewritten to them, expression index dropped. |
| §25 "legacy event rows" are JSON TEXT | Large `event.data` rows are already **OCDB-framed BLOBs** from the fork's sealer. | OSES backfill decodes frames; rollback/reverse-export must re-frame or restore TEXT; `ocdb_seal` journal is part of the migration input inventory. |
| §25.5 "compression outside transactions; one commit at a time" | The fork's sealer already does this per-row (UPDATE + journal UPSERT in one short tx, yield between batches). The fork also has the **second-connection + lock-retry** answer to WAL contention. | Backfill and sealing use `withBackfillDb`-style connections, not the shared client. |
| §27/§26 assume `opencode db` raw SQL | Verified: `opencode db <query>` runs SQL through the app, and `opencode db` with no args spawns an **external `sqlite3` shell** on `Database.path()` (`packages/opencode/src/cli/cmd/db.ts`). | External `sqlite3` will see OCDB/OSES BLOBs. Routing columns must stay readable; payload stays opaque. Also: an external shell can `UPDATE`/`DELETE` OSES rows while the app is not running — epoch/segment integrity cannot be enforced by the shell, so the app must tolerate (detect + fail closed on) externally corrupted invariants. |

---

## 2. Migration sequence mapped onto this repo's migration workflow

### 2.1 Naming/authoring conventions to respect

- Migrations are drizzle-kit generated: `bun migration --name <name>` (see `packages/core/script/migration.ts`) → creates `packages/core/src/database/migration/<timestamp>_<name>.ts`, regenerates `migration.gen.ts` and `schema.gen.ts`.
- Each migration is `{ id, up(tx) }`, runs **inside one transaction** (`applyOnly` wraps `up` + the `migration` row insert in `db.transaction`). Long-running data work must never live inside `up`.
- Fresh-DB path seeds all migrations as done after `schema.up` — so schema drift between fresh/migrated installs is the #1 thing to test.

### 2.2 The concrete sequence (A–E mapped to artifacts)

Every stage is a **binary capability flag + DDL + runtime pass**, never one irreversible switch.

```
STAGE A — reader-capable schema (ship release R1)
  DDL (drizzle migration "storage_epoch_init", one tx):
    storage_meta(key TEXT PRIMARY KEY, value TEXT)   -- epoch row lives here
    oses dictionary tables (oses_aggregate_key, oses_type_key, oses_dictionary)
    oses segment/metadata tables (per oses-arch's design — NOTE: the hot tail is
      the EXISTING `event` table; oses-arch ships NO event_hot rewrite, so no
      event_hot DDL and no hot-row migration. Integer surrogate keys live only
      inside sealed segment metadata; oses_seal journal replaces ocdb_seal once
      the fork sealer retires.)
    oses_migration cursor table (see §3)
  Runtime (new binary only):
    EventStore adapter can READ legacy event + OCDB frames AND OSES shadow;
    writers still go to legacy `event` (identity toDriver — unchanged hot path).
    storage_epoch = 'legacy' (row inserted by the migration).
  Old binary behavior: unaffected — it never reads the new tables.

STAGE B — bounded historical shadow backfill (ship R1, opt-in / canary)
  Runtime pass `OsesBackfill.shadow` (fork of SessionSearch.backfillParts):
    dedicated `withBackfillDb` connection, chunked by aggregate → rowid,
    decode OCDB frames if present, encode OSES microframes/segments OUTSIDE
    the write tx, commit shadow rows + watermark in ONE short tx per chunk,
    yield + retryOnLock between chunks, capped batch bytes.
    Legacy rows remain authoritative. Shadow is read-but-ignored until epoch flips.
  Crash here: watermark not advanced ⇒ chunk re-runs; idempotent (dedupe by
  (aggregate_key, seq) with INSERT OR IGNORE + verified-segment commit).

STAGE C — catch-up + atomic epoch cutover (ship R2, flag-gated default-off)
  Fence: STARTUP fence, per contract-arch (Q1 RESOLVED — see §12). The desktop V1
  server is a long-lived Electron utilityProcess with no reliable shutdown idle
  window, and a mid-run fence (drain in-flight prompt loops + reject publishes)
  is a product-visible freeze. Stage C therefore runs at server boot, BEFORE the
  HTTP listener starts, guarded by the epoch UPDATE. Cross-process exclusion
  (a concurrent CLI / second session) comes from the guarded single-row UPDATE
  (WHERE value='legacy') + WAL write-lock — not from app-level coordination.
  Startup-latency budget is a GATE: catch-up must stay under the app's
  load-to-ready budget, or Stage B's shadow protocol must run longer pre-cutover
  (mirrors how the fork already tolerates startup migration + search backfill).
  Catch-up:
    - for DBs within the §2.3 direct-conversion gate: one synchronous bounded pass;
    - for huge DBs: a final bounded catch-up (B resumes to the seq frontier), then flip.
  Flip = ONE transaction on the primary connection:
    BEGIN IMMEDIATE
      read event_sequence max per aggregate (the frontier) — READ ONLY.
        event_sequence is the SYNC-FENCE authority (oses-arch: hot-tail keeps it
        byte-identical; fence.ts/control-plane read it raw) — the flip MUST NOT
        write, alter, or rename it.
      catch-up-verify: shadow rows == legacy rows for (count, id, type, seq, crc)
      UPDATE storage_meta SET value='oses-v1' WHERE key='epoch' AND value='legacy'
      (the WHERE makes a second process's flip fail the tx — see §10)
    COMMIT
  After commit: EventStore adapter flips its write path to event_hot.
  Crash before COMMIT → epoch still 'legacy', shadow present, all recoverable.
  Crash after COMMIT → new epoch; old binary now blocked; reverse export (§5) is
  the only way back. This is the designed-for boundary, not an accident.
  (Note: reverse-export DOES upsert event_sequence.seq to the restored frontier —
  that is the rollback path restoring legacy-writer semantics, consistent with
  event_sequence remaining the fence authority; only the FORWARD flip is
  read-only on it.)

STAGE D — rollback window (R2 … R2+N releases)
  Legacy `event`/`event_sequence` kept, read-only, untouched by new writes.
  Downgrade = run the reverse-export tool (§5) which is REQUIRED to exist and
  be fault-tested BEFORE R2 ships. See §6 for window length and reclaim.

STAGE E — reclaim (R2+N)
  Maintenance pass `opencode storage reclaim`:
    verify reverse-export tool has been exercised at least once on a copy
    (release policy), then DROP event / event_sequence / ocdb_seal /
    idx_event_seal_candidates, checkpoint PASSIVE, optional VACUUM when safe,
    log reclaimed bytes (research doc §32.1 metric sqlite.wal_bytes etc.).
```

### 2.3 The small-DB short-circuit (challenging the shadow protocol)

A 420 KiB reference DB does not need a shadow store. Propose a **size gate**:

- If `event` row count < `DIRECT_CUTOVER_EVENTS` (benchmark; hypothesis 25k) **or** legacy event bytes < `DIRECT_CUTOVER_BYTES` (hypothesis 256 MiB) → skip Stage B entirely; do a **synchronous, bounded, resumable-in-restart** conversion inside a startup fence: convert all legacy+frame rows to OSES, verify, flip epoch, all before the server accepts the first request. Progress state still lives in `oses_migration` so a crash mid-way resumes on next start (idempotent by (aggregate_key, seq) dedupe).
- The shadow protocol is only exercised above the gate, where backfill genuinely takes minutes-to-hours and must not block startup.

This collapses A–E to A → (B+C fused) → D → E for the 99% desktop case and keeps the full protocol for the pathological multi-GB case. **The research doc's 5-stage protocol is not over-engineered for big DBs; it is over-engineered for small ones unless the gate exists.**

---

## 3. `oses_migration` resumable state (extends research doc §25.2)

Follow the fork's watermark idiom, with a `phase` column so one job row drives the whole lifecycle:

```sql
-- PROPOSED SCHEMA (design artifact; created by the storage_epoch_init migration, DDL only)
CREATE TABLE oses_migration (
  name              TEXT PRIMARY KEY,          -- 'oses-shadow', 'oses-catchup', 'oses-reverse-export'
  phase             TEXT NOT NULL,             -- 'building' | 'verified' | 'flipped' | 'exporting' | 'done'
  aggregate_cursor  TEXT,                      -- last aggregate id processed (lexical resume)
  sequence_cursor   INTEGER,                   -- last seq processed within that aggregate
  watermark_rowid   INTEGER NOT NULL DEFAULT -1, -- legacy event rowid high-water (fork idiom)
  rows_done         INTEGER NOT NULL DEFAULT 0,
  raw_bytes_done    INTEGER NOT NULL DEFAULT 0,
  stored_bytes_done INTEGER NOT NULL DEFAULT 0,
  verified_count    INTEGER,                   -- populated by the Stage C verification step
  verified_crc      TEXT,                      -- aggregate hash of (id,seq,type,crc32(data)) — see §4
  time_started      INTEGER NOT NULL,
  time_updated      INTEGER NOT NULL,
  time_completed    INTEGER
);
```

Invariants (each one tested by the fault-injection suite, §10):

- **Progress advances in the same transaction as the shadow writes** — an aborted chunk leaves the cursor at the last committed watermark, so a kill/restart simply re-runs from the cursor. This is the `part_search_backfill` guarantee, verified in `search.ts` and `core/test/session-search.test.ts` (resume-after-kill cases).
- **Idempotency by content, not by cursor**: shadow inserts use `INSERT OR IGNORE` keyed on `(aggregate_key, seq)` so a re-run never duplicates; a partially written segment is never committed (segment commit is one tx: segment row + high-water delete, matching seal-commit semantics).
- **`phase` transitions are one-row UPDATEs inside the same tx as the work that completes the phase.** `'building' → 'verified'` happens inside the Stage C verification tx; `'verified' → 'flipped'` is the epoch-flip tx itself (single row update of `oses_migration` + `storage_meta`).
- A `done=1`-style terminal check at pass start makes re-runs no-ops (mirrors `setPartBackfillDone`).

---

## 4. `storage_epoch` — where it lives, how binaries gate, what an old binary sees

### 4.1 Storage

- **Canonical location:** `storage_meta(key, value)` single-row table, `key='epoch'`, values `'legacy' | 'oses-v1'`, plus `key='min_reader_epoch'` if we ever need to express "readers below X are refused" (future-proofing; not needed for the first flip).
- **Mirror into `PRAGMA user_version`** (one `PRAGMA user_version = N` on flip) so *external* tools (`sqlite3` shell, `opencode db`) can cheaply see the epoch without a join. `user_version` is advisory only; the table row is authoritative.

### 4.2 New-binary gating (fail-closed)

- Read epoch in the `Database` layer **after migrations, before any Event service or read path** is constructed. Compare against the compiled-in `MIN_READER_EPOCH`. On mismatch (e.g. a downgraded binary meeting `'oses-v1'`), fail with a typed, user-facing error — the research doc's "fail closed; never overwrite an unknown representation" — and **do not** open the DB read-write for the storage services. The desktop UI should show: *"This database uses a storage format from a newer version of OpenCode. Downgrade is available via `opencode storage rollback` (requires the newer version once more, or a backup)."*
- Gate is checked once at startup on the primary connection; the backfill connection inherits the epoch from the file it opens (it must also check before writing).

### 4.3 What an OLD binary (pre-OSES) actually does — and why that can't be "fail closed"

An old binary knows nothing about `storage_meta` or OSES tables. It will:
1. run its own migration list (all present → no-op), then
2. read `event` — which still exists during the rollback window and is **stale or empty after cutover** (new writes went to `event_hot`), and
3. hit `json_extract` on any OPCL-framed `message.data` — which returns NULL silently.

So an old binary does not crash loudly; it **silently loses or misreads data**. The only real protections are:
- **Release policy:** OSES cutover (R2) only ships in a release whose *support contract for the previous version has expired* or which carries an auto-run reverse-export on downgrade (impractical for offline desktop — accept this and rely on the rollback window + tooling).
- **The rollback window itself:** old binaries keep working correctly *until cutover* because Stage A/B leave legacy rows authoritative. The instant the epoch flips, the window opens for *using the new binary* to reverse-export; the old binary alone is not safe. This must be stated in the upgrade notes.
- **Marker for old binaries that read `PRAGMA user_version`:** an old binary that happens to assert `user_version` (none currently do) would fail closed naturally; low cost, worth setting anyway.

---

## 5. Reverse export — the exact steps, and why it must be tested code

**Rationale (research doc §27 conclusion):** there is no free backward compatibility; the reverse exporter *is* the downgrade path, so it must be a first-class, fault-tested maintenance command, not a paragraph.

### 5.1 The operation (`opencode storage rollback` / `opencode db export-legacy`)

```
1. PREFLIGHT
   - assert epoch == 'oses-v1' (a rollback on 'legacy' is a no-op success).
   - assert no live OSES writer: the command runs against a closed/quiet DB
     (single-user desktop: app exited, or the command is a maintenance subcommand
     of the running server that takes the write fence itself).
2. WRITE-FENCE
   - BEGIN IMMEDIATE on the primary connection; take the same single-writer
     guarantee the sealer uses. Optionally checkpoint PASSIVE first so WAL is small.
3. READ OSES HISTORY, EXACTLY
   - iterate aggregates in key order; per aggregate read hot rows (rowid order)
     then sealed segments in (segment_seq_low asc) order; decode microframes;
     unpack event IDs (§1.5 of research doc) back to canonical `evt_` IDs;
     reject any noncanonical escape by failing the export (never synthesize IDs);
   - RECONSTRUCT elided fields: oses-arch ships ONE semantic-elision rule —
     `data[sessionID]` is elided for every durable type (commitDurableEvent
     enforces the invariant at publish), so reverse export must re-inject
     `sessionID` from the aggregate envelope before writing legacy rows.
4. WRITE LEGACY ROWS (in the SAME tx per chunk)
   - upsert event_sequence(aggregate_id, seq) to the frontier;
   - insert event(id, aggregate_id, seq, type, data) with data as **PLAIN JSON TEXT,
     never OCDB frames** (codec-arch decision, §12 Q2 RESOLVED): rollback exists to
     let an OLD binary read the DB, and old binaries have no frame decoder;
     exporting frames would re-create the incompatibility being rolled back from.
   - unframe mechanism: the fork's `ocdb_seal` journal (table_name, row_id) is the
     exact set of framed rows — unframe those to TEXT, leave never-framed TEXT rows
     untouched, and verify crc32(data) per row against the frame header. A fresh
     sealer re-frames from TEXT idempotently afterward if the fork path ever needs
     compression again.
   - chunk by ~500 rows / 4 MiB with watermark advance (fork idiom), retryOnLock,
     yield between chunks.
5. DECODE OPCL PROJECTION ROWS
   - message.data / part.data / session_message.data / session_input / snapshots:
     decode framed BLOBs back to canonical JSON TEXT.
   - THIS MUST PRECEDE step 6 (index rebuild) so expression indexes are valid.
6. REBUILD JSON-DEPENDENT ARTIFACTS
   - DROP + recreate idx_message_provider_id (or better: the target release keeps
     native routing columns — see §11), and confirm part_fts / session_message_fts
     triggers still fire on search_text (they are data-independent of the blob
     shape; verify by a post-export FTS row count).
7. VERIFY (mandatory gate, same tx discipline)
   - per-aggregate: legacy count == OSES count; every (id, seq, type) matches;
     crc32(data) matches (the verified_crc recorded at flip);
   - `PRAGMA integrity_check` + `PRAGMA foreign_key_check`;
   - projection spot-check: message/part row counts and a sample decode equal.
8. FLIP EPOCH BACK
   - UPDATE storage_meta SET value='legacy' ... in the final tx; PRAGMA user_version = N-1.
9. POST
   - PASSIVE checkpoint; leave OSES tables in place (they are inert under 'legacy'
     epoch and can be dropped by reclaim); write a rollback receipt row
     (oses_migration phase='done') for audit.
```

### 5.2 Why it must be tested code (not a design doc paragraph)

- **Idempotency + resumability:** a crash in step 4 must leave the DB in a state where re-running the tool resumes from the watermark and the verification step (7) rejects a half-exported DB. A "paragraph" design cannot prove this.
- **It is the only downgrade path**; if it is subtly wrong (ID packing round-trip, frame decode, ordering), users are stranded on the new format with old releases. That risk is a product decision, and it must be backed by the §31.8 fault-injection matrix (kill during export, kill during flip-back, corrupt one segment mid-export).
- **The flip-back must be atomic with verification** so an interrupted rollback never leaves a half-legacy/half-OSES DB readable by the old binary — that is the exact silent-corruption scenario §27 forbids.
- The command itself must be shippable inside the packaged desktop (`packages/opencode/src/cli/cmd/`) and reachable headless, mirroring how `opencode db` exists today.

---

## 6. Rollback window strategy

| Question | Proposal |
|---|---|
| How long are legacy tables retained after cutover? | **Until 2 minor releases or 90 days after the first release that defaults cutover on, whichever is later**, AND until the reverse-export tool has been fault-tested in CI for that release. Window is a **release-policy constant**, stored in `storage_meta` (`key='reclaim_after'`) at flip time so reclaim never happens earlier than the DB was promised. |
| What is retained, exactly? | `event`, `event_sequence`, `ocdb_seal`, `idx_event_seal_candidates`, and legacy TEXT copies of `message/part` payloads. **Not** dual-write: legacy is read-only dust after flip. |
| When does reclaim happen? | Explicit maintenance pass (`opencode storage reclaim`), gated on: epoch == 'oses-v1', now ≥ reclaim_after, and a recorded successful reverse-export test run on a copy (release-level CI gate, not per-DB). Never automatic at startup. |
| What if the user needs to go back after reclaim? | Not supported. The backup made at cutover (§9) is the last-resort path. This is a stated product decision, matching research doc §25.6 ("set legacy epoch; only then launch old binary"). |
| Should reclaim VACUUM? | Optional and only when the pass can run with the app otherwise idle; measure reclaimed bytes before/after (research doc metric). Freelist-page reuse may make VACUUM unnecessary for months. |

---

## 7. Disk-space model during backfill

Legacy + shadow coexist, so the naive "compression saves disk" intuition is wrong mid-migration. Formula (research doc §25.4, now with concrete terms):

```
required_headroom = legacy_db_bytes
                  + estimated_oses_shadow_bytes        (measure from a sample aggregate;
                                                        hypothesis 40–70% of legacy event bytes)
                  + migration_wal_high_water           (measured; see §8)
                  + safety_margin                       (proposed: 10% of total, min 256 MiB)
```

- **Refuse/pause, don't degrade:** `OsesBackfill.shadow` checks free space (via `fs.statfs` on the DB's volume, or `PRAGMA freelist_count`-based estimate plus a filesystem free-bytes read) before each chunk batch. Below the bound → pause (retain watermark), log, resume when headroom returns. Never let backfill push the volume to zero while the app is also writing projections.
- **The small-DB gate (§2.3) sidesteps this entirely** for typical installs: a synchronous conversion's WAL high-water is bounded and the shadow estimate is the actual result, so the check is a simple pre-flight assert.
- Freelist reuse means "legacy dropped at reclaim" may *not* shrink the file immediately — report `VACUUM` as an explicit opt-in, and never assume reclaim == freed bytes.

---

## 8. WAL/checkpoint policy during backfill and sealing (Electron runtime)

Facts that frame this (all verified on this branch):

- PRAGMAs are `journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000, cache_size=-64000, foreign_keys=ON` + one `wal_checkpoint(PASSIVE)` at open.
- The packaged desktop server is a **Node 24.15 utility process** (`node:sqlite` `DatabaseSync`), one connection + one-permit semaphore. `withBackfillDb` proves a second writer connection works, but WAL allows **one writer at a time** — hence `retryOnLock` already exists.
- The fork's sealer already: compresses outside any tx, one short tx per row, `Effect.yieldNow` between batches, `MAX_ROWS_PER_PASS` cap.

Proposals:

1. **Keep default `wal_autocheckpoint = 1000` pages for interactive operation.** The research doc's caveat is right: the commit that crosses the threshold inherits PASSIVE checkpoint work. Measure, don't assume; only raise if sealing/backfill commit p99 regresses.
2. **For bulk phases, do NOT touch `wal_autocheckpoint` globally.** Instead, on the *backfill/seal connection*, run explicit `PRAGMA wal_checkpoint(PASSIVE)` **between chunk batches** (when no live app tx is running) so WAL bytes stay bounded without a heavy checkpoint on an interactive path. This is a per-connection, per-phase policy; the app's own connection keeps the default.
3. **Cap WAL growth attributable to maintenance**: monitor `PRAGMA wal_checkpoint`'s returned `(busy, log, checkpointed)` after each scheduled checkpoint; if `log` exceeds a bound (hypothesis 32 MiB) between batches, shrink the batch size instead of checkpointing harder. Research doc's `sqlite.wal_bytes` / `sqlite.checkpoint_ms` metrics are the acceptance gates.
4. **Never FULL/RESTART checkpoint on an interactive path** (research doc agrees). If a restart checkpoint is ever needed (reclaim), schedule it when the server is idle or at shutdown.
5. **Electron specifics:** no OS-level `nice(2)` from the utility process; "background-ness" must be expressed in-process. Use `Effect.yieldNow()` between chunks (already the idiom), gate maintenance behind the `automaticBackfillEnabled()`-style flag, and — if interactive p99 ever regresses — suspend maintenance via the adaptive-sealer control (research doc §32.3) rather than tuning SQLite knobs.
6. **Sealing follows the fork sealer's per-row/short-tx discipline**, generalized to segment commits: build compressed segment bytes outside any tx; commit = one tx (`INSERT segment + UPDATE hot prefix deletion`), one commit at a time; `Effect.yieldNow` + cap per pass.

---

## 9. Backup/restore semantics

- **Self-contained backup = one consistent SQLite file.** Everything needed lives in the DB file: schema, migrations, `storage_meta` epoch, OSES tables, dictionaries, OPCL frames, FTS content (external-content tables `part_fts`/`session_message_fts` are in the same file — automatically covered), search_text, legacy rows during the window.
- **How to take it:** copy `opencode.db` alone is **not** safe while WAL is live. Prefer `VACUUM INTO '<path>'` (checkpointed single-file snapshot, no WAL dependency) **gated on a runtime probe**: `sqlite_version()` + `PRAGMA compile_options` recorded once at startup, folded into the **codec capability probe** (codec-arch decision) with provenance captured per platform. If versions differ materially from the golden matrix, **fall back to checkpointed-copy + `PRAGMA integrity_check`** instead. `opencode db backup <path>` implements this.
- **Must include (checklist):** epoch row + user_version mirror; dictionary bytes (recommendation: **store a copy of any structural/trained dictionary inside the DB** (`oses_dictionary`), so the file is self-contained and survives codec-asset drift — research doc §25.7's "guaranteed immutable decoder dictionary assets" becomes moot); `ocdb_seal` journal; migration table. Exclude: the `-wal`/`-shm` files (the snapshot is checkpointed) and any external cache.
- **Restore semantics:** restore = stop app → replace DB file with the backup (the app has no live WAL to lose) → start app. The epoch gate (§4.2) then decides: if the backup predates cutover it's `'legacy'` (any binary works); if it's `'oses-v1'`, only new binaries open it.
- **Multi-resource caveat (future):** if large objects ever move to the file-backed `Storage` service (research doc §33.8 rejected this for v1 — agree), backup must grow a manifest. For the first OSES version, keep canonical payloads inside SQLite.

---

## 10. Corruption containment — crash windows, mapped

Three crash windows for the store (research doc §26.1, now bound to the fork's actual mechanics) plus the two epoch windows and the reclaim window:

| Window | What's authoritative after crash | Recovery |
|---|---|---|
| Crash while **building** shadow/segment (outside any tx) | Legacy rows + hot rows; no DB mutation from the build | Discard candidate; re-run (idempotent). Nothing to repair. |
| Crash **before** seal/segment COMMIT | Hot prefix authoritative; tx rolled back | Re-run the seal. |
| Crash **immediately after** segment COMMIT | Segment authoritative; hot prefix deleted in the *same* tx | No action; reader uses segment. (This is the fork sealer's per-row property, generalized.) |
| Crash during Stage B backfill | Legacy authoritative; watermark at last committed chunk | Resume from watermark (§3). |
| Crash **before** epoch-flip COMMIT | Epoch still `'legacy'`; shadow present but inert | Re-run catch-up + flip. Old binary still fine. |
| Crash **after** epoch-flip COMMIT | Epoch `'oses-v1'`; old binary blocked by policy | Forward: normal. Backward: reverse export (§5). |
| Crash during **reverse export** | Partial legacy rows, epoch still `'oses-v1'` | Re-run tool; verification step rejects incomplete export; flip-back atomic. |
| Crash during **reclaim** | Legacy tables partially dropped, epoch `'oses-v1'` | Reclaim is restartable/DDL-idempotent (`DROP TABLE IF EXISTS`); if epoch check at start sees tables already gone, it just finishes. |

**Two invariants to hold across all windows:**

1. **The epoch flip is a guarded single-row UPDATE**: `UPDATE storage_meta SET value='oses-v1' WHERE key='epoch' AND value='legacy'` inside the flip tx, and check rows-affected. A stray second writer (WSL path, a stray `sqlite3` shell, a second desktop instance) cannot double-flip or flip from an unexpected state.
2. **No segment ever spans aggregates** (research doc §26.3): a corrupt microframe is contained to one aggregate, and a missing sequence makes the *logical* replay fail deterministically rather than skip — repair is a targeted tool, never an ordinary read side effect.

Resource-exhaustion containment (research doc §26.4): all lengths/offsets/counts validated before allocation, caps on segment/frame/event raw bytes — this is codec-layer work (codec-arch's lane) that the migration flow must *invoke* on every decode during backfill and reverse export, so a corrupt source DB cannot become a decompression bomb mid-migration.

### 10.1 G9 migration/rollback crash-safety gates (benchmark-arch delegation)

benchmark-arch's acceptance-gate table reserves **G9 for this lane** (benchmark.md §7.2, row above G10): "G9 migration/rollback crash-safety gates live with migration-arch; the bench harness provides the pre/post snapshots and differential corpus for those gates." Concrete definition (to be pinned in `bench/gates.json` at corpus-v1 with the other gates):

| Gate | Metric | Proposed target (pin at corpus v1) | Measured via |
|---|---|---|---|
| **G9.1 shadow-backfill resumability** | kill/restart at every chunk boundary and mid-chunk during Stage B | resumes from the watermark; **zero** duplicate shadow rows (dedupe by `(aggregate_key, seq)`); final shadow == legacy (count, id, seq, type, crc) | bench fault-injection harness (§31.8) on the pre-cutover frozen snapshot |
| **G9.2 epoch-flip atomicity** | kill at every statement of the flip tx | exactly one of {`legacy`, `oses-v1`} is readable after restart — never both, never neither; **no committed event lost** (tripwires benchmark veto #2) | kill-sweep over the flip tx (a handful of statements — cheap to exhaust) |
| **G9.3 reverse-export correctness** | OSES → legacy rows vs the frozen **raw-JSON legacy snapshot** produced from the *same logical op-stream* (benchmark-arch's dual-baseline: compare against the RAW-JSON engine output, since reverse export emits plain TEXT, not frames) | byte/logical equality of (id, seq, type, data); `PRAGMA integrity_check` + `foreign_key_check` clean; FTS row counts unchanged | differential harness vs benchmark's frozen legacy snapshots (the same snapshots that anchor G6) |
| **G9.4 reverse-export resumability** | kill at every phase of the 9-step export (§5.1) | re-run resumes from watermark; the verification step **rejects** a partial export; epoch flip-back atomic with verification | fault injection over the export tool |
| **G9.5 reclaim idempotency** | kill mid-reclaim (Stage E) | re-run completes; `DROP TABLE IF EXISTS`-style DDL leaves no partial state; epoch check at start short-circuits if tables are already gone | fault injection |
| **G9.6 old-client boundary** | epoch `'oses-v1'` DB presented to a pre-OSES binary | documented, tested behavior: the binary must not *silently* lose/misread (new binary refuses; old binary's misreads are a documented release-policy liability mitigated by rollback window) | release-level test: assert the old-binary behavior matrix (§27 of research doc) is as documented |

The bench harness contract for G9: it supplies (a) the pre-cutover frozen legacy snapshot, (b) the post-cutover OSES snapshot, and (c) the logical op-stream corpus; the migration fault suite runs kill-sweeps against (a) as a *copy*, never the originals.

### 10.2 Kill-point enumeration for the G9 fault-injection harness (benchmark-arch contract)

Each `K<gate>-<n>` is a **statement boundary** in the running migration. The harness kills the process at the boundary (on a file copy), restarts, and asserts the G9.x invariant. The migration itself must expose its crash-injection points at these boundaries (a `STORAGE_FAULT_KILL=K9.x-n` hook in the maintenance passes) so the harness never guesses.

**G9.2 — epoch-flip tx** (statements in order):

| Kill point | Where | Post-restart invariant |
|---|---|---|
| K9.2-0 | before `BEGIN IMMEDIATE` | epoch `legacy`, shadow present, all recoverable |
| K9.2-1 | after BEGIN, before frontier SELECT | same — tx open, nothing committed |
| K9.2-2 | after frontier SELECT, before catch-up-verify | same |
| K9.2-3 | after verify SELECTs, before epoch UPDATE | same |
| K9.2-4 | after epoch UPDATE, before `oses_migration` phase UPDATE | epoch **flipped** but phase unmarked; restart re-verifies; idempotent |
| K9.2-5 | after phase UPDATE, before COMMIT | nothing committed; epoch `legacy` |
| K9.2-6 | after COMMIT returns | epoch `oses-v1`; forward path; reverse export is the escape hatch |

Invariant for all K9.2-n: **exactly one of {`legacy`, `oses-v1`} readable; no committed event lost** (trips benchmark veto #2).

**G9.1 — shadow-backfill chunk cycle** (same sub-boundaries for every chunk; harness picks first/middle/last chunk):

| Kill point | Where | Post-restart invariant |
|---|---|---|
| K9.1-0 | before candidates SELECT | watermark unchanged; chunk re-runs |
| K9.1-1 | after SELECT, before BEGIN | same — no tx |
| K9.1-2 | after BEGIN, before shadow INSERTs | tx rollback; watermark unchanged |
| K9.1-3 | between shadow INSERTs and watermark UPDATE | partial shadow rows roll back with tx; watermark unchanged |
| K9.1-4 | after watermark UPDATE, before COMMIT | same rollback |
| K9.1-5 | after COMMIT | chunk committed; watermark advanced; re-run adds zero duplicates (`INSERT OR IGNORE` on `(aggregate_key, seq)`) |

Invariant: resume-from-watermark; zero duplicate shadow rows; final shadow == legacy (count, id, seq, type, crc).

**G9.4 — reverse export** (steps of §5.1):

| Kill point | Where | Post-restart invariant |
|---|---|---|
| K9.4-0 | preflight assert | re-run is a clean no-op path |
| K9.4-1 | after fence BEGIN | rollback; export re-runs |
| K9.4-2/3 | per-chunk: SELECT OSES → decode/reconstruct (incl. elided `sessionID`) → legacy INSERTs → watermark → COMMIT | same sub-boundaries as K9.1-0..5; resumable from watermark |
| K9.4-4 | OPCL decode pass | resumable from watermark |
| K9.4-5 | index rebuild | resumable; indexes built before epoch flip-back |
| K9.4-6 | verification step | **partial export is REJECTED** (verification fails, no flip-back) |
| K9.4-7 | epoch flip-back UPDATE | atomic with verification; rows-affected = 1 |
| K9.4-8 | after COMMIT | epoch `legacy`; OSES inert; tool re-runs as no-op |

**G9.5 — reclaim:** every `DROP TABLE IF EXISTS` / PASSIVE checkpoint / (optional) VACUUM is a boundary; DDL is restart-idempotent; the start-of-run epoch + table-presence check short-circuits when tables are already gone.

---

## 11. The fork angle: `part_fts` triggers + the provider expression index during routing-plane changes

- **`part_fts` is external-content FTS5** (`content='part', content_rowid='rowid'`). Its AI/AD/AU triggers read `new.search_text` — they are **payload-shape-independent**, so OPCL framing of `part.data` does *not* break them as long as `search_text` stays a plain column. The projector computes `search_text` from `part.data` at the write boundary, so the OPCL decode boundary must sit *above* `SessionSearch.partSearchText` (opcl-arch's lane; the migration sequencing constraint here is: **`part.search_text` must exist and be populated before any OPCL BLOB write** — the fork's FTS migration already guarantees the column; the OPCL migration must not drop it).
- If the routing-plane change ever **rebuilds** `part` (new table + rename) rather than `ALTER TABLE`-adding columns, the DDL migration must drop + recreate `part_fts` and its three triggers **in the same transaction** and repopulate from `search_text` (or rebuild via the FTS `rebuild` command) — an orphaned external-content FTS pointing at a renamed table is a silent search break. Same for `session_message_fts`.
- **`message.data` json_extract consumers are the hard blocker** for OPCL framing of `message.data` — and opcl-arch's audit narrowed the landmine: the live consumers are **`providerID`, `role`, `cost`** in three sites: `SessionUsage` (`usage.ts`, incl. the runtime-created `idx_message_provider_id`), `fork/credentials.ts`, and the V1 search path (`search.ts` does `json_extract(message.data,'$.role')`). Sequence required: (1) add native `role`/`provider_id`/`cost` columns to `message` (reuse native `time_created` for `$.time.created` filters — no new time column), (2) rewrite `SessionUsage`, fork-credentials, and `search.ts` V1 to those columns, (3) `DROP INDEX IF EXISTS idx_message_provider_id`, (4) only then convert `message.data` payloads. Each of (1)–(3) is a normal drizzle migration; (4) is a bounded OPCL backfill (adopt the fork sealer's batch shape — 128 rows/batch, 5000/pass — rather than the research doc's 500/4 MiB).
- **`part.data` is already BLOB-ready** (opcl-arch: zero json_extract consumers anywhere; FTS is native `search_text`) — part rows can be sealed first with **no routing migration at all**. The `part_fts` external-content triggers only read `search_text`, so framing `part.data` is safe as long as that column survives; any future `part` table rebuild must recreate the vtab + three triggers in the same tx and repopulate from `search_text` (or FTS `rebuild`).
- The fork's **`chunk-sealer` prototype** retires **before** Stage C catch-up begins (contract-arch's contract: sealer retired before OSES cutover; opcl-arch agrees) — stop it from claiming new rows while legacy rows are still authoritative, so the shadow/catch-up snapshot is quiescent; its artifacts (`ocdb_seal`, `idx_event_seal_candidates`) are reclaimed in Stage E. Shadow backfill and the adapter's differential compare must decode OCRB frames (decompressFrame first) — corroborated by oses-arch and contract-arch.

---

## 12. Open questions (for the swarm / implementation phase)

1. **RESOLVED — Stage C fence is the STARTUP fence, not a mid-run fence** (contract-arch): the desktop V1 server is a long-lived Electron utilityProcess with no reliable shutdown idle window, and a mid-run fence is a product-visible freeze. Stage C runs at server boot before the HTTP listener, sized by the §2.3 gate; cross-process exclusion comes from the guarded epoch UPDATE + WAL write-lock. Startup-latency budget is a gate; reverse-export stays the escape hatch if the fence dies mid-transaction (SQLite rollback).
2. **RESOLVED — reverse-export target is plain JSON TEXT, not OCDB frames** (codec-arch, agreed by benchmark-arch): rollback exists to let an old binary read the DB; old binaries have no frame decoder. `ocdb_seal` provides the exact unframe list; verify crc32 per row. Keep frames out of the rollback target even in the "rollback to fork-with-sealer" path — a fresh sealer re-frames from TEXT idempotently.
2. **Reclaim trigger:** is "2 minor releases / 90 days, plus CI-proven reverse exporter" the right policy, or should reclaim be an explicit opt-in flag per user (privacy/disk-conscious users may want aggressive reclaim, enterprise may want long windows)? Research doc §32.5 implies staged default-on; the window constant should be a config, not a hardcoded policy.
3. **Does `PRAGMA user_version` mirroring help or hurt?** Old binaries ignore it today; if a future old release asserts it, the mirror becomes a compatibility lever. Cheap to set; worth confirming nothing in the current fork reads user_version.
4. **Segment-commit vs per-row-commit during backfill:** the fork sealer commits per row; OSES wants one tx per segment build. Under heavy app writes, a multi-microframe segment commit is a longer write tx — is that acceptable at `busy_timeout=5000` on the backfill connection? (Benchmark question; §15.)

---

## 13. Alternatives considered

| Alternative | Verdict | Why |
|---|---|---|
| Sustained dual-write (legacy + OSES for N days) | Rejected as default | Doubles event WAL traffic and every durable publish tx; the research doc's "no sustained dual-write" (§25.1) is correct. Shadow + flip achieves the same safety without the tax. |
| Single synchronous migration for everything (no shadow) | Accepted for small DBs only | The §2.3 gate makes this the *default* path for typical installs; shadow protocol is for the multi-GB tail. |
| `PRAGMA user_version` as the *only* epoch store | Rejected | Integer-only, no room for `min_reader_epoch`/`reclaim_after`, and invisible to the app's own gating code in a structured way. Table is authoritative; user_version is a mirror. |
| Reverse export as a documented procedure, not a tool | Rejected | §5.2 — the downgrade path must be fault-tested code; a procedure is not verifiable. |
| Copy `opencode.db` alone as backup | Rejected | WAL-live copies are inconsistent (research doc §26.1 last row); `VACUUM INTO`/backup API is the baseline. |
| Dropping legacy tables at cutover (no rollback window) | Rejected | Removes the only old-client path; §6 window + reclaim is strictly better. |

---

## 14. Must-benchmark section

1. **`DIRECT_CUTOVER_*` thresholds** (§2.3): measure wall-clock for synchronous conversion vs shadow protocol on DBs from 10k → 2M events; find the crossover where startup-fence conversion is cheaper than background shadow. Also measure startup latency impact of the synchronous path at the threshold.
2. **Chunk/segment commit duration under live writes:** time the multi-microframe segment commit vs the fork's per-row commit with the app writing concurrently on the other connection (`busy_timeout=5000`); measure retry counts from `retryOnLock` during backfill.
3. **WAL behavior during bulk phases:** WAL log-pages growth and the cost of the commit that crosses `wal_autocheckpoint`; compare (a) default 1000, (b) per-connection PASSIVE between batches, (c) raised autocheckpoint. Acceptance per research doc §1.10/§29.8: no interactive write p95/p99 regression beyond the agreed budget.
4. **Disk model accuracy** (§7): verify estimated shadow bytes vs measured across a real corpus; calibrate the safety margin; measure freelist behavior so reclaim expectations are honest.
5. **Reverse-export throughput & correctness**: export a seeded multi-GB OSES DB back to legacy; time per chunk; verify crc/count equality; fault-inject at every phase (research doc §31.8) — the tool must be provably resumable.
6. **FTS + OPCL coexistence**: OPCL-framed `part.data` with live `part_fts` triggers; search row counts and `rebuild` cost after the routing-plane migration; confirm external-content FTS behaves when `part.data` is BLOB (it should — triggers only read `search_text`).
7. **`VACUUM INTO` portability:** confirm availability + timing across the bundled Electron `node:sqlite` SQLite and each Bun build. Per codec-arch, fold `sqlite_version()` + `PRAGMA compile_options` into the **codec capability probe** (one startup probe, both runtimes, recorded in provenance, research doc §5.6 UNRESOLVED probe); on version mismatch fall back to checkpointed-copy + `integrity_check`.

---

## 15. Headline recommendations (summary)

1. **Reuse the fork's own migration idioms instead of inventing new ones:** DDL-only drizzle migrations + watermark-cursor resumable passes on `withBackfillDb` + `retryOnLock` (the `part_search_backfill`/`SessionSearch.backfillParts` pattern) are the proven chassis for both OSES shadow backfill and OPCL batch conversion. `oses_migration` is an extension of that idiom with a `phase` column, not a new mechanism — and the vestigial `data_migration` table should be left unused.
2. **Gate the protocol by size:** below a benchmarked threshold (hypothesis ~25k events / 256 MiB), skip the shadow store and do a synchronous, resumable-in-restart conversion inside a startup fence; reserve the full A–E shadow protocol for the multi-GB tail. This defuses the "is 5 stages over-engineered?" objection for the 99% single-user desktop case.
3. **The epoch flip is a guarded single-row UPDATE** (`WHERE value='legacy'`), mirrored in `PRAGMA user_version`; new binaries fail closed on any epoch above their `MIN_READER_EPOCH`; old binaries cannot fail closed (they silently misread), so the real protection is release policy + the rollback window + a **fault-tested reverse-export tool that must exist before cutover ships**. Reverse export and epoch flip-back are atomic-with-verification by construction.
4. **OPCL conversion is gated behind two fork-specific landmines:** `idx_message_provider_id` / `SessionUsage` json_extract (silent breakage if not normalized to native columns first) and the external-content `part_fts`/`session_message_fts` triggers (safe as long as `search_text` survives and any table rebuild recreates the virtual table + triggers in the same tx). The fork's `chunk-sealer`/OCDB frames are part of the migration input inventory — decode before re-encoding, gate the sealer off at flip, reclaim `ocdb_seal` + its partial index in Stage E.
5. **Bulk phases get their own WAL policy on their own connection:** leave interactive `wal_autocheckpoint` at 1000, schedule explicit PASSIVE checkpoints between batches on the backfill connection, cap maintenance WAL growth by shrinking batch size, never FULL/RESTART on an interactive path, and express "background-ness" in-process (`Effect.yieldNow` + maintenance flag) since the Electron utility process has no OS-level nice.
