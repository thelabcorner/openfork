# Adversarial Optimization Pass — maximum potential, viability, provability (ROUND 3)

**Author:** adversary, swarm `chunkdb-ideation` · **Date:** 2026-08-15
**Brief:** push the strengthened architecture to its maximum possible performance/compression potential; judge every candidate on (potential × viability × provability); produce a ranked optimization roadmap with proof protocols.
**Baselines:** `adversarial-evaluation.md` (R1), `adversarial-evaluation-r2.md` (R2 — CONDITIONAL READY), the six strengthened chapters.
**Reconciliation status note:** R1/R2 landed in storage.md §1.3 (semantic span guard + UTF-8 byte-offset walker, verified on disk). R4 is **half-resolved**: contract.md §7 fixed ("v1 = raw retired"), but **readpath.md §3.4/§10 still carries the three stale "raw in v1" spots** (lines 206/426/450) — the only outstanding R1–R10 item. R10's stale cross-refs also remain (readpath §2.2 flag; codec.md §3.5 alignment flag).
**Evidence labels:** [HYPOTHESIS] = computed from mechanism evidence, pending corpus; [MEASURED] = probe/mechanism; [T0] = corpus-anchored; [VIABLE]/[VIABLE-GATED]/[NOT-VIABLE] = the Part B filter.

---

## PART A — SEEK THE CEILING (per axis: current number → achievable floor)

### A1. COMPRESSION — current → ceiling

**Current stack:** per-aggregate exact-value dedup of summary.diffs (35–65% event-subsystem elimination **[HYPOTHESIS, N=2]**) → value-entry compression (brotli q1, raw below ~64 KiB) → shared-window LZ frames (16–32 KiB) → sessionID elision (~0.2%).

**Ceiling estimate for the 18 GB snapshot** (arithmetic from measured ratios — **[HYPOTHESIS]** pending D2/D3/D7):

| Byte class | Raw (est.) | Mechanism | Stored (est.) |
|---|---|---|---|
| `message.updated` (~85–90% of event bytes ≈ 14.4 GB) | 14.4 GB | dedup 40–70% → LZ ~0.06 | **0.26–0.52 GB** |
| distinct summary values (whole-DB est. 1.5–3 GB) | — | value entries, zstd l1 0.042 | **0.08–0.13 GB** |
| `part.updated` (≈1.6 GB) | 1.6 GB | LZ 0.04–0.09 | **0.07–0.16 GB** |
| `session.updated` + rest | ~0.6 GB | LZ | **~0.03 GB** |
| **Event subsystem floor** | ~18 GB | | **~0.45–0.85 GB → ratio ≈ 0.025–0.047** |
| Projections (message/part/session rows + FTS search_text) | ~2–4 GB | OPCL ~0.06 (if D1 justifies message) | **~0.15–0.3 GB** |
| SQLite/index overhead (hot tail, registry, FTS) | | | **~0.3–0.6 GB** |
| **Whole-DB floor** | 18 GB | | **~1.2–2 GB → ratio ≈ 0.07–0.11** |

**Headline:** the plan's gates (G6: event ≥60%, whole ≥25%) sit **3–4× below the achievable floor**. The floor is ~94–97% event-subsystem reduction and ~90–93% whole-DB reduction — the gates are minimums, not the claim. Recommend PLAN.md states the floor as the headline target and keeps the gates as the conservative minimum. **[HYPOTHESIS — the D2/D3/D7 scans are what convert this to a population claim.]**

**Redundancy the plan still stores twice (attack per axis):**

1. **Projection↔event duplication (the next byte class).** `message.data`'s `info.summary` mirrors the LAST `message.updated` event's summary (ground truth: 7/7 + 9/9 projection↔latest-event exact matches **[T0]**); `session.summary_diffs` carries the same session summary a THIRD time. The plan defers cross-layer dedup ("coupling the projection read path" — readpath §0.2/§4.4). **The ref-based cross-layer dedup is rightly NOT-VIABLE** (the renderer's hottest surface must not depend on the event store), **but the OPCL-framing half is a live, unclaimed win**: a session with N messages × 548 KB summaries duplicates ~N × 548 KB in the projection, and OPCL at ~0.06 compresses it 16×. The plan currently treats "message sealing" as a possible declared no-op pending D1 — **the corpus says it will NOT be a no-op** (the byte king is summary.diffs and message.data mirrors it). D1 is the gate; the default posture should be "message.data IS large, plan for OPCL-on-message".
2. **Cross-aggregate exact repeats** (same-repo sessions sharing patch text): O5, gated on the D2/D3 histogram (P8 landed).
3. **Value-table overhead**: 32 B sha256/value (O6), and the raw-below-64-KiB tier (O14 — see Part B).
4. **Per-patch / per-diffs-entry granularity (O2)**: if summaries differ only in one file's patch across versions (225 distinct whole-summaries ≈ mostly-overlapping), per-patch dedup could recover much of the remaining 50% of message.updated that whole-summary misses. The format supports it (codec.md §3.4); the D9 dedup-unit sweep gates it. **This is the compression-headline changer.**
5. **Shells / structural class (~2–3%)**: already retracted with measurement; LZ captures it in-window; cross-aggregate structural redundancy would need a global dictionary (gated — Bun zstd-dict broken). **No re-open.**

### A2. READ LATENCY — current → ceiling

**Current:** G4 <500 µs S2-primary for small events; **busted for the byte-king class** (R3: a point read of a message.updated event materializes the full summary — 3.2 KB–548 KB typical → 1–5 ms parse, over even the S4 2 ms hard bound). Tier P 16 KiB zstd; value cache; decoded-object cache OFF at the event adapter.

**Ceiling:**
1. **O1 — per-event logical digest + digest-first replay idempotency** (the R3-b generalization, now fully specified): the replay idempotency check (`commitDurableEvent` on a sealed seq) becomes: read the segment's **uncompressed index region** → compare stored digest vs digest(re-encoded incoming data) → match = idempotent, mismatch = divergence. **Zero frame decompress, zero value fetch, zero materialization.** Current cost of the check on the byte-king class: ~1–5 ms. Ceiling: ~5–20 µs (index slice + 32 B compare) — **100–1000×**. This closes R3 completely AND the G4 budget for the idempotency check becomes trivially met at ANY summary size.
   - **Format dependency (must be pinned):** the digest must live in the per-event payload-index entry in the **uncompressed** metadata/index region of the segment (the OCE2 layout already keeps header + ID/type/frame-directory streams uncompressed; the frames are the only compressed region). If the index were inside the compressed stream, the fast path would require a full segment decompress and the win evaporates. Reserve the per-event `has_digest` flag + optional 16–32 B digest in the v1 format **now** (cheap; empty until gated) so it is not a format break later.
2. **Decode floor:** Tier P point read of a compressed shell frame = read 1–2 KB + decompress (zstd l1) + slice + splice + parse small shell ≈ **sub-100 µs**. The frame is the granularity floor (brotli/zstd in node:zlib have no per-event seeking) — and the stored frame is ~1–2 KB for the deduped class, so the floor is already near-optimal. No further mechanism available short of a seekable codec (not in node:zlib; not worth a native addon).
3. **Codec decode speed (O3):** zstd l1 decodes ~1.5–2× faster than brotli **[MEASURED]** — for Tier R (replay/sync throughput) AND value-entry cache-misses, zstd l1 is the faster default on the dominant text class, byte-stable. Current plan: brotli q1 Tier R default, zstd only Tier P. **This is a SHOULD-IT-BE-DEFAULT candidate** (D7 decides).
4. **Decoded-object tail cache at the event adapter**: correctly OFF (streams one-pass; renderer reads projection). Confirmed — not a loss.
5. **Value cache / jumbo admission**: landed and correct (1 MiB LRU cap, lazy jumbo).

### A3. SEAL/BACKGROUND — the maximum the background can do

Seal is async with a generous budget — everything read-side expensive moves there. Current: registry `(frame_idx, offset)`, `value_set`, pre-warm of just-sealed frames + first segments. **Ceiling additions (all seal-funded, all free to the user):**
1. **O1's digest computation** — one sha256 over canonical data per large event at seal (~GB/s; a rounding error in the seal ledger).
2. **O8 — sealer-owned idle PASSIVE checkpoint policy**: the sealer (own connection) issues PASSIVE checkpoints during idle when WAL > soft cap, so the auto-checkpoint crossing-commit stall (G8's target) never lands on an interactive moment. Background, zero user cost.
3. **Pre-warm extension (O9, marginal)**: also pre-warm the segment *after* the just-sealed one for aggregates being replay-walked (sequential history). Low value; optional.
4. **The read-p99 throttle ladder (landed, readpath §8.2)** is the correct pacing control — the BUILD path (span-walk + hash + guard) is the CPU-contention risk G11 now measures. Keep.

### A4. DISK/WAL — the 18 GB → target floor

1. **The floor itself**: whole-DB ≈ 1.2–2 GB (A1 table) → **ratio ~0.07–0.11** (the plan's G6 ≥25% whole-DB gate is 3–4× under). **[HYPOTHESIS]**
2. **O7 — page_size 8/16 KiB on the new file**: the file is **born fresh at rebuild** — page_size is chosen at creation with zero migration cost (no VACUUM-over-18GB needed). A 16 KiB page holds a whole 16 KiB frame → BLOB fetch drops from ~8 page reads to 1. VIABLE-GATED (D7 sweep cell, currently listed as "offline VACUUM control" — should be a first-class new-file parameter).
3. **WAL during rebuild**: wal_autocheckpoint=10000 + explicit PASSIVE per batch (landed). TRUNCATE-checkpoint between passes keeps the .new WAL bounded.
4. **Rollback window**: .pre-oses retained 90 days; brotli-compressible ~4× → 4–6 GB. Landed.
5. **Cross-volume rebuild (R8, still open)**: build .new on a scratch volume; the 26–30 GB-free gate relaxes to DB-volume WAL headroom + one final move. **The hardest user-facing migration gate gets ~free.**

---

## PART B — VIABILITY (the hard-constraint filter)

Constraints: (a) replay exactness; (b) cross-runtime byte/golden parity; (c) read-latency-first; (d) no hot-path cost; (e) corruption containment; (f) corpus-first.

| # | Candidate | Viability | Constraint reasoning |
|---|---|---|---|
| **O1** | Per-event logical digest + digest-first idempotency | **VIABLE-GATED** | (a) isDeepStrictEqual stays the authority via a full-compare fallback (config/test mode); digest is sha256-truncated-to-128-bit — collision risk negligible; G1 differential asserts identical outcomes both modes. (b) sha256 cross-runtime identical; digest over canonical data (JSON.stringify of schema-encoded) — deterministic **[MEASURED]**. (c) removes work from the read path. (d) computed at seal, publish untouched. (e) digest lives in the segment index (segment CRC-protected); corrupt digest → mismatch → divergence error, fail-closed. (f) D10 measures. **Gate: G1 + a reserved format field now.** |
| **O2** | Per-patch / per-diffs-entry value granularity | **VIABLE-GATED** | (a) splice mechanics unchanged (refs at any subtree depth, codec.md §3.4). (b) no new codec. (c) ref-list grows (~6–10 B/ref; a 30-patch summary adds ~300 B/event index — negligible vs the 548 KB saved). (d) seal-time. (e) refs are per-event positional; fail-closed unchanged. (f) D9 dedup-unit sweep. **Gate: D9.** |
| **O3** | zstd l1 as default for Tier R frames AND value entries | **VIABLE-GATED** | (b) byte-stable across Bun/Node/Electron **[MEASURED]**. (c) decode ~1.5–2× faster. Ratio better on diff text (0.042 vs 0.061) **[MEASURED, mechanism]**. (a/d/e) neutral. **Gate: D7 real-corpus sweep + value-entry bench.** |
| **O4** | OPCL-on-message.data (projection duplicate compression) | **VIABLE-GATED** (ref-based cross-layer dedup = NOT-VIABLE) | Ref-based coupling breaks the projection-read-independence invariant (readpath §0.2) — NOT-VIABLE. OPCL framing is VIABLE: (c) hydrate adds one decompress per row, absorbed by the projection-side decoded working-set cache (readpath §4.4.2, opcl lane); (d) seal-time/background. **Gate: D1 (message.data ≥4 KiB share) + the hydrate gate (≤5–10% interactive).** |
| **O5** | Global (cross-aggregate) value table | **VIABLE-GATED** | (a) same splice contract, refcount-GC added; (e) cross-aggregate blast radius grows — must stay fail-closed; (f) D2/D3 histogram. **Gate: cross-aggregate duplicate share ≥~5%.** |
| **O6** | 64-bit truncated sha256 UNIQUE index key (full digest stays a column) | **VIABLE-GATED** | (a) full sha256 still computed at promotion; truncation only shrinks the index key; the exactness guard detects collisions. (f) D2 distinct-value counts. **Gate: value-count scale.** |
| **O7** | page_size 8/16 KiB on the new file | **VIABLE-GATED** | (c) BLOB fetch pages 8→1–2 for 16 KiB frames. (b/d/e) neutral. **Gate: D7 page_size sweep on the new-file format.** |
| **O8** | Sealer-owned idle PASSIVE checkpoint | **VIABLE** | (d) sealer's own connection; (c) removes checkpoint stalls from interactive moments; (a/b/e) neutral. **Gate: G8 WAL + crossing-commit stall measurement.** |
| **O9** | Pre-warm neighbor/first segments | **VIABLE-GATED** | Already partially in plan; marginal. **Gate: D9 cache-hit measurement.** |
| **O10** | (folded into O3) | — | — |
| **O11** | Structural encoding (V2 steer classes) | **NOT-VIABLE** | 0.015% of corpus rows; ~2% even where relevant **[T0]**. Cut — already retracted. |
| **O12** | Semantic deltas | **NOT-VIABLE** | Measured ≈ full-state post-LZ **[T0]**. Already cut. |
| **O13** | Decoded-object tail cache at the event adapter | **VIABLE-GATED, default OFF** | (c) serves replay reopen only; depends on readpath open Q1 (does session-open replay the event store?); memory amplification 2–4×. Keep OFF; revisit only on measured re-read hits. |

**Performance LOSSES vs plausible alternatives (the coordinator's flag):**
- **LOS-1:** the "raw below ~64 KiB" value-entry tier = a ~20× loss on the 1–64 KiB band. The value cache already absorbs decode (one decompress per residency) — there is no read-path reason for the raw tier; compress ALL promoted values (≥1 KiB), raw only when the worth-it guard fails (incompressible). **SHOULD-IT-BE-DEFAULT → compress-all.**
- **LOS-2:** brotli q1 as the Tier R default = decode-speed + ratio loss vs zstd l1 on the dominant text class. **SHOULD-IT-BE-DEFAULT (D7-gated).**
- **LOS-3:** 4 KiB pages on a file born fresh = BLOB-fetch page amplification. **SHOULD-IT-BE-DEFAULT (D7-gated) → 8/16 KiB at creation.**
- **LOS-4:** G6 gates at ≥60%/≥25% undersell the ~94–97%/~90–93% floor by 3–4× — the plan should claim the floor as the headline and keep gates as minimums. **Claims-strengthening.**

---

## PART C — PROVABILITY + RANKED OPTIMIZATION ROADMAP

Proof protocol fields: corpus deliverable (D# or new), tier, metric, acceptance threshold, falsification, evidence class. Ranked by (potential × viability × provability).

| Rank | Opt | Ships | Proof protocol | Acceptance | Falsification | Evidence |
|---|---|---|---|---|---|---|
| 1 | **O1 digest-first idempotency** | **v1 (format field reserved now); fast-path gated** | **D10 (new)**: on the 1,284×-repeat session (T1), replay-idempotency-check p99 with fast path on/off + digest index bytes/event; **G1 differential**: identical replay outcomes (idempotent / divergent) in both modes across the three-home corpus; authority full-compare retained in a test config | idempotency-check p99 ≥10× faster; zero G1 divergence; digest ≤32 B/event avg; ≤5% replay-throughput regression | any G1 divergence with the fast path on; digest cost >64 B/event | population (T1) |
| 2 | **O2 per-patch granularity** | **v1.1 gated** | **D9** (dedup-unit sweep, exists): whole-DB elimination at whole-summary vs per-diffs-entry vs per-patch on real aggregates; ref-list overhead per event; splice fuzz | per-patch adds ≥10pp elimination over whole-summary with ref overhead ≤2× and fuzz clean | per-patch <5pp better than whole-summary | population (T1) |
| 3 | **O3 zstd l1 for Tier R + value entries** | **v1 default if D7 confirms** | **D7** (exists) + value-entry bench (codec-arch): zstd l1 vs brotli q1/q4 on post-dedup Tier R content + distinct values; byte-golden both runtimes | zstd l1 ratio not worse AND decode p99 ≥1.2× faster on the real classes | brotli beats zstd on the real post-dedup text | population (D7) |
| 4 | **O4 OPCL-on-message.data** | **v1 (decision pending D1)** | **D1** (exists): message.data rows/bytes ≥4 KiB share, both units | material share → OPCL frames message.data; hydrate ≤+5–10% interactive (with projection decoded cache) | D1 shows message.data rarely ≥4 KiB | population (D1) |
| 5 | **O7 page_size 8/16 KiB** | **v1 (new-file creation)** | **D7** (add page_size as a first-class new-file cell): point-read p99 + BLOB-fetch page count + file size at 4/8/16 KiB | ≥10% point-read p99 reduction, ≤5% file-size increase | larger pages don't reduce BLOB fetch | population (D7) |
| 6 | **O8 idle PASSIVE checkpoint** | **v1** | **G8** (exists) + prod-path: WAL bytes + auto-checkpoint crossing-commit stall, idle-checkpoint on vs off | bounded WAL; no interactive read/write p99 regression (G11) | checkpoint policy moves p99 | population |
| 7 | **O5 global value table** | **v1.1 gated** | **D2/D3** (exists): cross-aggregate duplicate-byte histogram | ≥~5% cross-aggregate share → build; <5% → per-aggregate confirmed | share <5% | population |
| 8 | **O6 truncated sha256 key** | **v1.1 gated** | **D2** (exists): distinct-value counts per aggregate | ≥2^28 total values → truncate with exactness-guard audit; else keep full | value counts tiny | population |
| 9 | **O9 pre-warm neighbor** | **v1.1** | **D9** (exists): cache hit rate on replay-walk | ≥5pp hit-rate gain | no measurable gain | population |
| 10 | **O13 decoded tail cache** | **proven-only-later** | readpath open Q1 + **D9 extension**: session-open replay existence + re-read hit rate | only if open Q1 = yes AND hit rate material | Q1 = no | population |

**SHOULD-IT-BE-CUT:** O11 structural encoding, O12 semantic deltas (already cut — confirmed), O13 decoded tail cache (keep OFF), O9 if D9 shows nothing.
**SHOULD-IT-BE-DEFAULT:** O1's digest field (reserve now); O3 zstd l1 (post-D7); O14 compress-all-values (post-D2/D3 bench); O7 8/16 KiB pages (post-D7).
**Gates to add:** D10 (digest fast-path) is the only genuinely new deliverable; O3/O7 fold into D7; O2 folds into D9; O8 folds into G8/G11.

---

## PART D — VERDICT

**The single optimization that, if proven, changes the architecture's headline numbers most: O1 — the per-event logical digest with digest-first replay idempotency.** It is seal-funded (free to the user), byte-stable, and it converts the one broken headline (G4 for the byte-king class — R3) into a trivially-met budget: the replay-idempotency point read drops from ~1–5 ms of materialization to ~5–20 µs of index-compare, at any summary size. It also generalizes (divergence checks, sync-history verification) and it forces a format decision that must be made now regardless (digest in the uncompressed index region). Runner-up for the COMPRESSION headline: O2 (per-patch granularity) — it is the only remaining mechanism that can materially move the 35–65% number, and the format already supports it.

**Overall verdict:** the architecture is correct and near its practical floor on read latency and disk; the remaining headroom is (1) one format decision (O1's digest field) that must be reserved in v1 or become a format break, (2) two default-flips (O3 zstd l1, O14 compress-all-values) that D7/D2-D3 will confirm, (3) the projection duplicate class (O4) whose gate (D1) the plan currently treats as possibly-a-no-op but the corpus says will be a live win, and (4) claims-strengthening: the plan's G6 gates undersell a ~90%-whole-DB floor by 3–4× — claim the floor, gate the minimum. No NOT-VIABLE optimization should ship; no new D-deliverable beyond D10 is required.
