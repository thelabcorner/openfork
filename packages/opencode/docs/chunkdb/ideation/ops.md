# ChunkDB Ops Tooling, Durability & Restore — Production Design Proposal

> Owner: `ops-v2` (task `task_b9396726f5284419a79fd5992da34fd3`)
> Grounded in: `packages/core/src/database/json-codec.ts`, `chunk-sealer.ts`,
> `packages/opencode/bench/chunkdb-readpath.ts` (path 9 full-frame audit, path 10
> fail-closed), `chunkdb-bench.ts`, and the 11 prior swarm deliverables
> (storage / codec / contract / migration / oses / opcl / readpath / benchmark /
> sealing). Coordinates with `seal-v2` (scheduler/connection/checkpoint) and
> `readpath-v2` (fail-closed decode boundary, corrupt-event UX) and `schema-v2`
> (format-epoch gate for downgrade).

---

## 0. Facts this design is built on

- **Frame v2** (`json-codec.ts`): 14-byte header (`OCDB` magic, version 2, codec
  1=zstd/2=brotli/3=deflate, rawLen LE u32, CRC32 LE u32 over decompressed
  bytes), then compressed JSON. `decompressFrame` is **fail-closed** in 5 stages
  (bad magic / unsupported version / unsupported codec / rawLen bomb pre-cap /
  CRC mismatch) and throws `OCDBFrameError` carrying `restoreHint` =
  `"run the restore CLI: bun x opencode-restore --db <path>"`.
- **`restoreText(stored: string | Uint8Array): string`** is already exported and
  is the single correct entry point to decode *any* stored value back to its raw
  JSON string (string → returned as-is; Uint8Array → `decompressFrame`).
- **`compressText(json, {codec, level})`** is the sole frame producer (sealer
  path only; `toDriver` is identity). Returns `string` when below `THRESHOLD`
  (4096) or when framing does not beat raw by ≥24 bytes.
- **Sealer** (`chunk-sealer.ts` + `seal-v2` production design): background fiber,
  dedicated 3rd SQLite connection, one WAL tx per batch (frame `UPDATE` +
  `ocdb_seal` UPSERT atomic), `ocdb_seal` journal keyed `(table_name, row_id)`
  with `raw_bytes`/`stored_bytes`/`time_sealed`. Eligibility: write-cold (48h) +
  read-warm-excluded (last_read_ms + active sessions) + `typeof(data)='text'` +
  `length>=4096`, idempotent via `LEFT JOIN ocdb_seal`. WAL `PASSIVE` checkpoint
  after each pass, `TRUNCATE` deep-idle.
- **v1 framing is `event.data`-ONLY** (`readpath-v2` hard invariant): columns with
  a SQL `json_extract` consumer (`message.data`) are ineligible; `message`/`part`/
  `session_message` stay TEXT in v1. The restore/check CLIs are therefore
  **table-agnostic** (scan all four) but in v1 only `event` carries frames; OPCL
  framing is a later, separately-gated move.
- **Fail-closed read boundary** (`readpath-v2`): decode happens per-event at the
  *consume* boundary (raw SQL + per-event try/catch), never bulk Drizzle mapping,
  so one corrupt row cannot lose a whole result set. `OCDBFrameError` carries the
  restore hint. **Corrupt-event UX is an open product decision** (abort-hard vs
  skip-and-report) — this design supports both (see §1.4).
- **Read-latency-first** is the governing constraint: ops tooling must add **zero**
  hot-path cost. `opencode-db-check` startup mode is a *cheap subset*; the full
  audit is on-demand only.

---

## 1. The missing `opencode-restore` CLI

### 1.1 CLI shape

```
bun x opencode-restore --db <path> [options]

  --db <path>            REQUIRED. Target SQLite db file (or :memory: for tests).
  --backup <path>        Coherent backup db to source original TEXT values from
                         (see §3). Enables content restore for corrupt frames.
  --mode <audit|repair|reverse-export>
                         audit   = scan + classify + report, no writes (default)
                         repair  = fix reconcilable rows (see §1.3)
                         reverse-export = decode all frames -> plain JSON TEXT
                                          into --to <path> (legacy-compatible DB)
  --tables <csv>         subset to scan (default: event,message,part,session_message)
  --repair-codec <1|2|3> when re-encoding a verified frame, target codec
                         (default 2=brotli-q1, the byte-stable baseline, codec-arch)
  --quarantine           on unrecoverable corruption, move the row to
                         _ocdb_quarantine instead of leaving it in place (default ON)
  --dry-run              report what would change, write nothing
  --json                 emit machine-readable JSON report (for monitoring)
  --verbose
```

`bun x` integration: register two bin entries in `packages/opencode/package.json`
(`"bin": { "opencode-restore": "./dist/cli/restore.js", "opencode-db-check": ... }`)
so `bun x opencode-restore` resolves from any cwd. The CLI is a **thin wrapper**
around a library module `packages/core/src/database/restore.ts` exporting
`auditDb`, `repairDb`, `reverseExport` — so the desktop app can call restore
programmatically on startup (e.g. when `db-check` reports corruption) without
spawning a subprocess.

### 1.2 Algorithm (three phases)

**Phase A — Audit / classify.** For each scanned table, stream rows in bounded
pages (reuse the bench `Driver` abstraction; never load 1.37M rows at once):

- `typeof(data)='text'` → TEXT (healthy, native).
- `typeof(data)='blob'` AND magic `OCDB` → framed. Call `decompressFrame`
  inside a `try/catch`. On success → `crc_ok`. On `OCDBFrameError` → record
  `reason` (bad_magic / bad_crc / rawlen_bomb / unsupported_version /
  unsupported_codec). **This is exactly chunkdb-readpath path 9/10 logic, lifted
  into the production CLI.**
- Anything else (e.g. a BLOB that is not an OCDB frame) → `unknown`, flagged.

**Phase B — Reconcile against `ocdb_seal` journal.** The journal is the
authoritative manifest of *what was sealed* (it lives inside the db file, so it
is captured coherently by the backup in §3). Three drift classes:

- `journal_sealed` but row is now TEXT → **reverted** (an update-after-seal wrote
  TEXT back; `opcl`/storage noted this is expected). Repair = re-seal (§1.3b).
- row is framed but **absent from journal** → **orphan frame** (sealed by a
  process whose journal tx rolled back, or journal lost). Repair = re-register in
  `ocdb_seal` (recompute raw/stored bytes) so coverage accounting is honest.
- `journal_sealed` and frame `crc_fail` → **corrupt** (the real durability event).

**Phase C — Repair** (only in `--mode repair`, never in `audit`):

- **(a) Restore-from-backup (content repair).** For each `crc_fail` row, fetch the
  original stored value from `--backup` by `(table_name, row_id)`. If the backup
  value is TEXT → write it back as TEXT (this is the *safest* repair: the app
  reads TEXT natively, and the sealer can re-seal later). If the backup value is
  itself a frame → verify its CRC; if good, copy it; if also bad → quarantine.
  **This is a single-row operation** because the journal manifest + per-row CRC
  let us verify each restored value independently — no whole-table re-seal needed.
- **(b) Re-seal reverted / register orphan (format reconciliation).** `compressText`
  on the TEXT value (or recompute journal entry). No backup required.
- **(c) Single-row decode-and-rewrite (CRC+rawLen-enabled repair).** For an
  *intact* frame (`crc_ok`) that must change codec/version — e.g. the current
  runtime cannot decode the stored codec (downgrade scenario, §4), or we are
  normalizing to the byte-stable brotli-q1 baseline — decode via `restoreText`
  (CRC proves the decoded text is correct; `rawLen` bounds the decompress so no
  bomb) and re-encode with `--repair-codec`. **This is the precise sense in which
  "CRC+rawLen enable single-row repair": you can only safely re-encode a frame
  whose CRC verifies, and rawLen makes that re-encode allocation-safe.** It is a
  *format* repair, not a corruption recovery.
- **(d) Unrecoverable.** A `crc_fail` row with no usable backup, or an `unknown`
  BLOB, cannot be reconstructed (the frame is a lossless compression; payload
  corruption is unrecoverable from the frame alone). Default = **quarantine** to
  `_ocdb_quarantine (table_name, row_id, raw_blob, detected_at, reason)` and
  report. **Never silently drop** — quarantine preserves forensic data and lets
  the app boot (the row is no longer in the live table). This directly serves
  `readpath-v2` Q5: under *abort-hard* UX the app refuses to start until restore
  runs; under *skip-and-report* UX the quarantined row is simply absent.

### 1.3 `restoreText` usage contract

`restoreText` is the **only** decoder the CLI uses for frames; it is never
re-implemented. The CLI adds exactly two things on top of it: (1) the
table/row-key association and journal reconciliation (Phase B), and (2) the
backup-source lookup and quarantine sink (Phase C). All CRC/integrity semantics
stay inside `json-codec.ts`, so the CLI cannot drift from the read path's
fail-closed contract.

### 1.4 Exit codes / report

- `0` clean (audit: no corruption; repair: all reconciled).
- `2` corruption found but repaired (or quarantined) — app may proceed.
- `3` unrecoverable corruption remains after repair (no backup) — under
  abort-hard UX the launcher should block and tell the user to supply a backup.
- JSON report (when `--json`) carries per-table `{text, framed, crc_ok,
  crc_fail_by_reason, unknown, journal_drift:{reverted,orphan,corrupt},
  quarantined, restored_from_backup, resealed}`.

---

## 2. `opencode-db-check` verify/repair harness

A single CLI with three modes. It is the **verify** surface; `--mode repair`
delegates the write path to the same `restore.ts` library as `opencode-restore`
(no duplicated logic).

```
bun x opencode-db-check --db <path> [--mode startup|full|repair] [--json] [--repair] [--backup <path>]
```

### 2.1 `startup` mode (cheap subset, runs on every app boot)

Per read-latency-first, this must be fast and non-blocking. It does **not** walk
all 1.37M rows. It verifies the *boot-critical* surface:

1. Codec/runtime capability probe: can this binary decode every codec present in
   the db? (codec-arch: brotli-q1 + dict-less zstd are byte-stable; deflate is
   runtime-divergent — if a frame uses deflate and we are on a runtime whose
   zlib differs, flag it). Emit `unsupported_codec_present`.
2. Hot-tail audit: scan only `event` rows for aggregates with
   `session.time_updated` within the read-warm window (the rows the app WILL read
   on open) + a bounded random sample (e.g. 2 000) of all framed rows. Verify
   CRC via `decompressFrame`.
3. `ocdb_seal` journal integrity: row count vs actual framed rows; any
   `journal_sealed` row whose frame `crc_fail` in the sampled set.
4. **Fail-closed boot decision:** if corruption is found in a row the app would
   read on boot → **refuse to start** (exit non-zero, print the restore hint).
   If corruption is only in cold rows → start normally but write a
   `degraded` verdict to the metrics log and recommend an on-demand `full` check.

### 2.2 `full` mode (on-demand, the production path-9)

Walks **every** framed row in all four tables (streamed, page-batched), verifying
CRC + JSON.parse exactly like `chunkdb-readpath.ts` path 9, and classifies every
row like §1.2 Phase A/B. Reports the full coverage/corruption picture. This is
the command CI / support runs against a user's db.

### 2.3 Metrics JSON schema (emitted by both modes, `--json`)

```json
{
  "tool": "opencode-db-check",
  "db": "<path>",
  "runtime": "bun|node",
  "mode": "startup|full",
  "checked_at": 1787166505931,
  "tables": {
    "event":        { "text": N, "framed": N, "crc_ok": N, "crc_fail": N, "unknown": N },
    "message":      { "text": N, "framed": 0, "crc_ok": 0, "crc_fail": 0, "unknown": 0 },
    "part":         { "text": N, "framed": 0, "crc_ok": 0, "crc_fail": 0, "unknown": 0 },
    "session_message": { "text": N, "framed": 0, "crc_ok": 0, "crc_fail": 0, "unknown": 0 }
  },
  "framed_total": N,
  "crc_verified": N,
  "crc_failed": N,
  "ocdb_frame_errors": {
    "bad_magic": n, "bad_crc": n, "rawlen_bomb": n,
    "unsupported_version": n, "unsupported_codec": n
  },
  "coverage_pct": 42.7,
  "bytes_saved": 1234567890,
  "sealed_rows": N,
  "journal_consistency": "ok|drift",
  "journal_drift": { "reverted": n, "orphan": n, "corrupt": n },
  "decode_on_resume_latency_ms": { "p50": 0.08, "p99": 0.42, "sample": 2000 },
  "verdict": "ok|degraded|corrupt"
}
```

`coverage_pct` = `sum(ocdb_seal.raw_bytes) / total event.data bytes` (mirrors
`chunkdb-bench.ts` line 286). `bytes_saved` = `sum(raw_bytes - stored_bytes)`.
`decode_on_resume_latency_ms` = measured `decompressFrame` p99 over a sample of
framed rows — the regression gate against `readpath` G4 (point sealed event
<500µs S3). `ocdb_frame_errors` by reason is the field monitoring alerts on.

---

## 3. Backup coherence (seal-then-checkpoint-then-copy)

The durability guarantee is: **a coherent backup can always restore any corrupt
frame to its original TEXT.** Coherence is achieved by ordering, not by locking
the sealer for the whole backup.

### 3.1 Procedure (backup tool / `opencode-db-backup`)

1. **Acquire the sealer lease** (coordination, see §3.3): set
   `ocdb_control.mode='backup'` so the sealer's per-batch gate yields instead of
   writing. Short lease — the sealer yields between batches, so a backup only
   waits for the in-flight batch to commit.
2. **`PRAGMA wal_checkpoint(TRUNCATE)`** on the dedicated sealer connection
   (aligns with `seal-v2`: PASSIVE after each pass, TRUNCATE deep-idle). This
   folds the WAL into the main `.db` file. Because `ocdb_seal` is a *table inside
   the db file*, frames + journal are now atomically consistent in one file.
3. **Copy the `.db` file only.** After TRUNCATE the WAL is empty, so the single
   `.db` is the complete, coherent state. (Optionally also copy `-wal`/`-shm` if
   you skip the checkpoint, but TRUNCATE makes them unnecessary.)
4. **Release the lease** (`ocdb_control.mode='normal'`).

Why this is coherent without pausing the sealer for long: each sealer batch is
one WAL tx (frame + journal UPSERT atomic). A checkpoint taken between batches
captures a state where every framed row has its journal entry — or neither. There
is never a half-written frame. The lease merely prevents a batch from *starting*
mid-checkpoint, eliminating the one race (checkpoint racing a committing batch).

### 3.2 Stale-WAL handling on restore

A restored db must not inherit a WAL from a different lifecycle. Rule: on
restore, place the `.db` and **delete any pre-existing `-wal`/`-shm`** that do not
belong to the restored checkpoint (after TRUNCATE there are none; if a user
restores a raw `.db` + separate `-wal`, they must be the matched pair or the
`-wal` is discarded and the `.db` is treated as authoritative). SQLite refuses to
apply a `-wal` whose checksum doesn't match the `-db`; we make that explicit by
deleting unmatched WAL files rather than letting SQLite error mid-open.

### 3.3 Coordination with the sealer (`ocdb_control` lease)

`seal-v2` Q3 asks whether the WAL lock is enough or an explicit single-writer
lease is needed for multi-process sealing. This design answers: **add an explicit
`ocdb_control` table** as the shared signal for *all* background mutators
(sealer, backup, restore, migration rebuild):

```sql
CREATE TABLE IF NOT EXISTS ocdb_control (
  kind   TEXT PRIMARY KEY,   -- 'sealer' | 'backup' | 'restore' | 'migration'
  mode   TEXT NOT NULL,      -- 'normal' | 'paused' | 'exclusive'
  owner  TEXT,               -- process/id holding the lease
  expires INTEGER            -- epoch ms; stale leases are ignored
);
```

- The sealer reads `mode` at the top of every batch; `paused`/`exclusive` →
  yield + sleep (re-check). This is the multi-process single-writer guard
  `seal-v2` flagged and the backup coordination point. It also resolves the
  readpath-arch TOCTOU concern about multi-process sealing.
- `restore --mode repair` and `migration` take `exclusive` (no concurrent sealer
  writes). `backup` takes `paused` (sealer may resume immediately after).
- Leases are heartbeat-renewed and auto-expire (defense against a crashed holder
  leaving the db frozen).

---

## 4. Rollout to real users

### 4.1 Feature flags (config, `opencode.json`)

- `chunkdb.seal.enabled` — default **false** in phase 0/1, flips to **true** in
  phase 2. Gated further by a runtime capability probe (codec support) so a
  runtime that cannot decode a present codec never seals with that codec.
- `chunkdb.restore.enabled` — default **true** once shipping (the CLI is
  read-only-safe; having it available costs nothing).
- `chunkdb.dbcheck.startup` — default **true** in phase 1+ (cheap subset only).

### 4.2 Sequence

- **Phase 0 — dogfood (opt-in).** Maintainers + dogfooders set
  `chunkdb.seal.enabled=true`. Sealer runs in background; `db-check` startup
  subset active. Watch coverage % / bytes saved / decode-resume latency. No
  user-visible change (hot path untouched, `toDriver` identity).
- **Phase 1 — canary / new installs.** Default `seal.enabled=true` for *fresh*
  installs; existing users opt-in (or opt-out). `db-check` startup on. Begin
  collecting fleet metrics.
- **Phase 2 — default-on for all.** Flip default; keep opt-out. Full `db-check`
  available on-demand / support-triggered.

### 4.3 Downgrade handling (coordinate with `schema-v2` format-epoch gate)

Two independent safeguards, both required:

1. **`user_version` bump (fail-closed downgrade).** On first seal, bump
   `PRAGMA user_version` by a defined delta (e.g. +1, the "OCDB frame" epoch).
   Old binaries (pre-ChunkDB) see a `user_version` higher than their known max;
   a correct migration runner **refuses to open** a db with a higher
   `user_version` (standard SQLite migration hygiene) → the downgrade fails
   *closed* with a clear message ("DB requires opencode ≥ X") instead of
   silently `JSON.parse`-ing a BLOB and corrupting reads (`migration-arch`
   noted old binaries "silently misread" — the `user_version` guard is what
   converts that into a safe refusal). **This requires `schema-v2` to reserve
   the epoch number and add the guard in the old binary's migration path.**
2. **`reverse-export` tool (explicit, safe downgrade).** `opencode-restore
   --mode reverse-export --to <plain.db>` decodes *every* frame via `restoreText`
   and writes plain JSON TEXT into a fresh legacy-compatible db (no frames,
   `user_version` left at the old value). User runs this *before* downgrading.
   This is `migration-arch`'s reverse-export requirement, fulfilled by the same
   `restore.ts` library. Target is always plain TEXT (never frames), so the
   rolled-back db is readable by any old binary.

Decision: **reverse-export is the primary downgrade path; `user_version` is the
accidental-downgrade safety net.** Both must land together; neither alone is
sufficient (reverse-export requires user action; user_version alone strands a
user who wanted to downgrade).

---

## 5. Monitoring / observability

### 5.1 Signals the sealer emits (`seal-v2` 18-signal group, surfaced here)

- `ocdb_sealed_total{table}` — cumulative rows sealed.
- `ocdb_bytes_saved{table}` — cumulative `raw - stored`.
- `ocdb_coverage_ratio` — `sealed_raw_bytes / total_event_bytes`.
- `ocdb_decode_resume_latency_ms{p50,p99}` — measured `decompressFrame` cost
  (regression gate vs G4 <500µs S3).
- `ocdb_frame_errors_total{reason}` — monotonic counter of `OCDBFrameError`
  classes seen during sealing/verification.
- `ocdb_journal_drift{reverted,orphan,corrupt}` — reconciliation deltas.

### 5.2 Signals `db-check` emits (per run, JSON + log line)

The §2.3 schema, plus a one-line `ocdb_verdict{ok|degraded|corrupt}` gauge. The
desktop/app surfaces `degraded`/`corrupt` as a non-blocking notice with the
restore command; under abort-hard UX it blocks launch.

### 5.3 Regression alerts (what ops watches)

- `ocdb_frame_errors_total{reason="bad_crc"} > 0` after a `full` check → page
  (data corruption, not a metric blip).
- `ocdb_coverage_ratio` drops unexpectedly between passes → sealer stalled or
  reverted rows not re-sealed.
- `ocdb_decode_resume_latency_ms.p99` exceeds G4 budget → codec/geometry
  regression (e.g. a zstd frame slipped in where brotli-q1 was expected).
- `ocdb_bytes_saved` regresses vs baseline → codec default changed or framing
  worth-it guard mis-tuned.
- `verdict=corrupt` on startup → block launch, prompt restore.

These feed the existing opencode telemetry/log bus; no new infra — the sealer
already emits structured metrics (`seal-v2`), and `db-check` emits JSON, so the
app just forwards them.

---

## 6. Decisions (opinionated)

1. **`opencode-restore` is audit-by-default, repair-opt-in.** Never mutates
   without `--mode repair` / `--repair`. Matches fail-closed posture.
2. **Restore-from-backup reverts a corrupt frame to its original TEXT**, not to a
   re-encoded frame. TEXT is the universally-readable form; re-sealing is
   deferred to the background sealer. Safest possible repair.
3. **`ocdb_seal` journal is the coherence anchor** for both backup (it travels
   inside the db file) and reconciliation (drift detection). No separate manifest
   file.
4. **Backup = checkpoint-TRUNCATE then copy `.db` only**, with a short
   `ocdb_control` lease. No full sealer pause; per-batch atomicity makes
   mid-batch capture already coherent.
5. **Downgrade = reverse-export (primary) + `user_version` guard (safety net)**,
   co-owned with `schema-v2`.
6. **Quarantine, never drop**, on unrecoverable corruption. Preserves forensics
   and lets the app boot.
7. **`restoreText`/`compressText` are the only codec touchpoints** the CLI uses —
   ops tooling cannot drift from the read path's fail-closed contract.

## 7. Tradeoffs

- **Journal stores metadata, not content.** `ocdb_seal` has `raw_bytes`/
  `stored_bytes` but not the original text, so content restore *requires a backup*
  (§1.2c/d). This is intentional (storing content would double the db). Cost: a
  db with no backup and a corrupt frame is unrecoverable → quarantine. Mitigation:
  backup coherence (§3) is cheap and the default-recommended practice.
- **Startup `db-check` is a sample, not exhaustive.** Exhaustive audit would
  violate read-latency-first on boot. Cost: a corrupt *cold* row can pass startup
  and only surface on `full` check / on read. Mitigation: fail-closed read
  boundary (`readpath-v2`) catches it at consume time and points at restore.
- **`ocdb_control` lease adds a coordination table** to every background mutator.
  Cost: one extra read per sealer batch + lease heartbeat. Benefit: resolves
  multi-process sealing TOCTOU and gives backup/restore/migration a clean
  exclusion signal (answers `seal-v2` Q3 in favor of an explicit lease).
- **Reverse-export is user-actioned.** Cost: a user who downgrades without
  running it is blocked by the `user_version` guard and must run restore. Benefit:
  no silent corruption, no automatic (possibly lossy) rewrite on downgrade.

## 8. Open questions (ranked)

1. **Should `ocdb_seal` also store a sha256 of the original text?** (Storage cost
   vs. enabling backup-free integrity verification and cross-backup dedupe.
   Currently it stores only sizes, so content restore is backup-dependent — §7.)
2. **Downgrade guard ownership:** exact `user_version` delta and the migration
   guard in the *old* binary — needs `schema-v2` to reserve the epoch and add the
   refuse-on-higher-version check. Is a single +1 epoch enough, or do we need a
   separate `storage_format` config row for forward-compat?
3. **Multi-process sealer lease:** is `ocdb_control` (table-based, heartbeat +
   expiry) sufficient, or do we also need a filesystem lock for the
   cross-process / cross-machine (network db) case `seal-v2` Q3 raises?
4. **Startup `db-check` scope:** verify the entire read-warm window, or just
   sample it? (Latency budget vs. guaranteeing the boot-critical path is clean.)
5. **Corrupt-event UX (from `readpath-v2` Q5):** abort-hard (app refuses until
   restore succeeds) vs skip-and-report (quarantined row simply absent). This
   design supports both, but the *default* is a product decision that changes
   whether `db-check` startup `corrupt` blocks launch or merely warns.
