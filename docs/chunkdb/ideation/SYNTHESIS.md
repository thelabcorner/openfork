# ChunkDB Storage Architecture — Cross-Lane Synthesis

**Swarm:** `chunkdb-ideation` (swarm_44168cdd1e6e40ee9ba38f73d55bcc65)
**Branch:** `openfork` (fork of v1.18.18, pinned `31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d`, current `fc19430c2c`)
**Status:** IDEATION ONLY. Six lanes produced six independent design docs; this is the coordinator's reconciliation of those docs into one coherent architecture with the remaining open questions and a recommended implementation order.

---

## 0. How to read this document

Each lane delivered a full design doc in `docs/chunkdb/ideation/`:

| Lane | Doc | Owner focus |
|---|---|---|
| OSES physical design | `oses.md` (58.5 KB) | hot tail, segments/microframes, event-ID packing, elision, locator, sealer |
| OPCL projections | `opcl.md` (31.6 KB) | message/part payload codec + routing plane |
| Codec & cross-runtime | `codec.md` (36.2 KB) | codec registry, dictionaries, Node/Bun parity |
| Migration & rollback | `migration.md` (45.1 KB) | shadow store, epoch flip, reverse export |
| Benchmark & gates | `benchmark.md` (37.5 KB) | corpus, harness, Pareto sweep, acceptance gates |
| Product contract | `contract.md` (59.7 KB) | storage-neutral adapter, sync/replay, desktop surface |

This synthesis (a) records the **one fork fact that reshaped everything**, (b) resolves the **cross-lane contradictions**, (c) lists the **settled design decisions**, (d) lists the **open questions that only benchmarks can close**, and (e) proposes an **implementation order**.

---

## 1. The single most important finding: the fork is not v1.18.18 pristine

The research doc was written against upstream v1.18.18. **Every lane independently discovered that the openfork branch already ships a ChunkDB prototype slice**, and all six cross-validated it:

- `packages/core/src/database/json-codec.ts` — OCDB frame v2: `"OCDB"` magic, 14-byte header (version, codec, rawLen LE u32, CRC32-of-decompressed LE u32), **codec registry `1=zstd, 2=brotli, 3=raw-deflate`**, threshold 4096 UTF-16 code units, **identity `toDriver`** (hot writes stay TEXT), fail-closed `fromDriver`.
- `packages/core/src/database/chunk-sealer.ts` — background cold-row sealer: `typeof(data)='text' AND length(data)>=4096`, dormant-session eligibility, `ocdb_seal(table_name, row_id, raw_bytes, stored_bytes, time_sealed)` journal, partial index `idx_event_seal_candidates`, batch 128 / 5000 per pass, one short tx per row.
- `packages/opencode/bench/chunkdb-*.ts` — prototype benches (incl. a worker-thread parallel sealer).

Consequences that cascade through every lane:

1. **The "legacy event table" is already mixed TEXT/BLOB** wherever the sealer ran. OSES backfill and reverse export must **decode OCDB frames first** (migration-arch, contract-arch, oses-arch all agree).
2. **The codec registry is frozen and append-only** at `1=zstd, 2=brotli, 3=raw-deflate`. The research doc's `1=deflate` numbering (§22.2, Appendix B) **conflicts with bytes already on disk** and is superseded (codec-arch).
3. **The fork sealer is "OSES-lite."** OSES subsumes it: same identity-write + background-sealer split, same journal shape. It must be **gated off before OSES cutover** so two sealers never race (contract-arch, oses-arch, opcl-arch).
4. **The fork's backfill idiom is the migration chassis**: watermark cursor table + `Database.withBackfillDb` second connection + `retryOnLock` exponential backoff (`SessionSearch.backfillParts`). Migration should extend this, not invent machinery (migration-arch).

---

## 2. Cross-lane contradictions and how they were resolved

| Conflict | Lane A says | Lane B says | Resolution |
|---|---|---|---|
| Hot tail design | research doc: new `event_hot` table w/ integer surrogate keys | oses-arch: keep the existing `event` table | **Keep `event`.** `event_sequence` is the sync-fence authority (`fence.ts`, `workspace.ts` read it raw); rewriting breaks the FK + fence with no measured benefit. Surrogate keys move *inside sealed segment metadata* only. |
| Microframe geometry | research doc: 8–16 KiB microframes, 64 KiB segment | oses-arch: raise to 16–32 KiB raw; stored-bytes segment budget; `frame_count=1` legal | **16–32 KiB frames, 8–16 KiB stored segment target.** Workload is range-scan dominated (fork: 1.37M rows, replay/readAggregate > point reads); microframes serve corruption containment + cache granularity, not point-read latency. Geometry is runtime policy, swept by benchmark. |
| OPCL envelope | research doc: new OPCL v1 envelope (magic/version/codec/flags/dict-id/payload-len/checksum) | opcl-arch + codec-arch: reuse OCDB frame v2 | **No second envelope.** `payload-length` derivable; `dict-id` a documented extension point (reserve codec IDs 4–7, extend header to 18 B only if a dictionary Pareto-wins). |
| Message routing plane | research doc/Appendix A: role, provider_id, model_id, cost, 5 token cols | opcl-arch: **role + provider_id + cost only** | **Minimal plane.** `model_id` + tokens have zero live SQL consumers (one-time migration only). Reuse existing native `time_created` for `$.time.created` filters. Add `part_type` (ops/telemetry only). |
| Codec registry + stability | research doc: deflate baseline, zstd experimental risk | codec-arch [MEASURED]: **brotli q1/q4 and dict-less zstd are byte-identical across Bun/Node; deflate is NOT** | **Brotli q1 is the byte-stable baseline** (also the fork default). Deflate = interoperable-only compat (no byte-golden fixtures). Zstd = ratio-optimization candidate. |
| Zstd dictionaries | research doc: first-class experiment | codec-arch [MEASURED]: **zstd+dict broken on Bun 1.3.14 both ways** (dict silently ignored on compress; Node-written dict frames undecodable) | **Trained zstd dicts are gated/experimental.** Only cross-runtime-safe dict today = **structural deflate dict** (schema-only, zero privacy). Capability-probe every shipped runtime; writers emit the intersection. |
| Semantic elision | research doc: candidate manifest, cautious | oses-arch: **one provable rule** — elide `data[durable.aggregate]` (=`sessionID`) for every durable type | **Ship the one invariant-backed rule now.** `commitDurableEvent` enforces `data.sessionID === aggregate_id` at publish. This is the *only* rule no dictionary can cover (per-aggregate IDs can't be in a shared dict). Everything else (info.id, timestamp) = property-tested empirical candidates only. |
| Event-ID packing | research doc: 48-bit clock + 84-bit suffix, positive deltas | oses-arch [VERIFIED]: hex is `(ts*4096+counter) mod 2^48` — **top 5 bits truncated**, wraparound possible; suffix is `bytes[i] % 62`; `descending()` variant bitwise-NOTs | **Treat the 48-bit field opaquely; zigzag-delta uvarints; escape for non-canonical.** Packer round-trips the exact hex string, never re-derives timestamps. |
| Event-ID locator | research doc: Tier A registry vs Tier B fingerprint | oses-arch: today's `event.id` PK is *already* a full global ID index | **Tier A packed registry replaces the existing PK index (strictly cheaper, ~2.4×).** Tier B is a column-type change later, exact-verify from the packed stream. Benchmark decides. |
| Sync history ordering | research doc: "preserve deterministic behavior exactly" | contract-arch [VERIFIED]: tie-break **is** the rowid = global append order | **Documented two-key contract `(seq ASC, global_append_ordinal ASC)`.** OSES carries ordinal per-segment base + per-event uvarint deltas; k-way merge reproduces legacy exactly. |
| Migration protocol | research doc: 5-stage A–E always | migration-arch: **size-gate it** | **Synchronous startup-fence conversion below ~25k events / 256 MiB**; full shadow protocol only for the multi-GB tail. Resolves "is 5 stages over-engineered?" for the 99% desktop case. |
| Cache budget | research doc: shared budget | oses-arch + codec-arch | **One budget**: SQLite page cache (64 MiB today) + OSES frame cache ≤ storage budget; start OSES at 8–16 MiB, reduce SQLite only if measured. Scan-resistant (2Q/SLRU) admission. |
| Storage service role | research doc: potential canonical object store | contract-arch: stays **product-artifact store** (diffs/plans/snapshots) | **Not the OSES segment store.** Large-object externalization deferred behind a measured exact-duplicate gate; if pursued, only SQLite-manifest or extended-Storage designs with full transactional guarantees. |

---

## 3. Settled design decisions (all lanes agree)

**OSES durable event store**
1. Hot tail = the existing `event` table (rowid, `event.id TEXT PK`). No `event_hot`, no hot-path integer keys. `event_sequence` is the sync fence and never changes.
2. Aggregate accounting = sealer-owned extension table `event_aggregate(aggregate_id TEXT PK, sealed_seq, hot_count, hot_raw_bytes, last_append_ms, generation)` keyed by the same TEXT id (1:1 with `event_sequence`).
3. Sealed history = `event_segment` (metadata incl. exact `type_set`, CRCs, codec/dict IDs) + `event_segment_blob` (payload), per-aggregate, immutable after commit, `UNIQUE(aggregate_id, first_seq)` overlap guard.
4. Segments built OUTSIDE the write tx; one commit tx (insert segment + blob + registry + journal + delete hot prefix + update counters). Appends above `cutoff_seq` never invalidate a candidate; `generation` bumps only for representation-changing ops.
5. Sealer = fork ChunkSealer generalized (same frontier rule `seq <= event_sequence.seq AND owner_id IS NULL`, own connection, per-batch tx + yield, `oses_seal` journal reusing `ocdb_seal` accounting).
6. Elide `data[sessionID]` for every durable type (publish-enforced invariant); per-event elided/no-elision flags; rehydrate before schema decode.
7. Event-ID packing: zigzag-delta uvarint over the opaque mod-2^48 clock + 84-bit base-62 suffix; escape for non-canonical IDs; ~12–17 B/event vs 30 B ASCII.
8. Tier A packed ID registry as the v1 locator (replaces the `event.id` PK index); authoritative bytes live in the segment ID stream.
9. Sync append-ordinal carried in segments (per-segment base u64 + per-event positive uvarint deltas of `event.rowid`).

**OPCL projections**
10. Reuse OCDB frame v2 for `message.data`/`part.data`. No second envelope. `part.data` is BLOB-ready with **zero** routing migration (no JSON deps, FTS is native `search_text`). Seal part first.
11. `message` routing plane = `role` + `provider_id` + `cost` (live consumers: `usage.ts`, `fork/credentials.ts`, `search.ts`). Reuse `time_created`. Add `idx_message_usage(provider_id, role, time_created) WHERE provider_id IS NOT NULL`; drop `idx_message_provider_id` after rewrite. Add `part_type` for ops.
12. Threshold stays 4096 code units + 24 B worth-it guard. Identity writes; cold-only background sealing; sealed row updated reverts to TEXT and re-seals after 48 h cooling. **Write-through rejected as a codec invariant.**
13. OPCL on projections is a **tail play**: median part = 29 B stays TEXT forever; volume is large tool outputs (compaction marks `time.compacted` but never deletes `state.output`).

**Codec & cross-runtime**
14. Freeze registry `1=zstd, 2=brotli, 3=raw-deflate`, append-only. Brotli q1 default (byte-stable). CRC32 via `node:zlib.crc32` over decompressed bytes, LE u32.
15. Startup capability probe; writers emit the **intersection** of all shipped runtimes' codecs; readers fail closed on unknown codec/dict. Zstd-dict gated. Structural deflate dict = only ship-first dict.
16. Golden vectors two-tier: logical-equality for every codec; byte-equality fixtures only for brotli/zstd-dict-less.

**Migration & contract**
17. Migration = DDL-only drizzle migrations + watermark-cursor resumable passes on `withBackfillDb` + `retryOnLock`. Size-gate the shadow protocol. Epoch flip = guarded single-row `UPDATE storage_meta SET value='oses-v1' WHERE key='epoch' AND value='legacy'` + `PRAGMA user_version` mirror.
18. Reverse export is **tested code, not a paragraph**; reverse-export target = plain JSON TEXT; fault-injected at every phase; atomic flip-back with verification.
19. Stage C runs at **server boot before the HTTP listener** (startup fence), guarded by the epoch UPDATE + WAL write-lock; codec probe precedes the first post-cutover write.
20. Storage-neutral `EventStore` adapter in `core/src/event/store.ts` (Tier A row gateway + Tier B read API), both stores implement it, `EventV2` refactors onto it, import guard bans `core/event/sql` outside `store*.ts`. Token deltas stay non-durable and out of the codec path. Sealing is single-writer (sidecar primary; CLI via maintenance lease).

**Benchmark & gates**
21. Two-form corpus (logical op-streams + frozen legacy snapshots), committed small tier + URL-pinned large tier, sealed holdout, per-class entropy budgets, generate-at-bench-time = veto. Harness = one process, three engines (legacy/OSES/OPCL) on the raw native driver (semaphore bypassed), reusing `packages/opencode/bench/` Driver. Two-stage geometry sweep → Pareto front + knee + per-class heatmap. Cold authority on Linux `drop_caches`; Windows = `cold-approx`.

---

## 4. Acceptance gates (proposed, pinned at corpus-v1 in `bench/gates.json`)

| Gate | Target |
|---|---|
| G1 correctness parity | 0 divergence (IDs, seq, replay order, dup/divergence, projector, sync, hard-delete) |
| G2 cross-runtime golden | exact logical equality; byte-equality for brotli/zstd-dict-less only |
| G3 active-write p95/p99 | ≤ +5% vs legacy (waivable only if absolute < 2 ms, explicitly accepted) |
| G4 cold point-event p99 | < 500 µs S3; < 2 ms S4 (Linux-container authority) |
| G4b point-read amplification | A_r ≤ 16× p99 |
| G5 range/replay p99 | ≤ +10% vs legacy; replay must not evict interactive working set |
| G6 storage reduction | event subsystem ≥ 60% vs raw legacy (≥ 35% vs fork-framed); whole DB ≥ 25% / ≥ 10%; no per-class > 1.15× |
| G7 startup catch-up | no interactive-write p99 impact > 5%; < 60 s for 1000 aggregates |
| G8 sealer commit | p99 < 10 ms; no unbounded WAL |
| G10 corrupt-frame fail-closed | deterministic bounded-time failure, no synthesized event |

**Five hard vetoes** (any one trips the whole review): exact-replay break / crash corruption / unsupported-runtime-API / write amplification > 8× or unbounded WAL / privacy-poisoned dictionary.

---

## 5. Remaining open questions (benchmark- or product-owned)

1. **Does microframe independence survive the real-corpus sweep?** Format allows `frame_count=1`; if single-frame 16–32 KiB segments win on ratio + p99 (point reads rare), the *policy* default becomes one frame per segment. Blast-radius + cache-granularity must be quantified before spending complexity on multi-frame logic. *(oses-arch §10)*
2. **Sealing cooling predicate**: event-ID clock (`floor(clock/4096)`) vs `session.time_updated` (projection timestamp, bumped by any session write). ID clock is per-event and free; needs a corpus correlation check. *(oses-arch)*
3. **Real `part.data` tail distribution** (% rows/bytes ≥ 4 KiB per `part_type`; does `message.data` ever exceed 4 KiB in production?). Decides whether OPCL-on-projections ships for message or is a declared no-op. This is the **gating measurement** — the 9-part reference DB cannot answer it. *(opcl-arch)*
4. **`sync/history` payload size**: keep the full-array shape for v1 (zero client change) vs. additive `after`/`limit` pagination endpoint if materialization proves pathological. *(contract-arch §13.2)*
5. **CLI sealing**: maintenance lease (one sealer per DB) vs. CLI permanently excluded from sealing (read-only maintenance role). Decides how much lease machinery ships. *(contract-arch §13.3)*
6. **Corpus storage policy**: URL-pinned private store for multi-GiB corpora + who approves release of sanitized corpora. *(benchmark-arch §11)*
7. **Reference-hardware definition** for absolute gates (G4): pinned CI container authority, desktop = relative evidence. *(benchmark-arch §7.3)*
8. **`VACUUM INTO` portability + `sqlite_version()` per platform** (Electron vs Bun) — folded into the codec capability probe. *(codec-arch, migration-arch)*
9. **Packaged Electron 24.15 zstd-dict behavior + newer Bun fix** — moving target; re-probe on each runtime bump. *(codec-arch)*
10. **Reclaim policy**: "2 minor releases / 90 days + CI-proven reverse exporter" — config vs hardcoded. *(migration-arch §12)*

---

## 6. Fork landmines checklist (each verified by ≥1 lane)

- [ ] `event.data` may already be OCDB-framed → OSES backfill + reverse export decode frames first; `ocdb_seal` journal is the authoritative frame inventory.
- [ ] `idx_message_provider_id` + `SessionUsage`/`fork/credentials.ts`/`search.ts` `json_extract` on `message.data` → **silent NULL** on BLOB (no error). Native routing columns must land before any message framing.
- [ ] `part_fts`/`session_message_fts` are external-content FTS5 over native `search_text` → safe while `search_text` survives; any `part` table rebuild must recreate the virtual tables + triggers in the same tx.
- [ ] `search.ts` reads `json_extract(m.data,'$.role')` — search is a JSON consumer (research doc §21.5 wrong); rewrite to native `role`.
- [ ] `event_sequence` is the sync-fence authority → never rewritten/renamed; only reverse export upserts `seq`.
- [ ] Fork sealer must be gated off before OSES cutover; `ocdb_seal` + `idx_event_seal_candidates` = Stage E reclaim inventory.
- [ ] `event.id` PK is already a full global ID index → Tier A registry *replaces* it, doesn't add cost.
- [ ] Event-ID hex is mod-2^48 (truncated) and may be bitwise-NOTed (`descending()`) → pack opaquely.
- [ ] `data_migration` table is vestigial — don't resurrect; use the watermark idiom.
- [ ] Fresh-DB path seeds all migrations → every OSES/OPCL table must land in both `schema.gen` and a migration file or fresh/migrated DBs diverge.
- [ ] External `sqlite3`/`opencode db` sees BLOB payloads → routing plane is the supported SQL surface; shell edits can corrupt invariants the app must detect/fail-closed on.

---

## 7. Recommended implementation order (synthesis of all lanes)

**Phase 0 — Ground truth & corpus (benchmark-arch, blocks everything)**
- Build the two-form corpus (logical op-stream + frozen legacy snapshots incl. framing census) + `bench/run.ts` 3-engine harness + gates.json. Measure the gating `part.data` tail distribution. The 50-event reference DB is a *mechanism* corpus only.

**Phase 1 — Contract & routing groundwork (contract-arch + opcl-arch, no new storage format yet)**
- `core/src/event/store.ts` two-tier adapter; route E8/E9 (`sync/history`, `sessionWarp`) through it; import guard.
- Add `message.role/provider_id/cost` + `part.part_type`; rewrite `usage.ts`/`credentials.ts`/`search.ts` to native columns; `idx_message_usage`; drop `idx_message_provider_id`.
- Document the `(seq, append-ordinal)` sync contract + golden fixtures.

**Phase 2 — Codec & format foundation (codec-arch + oses-arch)**
- Capability probe; freeze registry; `node:zlib.crc32`; two-tier golden vectors.
- OSES binary parser/encoder (packed IDs, zigzag deltas, `type_set`, elision, frame_count optional), shadow schema + legacy/OSES differential reader; writes stay legacy.

**Phase 3 — Shadow backfill + reverse export (migration-arch)**
- `withBackfillDb` watermark-cursor shadow backfill (decode OCDB frames first); differential verifier.
- Reverse-export tool = tested code, fault-injected; rollback window policy.

**Phase 4 — Cutover experiment (all lanes)**
- Hot tail = existing `event`; Tier A registry; generalized sealer; startup-fence Stage C; epoch flip; feature gates (READ→SHADOW→WRITE_HOT→SEAL→EPOCH). Cross-runtime on packaged Electron + compiled Bun.
- Benchmark gates G1–G10; hard vetoes enforced.

**Phase 5 — OPCL projections enablement**
- Seal `part.data` first (no routing dependency); message sealing only if the tail measurement justifies it. Routing plane ships regardless.

**Phase 6 — Pareto refinements (independent, gated)**
- Fingerprint locator Tier B; structural-deflate dictionary if it Pareto-wins; trained zstd dict only when the capability probe passes on all runtimes; adaptive microframe geometry; scan-resistant frame cache; page_size control.

**Phase 7 — Deferred**
- Semantic deltas/checkpoints (only vs compressed OSES, post-compression Pareto test).
- Protocol-safe history GC (needs explicit replay/sync-safe checkpoint semantics; archive ≠ delete).

---

## 8. Where the research doc was wrong/outdated (consolidated)

The research doc is a strong *design skeleton against pristine v1.18.18*, but the fork reality supersedes it in these specific places:

1. §20.3/§F.2 `event_hot` rewrite → keep the existing `event` table (sync fence).
2. §22.2/App B codec numbering → frozen shipped registry `1=zstd, 2=brotli, 3=raw-deflate`.
3. §1.5/§22.5 event-ID clock → mod-2^48, truncated, may be NOTed; zigzag deltas.
4. §22.1/App A OPCL envelope → reuse 14 B OCDB v2; minimal routing plane (role/provider_id/cost, not model_id + 5 tokens).
5. §21.5 search independence → search IS a `message.data` JSON consumer (`search.ts:227`).
6. §17.8/§33.14 zstd posture → dict-less zstd is byte-stable; zstd+dict is *broken on Bun*; brotli is the stable baseline.
7. §25.3 batch numbers → fork idiom: 128/batch, 5000/pass, 48 h cooling, journal.
8. §1.2/§13 corpus → 50 events / 23 KB is not representative (fork: 1.37M rows, 32.8 MB max row).
9. §23.9 sync ordering → tie-break identified as rowid = global append ordinal; explicit two-key contract.
10. §20.8 locator → today's `event.id` PK is already a global ID index; Tier A replaces it (cheaper).
11. The fork's OCDB frame codec + chunk-sealer + `ocdb_seal` journal + `idx_event_seal_candidates` + `part_fts`/`session_message_fts` + `idx_message_provider_id` — none exist in the pristine baseline and all are load-bearing for this design.

---

## 9. Final position

The hybrid architecture the research doc recommended — **OPCL for current-state projections + OSES for durable event history, one SQLite authority** — is confirmed, with one major fork-driven simplification: **the fork's shipped OCDB frame codec and sealer become the payload layer and the migration chassis**, so "implement OSES" is largely *generalizing what the fork already ships* rather than building from scratch.

The highest-risk, highest-value next step is not more design — it is **Phase 0**: a real multi-session corpus and the 3-engine harness, because every quantitative claim still resting on the 50-event reference DB (compression ratios, geometry, locator footprint) is a hypothesis until then. Design decisions that are *correctness-critical and benchmark-independent* (keep `event` hot tail, elide `sessionID`, freeze the registry, keep `event_sequence` untouched, route sync through an adapter, decode OCDB frames before backfill) should be locked now.
