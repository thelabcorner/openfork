# Read-Path & Hot/Cold Tiering — Production Design Proposal (mixed TEXT|frame store)

**Author:** readpath-v2, swarm `chunkdb-ideation`
**Grounded in:** `packages/core/src/database/json-codec.ts`, `chunk-sealer.ts`, `database.ts`; `packages/opencode/bench/chunkdb-readpath.ts` (12 paths), `chunkdb-readlatency.ts`, `chunkdb-seal-parallel.ts`; blackboard `architecture/read-latency-first`, `corpus/ground-truth-v2`, `deliverable/arch-readpath`, `deliverable/arch-contract`.
**Scope statement (builds on prior work, does not re-derive):** The shipped prototype is **frame v2 on `event.data` only** — `compressedJson` customType (identity `toDriver`, fail-closed `fromDriver`), a background sealer that is the *only* frame producer, `message`/`part`/`session_message` staying TEXT. The elaborate OSES microframe/segment/`event_value` design in `arch-readpath.md` §2–§5 is a **separate future phase behind feature gates**; this proposal designs production reads for the **current mixed TEXT|frame store** and adopts the shared principles from prior work: read-latency-first, fail-closed, decode caching, read-recency, G11.

---

## 1. `compressedJson.fromDriver` coverage of all 12 app read paths

**Mechanism.** A Drizzle `customType`'s `fromDriver` is invoked once per materialized column value. For `event.data` it maps `string → JSON.parse` and `Uint8Array → decompressFrame → JSON.parse`. Therefore **any** query that selects `event.data` is decoded uniformly — the 12 paths are not special-cased; they are all "SELECT `data` FROM `event`/`message`/…" and the customType handles each value.

**Wiring fact (production step).** `compressedJson` is currently defined but **not referenced by any schema column** (only `json-codec.ts` + the bench harness). The one production change is in `packages/core/src/event/sql.ts:19`:

```ts
// before
data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
// after
data: compressedJson.$type<Record<string, unknown>>().notNull(),
```

Same `TEXT` affinity (the codec comment confirms a bound `Uint8Array` still uses SQLite's BLOB storage class under TEXT affinity) → **no migration**; hot writes are byte-identical because `toDriver` is `JSON.stringify` only (identity vs `text({mode:"json"}`); the sealer is the sole frame producer.

**Path-by-path confirmation (all 12 from `chunkdb-readpath.ts`):**

| # | Path | Column | Decode path | Covered? |
|---|------|--------|-------------|----------|
| 1 | `readAfter` (event.ts) `SELECT … data … WHERE aggregate_id=? AND seq>?` | `event.data` | `fromDriver` (TEXT\|frame) | ✅ |
| 2 | `readAggregate` (event.ts) type-filtered + LIMIT | `event.data` | `fromDriver` | ✅ |
| 3 | full-history read (after=-1), biggest aggregate | `event.data` | `fromDriver` | ✅ |
| 4 | `SessionHistory.load` (history.ts) `session_message` projection | `session_message.data` (TEXT) | `fromDriver` = `JSON.parse(string)` | ✅ (0 blobs) |
| 5 | `message` page + `part` hydrate (message-v2.ts) | `message.data`,`part.data` (TEXT) | `fromDriver` = `JSON.parse` | ✅ (0 blobs) |
| 6 | `usage.ts` `json_extract(data,'$.providerID'…)` | `message.data` (TEXT) | SQL `json_extract` on TEXT — no `fromDriver` | ✅ |
| 7 | `credentials.ts` backfill `json_extract(message.data,…)` | `message.data` (TEXT) | SQL `json_extract` on TEXT | ✅ |
| 8 | `message.data`/`part.data` untouched (0 blobs) | TEXT | — | ✅ |
| 9 | full frame audit (all framed rows CRC+JSON) | `event.data` BLOB | `decompressFrame` (also via `fromDriver`) | ✅ |
| 10 | fail-closed (4 corruptions throw, healthy rows unaffected) | `event.data` | `fromDriver`/`decompressFrame` per value | ✅ |
| 11 | `sync.ts:76` global history scan `WHERE NOT (…) ORDER BY seq LIMIT 5000` | `event.data` | `fromDriver` | ✅ |
| 12 | v1 frame decodability (10-byte header, no CRC) | `event.data` BLOB | `decompressFrame` v1 branch | ✅ |

**Hard constraint (carried forward):** `event.data` must **never** be the target of a SQL `json_extract` *after* framing — a BLOB frame breaks `json_extract` (SQLite requires TEXT/JSON). The 12 paths select the whole column and decode in JS, so they comply. Any future path that adds `json_extract(event.data, …)` must be rewritten to select-and-decode in JS.

---

## 2. Hot/cold tiering contract

**Framable (cold-only, background sealer): `event.data` ONLY.**
- Why: it is the byte king (`message.updated` ≈ 85–90 % of event bytes), it is **never** `json_extract`-ed by the app, and it is read only on history/replay/sync cold paths — never the interactive projection path (`MessageV2.hydrate` is projection-only, `arch-contract.md` §10.2).
- The sealer's eligibility predicate already encodes cold-only: `seq <= event_sequence.seq` (settled frontier) AND `owner_id IS NULL` (not running) AND `session.time_updated <= cooling cutoff` (dormant) AND `typeof(data)='text'` (idempotent skip of framed) AND `length(data) >= 4096` (threshold). Hot/active rows stay TEXT **by construction**.

**Must stay TEXT (queryable via `json_extract` + projection):**
- `message.data` — `core/src/session/usage.ts:113–144` and the credentials backfill `json_extract` `providerID`/`role`/`cost`/`time.created`. **HARD INVARIANT: a column with a SQL `json_extract` consumer is INELIGIBLE for framing** (a BLOB frame makes `json_extract` throw).
- `part.data` — `MessageV2.hydrate` projection (the hottest surface; scroll-back). Framing puts a decompress on every re-read of the hottest path. Stays TEXT.
- `session_message.data` — `SessionHistory.load` projection. Stays TEXT.
- `session.summary_diffs` — projection. Stays TEXT (or OPCL-framed inside the projection read per opcl-arch — a separate codec boundary, not the event store).

**If framing ever extends to `message`/`part`/`session_message` (the OPCL question):**
- Must be paired with **routing-column promotion**: move the queried fields to real columns (`message.provider_id`, `message.role`, `message.cost`, `message.time_created`) so `usage.ts` reads columns, not `json_extract(data)`. Then `message.data` can be framed without breaking queryability. (opcl-arch's lane already wants these as routing columns — `arch-contract.md` §10.2.)
- Alternative: a shadow uncompressed column holding only the queried fields. Rejected as messier than routing-column promotion.
- **Decision: DO NOT frame `message`/`part`/`session_message` in v1.** The win is small (the projection already holds a copy; the event store holds the canonical framed copy). Keep them TEXT. OPCL framing, if adopted, is **gated on routing-column promotion** so no `json_extract`-targeted column is ever framed.

---

## 3. V2 session cold-resume cost bounding (2.5 GB legacy aggregates)

**Fixture (from `corpus/ground-truth-v2`):** `ses_0361b832` = 2.5 GB raw → 273 MB stored across **772 framed rows** (6,866 events); biggest aggregate 18,416 events; max row ~32.8 MB.

**Principle (read-latency-first):** cold-resume decode is **background work**, exactly like sealing. The user must see their session immediately from the hot tail / already-projected state; the cold history streams in asynchronously and must never block interactive work.

**Four bounding mechanisms:**
1. **Lazy / incremental decode.** Page the replay (1,000 rows at a time, as `chunkdb-readlatency.ts`'s `pagedSelect` does). Do **not** decode all 772 frames up front. The V2 `SessionRunner` promotes admitted inputs into visible messages at safe boundaries and reloads projected history before durable continuation — it does not need the full decoded history to paint the first screen.
2. **Parallel worker pool for reads (reuse `chunkdb-seal-parallel.ts`).** Mirror the sealer's `worker_threads` pool, but for **decompression**: the main thread reads BLOB bytes (fast via the SQLite page cache) and ships them to workers for brotli/zstd decompress + `JSON.parse`. This keeps the main thread free for interactive work. The single-writer DB rule is unaffected (reads are read-only snapshots / WAL readers). Byte-balanced chunking (the bench's `CHUNK_BYTES = 16 MiB`) keeps any one worker from stalling on a 32.8 MB row.
3. **Decode cache (§4).** Keyed by `(row_id, crc32)` so re-resume / sync re-walk / warp re-export are free.
4. **G11 read-p99 throttle.** The decode pool consults the same read-pressure ladder as the sealer (normal / slow / suspend) and yields to interactive pressure.

**User-visible latency budget:**
- **First paint < 100 ms** — hot tail projection + a bounded decode of the most-recent cold rows (the tail is mostly hot TEXT; only the deep prefix is framed).
- **Full cold history decode (772 frames) in background:** ~772 / N ms of pure decode (N = workers). With 8 workers ≈ 100–200 ms brotli / 50–100 ms zstd, plus IO — **bounded < 1–2 s, non-blocking**. The interactive session is usable immediately; cold history fills in.

---

## 4. Decode caching strategy

**Why it is safe.** Frame v2 carries a `CRC32` over the **decompressed** bytes (header offset 10). A cache entry keyed by `(row_id, crc32)` is therefore guaranteed content-intact: any corruption changes the CRC and is rejected; a valid CRC ⇒ intact bytes. So we cache decompressed bytes **without re-validation** — the CRC *is* the integrity check.

**Key:** `(row_id, crc32_from_header)`. The CRC lives in the 14-byte header, readable without decompressing (cheap after the BLOB fetch). Fallback key component: `stored_bytes` (stable because the sealer is the only writer) if the header is not yet in hand.

**Value:** **decompressed bytes (`Uint8Array`), not parsed object graphs.** Per `arch-readpath.md` §4.2, the event adapter's re-reads are rare / one-pass; caching bytes kills the decompress tax on *repeat* reads (a repeat read of any event in a frame = index + parse only, no decompress). This is the single highest-leverage read accelerator.

**Memory bound:** ~**32 MiB** decompressed-frame cache (the `arch-readpath.md` §4.1 re-split; raised from the old 64 MiB page-only budget, justified by measured read win, never an entitlement). 32 MiB ≈ 2,000 × 16 KiB frames. For the 2.5 GB aggregate (772 frames, ~3.2 MB decompressed each) the cache holds a **working subset** (recently / recently-read frames) — correct, since it is a working set, not the whole aggregate, and a single cold-resume is one-pass.

**Admission:** scan-resistant (2Q/SLRU) everywhere — a long replay must not evict the interactive working set (G5). **Pre-warm items** (the sealer writes its just-built frames' decompressed bytes into the cache as it seals — ≈ 0 marginal cost, it already holds the bytes) are marked **lowest-priority / first-evictable** so a user read always displaces them (`arch-readpath.md` §7).

---

## 5. Fail-closed production error contract

**Current state (good):** `decompressFrame` already fails closed — bad magic, bad CRC, `rawLen` bomb (> `RAWLEN_PRE_CAP`, rejected **before** decompress), unsupported version, unsupported codec → `OCDBFrameError` carrying a `restoreHint` (`bun x opencode-restore --db <path>`).

**Critical production gap.** Drizzle's *bulk* `fromDriver` mapping throws on the **first** corrupt row, losing the **entire** result set — healthy rows 1–499 and 501–1000 are discarded too. That violates "a corrupt frame never poisons healthy rows."

**Production fix — decode at the consume boundary, per-event, with a per-event fault boundary:**
- **Point reads** (single row by PK / event ID): Drizzle `fromDriver` is fine — one row, one decode; a throw is the correct fail-closed outcome for that one event.
- **Bulk history reads** (`readAfter` / `readAggregate` / `sync` scan): the adapter selects the **raw** `data` (`string | Uint8Array`) via raw SQL (NOT the customType auto-map), then decodes **per-event in JS** with a `try/catch`. A corrupt row → typed `OCDBFrameError(aggregate_id, seq, row_id, reason)`; healthy rows decode normally. The caller (replay / sync) then fails **deterministically on that specific event** — never serves a partial/garbage event, never loses the healthy ones.

**Typed error + recovery:** `OCDBFrameError` carries `(aggregate_id, seq, row_id, reason)` + the restore hint, surfaced to the user with a recovery path.

**Aggregate-level error budget:** if *many* frames in one aggregate fail, it is systemic (wrong codec / version mismatch) → surface **one** aggregate-level error, not 772 individual ones. Per-event isolation still holds for the healthy rows.

**"Never synthesize" (from `arch-contract.md` §4.2):** a corrupt event produces **no** partial event — replay's `isDeepStrictEqual` would otherwise false-pass (divergence hidden) or false-fail. Fail-closed is the only correct option.

**Corruption sources:** disk bit-rot (CRC), sealer bug (CRC on next read), external tampering (CRC). All fail closed. The sealer is the only writer and is crash-consistent (per-row `UPDATE` + `ocdb_seal` journal `UPSERT` in one tx), so a half-written frame cannot reach readers.

---

## Headline decisions (for PLAN.md)

1. **Wire `compressedJson` into `event.data`** — one-line schema change (`event/sql.ts:19`), same TEXT affinity, no migration, hot writes byte-identical. All 12 read paths covered automatically by the customType.
2. **Framing is `event.data`-only.** HARD INVARIANT: a column with a SQL `json_extract` consumer (`message.data`) is ineligible for framing. `message`/`part`/`session_message` stay TEXT in v1; OPCL framing (if adopted) is gated on routing-column promotion.
3. **Cold-resume decode is background work:** lazy paging + parallel worker pool (reuse `chunkdb-seal-parallel`) + decode cache + G11 read-p99 throttle. First paint < 100 ms; full 2.5 GB decode < 1–2 s non-blocking.
4. **Decode cache:** `(row_id, crc32)`-keyed decompressed bytes, ~32 MiB, scan-resistant, pre-warm-evictable. CRC32 makes it safe.
5. **Fail-closed:** per-event decode at the consume boundary (not bulk Drizzle mapping) so one corrupt row never poisons the batch. Typed `OCDBFrameError` + restore hint. Never synthesize.

---

## Tradeoffs

- **Per-row framing (prototype) vs OSES microframes (future).** The prototype frames one `event.data` row per frame; the future OSES design packs many events per frame with a per-event index. The decode cache key would shift from `(row_id, crc)` to `(frame_id, crc)` + per-event offset, and point reads would decompress one frame containing N events. This proposal is correct for the shipped store; the future design reuses the same CRC-safe cache + per-event fault boundary, just at frame granularity.
- **Raw-SQL + per-event decode (§5) vs Drizzle auto-map.** Raw SQL loses some Drizzle ergonomics but is required for per-event fault isolation. Acceptable: the event store is the only consumer and already uses raw SQL in the sealer/bench.
- **32 MiB frame cache vs working-set reality.** For a single 2.5 GB cold-resume the cache cannot hold all 772 frames; it helps on *re*-resume / sync re-walk. This is the intended design (readpath.md §4.2) — the decompress tax is killed on repeat reads, not on the first one-pass.
- **Background decode pool adds worker threads.** CPU contention is bounded by the G11 throttle; on low-end hardware the pool shrinks to 1–2 workers. Trade: slightly slower cold-resume for guaranteed zero interactive impact.

---

## Open questions (3–5)

1. **Bulk-decode fault boundary placement.** Should bulk history reads bypass Drizzle's customType auto-map (raw SQL + per-event decode, as proposed) or should we add a fault-isolating wrapper *inside* the customType so all callers get per-event isolation for free? (Ownership: `core/event` store.)
2. **V2 projector read-on-open.** Does the V2 `SessionRunner`/`SessionV2` read sealed event history on session open, or only the projection? This decides how much cold-resume decode cost matters and whether the worker pool is warranted vs a simpler single-thread lazy decode. (`arch-contract.md` §10.2 confirms the *renderer* is projection-served; the V2 projector's open-time behavior needs confirmation.)
3. **Decode-cache sizing per device class.** 32 MiB is proposed (readpath.md re-split). Should it be tunable for 8 GiB vs 16 GiB machines? D7/D9 calibrate the absolute number.
4. **OPCL-on-message gating.** If `message.data`/`part.data` framing is adopted (opcl-arch lane), is routing-column promotion (`provider_id`/`role`/`cost`/`time_created` as real columns) the agreed path to keep `usage.ts` working? Needs opcl-arch + contract-arch sign-off before any framing touches those columns.
5. **Corrupt-event UX policy.** On a single corrupt event during replay, should the session open **abort hard** (strict — replay needs all events) or **skip-and-report** (lenient — open without that history)? Strict is correct for replay correctness, but the user-facing behavior (restore hint + offer to open without history) needs a product decision.
