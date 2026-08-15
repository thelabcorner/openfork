# Adversarial Convergence Check — ROUND 4 (final pass before PLAN.md)

**Author:** adversary, swarm `chunkdb-ideation` · **Date:** 2026-08-15
**Basis:** re-read of all six architecture chapters (final revision wave 12:18 AM: codec/storage/corpus/readpath/migration/contract) + the three adversarial docs (`evaluation`, `evaluation-r2`, `optimization`). This is the honest final sweep: nothing below is invented to justify the round — two items are real, both small, both fixable in one line.

---

## 1. Does anything reasonable remain? — YES, two small items (both surfaced now, both one-line)

### F1 [FORMAT-CONSISTENCY] readpath.md's digest size contradicts the pinned 128-bit format decision
- **The pin (3 chapters, consistent):** storage.md §1.x ("`has_digest` flag + optional **128-bit** digest (sha256 truncated to 128 bits over the CANONICAL data)... **64-bit digest could false-positive-match and silently drop a divergent replay (correctness bug)**; 128-bit is collision-negligible"), codec.md §3.3 ("reserves a `has_digest` flag + optional **128-bit digest** (`sha256` of canonical data, truncated to 128 bit), empty until gated"), contract.md §4.4 ("16–32 B, sha256 truncated to 128-bit").
- **The contradiction:** readpath.md §1.4 stance (b) says "per-event STORED LOGICAL DIGEST (**crc32/sha256 of canonical data, 8–32 B/event** at seal, in the uncompressed index region)". An 8-byte crc32 is exactly the class storage.md's own wording warns against — it could false-positive-match and silently drop a divergent replay. If an implementer followed readpath.md, the format could reserve a crc32 digest with a material idempotency collision risk.
- **Fix (one line):** readpath.md §1.4 stance (b) must say "**128-bit sha256-truncated digest (16 B minimum)**; crc32 is never sufficient for the idempotent decision" — aligning with storage/codec/contract. (The 8–32 B range presumably came from an earlier crc32/sha256 sketch; the three chapters that pinned the correctness contract all rejected it.)
- **Why it matters:** the coordinator's item 2(c) asked for "same index region, same 128-bit, same authority-fallback semantics" — 3/4 chapters are identical (index region ✓, 128-bit ✓, authority fallback ✓); readpath.md is the sole outlier on the bit-size. This must be aligned before the format freezes, not at gates.json time.

### F2 [ROUTING-GAP] The signed-float G1 fixture is specified in contract.md but not recorded in the corpus lane's D10 proof protocol
- contract.md §4.4 residual (3) specifies: "the G1 differential includes a signed-float fixture (`-0`/`+0`/NaN-adjacent) as cheap insurance." Verified on disk.
- corpus.md's D10 row (the digest fast-path proof protocol) says "G1 differential (identical idempotent/divergent outcomes in both modes across the three-home corpus)" — it does **not** mention the signed-float fixture, and the G1 row in corpus.md has no signed-float/NaN mention.
- **Fix (one line):** benchmark-arch adds "G1 differential includes the signed-float `-0`/`+0`/NaN-adjacent fixture (contract.md §4.4 residual 3)" to D10's proof protocol at gates.json pin time. The fixture exists in the contract; it just needs to be recorded where the harness is built.

## 2. Everything else checked out — the full audit table

| Item (coordinator's ask) | Verdict | Evidence |
|---|---|---|
| (a) contract.md §7 LOS-1 compress-all wording | **Landed** | §7 line 219: "the 'raw below 64 KiB' tier may also narrow to 'raw only when the worth-it guard fails' since the value cache already absorbs decode" — gated on D2/D3. |
| (b) carry-over 1: G4 small-payload scoping | **Recorded** | readpath.md §1.3/§1.4: primary pin scoped to <64 KiB logical payloads; byte-king class gets its own documented row (<25 ms S3 / <10 ms S2, amortized); O1 ceiling noted. corpus.md D10 consumer column cites the G4 byte-king stance. |
| (b) carry-over 2: signed-float G1 fixture | **Recorded in contract, NOT in corpus lane** | F2 above — one-line routing gap. |
| (c) O1 format reservation consistency | **3/4 consistent — readpath.md outlier** | F1 above — 128-bit in storage/codec/contract; "crc32/sha256, 8–32 B" in readpath. |
| R6 G11 double definition | **Resolved** | readpath.md §8.1: "< 1% read-p99 — this is THE definition (NEW-R6, single definition)... the coordinator accepts... benchmark.md's G11 row will be aligned to < 1% at gates.json pin time." |
| R7 swap-pending marker + ordering | **Landed** | migration.md §4.2: `oses_migration.phase='verified'` marker; pinned startup ordering (0 pre-flight → 1 recovery → 2 swap-decision → 3 resume); K-SW-0..5 re-mapped. |
| R8 cross-volume rebuild | **Landed** | migration.md §6 Mode B = Tier-L default when DB-volume free is tight; swap-time FULL checkpoint + resumable byte-copy rehearsal-gated at D8 (correctly identified as the only user-visible migration I/O). |
| O1 format reservation (index region) | **Consistent (all 4)** | storage/codec/contract/readpath all: uncompressed index region, empty until gated. |
| O4 projection posture flip | **Landed** | corpus.md D1: "message.data IS large — D1 is the SIZE gate, not the yes/no gate; plan for OPCL-on-message." |

## 3. Provisional-by-design (not defects — the corpus gates that convert hypotheses to population claims)

These are the things I have deliberately NOT flagged as defects because they are gated measurements with proof protocols, exactly as the architecture intends:
- D1: OPCL-on-message scale (posture flipped to "IS large"; D1 sizes it).
- D2/D3: the 35–65% dedup band, SIZE_THRESHOLD/JUMBO_PROMOTE, cross-aggregate histogram (O5), value-entry codec choice (LOS-1/LOS-2), per-patch granularity (O2).
- D5: cooling/read-recency correlation.
- D7: geometry + Tier P/R placement + zstd-vs-brotli default-flip + page_size (O3/O7).
- D9: dedup-unit sweep + three-home rehydration differential + value-cache policy.
- D10: digest fast-path (F2's fixture routing aside).
- Reference-hardware pinning (corpus.md §7.3 UNRESOLVED — a coordinator/benchmark call, not an architecture defect).
- G11 number alignment to <1% at gates.json pin time (documented resolution).

## 4. PLAN.md readiness statement

The architecture is ready for PLAN.md. After three adversarial passes and the final convergence audit, the plan claims: (1) per-aggregate exact-value dedup of summary.diffs via a transactional `event_value` table (original-span storage, semantic+canonical dual guard, per-value crc32 read-tag, compressed entries, cascade-only GC) composed with (2) single-frame-per-segment OSES history (16–32 KiB, Tier P/Tier R placement, 128-bit digest field reserved in the uncompressed index for the gated digest-first idempotency fast path) on a hot tail that is byte-identical to today's `event` table, (3) a file-swap rebuild migration (swap-pending marker, Mode B cross-volume, rollback-by-file-restore), and (4) a read-path that is bounded-low at every point except the documented, amortized byte-king materialization. The provisional-by-design quantities — the dedup band, geometry, codec defaults, G4/G11 absolute numbers — convert to population claims at corpus-v1 in this exact order: **D1 (projection/OPCL scale) → D2/D3 (dedup band + thresholds + cross-aggregate + value-entry codec) → D5 (cooling) → D7 (geometry/codec/page_size sweeps) → D9 (granularity + rehydration differential) → D10 (digest fast path)**, with reference hardware pinned before any absolute gate. Two one-line fixes (F1 readpath digest wording; F2 signed-float fixture into D10) should land with the chapters, not at pin time. After that: no remaining reasonable claim — this is the convergence the rounds were built to produce.
