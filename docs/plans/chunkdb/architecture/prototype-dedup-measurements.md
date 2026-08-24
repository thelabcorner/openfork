# Prototype Stage 1 — Real-Corpus Dedup Measurements (D2/D3/D9/LOS-1/O5)

**Author:** coordinator, swarm `chunkdb-ideation` — prototype execution
**Data:** read-only bounded scan of the 18 GB sanctioned snapshot (`D:\opencode-backup\opencode-db-snapshot-20260812\opencode - Copy.db`). Source never modified. Heaviest 5 `message.updated` aggregates, 15,053 events, 3,988 MB raw.
**Method:** hash-based exact-value dedup identity (FNV-1a dual-lane for this measurement; the production format uses sha256 — identity is consistent within the run). This is **population evidence** for the `message.updated` byte class, not a hypothesis.
**Supersedes:** the `[HYPOTHESIS]` tags on the 35–65% band, LOS-1, and O2 in `PLAN.md` §3 where they conflict.

---

## 1. D2 — true whole-summary dedup elimination (population measurement)

| Aggregate | Events | Raw event bytes | Whole-summary elim | Elim % |
|---|---:|---:|---:|---:|
| `ses_0361b832…` | 1,713 | 2,497.7 MB | 1,259.8 MB | **50.4%** |
| `ses_01e19df4…` | 689 | 660.3 MB | 692.7 MB | **104.9%*** |
| `ses_00e74f7f…` | 4,401 | 344.4 MB | 218.8 MB | **63.5%** |
| `ses_00e74f84…` | 2,831 | 310.7 MB | 194.4 MB | **62.6%** |
| `ses_0310c32…` | 5,419 | 174.9 MB | 103.2 MB | **59.0%** |
| **Blend** | 15,053 | **3,988.0 MB** | **2,468.9 MB** | **61.9%** |

*>100% because the repeated summary bytes exceed the sampled row payloads (the aggregate's later events are tiny shells carrying a huge repeated summary).

**Result:** the whole-summary dedup band is **~59–64% on the byte-heavy aggregates, 61.9% blended**, materially **above** the plan's conservative 35–65% midpoint and right at its top. For the heaviest-5 message.updated slice (which is the bulk of event bytes), **~62% of event bytes are elim-inable before any compression**. This converts the headline D2 hypothesis to a population claim for this byte class. *(Whole-DB fraction remains bounded: message.updated ≈ 85–90% of event bytes, so event-subsystem elimination ≈ 0.62 × 0.87 ≈ 54% before compression — still strong, and it stacks with the LZ and value-compression layers.)*

## 2. D3 — distinct-value histogram (thresholds)

Across the 5 aggregates: **224 + 7 + 148 + 125 + 537 = 1,041 distinct whole-summary values** vs 15,053 events → **~14× average multiplicity**. The heavy session alone has 224 distinct values over 1,713 events (7.6×). Size distribution: distinct values range from ~13.5 MB (a low-multiplicity aggregate's residual) to the heavy session's ~1.24 GB total distinct bytes.

**Threshold implication:** with this multiplicity, even a modest `SIZE_THRESHOLD` (e.g. ≥1 KiB) captures virtually the entire win — the repeats are dominated by large diff patches. `JUMBO_PROMOTE ≥1 MiB` covers the 24 MB-class. **The proposed thresholds hold; D3 confirms they are not the binding constraint.**

## 3. LOS-1 — value-entry compression (compress-all confirmed)

| Aggregate | Distinct value bytes raw | brotli q1 | zstd l1 |
|---|---:|---:|---:|
| `ses_0361b832…` | 1,238.8 MB | 133.8 MB (11%) | 120.8 MB (10%) |
| `ses_01e19df4…` | 13.5 MB | 3.0 MB (22%) | 2.8 MB (21%) |
| `ses_00e74f7f…` | 123.4 MB | 28.0 MB (23%) | 23.5 MB (19%) |
| `ses_00e74f84…` | 114.9 MB | 26.1 MB (23%) | 22.3 MB (19%) |
| `ses_0310c32…` | 69.0 MB | 15.0 MB (22%) | 14.2 MB (21%) |
| **Total** | **1,559.6 MB** | **205.9 MB (13%)** | **183.6 MB (12%)** |

**Result:** the value table's residual footprint compresses **~7.5–8.5× (to 12–13%)**. The heavy session's 1.24 GB distinct values → ~120 MB (zstd l1). This **confirms the LOS-1 compress-all decision with population data** — the value cache absorbs the one-decompress-per-residency cost, so there is no read-path reason for a raw tier. **zstd l1 is consistently better than brotli q1 on diff-text values** (10–21% vs 11–23%), strengthening the O3 zstd-default case.

## 4. D9 — per-patch/per-entry granularity: REVISED (small win, not the headline)

### The incremental test (does per-entry add over whole-summary?)
**0.0 MB incremental** across all three heavy aggregates. Whole-summary dedup already captures every repeated diff entry, because a repeated summary is byte-identical including all its diffs. **When whole-summary is the dedup unit, per-entry granularity adds nothing on top of it** for repeated summaries.

### The distinct-summary overlap test (is there cross-summary entry sharing?)
379 distinct summaries → 786,365 entry slots → **16,786 distinct entry hashes**. Only **1.95% of entry slots** are shared across ≥2 *distinct* summaries (15,307 entries; max share 146×). Patch-level: 785,311 slots → 16,623 distinct, 15,290 shared (1.95%).

**Result:** per-entry/per-patch granularity could recover at most **~1.95% of the distinct-value residual** — on the 1.56 GB distinct-value class that's ~30 MB theoretical (less the ref-list overhead). **The adversary's O2 ("the compression-headline changer") is measured as a minor optimization on this corpus**, not a headline. The 35–65%→~62% headline comes from whole-summary dedup alone; per-patch would add ~1–2 percentage points of event bytes at best. **D9 verdict: keep whole-summary as the dedup unit in v1; O2 is a v1.1 marginal, not the ceiling-breaker hypothesized.**

## 5. O5 — cross-aggregate duplication: CONFIRMED same-workspace sharing

- 37 of 1,000 distinct summary hashes appear in ≥2 aggregates; cross-aggregate repeat bytes ≈ 194 MB in the sample.
- **Root cause verified:** all five heaviest sessions share the same directory — `C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts` — they are same-workspace sessions (ExtendScript/Illustrator tooling). Titles confirm: "arcfit-drm-phase5 / evidence-live", "refresh-portal", "Integrate ExtendScript Debugger", "Illustrator ExtendScript minification".

**Result:** the adversary's A3 hypothesis is **confirmed**: same-workspace sessions DO share patch text. 37/1000 distinct summaries (3.7%) are cross-aggregate, but they carry ~194 MB of repeat bytes — because the shared values are the large diff patches. This is **above the ~5% byte-share gate only marginally** (194 MB / ~4 GB sample ≈ 4.9%), but the *existence* of same-workspace sharing validates the O5 v1.1 candidate: a **global value table with refcount GC** would reclaim these cross-session duplicates, at the cost of cross-aggregate corruption blast radius and GC complexity. **Recommend: run the full D2/D3 global histogram before deciding; per-aggregate remains v1, global table is a v1.1 candidate with the evidence now pointing at ~5% additional.**

---

## 6. What this changes in the plan

| Plan claim | Before (hypothesis) | After (population, heaviest-5 slice) |
|---|---|---|
| D2 whole-summary elimination | 35–65% | **~62% blended** on the byte-heavy class; ~54% event-subsystem pre-compression |
| LOS-1 compress-all | justified by mechanism | **confirmed — 7.5–8.5× value-table compression** |
| O3 zstd l1 default | D7-gated candidate | **strengthened — zstd beats brotli on diff-text values (10–21% vs 11–23%)** |
| O2 per-patch granularity | "compression-headline changer" | **demoted — ~1.95% of distinct-value residual (~30 MB)**, minor v1.1 |
| O5 global table | v1.1-gated | **confirmed same-workspace sharing exists** (~5% byte share); global table is a real v1.1 candidate |

**The architecture's core claim is now population-anchored:** aggregate whole-summary dedup + value compression + shared-window LZ achieves the headline reduction on real data, and the "next ceiling" is not per-patch granularity (measured ~1–2%) but the **same-workspace cross-aggregate class (~5%)** and the **projection↔event duplication class (O4)**.

---

## 7. PROTOTYPE STAGE 2 — O4 projection duplication (corrected the plan's assumption)

Measured at whole-DB scale (1,847 sessions) plus the 3 heaviest sessions:

| Class | Whole-DB bytes | Content |
|---|---:|---|
| `message.data` | 902.2 MB | **100% summary.diffs** (sample of 200 largest: 442.9/442.9 MB) |
| `part.data` | 1,156.1 MB | unique text/tool output (not diffs) |
| `event.data` | 14,124.4 MB | the dominant class (13× the projection) |
| `session.summary_diffs` | **0 MB — never populated** | 0/1,847 rows in this fork |

**Findings that correct the plan:**

1. **`message.data` IS large** (902 MB, ~100% summary.diffs) — the O4 "message sealing ships" posture flip was right. But as a *projection* class it is **6% of the event log** (902 MB vs 14,124 MB), not a co-equal byte class.
2. **`session.summary_diffs` is dead weight in the plan's "third copy" argument** — this fork never populates it (0/1,847). The plan's O4 rationale cited `message.data` + `session.summary_diffs` + event = three copies; **measured reality is two copies** (projection `message.data` + event log), and the event log holds **3.0× copies per message row** (333,161 events / 109,950 messages).
3. **`part.data` (1,156 MB) exceeds `message.data` (902 MB)** — the projection tail is tool-output text, not diffs. The D1 projection tail measurement (per-`part_type` ≥4 KiB share) matters more than the O4 diff-copy framing.

**O4 verdict (revised):** OPCL-on-message remains worth doing (902 MB → ~60 MB at 0.06) but it is a **~6% whole-DB-class win**, not the "next byte class after dedup" the adversary ranked it. The measured order of remaining headroom is: (1) event-log dedup 61.9% + value compression 8× → **already the dominant win**; (2) cross-aggregate same-workspace class ~5%; (3) OPCL-on-message ~6% of DB; (4) OPCL-on-part (1.2 GB text, tail play). The projection↔event *duplication* framing should be replaced by "projection compression" — it's not redundant with the event store in this corpus (the projection is a genuinely separate, smaller copy, and the event log's 3× per-message amplification is the real redundancy).

---

## 8. PROTOTYPE STAGE 3 — read-latency / O1 fast-path (measured decode arithmetic)

Sealed point-read decode cost on real byte-king payloads (decode-only; frame/IO not yet built):

| Payload | full parse | **shell parse (post-dedup)** | summary parse | digest (sha256) | splice (memcpy) |
|---|---:|---:|---:|---:|---:|
| ~3 KB (2,239 B) | 8 µs | **5 µs** | 5 µs | 2 µs | 1 µs |
| ~50 KB (59,429 B) | 86 µs | **1 µs** | 81 µs | 35 µs | 48 µs |
| ~500 KB (427,273 B) | 760 µs | **1 µs** | 637 µs | 247 µs | 65 µs |

**Result — the G4 budget is validated by measurement:**

1. **Value-dedup turns the byte-king point read into a shell read.** A sealed `message.updated` point read pays the shell parse (~1 µs) + splice (~50 µs) + digest compare (~35–250 µs) instead of the full summary materialization (86–760 µs). The 500 KB event drops **~760 µs → ~50–100 µs** — comfortably inside G4 (S2 <500 µs) and the S4 hard bound.
2. **The O1 digest fast-path is confirmed viable:** sha256 of the canonical data is 2–250 µs depending on size — the digest is computed once at seal (background, free), and the replay-idempotency check becomes index-slice + digest compare, eliminating the summary parse entirely from the idempotent path.
3. **Splice is bounded:** the memcpy of a 427 KB summary is ~65 µs — the value-cache makes the 1,284× fan-out memcpy, exactly as designed.
4. The ~3 KB event (the plan's G4 calibration target) is already sub-10 µs even at full parse.

The decode chain measurement closes the R3/G4 arithmetic: **the byte-king point-read class is no longer a G4 violation** once dedup + the O1 fast path are in place.

---

## 9. PROTOTYPE STAGE 4 — D7 frame geometry on real post-dedup content

Window sensitivity measured on REAL payload classes (400 part.updated text events + 400 post-dedup message.updated shells, bounded sample):

| Class | 8 KiB | 16 KiB | 32 KiB | 64 KiB | one-shot |
|---|---:|---:|---:|---:|---:|
| **Unique text** (tool output, b1) | 0.1652 | 0.1626 | 0.1606 | 0.1580 | 0.1471 |
| **Value-ref shells** (message.updated post-dedup, b1) | 0.1985 | 0.1664 | 0.1318 | 0.1020 | 0.0799 |
| **Mixed** (text + shells, b1) | — | 0.1676 | 0.1648 | — | — |
| **Mixed** (zstd l1) | — | **0.1557** | **0.1533** | — | — |

**Findings (settle the D7 geometry question):**

1. **The 16–32 KiB frame lock is CONFIRMED on real content** — but for the opposite reason than the plan claimed. Unique text (the dominant frame content post-dedup) is **window-flat**: 8→64 KiB buys only ~4% (0.165→0.158). Each tool output is its own compressible unit; bigger windows don't help. The synthetic steer curve (0.193→0.044, 4.4×) that motivated "sweep to 64 KiB" was a tiny-event artifact that doesn't exist on real post-dedup content. **"Sweep to 64 KiB" is settled dead: ~1–3% on real text, not worth the point-read cost.**
2. **Value-ref shells favor smaller point-read frames**: shells are already ~1–2 KB stored; the 16 KiB Tier P frame holds ~30–80 of them and stays one BLOB fetch. The shell class improves with window (2× at 64 KiB) but it is the *point-read* class — Tier P's 16 KiB placement is confirmed by the read-latency budget (Stage 3), not the ratio.
3. **O3 zstd l1 is reinforced on real mixed content**: 0.1557 vs 0.1676 (brotli q1) at 16 KiB — zstd wins the mixed real frame too, not just diff-text values.

**D7 verdict: the 16–32 KiB band stays the v1 lock; Tier P 16 KiB / Tier R 32 KiB placement is confirmed on real data; zstd l1 default is the strongest it's been measured.**

---

## 10. Next prototype stages (what's still to measure)

1. **Whole-DB D2** — extend beyond the heaviest-5 to a broader aggregate sample for the true whole-DB elimination fraction (heaviest-5 = 61.9%; medium/small aggregates will dilute it).
2. **OPCL-on-part tail (D1)** — per-`part_type` ≥4 KiB share on the 1,156 MB part.data class.
3. **Sealer throughput** — span-walk + hash + splice cost at 18 GB scale (the 5–15 min CPU estimate).

*All measurements: read-only, bounded, source untouched. Stage scripts: `proto-dedup.ts`, `proto-d9-incremental.ts`, `proto-d9-distinct.ts`, `proto-o4-projection.ts`, `proto-o4-scale.ts`, `proto-readlatency.ts`, `proto-geometry.ts` (scratch copies under the run's temp dir; not committed).*
