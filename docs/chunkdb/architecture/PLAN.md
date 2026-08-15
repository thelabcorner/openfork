# OpenCode ChunkDB Storage — Executive Architecture Plan (PLAN.md)

**Author:** coordinator, swarm `chunkdb-ideation`
**Status:** EXECUTIVE PLAN — the product of six architecture chapters + four adversarial rounds (correctness → audit → optimization-maximization → convergence). **Not implementation code.** All quantitative claims are evidence-class-tagged per the corpus discipline (population / mechanism / hypothesis); corpus-v1 scans convert hypotheses to population claims.
**Documents:** `architecture/{corpus,storage,contract,codec,migration,readpath}.md` (chapters) + `architecture/{adversarial-evaluation,adversarial-evaluation-r2,adversarial-optimization,adversarial-convergence}.md` (adversarial records) + `ideation/*` (rationale).

---

## 0. One-page architecture

OpenCode's production database grows unbounded because the **durable event log** re-carries session state: the real 18 GB corpus (1,377,243 events) shows `message.updated.1` at ~85–90% of event bytes, and its payload is 95–100% `info.summary.diffs` — full git diff patches, with the **same diff stored 500–1,284× per session** (measured). The architecture eliminates that duplication, compresses what remains, and migrates safely — all invisible above the repository boundary, with retrieval made the critical resource.

```
READ LATENCY FIRST (seal/compression async in background — never affects the user)
│
├── HOT TAIL = existing `event` table (byte-identical to today; identity writes; sync fence untouched)
│
├── SEALED HISTORY = OSES segments
│   ├── one frame per segment (frame_count=1, 16–32 KiB: Tier P 16 KiB point-read / Tier R 32 KiB replay)
│   ├── aggregate VALUE TABLE (event_value): original-span bytes, sha256 content-addressed,
│   │   compressed entries, dual semantic+canonical guard, per-value crc32 read-tag
│   ├── per-event 128-bit logical digest RESERVED in the uncompressed index (gated fast path)
│   └── packed event IDs, type_set, sync append-ordinal, exact ID registry (unchanged from oses.md)
│
├── MIGRATION = file-swap rebuild (opencode.db.new born oses-v1, page_size at birth,
│   swap-pending marker, Mode B cross-volume default, rollback = file restore)
│
└── ADAPTER = storage-neutral EventStore (Tier A row gateway + Tier B read API, import guard),
    byte-splice rehydration, one logical event across TEXT/OCDB-frame/OSES-hot/OSES-sealed
```

**Headline claim (hypothesis, N=2 mechanism evidence):** event-subsystem reduction ≈ 94–97%, whole-DB ≈ 90–93% — the G6 gates (≥60%/≥25%) are the conservative *minimum*, not the claim. Converted to population claims by D1→D2/D3→D5→D7→D9→D10 at corpus-v1.

---

## 1. Settled architecture (survived four adversarial rounds)

### 1.1 Storage (storage.md)
- **Hot tail = the existing `event` table.** No `event_hot`, no hot-path surrogate keys. `event_sequence` is the sync-fence authority and stays byte-identical.
- **Aggregate value table `event_value`** — the headline move (frozen schema for D2/D3/D4):
  `(aggregate_id, value_id, sha256, raw_len, bytes, refs, time_promoted)`, per-aggregate scope, `UNIQUE(aggregate_id, sha256)`.
  - **Original-span storage**: value bytes = the exact byte span extracted from the original event TEXT by a UTF-8-aware span-walker (offsets in bytes, never UTF-16 code units; astral-boundary golden vectors).
  - **Dual guard**: (1) semantic — `JSON.parse(span)` deep-equals `parsed_event[path]` (closes walker-mislocation); (2) canonical — original == canonical re-serialization. Any failure → inline, never stored.
  - **Compressed entries (LOS-1)**: ALL promoted values ≥1 KiB compressed (OCDB envelope); raw only when the worth-it guard fails. sha256 over raw bytes (dedup key unchanged). Value cache absorbs decode (one decompress per residency, then memcpy splices).
  - **Per-value crc32 read-tag** verified before splice — one corrupt row can never silently poison 1,284 reads (fail-closed, detected).
- **OSES segments**: one frame per segment (frame_count=1 v1 policy, format field kept; multi-frame deferred to D7); 16–32 KiB; Tier P (16 KiB, zstd l1 default candidate) for point-read classes / Tier R (32 KiB) for replay text; packed event IDs (zigzag-delta mod-2^48 clock, uppercase-hex escapes); `type_set` exact delta-varint; sync append-ordinal (seq, ordinal); Tier A packed ID registry.
- **O1 format reservation (decided now)**: per-event `has_digest` flag + 128-bit sha256-truncated digest in the **uncompressed index region** — empty until the D10-gated digest-first idempotency fast path ships (sealed-point replay check ~5–20 µs instead of 1–5 ms materialization). 128-bit minimum: a 64-bit digest could false-positive and silently drop a divergent replay.
- **Sealer**: async, own connection (BUILD+COMMIT), append-safe prefix commit, `event_value_pending` ledger (promote-on-second; JUMBO_PROMOTE D3-gated), seal-time-only (never in the publish txn).

### 1.2 Codec (codec.md)
- Frozen registry `1=zstd, 2=brotli, 3=raw-deflate` (bytes already on disk). Brotli q1 = byte-stable baseline; **zstd l1 = default-flip candidate (D7)** — ~1.5–2× faster decode + better ratio on diff text (0.042 vs 0.061 [MEASURED]), byte-stable cross-runtime.
- Splice-ref encoding (placeholder + per-event ref list in the payload index); original-span storage → reverse export emits original bytes → G1 byte-identity passes unconditionally.
- Digest golden vectors (cross-runtime determinism, idempotent/divergent/corrupt vectors, full-compare authority parity via G1).
- NOT-VIABLE (confirmed): structural encoding (~2%, V2-steer class only), semantic deltas (≈ full-state post-LZ), zstd+dictionary (broken on Bun — gated), ref-based cross-layer dedup (breaks projection-read independence).

### 1.3 Contract (contract.md)
- Storage-neutral `EventStore` adapter (Tier A row gateway in-txn + Tier B read API), import guard banning `core/event/sql` + `event_value` outside `store*.ts`.
- One logical event, four physical homes (TEXT / OCDB-frame / OSES hot / OSES sealed-with-refs), byte-splice rehydration → exact original JSON text → `isDeepStrictEqual` replay exactness.
- Wire always carries full values (sync history, workspace export, /sync/replay) — refs are storage-local.
- `VALUE_DEDUP` gate independent of `EPOCH`; reversible; mixed-segment decode.
- Zero V1 public change (hydrate is projection-only; adapter is the only seam).

### 1.4 Migration (migration.md)
- **File-swap rebuild** replaces in-place shadow: build `opencode.db.new` (streaming legacy read-only, page_size 8/16 KiB at birth, born `oses-v1`, **no in-file epoch transaction**), catch up to frontier, swap at next startup fence.
- **Swap-pending marker + pinned startup ordering** (crash recovery → marker+verify → swap → resume): the normal completed-rebuild swap is reachable.
- **Mode B cross-volume rebuild = Tier-L default** (build on scratch volume; the only user-visible I/O is the final resumable byte-copy, rehearsal-gated at D8).
- Rollback = file restore of `.pre-oses` (zero reverse export during the window); reverse export (re-inflate refs + decode segments → plain JSON TEXT, fault-injected) only after the window closes.
- Three legacy states (pristine TEXT / OCDB-framed / OSES) via one row-level branch.

### 1.5 Read path (readpath.md) — read-latency-first is load-bearing
- **G4 semantics**: primary pin at S2 (warm OS, cold frame cache); S3 reported-secondary; S4 (<2 ms) the real cold hard bound; **byte-king logical-payload class (≥64 KiB) gets its own documented budget** (≤25 ms S3 / ≤10 ms S2, amortized; O1 digest fast-path is the ceiling).
- Mode-aware value preload (eager for replay ≤16 MiB/segment, lazy per-ref for point reads, 1 MiB jumbo admission cap).
- One combined cache budget (~120 MiB): SQLite page cache 64 + decompressed frames 32 primary + value/segment 16 + decoded 8–16 (projection-domain, gated).
- G11 seal-CPU-contention gate: <1% read/render p99 regression + model-token inter-arrival <1% during a full-throttle seal; read-p99 throttle paces the BUILD path.
- Tier P point-read decompress ≈ tens of µs (shell frames compress to ~1–2 KB; pure-ref frames are NOT skipped — worth-it guard is the single source of truth).

### 1.6 Corpus (corpus.md) — the load-bearing center
- Four tiers (T0 real sanctioned read-only / T1 real-derived frozen / T2 synthetic calibrated / T3 mechanism); eight measurement rules incl. the dominant-byte-class gate and the named-case registry (Case 001 = the summary.diffs correction).
- Gating deliverables D1–D10; evidence-class ledger on every number; hardware-first pinning order.
- **Corpus-v1 sequence:** pin reference hardware → D1 (message/part tail, O4 sizing) → D2/D3 (dedup elimination fraction, distinct-value distribution, cross-aggregate histogram) → D5 (cooling) → D7 (geometry/codec/page_size Pareto) → D9 (dedup-unit: per-patch vs whole-summary) → D10 (digest fast-path + G1 differential + signed-float fixtures) → pin gates.json.

---

## 2. Decision matrix (weighted, hard vetoes)

| Criterion | Weight |
|---|---|
| correctness / crash safety | 20 |
| active-write p99 / WAL | 15 |
| **read-latency p95/p99 (read-latency-first)** | 15 |
| total on-disk savings | 15 |
| cross-runtime compatibility | 10 |
| replay/range throughput | 8 |
| point-event first-miss latency | 5 |
| migration/rollback safety | 5 |
| memory/allocation | 4 |
| implementation/maintenance complexity | 3 |

**Hard vetoes (any one trips the review, regardless of score):**
1. Exact-replay break (any ID/seq/type/logical divergence; errors must match too)
2. Crash corruption (a killed process leaves a DB failing `integrity_check` or losing a committed event)
3. Unsupported runtime API (any format/codec/dict a shipped runtime cannot decode)
4. Pathological write amplification (>8×) or unbounded WAL under sealing
5. Privacy-poisoned dictionary (release dictionary trained on unsanitized content)
6. **Silent-corrupted-read** (a corrupt value row or walker mislocation served to readers undetected — closed by the crc32 read-tag + semantic guard)

---

## 3. Ranked optimization roadmap (from adversarial-optimization.md)

| Rank | Optimization | Ships | Gate |
|---|---|---|---|
| 1 | **O1 digest-first idempotency** (format field reserved NOW; fast path gated) | v1 field, gated fast path | D10 + G1 differential |
| 2 | O2 per-patch value granularity | v1.1 | D9 |
| 3 | O3 zstd l1 default (Tier R + value entries) | v1 if D7 confirms | D7 + value-entry bench |
| 4 | **O4 OPCL-on-message.data** (projection↔event duplication — next byte class; routing-plane prerequisite same-release) | v1 (decision pending D1) | D1 + hydrate gate |
| 5 | O7 page_size 8/16 KiB at file birth | v1 | D7 |
| 6 | O8 sealer-owned idle PASSIVE checkpoint | v1 | G8/G11 |
| 7 | O5 global value table | v1.1 | D2/D3 histogram ≥5% |
| 8 | O6 truncated sha256 key | v1.1 | D2 value-count scale |
| 9 | O9 pre-warm neighbor/first segments | v1.1 | D9 |
| 10 | O13 decoded-object tail cache (event adapter) | proven-only-later | readpath Q1 + D9 extension |

**Cut:** O11 structural encoding (V2-steer only), O12 semantic deltas (dead), O13 default OFF.
**Default-flips recorded:** O1 digest field, O3 zstd l1 (post-D7), LOS-1 compress-all-values, O7 page_size.
**Performance losses flagged and fixed:** LOS-1 (raw-below-64KiB tier → compress-all), LOS-2 (brotli Tier R → zstd l1 D7), LOS-3 (4 KiB pages → 8/16 KiB at birth), LOS-4 (G6 undersells floor → floor-as-headline, gates-as-minimum).

---

## 4. Acceptance gates (pinned at corpus-v1; provisional numbers)

| Gate | Target (proposed, hardware-first pin) |
|---|---|
| G1 correctness parity | 0 divergence (incl. -0/+0/NaN fixtures across three homes) |
| G2 cross-runtime golden | exact logical equality; byte-equality for brotli/zstd-dict-less; original-span → byte gates passable for sealed |
| G3 active-write p95/p99 | ≤ +5% vs legacy (waivable <2 ms absolute, explicitly accepted) |
| G4 point-event | small-payload: <500 µs S2-primary / <2 ms S4; byte-king class: separate documented budget (O1 = ceiling) |
| G4b amplification | A_r ≤16× p99 |
| G5 range/replay | ≤ +10% vs legacy; no working-set eviction |
| G6 storage reduction | event ≥60% / whole ≥25% MINIMUM (floor headline ≈94–97%/~90–93%, hypothesis until D2/D3/D7) |
| G7 startup catch-up | no interactive-write p99 impact >5%; <60 s for 1000 aggregates |
| G8 sealer commit | p99 <10 ms; no unbounded WAL |
| G10 corrupt-frame/value fail-closed | deterministic bounded-time failure, no synthesized event |
| **G11 seal-must-not-affect-user** | <1% read/render p99 regression + model-token inter-arrival <1% during full-throttle seal |

---

## 5. Phased roadmap

```
Phase 0  CORPUS (benchmark-arch): pin reference hardware → D1→D2/D3→D5→D7→D9→D10 →
         freeze corpus-v1 + gates.json. EVERY number downstream is provisional until here.
Phase 1  CONTRACT + ROUTING (contract/opcl): EventStore adapter + import guard; route E8/E9;
         message role/provider_id/cost + part_type; rewrite usage/credentials/search; drop idx.
Phase 2  FORMAT (oses/codec): OCDB-envelope value entries (compress-all), span-walker + dual guard,
         crc32 read-tag, O1 digest field reserved, segment format v1 (frame_count=1), golden vectors.
Phase 3  MIGRATION (migration): file-swap rebuild (Mode B default, page_size at birth, swap marker),
         reverse export = tested code, D8 rehearsal (incl. framed-input leg + final-move at scale).
Phase 4  CUTOVER EXPERIMENT: gates G1-G11 on packaged Electron + compiled Bun; epoch flip behind
         feature gates (READ→SHADOW→WRITE_HOT→SEAL→VALUE_DEDUP→EPOCH).
Phase 5  OPCL PROJECTIONS: part.data first (BLOB-ready, no routing dep); message.data after D1 +
         routing plane (O4). Projection decoded working-set cache as the enabler.
Phase 6  GATED OPTIMIZATIONS (each independent): O1 fast path (D10+G1), O2 per-patch (D9),
         O3 zstd l1 (D7), O5 global table (D2/D3), O7 page_size (D7), O8 idle checkpoint (G8).
Phase 7  DEFERRED: structural encoding (V2-steer), cross-layer dedup (measured gate),
         protocol-safe history GC (needs replay/sync-safe checkpoint semantics; archive ≠ delete).
```

---

## 6. Consolidated risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Dedup band 35–65% is N=2 | High (evidence) | D2 whole-DB bounded scan is the FIRST corpus gate; all downstream numbers tagged hypothesis |
| G4 byte-king class materialization | Med (perf) | Documented separate budget; O1 digest fast-path = ceiling (D10) |
| Span-walker mislocation | High (correctness) | Dual semantic+canonical guard; failure → inline, never store |
| Corrupt value row ×1,284 fan-out | High (correctness) | crc32 read-tag verified pre-splice → fail-closed, never silent |
| File-swap unreachable swap | Med (UX) | Swap-pending marker + pinned startup ordering (K-SW-0..5) |
| Migration disk gate 26–30 GB | High (UX) | Mode B cross-volume default; user-visible I/O = one rehearsal-gated copy |
| Seal CPU contention with model stream | Med (perf) | G11 (<1% p99 + token inter-arrival); read-p99 throttle on BUILD |
| Multi-process sealer race | Med | Dedicated connection, single-writer lease, generation guard, BACKOFF |
| Cross-runtime byte drift | Med | Frozen registry; byte-stable brotli/zstd; two-tier golden vectors; capability probe |
| Rebuild cost estimate drift | Low | D8 measures real wall-time (walker 5–15 min/18 GB, not 1–3) |

---

## 7. Open questions (each with an owner + a corpus deliverable)

1. Real part/message tail distribution (D1) — decides O4 magnitude. [opcl + benchmark]
2. True whole-DB dedup elimination + distinct-value distribution (D2/D3) — converts every headline number. [benchmark]
3. Per-patch vs whole-summary dedup unit (D9) — the compression-headline changer. [oses + benchmark]
4. Post-dedup byte-class geometry/codec/page_size Pareto (D7) — O3/O7 + the 16–32 KiB lock. [oses/codec + benchmark]
5. Cooling predicate: event-ID clock vs session.time_updated (D5). [oses]
6. Digest fast-path viability + signed-float fixtures (D10 + G1). [benchmark + codec]
7. Reference-hardware authority — UNRESOLVED until pinned; blocks absolute gate numbers. [coordinator + benchmark]
8. Does session.updated summary repeat like message.updated's (7.1% rows)? [D2 sub-scan]

---

## 8. What the four adversarial rounds bought (summary)

The architecture was attacked four times by a dedicated skeptic and revised each time:
- **R1** killed the vacuous encode guard, forced original-span storage + a real guard, compressed the value table, cut microframe machinery to v1, closed the silent-corrupted-read hole, pinned the sealer commit connection, and fixed uppercase-hex ID escaping.
- **R2** added the semantic (walker) guard, pinned UTF-8 byte offsets, scoped G4 honestly, fixed three cross-chapter contradictions, made the file-swap swap reachable, and gave migration its first strengthening pass.
- **R3** reserved the O1 digest field (128-bit), flipped four defaults (zstd l1, compress-all, page_size, floor-claims), and identified the projection↔event duplication as the next byte class.
- **R4** converged: exactly two one-line fixes remained (digest wording, signed-float fixture), both landed.

The adversary's final statement: **no remaining reasonable claim** — the convergence the rounds were built to produce. What remains is not design but measurement: the corpus-v1 sequence converts the hypotheses (dedup band, thresholds, geometry, codec defaults, absolute latency numbers) into population claims, and the gates get pinned on real evidence.
