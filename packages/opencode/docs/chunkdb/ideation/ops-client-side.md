# ChunkDB Client-Side Restructure — Boundary, Migration & Read-SLO Enforcement

> Owner: `ops-v2`. New coordinator direction (2026-08-19): **CLIENT-SIDE-ONLY** storage
> restructure — no SSE/wire/V1-API change; adapter presents byte-identical data; wire
> carries full values. Builds on `constraint/client-side-only`, `ops.md` (restore/check/
> backup), `schema-v2` epoch gate + topology, `readpath-v2` layout + fail-closed boundary,
> `seal-v2` async compactor + `ocdb_control` lease, and the adversarial correctness risks
> (`adversarial-evaluation` / `adversarial-optimization`).

My lane in this direction: **client-side boundary enforcement + migration of existing
16.75GiB DBs + read-speed SLOs/verification + backward compat.** The storage *topology*
(event_hot + event_segment + event_value dedup) is schema-v2/oses-arch's; the *read layout*
is readpath-v2's; the *compactor* is seal-v2's. I wire them into a safe, verifiable,
reversible client-side rollout.

---

## 0. The hard constraint, restated as enforceable rules

`constraint/client-side-only`: ChunkDB is a client-side-only optimization inside
`opencode.db`. **No upstream SSE shape, wire protocol, or V1 product API changes.** The
EventStore adapter must present **byte-identical data** to every reader (renderer
projection `MessageV2.page+hydrate`, sync/history, V2 session replay, desktop). SSE
delivers hot ref-free events unchanged. **Wire always carries full values; refs are
storage-local.** Any design requiring a wire/SSE/protocol change is OUT OF SCOPE.

Three enforceable corollaries this proposal makes *test-failing*:
1. **No storage bypass** — every read/write of event storage goes through the adapter.
2. **No ref leak to wire** — SSE/sync/history payloads are byte-identical to the
   pre-ChunkDB baseline (golden vectors).
3. **No `json_extract` on a ref/framed column** — would break on BLOB/ref storage.

---

## 1. Client-side boundary enforcement (no-wire-change)

### 1.1 The EventStore adapter is the single boundary

`core/src/event/store.ts` (concept from `contract-arch`) is the **only** module that
touches event storage. Two tiers:
- **Tier A — transactional row gateway** (`latestSeq`, `readByAggregateSeq`,
  `eventIDLookup`, `insert`, `removeAggregate`): runs inside `commitDurableEvent`'s
  existing txn. Writes are identity/ref-free on the hot path (per read-latency-first).
- **Tier B — read API** (`readAggregatePage`, `readAfter`, `syncHistory`, `syncState`,
  `allForAggregate`): returns **rehydrated, byte-identical** events. For cold segments
  this means: fetch segment → for each value-ref, fetch `event_value` row → verify
  `crc32(value.bytes) === ref.crc32` → splice exact bytes at `(offset, len)` →
  `JSON.parse`. The wire/renderer/projection never sees a ref.

All four readers consume Tier B only. The renderer projection, sync/history, V2 replay,
and desktop are **above the boundary** and cannot tell storage is restructured.

### 1.2 Import guard — bypass is a build/test failure

The enforceable "invisible above the boundary" rule (`contract-arch`): **ban
`core/src/event/sql.ts` (and any raw event-storage SQL) outside `store*.ts`.**

Implementation (two layers, both fail the build in CI):
- **Static lint rule** (ESLint `no-restricted-imports` or a custom `scripts/check-boundary.ts`
  run in `bun run typecheck`/`build`): any file NOT matching `core/src/event/store*.ts`
  or the legacy differential test suite (`**/test/**/event-legacy-*.ts`) that imports
  `./event/sql` / `./event/sql.ts` / raw `event`/`event_value`/`event_segment` SQL →
  **build error**. This is the mechanical guarantee that a new code path cannot reach
  storage directly.
- **Runtime dev assertion**: in dev builds, the adapter wraps the storage connection;
  any SQL touching event tables issued outside the adapter's scope throws
  `BoundaryViolation`. Catches dynamic/string-built SQL the lint rule misses.

### 1.3 Wire-shape golden guard — ref leak is a test failure

A regression test (corpus `D6` golden vectors) serializes the SSE `/sync/history` and
V2 replay payload for a fixed set of sessions from the **new-structure** DB and asserts
**byte-identical** to the pre-ChunkDB baseline captured on the pristine TEXT snapshot.
Because the adapter rehydrates refs to full values before any payload is built, a ref
that leaks into the wire changes the bytes → golden test fails. This is the specific
guard against "wire-changing mistake": it is caught by CI, not by a user.

### 1.4 Rehydration correctness — closes the adversarial read-path holes

The adversarial evaluation named three correctness risks this boundary must defeat:
- **R1 (splice byte-exact invariant is conditional; encode-side guard can't fire):**
  the adapter's rehydration must produce text **byte-identical** to the original
  `event.data`. Enforce with a **differential golden test**: for a bounded sample of
  real rows, `rehydrate(segment) === original_raw_text` (string equality on the UTF-8
  bytes, not just `JSON.parse` equality). This is the enforceable form of the
  adversarial "semantic guard" — we compare the *rehydrated bytes* to the *source
  bytes*, which is exactly what replay's `isDeepStrictEqual` needs.
- **R2 / adversarial top-risk #2 (valid-but-wrong value row served silently):** a
  mismatched `event_value` row would serve corrupt data with no error. Closed by the
  **per-value `crc32` tag compared BEFORE splice** (adversarial #5): each ref carries
  the `crc32` of the value it expects; if the fetched `event_value.bytes` crc32 differs
  → **fail-closed** (`OCDBFrameError` + restore hint), never synthesize. This is the
  read-path hole the adversarial pass flagged; the per-value crc32 is the fix.
- **#3 (uppercase-hex event IDs round-trip to a different string):** the adapter treats
  event IDs as **opaque bytes** through the packer (oses-arch fixed the canonical/escape
  rule); it never re-emits or re-cases an ID, so the byte-exact requirement holds.

**Fail-closed contract (readpath-v2):** decode at the *consume* boundary, per event,
with `try/catch` — bulk Drizzle `fromDriver` mapping throws on the first corrupt row and
loses the whole result set. The adapter selects RAW segment/value bytes and decodes
per-event in JS. Corrupt row → typed `OCDBFrameError(aggregate_id, seq, row_id, reason)`;
healthy rows decode; caller fails deterministically, never serves partial/garbage.

### 1.5 The 11 production leak sites — all route through the adapter

From `contract-arch` (handoff #13), the full leak inventory is **11 prod sites**:
`core/event.ts` **E1–E7** (7), `sync.ts` `history:76` (cross-aggregate, 1),
`workspace.ts` `sessionWarp:653` (1), `sync-state:322` (1), `sync-state:925` (1).

All 11 are re-pointed to the adapter's Tier A/B. The **8 core/test files** that compare
old-vs-new behavior stay as the **legacy differential suite** (they are exempt from the
import guard and assert byte-identical output). This is the verification that the
boundary is complete: if any of the 11 still hit storage directly, the import guard
fails the build; if any produces different bytes, the differential suite fails.

---

## 2. Client-side migration of existing 16.75GiB DBs (file-swap rebuild)

Adapts `migration-arch`'s file-swap rebuild to a **purely client-side** operation (no
server, runs at the desktop/app startup fence). The rebuild **is** the backfill:
dedup + compress + redundancy elimination, all in one streaming pass.

### 2.1 Procedure

1. **Detect legacy:** `framing_epoch=0` / `user_version=0` (pristine TEXT today) and the
   new structure is enabled (flag or binary-version floor).
2. **Build `opencode.db.new` streaming the legacy file READ-ONLY** (source never mutated
   — matches migration-arch's read-only discipline). In aggregate order:
   - apply **per-aggregate exact-value dedup** (`event_value` promotion on second
     occurrence per ruleset; `SIZE≥1KiB`, `JUMBO_PROMOTE≥1MiB`) — this is the
     **within-event-store** redundancy elimination: repeated `info.summary.diffs`
     (50–98% of `message.updated` bytes per corpus ground truth; the 1,284× repeat
     case) and `session.summary_diffs` collapse to shared `event_value` rows
     referenced by storage-local refs.
   - compress the remainder into **segments** (OCDB frame / microframe, 16–32KiB band);
   - write `event_hot` tail byte-identically (recent events stay raw TEXT — the wire
     never changes for hot reads).

   **Redundancy scope (staged — schema-v2 topology + seal-v2/readpath-v2):** the
   rebuild **always** eliminates **event-store-internal** redundancy — the 1,284×
   repeated `info.summary.diffs` and `session.summary_diffs` collapse to shared
   `event_value` rows (the 35–65% whole-DB win). **Cross-table projection
   duplication** (event↔`session_message`, `message.data` mirroring the last event's
   summary) is **conditional**: the epoch-2 rebuild *can* collapse it to shared
   `event_value` refs **only if the projection rewrite (routing-column promotion,
   OPCL lane) lands in the same cut** — because `message.data` today carries live
   `json_extract` consumers (usage.ts / credentials.ts / search.ts) that break on a
   ref/BLOB (readpath-v2 HARD INVARIANT). If that promotion is not in the v1 cut,
   cross-table duplication remains an **accepted V1-API cost** and is deferred to
   schema-v2 Stage 3. The coordinator's bullet (c) lists cross-table duplication as a
   goal; the no-wire-change + byte-identical + json_extract constraints mean v1 may
   only capture the event-store share. **Surfaced as open Q2** — a real tension
   between the stated goal and the hard constraints, not a silent scope cut.

   **Migration vs ongoing compaction (no contradiction):** this §2 is the **one-time
   cutover** of an existing 16.75GiB legacy DB to the new structure (file-swap,
   resumable, rollback via `.pre`). After cutover, **seal-v2's in-place compaction
   pipeline** (dedicated 3rd connection, per-segment atomic COMMIT, `event_aggregate
   .sealed_seq` frontier, `oses_seal` ledger, in-place reclaim) handles newly-cold
   rows continuously. Both write the **same** topology (`event_hot` + `event_segment` +
   `event_value`); the file-swap is the bulk bootstrap, the in-place compactor is the
   steady state. The `ocdb_control` lease coordinates both.
3. **Catch-up:** after the initial stream, re-read events written to the legacy file
   during the build (frontier tracked via `event_sequence`) and apply them to `.new`.
4. **Swap at startup fence** (2 renames + 3-rule recovery, migration-arch §):
   - `opencode.db` → `opencode.db.pre-<ts>` (rollback window)
   - `opencode.db.new` → `opencode.db`
   - bump `framing_epoch=2` + `PRAGMA user_version=2` atomically in the swapped file.
5. **Rollback window:** `.pre` retained for N days. Downgrade = file restore (rename
   `.pre` back); no reverse-export needed for rollback. After window → **reclaim = delete
   `.pre`** (no VACUUM).

### 2.2 No VACUUM, reclaim = delete old file

`.new` is **born-fresh** (compact by construction; `auto_vacuum=INCREMENTAL` set at
creation). There is no online `VACUUM` (it blocks, violates read-latency-first —
seal-v2 §6). True shrink is achieved by *building a new file*, not compacting the old
one. Reclaim is deleting the `.pre` after the rollback window. Legacy DBs therefore
shrink on migration, not in place.

### 2.3 Resumability + `ocdb_control` lease

- **Resumable:** the build records progress (last completed `aggregate_id`) in `.new`'s
  `ocdb_meta`; a crash discards `.new` and restarts from the read-only source (source is
  immutable, so restart is safe and idempotent).
- **`ocdb_control` lease** (seal-v2's refined shape): `ocdb_control(lock_name PK,
  holder_id, acquired_at, expires_at, kind)` where `kind ∈ {sealer, migration-rebuild,
  backup, restore}`. The rebuild claims `lock_name='maintenance'` with `kind='migration'`
  exclusive; the sealer/backup/restore yield between batches. Conditional upsert claim
  (`INSERT ... ON CONFLICT(lock_name) DO UPDATE ... WHERE expires_at < :now OR holder_id =
  :me`) — generation guard from oses.md §6.5. This is the single coordination point that
  also answers seal-v2 Q3 and schema-v2 Q4 (epoch flip under the same lease).

### 2.4 Three-rule recovery

1. If `.new` is missing/incomplete at fence → **abort swap**, keep legacy, retry next
   startup. App boots on the unchanged legacy DB (zero regression).
2. If `.pre` exists and `opencode.db` is still legacy → restore `.pre`→`opencode.db`
   (shouldn't happen; defensive).
3. If both `.new` and `.pre` exist → use `.new` (swap succeeded); `.pre` is the rollback.

---

## 3. Read-speed SLOs + verification (opencode-db-check on the new structure)

### 3.1 SLO targets (from readpath-v2 / benchmark-arch gates)

| Surface | SLO (p99) | Source |
|---|---|---|
| Point sealed event `(aggregate, seq)` | **<500µs S3** / <200µs S2 (G4) | readpath-v2 |
| Session-open replay | **<10ms per 1k events S3** | readpath-v2 |
| `MessageV2.page+hydrate` | **≤ +0%** (projection lane, never OSES) | readpath-v2 |
| `sync-history` page | <5ms S3 | readpath-v2 |
| `readAfter` tail | <2ms first event | readpath-v2 |

These are **retrieval** budgets. Writes (dedup/compress) are background and exempt.

### 3.2 How `opencode-db-check` verifies reads (not just CRC)

The new `db-check` (extends my `ops.md` §2) adds a **read-latency probe mode** that
runs the *actual adapter read path* against the new structure and measures against the
SLOs — CRC alone does not prove reads are fast:

- **Point-read probe:** pick K random cold `(aggregate, seq)`, time the full adapter
  read (segment fetch + ref splice + decompress + parse), report p50/p99 vs G4.
- **Session-open probe:** pick K sessions, time replay of the first 1k events via the
  adapter, report vs <10ms/1k.
- **MessageV2 probe:** time `page+hydrate` of a session's messages; assert **≤ +0%**
  vs the pre-ChunkDB baseline (or within a tight tolerance).
- **Integrity (still CRC-based):** verify each segment's OCDB-frame CRC32 AND each
  referenced `event_value.crc32` (the R2 guard) — fail-closed on mismatch.
- **Redundancy-coverage probe:** report dedup ratio (`distinct event_value bytes / total
  event bytes`) and confirm it matches the corpus ground-truth band (35–65% event-subsystem
  elimination) — a regression here means the rebuild under-eliminated.

Output JSON extends `ops.md` §2.3 with `read_slo:{point_p99_ms, session_open_p99_ms,
messagev2_regression_pct, verdict:ok|degraded|corrupt}`.

### 3.3 Alerts on read-regression

- `read_slo.point_p99_ms > 500µs` → page (G4 regression).
- `read_slo.session_open_p99_ms > 10ms/1k` → page.
- `read_slo.messagev2_regression_pct > tolerance` → page (projection broke).
- `ocdb_frame_errors_total{reason="bad_crc"} > 0` after a full check → page (data
  corruption, not a metric blip).
- `dedup_ratio` outside the corpus band → investigate rebuild.

These feed the existing opencode telemetry bus (sealer 18-signal group + db-check JSON);
no new infra.

---

## 4. Backward compat (fail-closed old binary + reverse-export)

### 4.1 Epoch gate (schema-v2) + `user_version` bump

The new restructure is **epoch 2** in schema-v2's reserved scheme (0=legacy, 1=OCDB v2
framing, 2+=OSES/new-structure). On swap (§2.4) we set `ocdb_meta('framing_epoch')='2'`
and `PRAGMA user_version=2` atomically.

- **New binary on open:** assert `db_epoch <= binary_max_epoch`. A binary that only knows
  epoch ≤1 **refuses to open** a epoch-2 DB with a clear message + restore hint →
  **fail-closed** (forward-compat).
- **Old/unmodified binary:** cannot be made to fail closed (it doesn't know epoch 2).
  Mitigation is two-fold and a **hard shipping gate**: (a) the new structure ships
  behind the epoch gate + opt-in flag, so existing users are not auto-migrated; (b) the
  **reverse-export tool MUST exist and be fault-tested before any auto-enable ships.**

### 4.2 Reverse-export tool (safety net)

`opencode-restore --mode reverse-export --to <plain.db>` decodes every segment + splices
every `event_value` ref → plain JSON TEXT into a fresh legacy-compatible db
(`framing_epoch=0`, `user_version=0`). User runs this **before** downgrading. Target is
always plain TEXT (never refs/frames), so the rolled-back db is readable by any old
binary. This is the migration-arch reverse-export requirement, fulfilled by the same
`restore.ts` library from `ops.md` §1.

### 4.3 Backup coherence with `ocdb_control` lease

Backup = `wal_checkpoint(TRUNCATE)` on the dedicated sealer/compactor connection → copy
`.db` only (all new-structure tables — `event_hot`, `event_segment`, `event_value`,
`ocdb_seal`/`oses_seal`, `ocdb_meta` — travel inside the file) → release the
`ocdb_control` lease. Stale `-wal`/`-shm` deleted on restore (`.db` authoritative). The
lease is the single exclusion point for sealer/compactor/backup/restore/migration, so a
backup never captures a half-rebuilt or half-flipped DB.

---

## 5. Decisions (opinionated)

1. **Adapter is the only boundary.** Import guard (build-failing) + runtime dev assertion
   + wire-shape golden test make all three no-wire-change corollaries *test-failing*, not
   just documented.
2. **Rehydration is byte-exact + per-value crc32-verified, fail-closed.** This is what
   defeats adversarial R1/R2/#5 and keeps `isDeepStrictEqual` replay exact through dedup.
3. **Migration = file-swap rebuild, client-side, at startup fence.** Source read-only;
   rebuild is the backfill (dedup+compress+redundancy elimination); no VACUUM; reclaim =
   delete `.pre`.
4. **`ocdb_control` lease is the single coordination point** for sealer/compactor/backup/
   restore/migration/epoch-flip (answers seal-v2 Q3 + schema-v2 Q4).
5. **Read-SLO verification is latency probes through the real adapter path**, not just
   CRC. CRC proves integrity; latency probes prove the "extremely fast retrieval" claim.
6. **Backward compat = epoch gate (fail-closed refuse) + reverse-export (safety net).**
   Both ship together; neither alone is sufficient.

## 6. Tradeoffs

- **Import guard adds a lint rule + dev-only runtime check.** Cost: one CI step + a
  dev-mode wrapper. Benefit: a storage bypass (the thing most likely to leak a ref to the
  wire or break byte-identity) becomes a build failure, not a runtime surprise.
- **Differential golden suite is sample-based.** Cost: bounded real-row sampling, not
  exhaustive. Benefit: catches the realistic regression class without 1.37M-row diffs.
- **File-swap rebuild doubles peak disk during migration** (`.new` + `.pre` + legacy
  coexist briefly). Cost: ~2x DB size transiently (16.75GiB → ~33GiB peak). Benefit:
  zero-risk rollback + no in-place VACUUM stall. Mitigation: the rebuild is born-fresh and
  smaller than the source (dedup), so peak is often <2x.
- **Epoch 2 means old binaries hard-refuse.** Cost: a user who downgrades without
  reverse-export is blocked. Benefit: no silent corruption of a restructured DB.
- **Read-SLO probes add startup/on-demand latency.** Cost: a few hundred timed reads per
  `db-check` run. Benefit: proves the headline "extremely fast retrieval" SLO, not just
  asserts it.

## 7. Open questions (ranked)

1. **Migration trigger policy:** run the rebuild automatically at the startup fence once a
   binary-version floor is crossed (auto-migrate), or keep it strictly opt-in behind a flag
   until the fleet has burn-in? (Tradeoff: storage win realized sooner vs. zero-surprise
   guarantee. schema-v2 Q1 is the same axis.)
2. **Redundancy-elimination scope in v1 of the restructure:** does the first client-side
   cut eliminate *all* three cross-table redundancies (event↔session_message, message.data
   mirror, session.summary_diffs), or ship event_value dedup first and defer the
   projection-duplication collapse? The latter is safer but leaves the biggest tail
   (message.data summary mirror) on disk.
3. **Wire-shape golden vectors source:** corpus `D6` provides sync-ordering vectors, but do
   we have a frozen SSE-payload golden for the renderer projection to assert byte-identity?
   Without it, the no-ref-leak guard is partial.
4. **`ocdb_control` lease for network/shared DBs:** sufficient for local single-user (seal-v2
   Q3 says yes, fs lock out of scope for v1), but a DB on a network volume would need an fs
   lock — is client-side-only ever expected on a network path, or do we refuse restructuring
   there?
5. **Corrupt-event UX (readpath-v2 Q5, shared):** abort-hard (app refuses until restore
   succeeds) vs skip-and-report (quarantined row absent). Determines whether a `db-check`
   startup `corrupt` blocks launch or merely warns — and whether the adapter's fail-closed
   path is strict or lenient.
