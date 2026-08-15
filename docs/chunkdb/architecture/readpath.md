# Read-Path Architecture — read-latency-first

**Author:** readpath-arch, swarm `chunkdb-ideation` (architecture-planning phase)
**Branch:** `openfork` (v1.18.18 fork). **Phase:** IDEATION + DESIGN (architecture chapter; illustrative pseudocode only, no implementation code).
**Parent constraint:** blackboard `architecture/read-latency-first` (coordinator directive, 2026-08) — **READ LATENCY IS THE CRITICAL RESOURCE.** Seal/compression/backfill may be async, slow, batch, background with a generous CPU/time budget **as long as it never affects the user**. RETRIEVAL MUST BE EXTREMELY FAST.
**Corpus authority:** `corpus/ground-truth-v2` (18 GB snapshot, 1,377,243 events; the 2.5 GiB raw heavy-tail aggregate fixture) + benchmark-arch's measurement discipline (`architecture/corpus.md` rules 1–8). Every absolute number here is **[PROPOSED]** pending corpus-v1 (D1–D9) and is pinned in `bench/gates.json` at corpus-v1 time — exactly like every other gate.
**Evidence labels:** [T0-MEASURED] = measured on the sanctioned 18 GB snapshot / ground-truth-v2; [MEASURED] = mechanism-class probe (reproducible, same legend as codec-arch); [VERIFIED] = read from the openfork tree; [LOCKED] = swarm-settled, not re-opened; [PROPOSED] = this chapter's design value, pinned at corpus-v1.
**Companions:** `architecture/storage.md` (frame geometry, value splice — §4.2 now settled under the read-latency constraint; this chapter records the resolution and adds placement), `architecture/contract.md` (adapter read path, rehydration), `architecture/codec.md` (decode-speed bias, splice-ref), `architecture/corpus.md` (measurement discipline, D1–D8), `architecture/migration.md` (file-swap rebuild), `ideation/event-codec.md` (window sensitivity), `ideation/SYNTHESIS.md` (locked decisions + gates).

---

## 0. The constraint, restated for this lane

Every read of durable event history pays a tax stack. From the outside in:

```text
read op = IO (SQLite page fetch)
        + frame decompression      ← the big one, scales with frame size
        + value splice             ← memcpy IF the value is preloaded; BLOB read if not
        + JSON.parse               ← linear in decoded payload
        + elision rehydration      ← sessionID from envelope, ~free
        + schema decode            ← Effect schema, per-event fixed cost
```

The directive re-prioritizes everything: the sealer's CPU budget is no longer scarce, so **every read-side optimization that can be funded by seal-time work is mandatory and free to the user** — richer indexes, more/smaller frames, pre-warming, value preload. The objective function flips from "storage bytes per CPU unit" to **"read p99 per op, on reference hardware, with seal CPU unconstrained."**

Two consequences frame the whole chapter:

1. **The interactive renderer never touches the event store.** [VERIFIED — contract.md §10.2] `MessageV2.hydrate` is projection-only (1 `message` SELECT + 1 `part IN(...)` SELECT — never `EventTable`, never `event_value`). So the event-store read surface is *history* reads: replay, readAggregate, readAfter/durable, sync-history, workspace warp, idempotent replay check. This is what read-latency-first governs on the event side. The projection read path (MessageV2.page+hydrate) is opcl-arch's lane; this chapter sets its budget but does not design it.
2. **Point reads on sealed history are rare but must be bounded-low.** The research doc and storage.md cached "point reads are rare" — true, but the directive says *when they happen they must be bounded-low* (session open of a cold aggregate, idempotent replay check, event-ID lookup). Rare is not an excuse for unbounded.

The design answer, in one line: **read-recency keeps the interactively-read history raw (zero decompress on the common path); the sealed path exists for old/cold history and is bounded by small frames + a seal-time accelerator + pre-warm.**

---

## 1. The read-latency budget (proposed numbers, pinned at corpus-v1)

### 1.1 Reference hardware and authority

Same as benchmark-arch §7.3: (a) a documented reference profile — mid-2020s laptop, 8-core, 16 GiB, NVMe — with full spec in provenance; (b) an always-identical Linux CI container whose **cold** numbers are authoritative (`drop_caches`, root). Windows desktop runs are `cold-approx` (OS page cache cannot be dropped from userspace — [VERIFIED] platform fact). Absolute gates run on Linux CI; relative gates are CI-relative. Every result row carries its cache-state label (S1 hot app caches / S2 warm OS + cold frame cache / S3 cold everything / S4 cold + no page cache) or it is rejected — per corpus rule 7.

### 1.2 The decode-tax budget allocation (per event, mechanism-class, S2)

The budget below is derived from the per-step taxes. These are **[MEASURED/estimates]** — mechanism-class from the fork prototype + codec-arch probes; the packaged-runtime confirm is corpus D7/D9's job:

| Step | 16 KiB frame | 64 KiB frame | Note |
|---|---|---|---|
| SQLite BLOB fetch (frame) | ~20–50 µs | ~50–100 µs | NVMe, page-cache-adjacent |
| **Decompress** brotli q1 | ~100–250 µs | ~0.5–1 ms | [MEASURED] the tax that scales with geometry |
| Decompress zstd l1 | ~50–125 µs | ~250–500 µs | [MEASURED] zstd decodes ~1.5–2× faster than brotli (codec.md §8) |
| Value splice (preloaded) | < 5 µs | < 5 µs | memcpy into the segment buffer |
| JSON.parse (1–4 KiB shell) | ~5–20 µs | ~5–20 µs | linear in decoded payload |
| Elision rehydrate + schema decode | ~10–40 µs | ~10–40 µs | per-event fixed |

The single geometry-dependent term is **decompress**. A 64 KiB frame's decompress (~1 ms) is 2× the *entire* G4 point-read budget (< 500 µs S3) before IO, splice, parse, and schema decode are counted. That is the quantified core of the §4.2 conflict (§2).

### 1.3 Per-op budget table ([PROPOSED], authority = Linux CI cold / reference desktop)

The table is the **read-path view** of the gate triangle; the G4 reconciliation with the frame-decompression arithmetic is §1.4 and §2.2 (Tier P placement + S2-primary pinning). **Reference hardware must be pinned FIRST** (corpus.md §7.3 is still [UNRESOLVED]) — the absolute numbers below are proposed values for that profile, not self-justifying constants.

| Read op | Surface | p99 budget S3 cold | p99 budget S2 warm-OS | Notes |
|---|---|---|---|---|
| Point event by (aggregate, seq), sealed — **small logical payload** (< 64 KiB) | adapter Tier A/B | < 500 µs (secondary) | **< 500 µs (primary pin)** | G4 reconciliation §1.4 — decompress+IO+parse must fit at S2; S3 reported, not gating |
| Point event by event ID, sealed | `eventIDLookup` + adapter | < 500 µs (secondary) | **< 500 µs (primary pin)** | locator only, never rehydrates (contract.md §3.2); registry carries frame offset (§5.2) |
| Point event, **hot** (raw TEXT) | adapter | < 100 µs | < 50 µs | index + JSON.parse, no decompress |
| Point event by (aggregate, seq), sealed — **byte-king logical payload** (≥ 64 KiB: the deduped message.updated summary class) | adapter Tier A/B | **< 25 ms** (documented, amortized) | < 10 ms | NEW-R3 scoping — JSON.parse is linear in the materialized payload; **O1 ceiling: with the stored logical digest (index-region, 128-bit sha256-truncated, 16 B minimum/event at seal) the sealed-point replay-idempotency check is ~5–20 µs (index slice + digest compare) instead of materializing the full summary (1–5 ms)** — gated on G1 differential + D10, see §1.4 |
| `readAggregate` page (100 events) | Tier B | **< 5 ms** | < 1.5 ms | range decode; the common history read |
| `readAfter` tail catch-up | Tier B / durable() | **< 2 ms to first event**; stream after | — | tail is mostly hot rows; sealed prefix bounded by range budget |
| Session-open durable replay (per 1k events) | adapter / projector | **< 10 ms** | < 3 ms | the 2.5 GiB aggregate is the stress fixture; must not evict interactive working set (G5) |
| sync-history (page of 100) | E8 via adapter | **< 5 ms** | < 1.5 ms | wire always carries full values (contract.md §4.1) |
| MessageV2.page + hydrate | projection (OPCL lane) | **≤ +0% vs today** | — | the hottest surface; read-latency-first must not regress it; it never touches OSES |
| SSE streaming deltas | pubsub → SSE | **exempt** | — | non-durable, no codec in the delta path (contract.md §6) |

Jumbo carve-out, extended (NEW-R3): a point read whose **materialized logical payload** is ≥ 64 KiB is inherently above the small-payload budget — JSON.parse is linear in the materialized bytes, so a 548 KB summary parse (~1 ms) or a 24 MB one cannot fit any sub-ms pin. **Stance (a), v1 (recommended): G4's primary pin is scoped to small logical-payload point reads (< 64 KiB); the byte-king class gets its own documented budget row** (above: < 25 ms S3 / < 10 ms S2, amortized — these are replay/sync-heavy classes anyway, and the safety tail + read-recency keep interactively-read history raw so the byte-king point-read path is rare). **Stance (b), gated optimization (deferred, G1-differential-covered):** a per-event STORED LOGICAL DIGEST — **128-bit sha256-truncated (16 B minimum); crc32 is never sufficient for the idempotent decision** (a 64-bit/8-byte digest could false-positive-match and silently drop a divergent replay — storage.md pin) — at seal, in the point-read accelerator, enables a digest-first idempotency fast path — on digest match, the replay check passes without materializing the payload; mismatch → full materialize + deep-equal. This is a replay fast-path semantic change and must not ship before the G1 differential proves digest-match ⇔ deep-equal on the three-home corpus. Benchmark confirms the carve-out threshold ([PROPOSED]).

### 1.4 The G4 triangle, resolved explicitly (adversarial finding #3/B1)

The adversary's arithmetic is correct and must not be hand-waved: the cold sealed point-read chain is **metadata B-tree + BLOB B-tree + ~8-page BLOB read + brotli-decompress 32 KiB (0.2–1 ms, storage.md's own number) + splice + JSON.parse + schema decode** — decompress *alone* can exceed the entire < 500 µs cold budget before any IO or parsing is counted. The triangle (gate < 500 µs cold ∧ frames 16–32 KiB ∧ honest decompress cost) cannot all hold at S3 cold on a 32 KiB brotli frame. **Resolution — all three corners, so no corner is silently dropped:**

1. **Tier P frames are sized so the arithmetic closes** (§2.2): point-read classes sit at **≤ 16 KiB, default zstd l1** (decode ~1.5–2× faster than brotli → ~0.05–0.15 ms at 16 KiB), and — the decisive closer — **the deduped point-read class COMPRESSES to ~1–2 KB stored** (adversarial A5, accepted in storage.md §4.2.3 + codec.md §4: the worth-it guard is the single source of truth, and it predicts pure-ref shell frames compress — they are repetitive JSON that brotli crushes ~20–40×). A point read of that frame reads 1–2 KB and decompresses 1–2 KB ≈ **tens of µs** — effectively ~nothing for the budget, and FASTER than a raw 16 KiB read (no skip-compression, which would have meant reading 16 KiB raw). The 32 KiB brotli worst case binds only on Tier R text frames, which are range-scanned (never point-read) — the decompress there is amortized.
2. **G4 is pinned at S2 (warm OS cache, cold frame cache), not S3 cold.** The point-read budget's *primary* pin is S2 (< 500 µs), because that is the honest interactive reality (a desktop that just touched the DB has warm OS pages; the frame cache is the cold part the design controls). S3 cold is reported as a secondary, non-gating number, and the S4 hard bound (< 2 ms) stays from SYNTHESIS. This is the adversary's option (a) — defined and said out loud.
3. **Reference hardware is pinned before the number.** corpus.md §7.3 is still [UNRESOLVED]; the absolute pins are proposed for the documented mid-2020s profile and are finalized on the Linux CI container at corpus-v1. No number is accepted as a self-justifying constant (benchmark-arch's rule 1).
4. **G4's primary pin is scoped to small logical-payload point reads (NEW-R3).** The class the design identifies as the point-read class — sealed message.updated (replay idempotency + ID lookup) — MATERIALIZES the full summary on splice: 3.2 KB–548 KB typical, max 24 MB. JSON.parse is linear in that payload (≈ 1–5 ms at 548 KB), 10–100× over the S2 pin AND over the S4 < 2 ms hard bound. No frame-size choice fixes this — it is a payload-materialization cost, not a decompress cost. Stance: **(a) v1 honesty — G4's primary pin applies to logical payload < 64 KiB; the byte-king class gets its own documented budget row (§1.3)** (which is fine in practice: byte-king point reads are replay/sync-heavy, and read-recency keeps interactively-read history raw, so this path is rare and amortized). **(b) gated optimization — per-event STORED LOGICAL DIGEST (128-bit sha256-truncated, 16 B minimum; crc32 is never sufficient for the idempotent decision) in the uncompressed index region, enabling a digest-first idempotency fast path** (digest match ⇒ idempotent without materializing — the sealed-point replay-idempotency check becomes an index slice + digest compare, ~5–20 µs vs 1–5 ms materialize; mismatch ⇒ full materialize + deep-equal). This is optimization-adversarial O1, ranked #1; it is a replay fast-path semantic change: deferred, gated on the G1 differential (digest-match ⇔ deep-equal, three-home corpus) + benchmark-arch's D10, and flips the byte-king point-read ceiling from the §1.3 row to the digest cost whenever it ships.

The seed of the adversary's option (b) (two-tier frames as a D7 dimension) is already this chapter's FRAME_TIER_P / FRAME_TIER_R split (§2.2), now explicit that Tier P must be small *enough that the arithmetic closes* — 16 KiB with zstd l1, ≤ 8 KiB as the brotli fallback cell for low-end hardware, both swept by D7.

### 1.5 Budget methodology

- Interleaved A/B (legacy vs OSES per rep) to cancel thermal/ASLR/cache drift; ≥1000 samples for ms-scale p99, 10k for sub-ms ops; bootstrap CI on p99 (benchmark.md §5 — unchanged).
- The adapter measures the *actual* decode path (JSON.parse + schema decode included) with codec-layer counters (frames decoded, decompressed bytes, parse time) — the same non-negotiable rule as benchmark.md §5.
- Percentile discipline per corpus rule 5/7: cold authority on Linux, sampling frame recorded.

---

## 2. Frame geometry under read-latency-first — resolving storage.md §4.2

### 2.1 The conflict, quantified (now resolved upstream — recorded for the record)

- storage.md v1 §4.2 + event-codec.md §2.3: microframe target 16–32 KiB, **swept to 64 KiB** for text-heavy frames. Window sensitivity on unique text: 0.193 (2 KiB) → 0.044 (64 KiB) → 0.036 one-shot. **Ratio keeps improving to 64 KiB** — that recommendation was written when the sealer's CPU/ratio were the constraint.
- Read-latency-first: a point read decompresses exactly one frame. 64 KiB ≈ 1 ms decompress (brotli) vs 16 KiB ≈ 0.25 ms (§1.2). **1 ms is 2× the entire G4 point-read budget.** Under the directive, the sealer is async and free, so *producing more smaller frames costs nothing user-visible*; the only objective that matters is read latency. The v1 §4.2 sweep was therefore not acceptable as a blanket default.
- **Resolution status: storage.md v2 (locked under this same constraint) withdrew the 64 KiB sweep and settled 16–32 KiB.** This chapter's contribution is the placement *inside* the band (§2.2) and the budget guard (§2.3). The conflict is closed; the reasoning is recorded here so future lanes don't re-derive it.

### 2.2 Resolution: settled 16–32 KiB band, class-adaptive placement inside it

**Frame geometry is now SETTLED** (storage.md v2 §4.2/§13.6, locked under this same constraint): **microframes are 16–32 KiB; 64 KiB is a measure-only sweep cell, never a default.** The storage-side rationale is exactly the read-latency one: a point read decompresses exactly ONE containing frame; 32 KiB ≈ 0.2–1 ms brotli, 64 KiB doubles that; window sensitivity flattens after 32 KiB (0.047@32 vs 0.044@64 ≈ 6% — 32 KiB captures ~94% of the ratio at half the decompress cost); and the sealer is async, so more/smaller frames cost nothing user-visible. This chapter **accepts 16–32 KiB as the band** and places the classes inside it:

```text
FRAME_TIER_R  (range/replay): text-dominated frames (part.updated runs, post-dedup
              unique text). Use the TOP of the locked band (32 KiB). Reads are
              replay/sync-range only → decompress amortized across 100s of events.
              zstd l1 preferred (decode speed, codec.md §8). 64 KiB stays a
              measure-only sweep cell.

FRAME_TIER_P  (point-read-optimized): event-batch frames that a point read may
              target (message.updated/session.updated post-dedup shells + refs,
              steers, mixed). BOTTOM of the locked band: 16 KiB with zstd l1
              (~0.05–0.15 ms decompress), ≤ 8 KiB as the brotli/low-end fallback
              cell — sized so the G4 arithmetic closes (§1.4). Decisive closer:
              the deduped point-read class COMPRESSES to ~1–2 KB stored (guard
              is single source of truth — A5 accepted in storage.md §4.2.3 /
              codec.md §4), so a point-read decompress is tens of µs.

FRAME_TIER_J  (jumbo singleton): > 64 KiB raw event → own frame (unchanged,
              storage.md §5 / SYNTHESIS).
```

The assignment's option (b) — "small point-read frames *plus* larger replay frames" — is adopted **in its non-duplicating form**: the frame builder places each batch by content class within the locked band. Literal two-copy tiering (the same events in a small point-read frame AND a large replay frame) is **rejected**: it doubles storage, breaks the "each event appears once / frame is the unit" invariant, doubles the index, and widens the corruption blast radius. The frame stream stays single; the *placement* is class-adaptive policy, not a format change (`frame_count=1` legal, geometry is runtime policy).

Rationale per class (post-dedup, post-elision):

- **part.updated (68.6% of rows, ~9.8% of bytes, unique streaming text)** is never point-read from the event store — the renderer reads parts from the projection, and event-side part reads are replay/sync only. The 32 KiB end of the band costs those reads nothing per-event (amortized) and buys the window-sensitivity ratio. **Tier R, 32 KiB.**
- **message.updated / session.updated post-dedup** are 4-byte placeholders + a ~200–600 B shell. A 16 KiB frame holds ~30–80 shells; a point read of one event decompresses 16 KiB (raw target), not the event. These are exactly the point-read candidates (replay's idempotent check re-reads them; sync-history walks them). **Tier P, 16 KiB zstd / ≤8 KiB brotli.** The decisive closer for the G4 arithmetic (adversarial A5, accepted in storage.md §4.2.3 / codec.md §4): the deduped message.updated shell frame is repetitive JSON that **compresses ~20–40× to ~1–2 KB stored** — the worth-it guard is the single source of truth, and at the Tier P 16 KiB target it predicts these frames compress (the frame-size threshold: **shell frames at the 16 KiB target compress ≈1–2 KB stored; only sub-MIN_GAIN tiny frames stay raw** — per NEW-R5, codec.md §4 will state this explicitly). A point read then reads 1–2 KB and decompresses 1–2 KB ≈ **tens of µs** — effectively ~nothing for the budget, and faster than a raw 16 KiB read. The frame-size floor binds only on text-heavy (range-scanned) frames. sessionID elision further shrinks the shells' cross-event repetition (event-codec.md §2.4).
- **Mixed frames**: the sealer prefers same-class runs "where cheap" but must not split on it (event-codec.md §3.1 — the frame is the unit). A mixed frame sizes to the stricter class (Tier P placement applies if any point-read candidate is inside).

**The explicit budget guard (the "measured justification" the assignment asked for):** the sealer holds a per-codec decompress-bytes/ms table (from the codec bench). It places each frame within the locked 16–32 KiB band so that `estimated_decompress_p99(size, codec)` stays under `POINT_READ_DECOMPRESS_CAP` for any frame that may be point-read — i.e. Tier P frames sit at 16 KiB with zstd l1 (≤ 8 KiB as the brotli/low-end cell; smaller still if the codec bench says a shell class needs it), and the 32 KiB end is reserved for frames provably Tier R (zero point-read candidates — type-classified at build). The cap is a benchmark output (corpus D7), proposed initial value: 250 µs → **16 KiB** for zstd, **≤ 8 KiB** for brotli. The band itself is locked; this guard only chooses the position inside it.

### 2.3 Codec interaction (reconcile with codec.md)

- **`zstd l1 per-frame adaptive` is promoted from "alternative" to "the preferred codec for Tier P frames."** [MEASURED] zstd decodes ~1.5–2× faster than brotli; under read-latency-first, decode speed is the primary codec axis for point-read candidates. Byte-stable (codec.md §2), so no parity risk. brotli q1 stays the locked baseline for Tier R frames (decode speed quality-independent; q4 remains seal-side-only).
- Frame-worth-it guard stays **post-dedup** (codec.md §4) — unchanged.
- De-escape pre-transform stays rejected ([MEASURED] escape-tax ≈ 0) — unchanged.

### 2.4 What this changes / confirms vs storage.md §4.2

| storage.md claim | Verdict |
|---|---|
| "Microframe geometry 16–32 KiB" (v2, LOCKED) | **Confirmed as the band** — this chapter places classes inside it: Tier P at 16 KiB, Tier R at 32 KiB. |
| "Sweep to 64 KiB for text-heavy frames" (v1 wording) | **Withdrawn by storage.md v2 — aligned.** 64 KiB remains a measure-only sweep cell. A 64 KiB point frame would blow the G4 budget by 2× on decompress alone. |
| "Frame is the unit; tiny events never framed individually" | **Confirmed** [LOCKED] — unchanged; class-adaptive placement never frames a single event. |
| "brotli q1 default; q4 text-heavy; zstd adaptive" | **Confirmed** for Tier R; **zstd l1 becomes the Tier P default** (decode speed). |
| "Microframes serve corruption containment + cache granularity, not point-read latency" (SYNTHESIS) | **Amended under the directive**: microframe size is now ALSO the point-read-latency mechanism. Tier P sits at the 16 KiB end of the locked band for exactly that reason. |
| Pure-ref/ref-dominated frames compress to ~1–2 KB stored (guard = single source of truth, A5 accepted) | **Confirmed and load-bearing** — the deduped message.updated class point-read decompresses ~1–2 KB ≈ tens of µs at any frame size; the frame-size floor binds only on the range-scanned text class. |

---

## 3. Segment-scoped value preload — making the splice near-free

### 3.1 The segment value buffer — mode-aware (eager for replay, lazy for point reads)

The splice read path today (contract.md §3.3): per ref, `valueCache.get(aggregate_id, value_id)` → miss → BLOB read. In the 1,284×-repeat session that is 1,284 BLOB reads for one value row unless the LRU hits.

Under read-latency-first the mechanism becomes **segment-scoped preload** (per the directive's own consequence #5) — but the adversary's correction lands here: *eager* preload of a whole segment's referenced values is right for full-segment **replay**, wrong for **scattered point reads**. A 200-event segment can reference up to ~200 distinct values, each up to 24 MB on the heavy session distribution — eager-first-touch would pull gigabytes to answer one point read. The preload is therefore **mode-aware**:

```text
REPLAY / RANGE (full or large slice of segment S) — EAGER:
  1. read S's referenced value set: SELECT value_id, bytes
       FROM event_value WHERE aggregate_id = ? AND value_id IN (S.value_set)
     -- one query; value_id is a per-aggregate ordinal, so IN is a small index range
  2. materialize into a per-segment in-memory buffer: Map<value_id, bytes>
  3. splice = buffer.get(value_id) + memcpy into the payload at the ref offset
  → one load, then every splice is a Map hit + memcpy. Zero BLOB reads.
  ADMISSION GUARD: if Σ bytes(S.value_set) > SEGMENT_BUFFER_CAP (proposed 16 MiB,
  D9-calibrated), degrade to lazy for the overflowing tail — never let one segment's
  buffer blow the working set (a jumbo-diff-heavy segment can exceed it).

POINT READ (one event in one frame) — LAZY, per-ref:
  1. parse the target event's ref-list from the frame's per-event index (already in hand)
  2. fetch ONLY those value_ids (typically 1–3 for a shell event) as individual
     event_value PK reads → splice → do not materialize the segment buffer
  → a point read pays 1–3 small BLOB reads, never the segment's whole value set.
  Jumbo values (> 1 MiB) are ALWAYS lazy on point reads (read row directly, splice,
  never cache) — §3.3.
```

The 1,284× repeat in replay becomes: **one SELECT, 1,284 memcpys**. This is the difference contract.md's value cache was already hunting (open Q5 of storage.md) — segment-scoped preload is its structural form. Point reads keep the bounded behavior: **the worst-case point read pulls only the refs of its own event**, so the gigabytes-of-values hazard the adversary flagged cannot occur on the point path.

### 3.2 `value_set` in segment metadata (seal-time, free)

The sealer knows, at frame-build time, exactly which `value_id`s each segment references (it wrote the ref lists). It writes the segment's referenced set into segment metadata:

```text
event_segment.value_set: BLOB — sorted uvarint value_id deltas (0 bytes when ref-free)
```

Cost: ~1–4 B per distinct value per segment — effectively free at seal. This makes the preload one query and lets the reader *skip* the preload entirely for ref-free segments (`value_set` empty → no value table touch, common for part.updated-heavy segments).

### 3.3 The value LRU and jumbo admission

- **Segment buffers** are scoped to one replay pass: they exist for the duration of the read op that touched the segment and enter a small **segment-buffer LRU** (keyed segment_id, proposed 8–16 MiB) so recently-replayed segments are instant on re-replay (session reopen, sync re-walk).
- **Value LRU** keyed `(aggregate_id, value_id) → bytes` (contract.md's cache) complements the buffers for *random access* across segments (point reads, warp export that jumps around). Sits in the combined budget (§4).
- **Jumbo admission** (contract.md open Q2, answered): the cross-segment value LRU **never caches a value > 1 MiB** (one jumbo row would evict the whole working set; 24 MB is 1.5× the proposed total value-cache share). Jumbo values live **only** in the segment buffer during their owning segment's replay scope — they were loaded anyway, and they leave when the scope ends. A point read of a jumbo value reads the row directly (one BLOB), splices, and does not cache. ([PROPOSED] 1 MiB; D9's value-size histogram calibrates.)
- **Fail-closed unchanged** (contract.md §4.2 / storage.md §2.3): missing `value_id`, sha256 mismatch, out-of-range offsets all fail deterministically with identity. The preload does not weaken any guard; it only changes *where* the bytes come from.

### 3.4 Reconcile with contract.md / storage.md

- contract.md §3.2's value cache: **confirmed**, with placement refined — segment buffer (first) + value LRU (second). Its G5 clause ("rehydration cost must not push replay beyond +10%") is now structurally satisfied: rehydration is memcpy.
- storage.md open Q5 (value-row read caching): **answered** — segment-scoped buffer + value LRU, budgeted in §4.
- storage.md open Q3 (`event_value.bytes` compress?): **resolved — compressed-by-default is adopted** (A4/E2, accepted; storage.md §1.1/§10.3, codec.md §3.5: OCDB envelope, brotli q1, raw when the worth-it guard fails, raw below ~64 KiB tier). The read-path consequence is absorbed by this chapter's own cache design: a value entry decompresses **once per value-cache residency** (segment buffer / value LRU, §3.1/§3.3), and the 1,284× splice fan-out after that is memcpy — identical to the raw case. The old "decompress on every splice" objection does not hold under the segment-scoped preload; a point read of a jumbo value remains one bounded decompress (lazy per-ref, §3.1).
- Wire/sync/warp: unchanged — the wire always carries full values (contract.md §4.1), refs never leave the adapter.

---

## 4. Cache architecture — the budget, re-split for read acceleration

### 4.1 The combined budget invariant (unchanged) and the re-split (changed)

Research doc §1.8 / SYNTHESIS: **one budget** — `SQLite page cache + OSES frame cache ≤ storage cache budget`; scan-resistant admission. The directive shifts *what the budget is spent on*: seal CPU is no longer competing, but **memory is still memory** (16 GiB desktops). The re-split ([PROPOSED], benchmark-calibrated):

```text
STORAGE_CACHE_BUDGET (proposed raise: 64 MiB → 96–128 MiB, read-justified):
  SQLite page cache            64 MiB   (unchanged — serves hot TEXT rows, BLOB
                                          fetch, segment metadata)
  Decompressed-frame cache     32 MiB   (read acceleration primary — kills the
                                          decompress tax on repeat reads)
  Segment buffers + value LRU  16 MiB   (splice near-free, §3)
  Decoded working-set cache     8–16 MiB (gated, §4.4; may start at 0)
  ----------------------------------------------------------------------------
  total                        ≈ 120–128 MiB
```

The raise is justified *only* by measured read win (D7/D9), never as a default entitlement; the invariant `page + frame + value + decoded ≤ STORAGE_CACHE_BUDGET` is enforced by a single tunable. Raising SQLite's page cache alone is not the answer — the page cache holds compressed bytes; the frame cache holds the decompressed form, which is what repeat reads actually need.

### 4.2 Decompressed-frame cache (primary — confirms research doc)

Research doc §1.8: "cache decompressed **bytes/frames, not parsed object graphs.**" **Confirmed and promoted to the anchor**: a frame cache hit turns a repeat read of any event in the frame into index+parse only (no decompress). This is the single highest-leverage read accelerator — the decompress tax is the biggest per-read cost (§1.2). 32 MiB ≈ 2,000 × 16 KiB frames ≈ the interactive working set of a busy day of sessions. LRU/2Q admission.

### 4.3 Value/segment caches

As §3: segment-buffer LRU + value LRU inside the 16 MiB share.

### 4.4 Decoded-object (working-set) cache — the honest weighing

The research doc said parse-object caching "buys little"; the directive asks whether read-latency-first changes that. **Weighed honestly:**

**For a decoded-event cache at the adapter boundary:** saves JSON.parse + schema decode (~15–60 µs/event, §1.2) on re-read; memory amplification ~2–4× raw bytes (an object graph is bigger than its JSON).

**Against it:** the event adapter's reads are **range-stream-once** — replay, sync-history, warp each stream a range forward and don't re-read the same events within a pass. The *repeated re-read* the directive cites is the **renderer** reading `MessageV2.page` (scroll up/down, re-open a session) — and that surface reads the **projection** tables, never the event adapter (contract.md §10.2). A decoded cache at the event boundary would therefore be cold for the renderer's re-reads and redundant for the adapter's one-pass streams.

**Verdict:**
1. **Event adapter: decoded-object cache is NOT justified as a default.** The research doc's "buys little" holds *for the event adapter specifically*; the read-latency-first directive does not overturn it there, because the event surface's re-reads are rare (idempotency, warp) and its streams are one-pass. **Gate it on a measured re-read hit-rate (D9 extension): if session-open replay or warp shows repeated event reads, enable a small 8 MiB decoded cache keyed by (aggregate_id, seq) — default OFF.**
2. **Projection boundary (MessageV2.page+hydrate): THIS is where the directive's "renderer re-reads the same messages" is real.** A decoded page/message working-set cache (bounded, keyed by session + cursor window, scan-resistant so scroll-back doesn't evict) directly serves repeated render. Ownership: **opcl-arch** (projection lane). The read-latency-first constraint *justifies* it now; the projection chapter should evaluate it with the D1 tail + a page-revisit measurement. This chapter sets the budget share and defers the design.
3. **The decoded projection cache is the enabler for OPCL-on-message under read-latency-first (O4, adversarial-optimization.md).** If the D1 tail shows `message.data` large enough to justify OPCL framing (O4: the projection-side framing win, opcl-arch's lane), each hydrate row pays **one decompress per row** — and the decoded working-set cache is what absorbs that cost: a cache hit turns a re-read of a framed message row into a decode-free object handoff, exactly as the event-side frame cache does for sealed segments. Without it, OPCL-on-message would put a decompress on the *hottest* surface (scroll-back over a long session). So the §4.4.2 decoded cache is not optional if O4 ships — it is the read-latency-first precondition for framing the projection's byte-king rows, and the 8–16 MiB budget share is its cap. (This is a projection-lane decision; this chapter only records the dependency.)

### 4.5 SQLite page cache role

Stays 64 MiB: hot TEXT rows are read through it; segment blobs and metadata are fetched through it; the frame cache is the value-add *above* it. Do not reduce it to fund the frame cache (measured — §4.1 note).

### 4.6 Scan-resistance is now load-bearing

A long replay must not evict the interactive working set — G5's clause, now *structural*: all four cache layers use scan-resistant admission (2Q/SLRU, research doc §1.8). Pre-warm items (§7) are marked lowest priority / first-evictable. This is a hard requirement, not a nicety: the 2.5 GiB heavy-tail replay fixture exists precisely to test it.

---

## 5. Point-read accelerator

### 5.1 The point-read path (hot vs sealed)

```text
point(aggregate, seq):
  hot?   seq > event_aggregate.sealed_seq
         → event table PK/index read → raw TEXT → JSON.parse.          (< 100 µs S3)
  sealed → SELECT segment WHERE aggregate=? AND first_seq<=seq
           ORDER BY first_seq DESC LIMIT 1                              (index range scan, small)
         → read segment metadata (frame directory, value_set)           (1 row)
         → binary-search the frame containing seq                       (directory)
         → read frame blob → decompress (Tier P: 16 KiB ≈ 0.25 ms)      (bounded by §2.3)
         → per-event payload index → splice refs → JSON.parse → decode
```

The frame directory already confines decompress to **one frame** (oses.md §22.7 payload-index design), and the storage lane's metadata/BLOB separation means the frame INDEX (per-event ordinal + ref-list + offsets) is parsed **before** any decompression — point-read *planning* never materializes payloads. The remaining question: what does seal time (async, free) add so the cold point read is minimal?

### 5.2 The seal-time accelerator (free to build, free to read)

1. **`event_id_registry` rows carry `(frame_idx, event_offset, event_len)`** — written at seal (the sealer has them; ~4–6 B/event). Point-by-ID becomes: registry lookup → read that frame → decompress → slice the event at the offset. Skips the segment-metadata parse and the frame-directory search. (~2 lookups + one 16 KiB decompress total.)
2. **`event_segment.value_set`** (§3.2) — point reads preload only the refs the frame needs; ref-free frames skip `event_value` entirely.
3. **Tier P 16 KiB placement** (§2.2) — the decompress bound that makes the budget achievable.
4. **Pre-warm of just-sealed frames** (§7) — the most-likely-read history is already decompressed in the frame cache, so the cold point read becomes a cache hit.

### 5.3 Why NO global per-event sealed index in v1

A global `(aggregate_id, seq) → segment/frame/offset` index would make the point read 1 lookup + 1 decompress — but costs ~6–10 B/event stored (1.37M events ≈ 10–14 MB, plus B-tree overhead and write amplification at seal). The segment-first_seq range scan (§5.1) already reaches the segment in one small index range (an aggregate's segment count is ~hundreds for 1M events), and one Tier P decompress fits the budget. **Defer the global index**; it is format-compatible and additive if D-gates show point p99 over budget. ([PROPOSED] — the measured justification is the §1.2/§5.1 budget math; D7 confirms on the packaged runtime.)

### 5.4 What is NOT needed

- **Decoded-tail cache**: subsumed by read-recency (§6 — interactively-read history stays raw) + pre-warm (§7 — just-sealed history stays decompressed). A separate decoded-tail cache would double-count the same working set.
- **Pre-warmed first-frame**: elision already covers the cold-window first frame (event-codec.md §2.4); pre-warm makes it moot for recently-sealed aggregates.

---

## 6. Cooling and seal-eligibility by read-recency

### 6.1 The principle

**Actively-viewed sessions should not seal**, so interactive history reads hit raw TEXT (zero decompress, zero splice, zero frame index). The existing cooling (D5: event-ID clock / `session.time_updated` correlation) is **write-recency** — it keeps *actively-written* sessions hot. Read-recency adds the missing axis: a session that is **dormant-write but being re-read** (user browsing old history, sync client walking it, a V2 projector rebuilding it) stays raw too.

### 6.2 Cheap last-read tracking ([PROPOSED])

```text
event_aggregate.last_read_ms INTEGER NOT NULL DEFAULT 0    -- ALTER, same family as
                                                           -- value_count/value_bytes (storage.md §3)
```

- **When it's touched**: on *history-surface open* — first `readAggregate`/`readAfter`/`syncHistory`/`durable()` for the aggregate, session-open replay, warp export. **Not** per page, not per event — one Map update + (rarely) one row UPDATE per open.
- **Why it doesn't tax reads**: it is one bookkeeping write per history-open, amortized against the open itself (which is a multi-read operation). G3's write gate measures the *publish* path — untouched (§9). To keep the hot write path 100% clean, the UPDATE is gated to seal-candidate aggregates (has sealed history or hot tail beyond the safety tail); most active sessions never qualify.
- **In-memory mirror**: a per-process `recentlyRead: Map<aggregate_id, last_read_ms>` maintained by the adapter, consulted by the sealer synchronously. This closes the TOCTOU window (sealer read last_read_ms → user opens session → sealer seals anyway): the sealer re-checks the in-memory set immediately before commit. Persisted `last_read_ms` is for crash/multi-process (CLI-lease) continuity.

### 6.3 The seal-eligibility predicate

```text
seal_eligible(aggregate) =
    write-cold(aggregate)                     -- existing cooling: no appends for COOLDOWN (D5)
    AND NOT read-warm(aggregate)              -- NEW: now - last_read_ms < READ_WARM_WINDOW
    AND aggregate NOT IN active_sessions      -- NEW: the app's currently-open sessions
    AND frontier rule (seq <= event_sequence.seq AND owner_id IS NULL)
```

`READ_WARM_WINDOW` [PROPOSED] 1–2 h (a session you opened recently stays raw; opening it again re-warms). Active-session exclusion is absolute (the app knows its open sessions; they are excluded outright regardless of window). Both constants are D5/D9 calibration inputs.

### 6.4 Reconcile with migration.md's file-swap rebuild

- The **rebuild** streams legacy → new file in `(aggregate, seq)` order, read-only on legacy, and does not care about read-recency — it builds the whole file. Reads during the rebuild are unaffected by construction (legacy never mutated; WAL snapshot isolation; migration.md §3.1/§2.2). **Consistent with read-latency-first: backfill may be slow, it must not block reads, and it doesn't.**
- After the swap, the **incremental sealer** honors read-recency: a read-heavy session's history seals later → the new file holds it raw longer → its post-swap reads (session open, warp) are fast. **No correctness issue** — sealed fraction is a compression/latency trade, not a data issue. The rebuild's own output is unaffected by which sessions are read-warm *before* the swap (the swap is a one-time bulk seal boundary).
- **Backfill pacing**: migration.md already uses idle-window scheduling + read-p99 suspension (it cites research §32.3). This chapter makes the read-p99 throttle the **shared** pacing mechanism for sealer AND backfill (§8.2).

### 6.5 The challenge answered: should point reads ever decompress?

The assignment asks whether the safety tail + read-recency should keep *all* interactively-read events hot/raw, so point reads never decompress. **Answer: the design gets ~all of that win without a no-decompress guarantee:**

- The **safety tail + write-cooling + read-recency** keep the interactively-*reachable* history raw: active sessions (write-hot), recently-opened sessions (read-warm), and the tail are all TEXT. The events a user is likely to touch in the next hours are, by construction, unsealed.
- **Old/cold history** (the 2.5 GiB aggregate's deep past) is sealed and *decompresses on point read* — but bounded to one 16 KiB frame ≈ 0.25 ms, within G4. A hard "sealed events never decompress for point reads" rule would force a no-decompress sealed format (defeats the compression story) or keep everything hot (defeats the storage story). The bounded path is the right middle: **read-recency makes decompression rare; Tier P + the accelerator make it cheap when it happens.**

---

## 7. Pre-warm — sealer-funded read acceleration

Because the sealer is async/free, it can fund read-side warmth at ~zero marginal cost:

```text
PRE-WARM POLICY (runs inside the sealer's own pass, never the read path):
  WHAT  : the frames it JUST sealed + their value_set, for every aggregate it sealed.
          Also the first segment of each aggregate (cold-window/elision benefit).
  HOW   : the sealer built the decompressed bytes and the value buffers anyway —
          write the frame's decompressed bytes into the frame cache and the segment's
          value buffer into the buffer LRU before releasing the segment.
          Cost ≈ 0: the bytes are already in the sealer's hands.
  WHEN  : immediately post-commit, same pass. No separate scheduler.
  BUDGET: pre-warm items are marked lowest priority / first-evictable in every cache
          (scan-resistance §4.6) — a user read can always displace them.
  WHY   : the just-sealed tail is the most-likely-read history (sync walks it, session
          reopen re-reads it, warp exports it). Warming it makes those reads cache hits.
```

What is NOT pre-warmed: decoded/parsed objects (memory-expensive, and the renderer reads the projection, not events — §4.4 verdict). Warm the byte/frame/value layers only; the decoded working set warms itself on actual reads.

---

## 8. The "seal must not affect user" gate

### 8.1 New gate G11 ([PROPOSED], owned by benchmark-arch, pinned at corpus-v1)

| Gate | Metric | Target | Measured via |
|---|---|---|---|
| **G11 seal/backfill must not affect user** | interactive read p99 (MessageV2.page+hydrate, readAggregate page, sync-history, session-open replay) measured **idle vs sealer/backfill at full throttle** (worst case: sealing + checkpoint + rebuild batch all active) | **< 1% p99 regression** on every listed op | interleaved A/B, S1/S2, both engines; sealer at max pacing; includes the rebuild pass (migration D8 rehearsal pair) |

Tighter than G7's 5% write-impact gate because **reads are now the critical resource** — the directive makes a 1%-on-reads budget the honest expression of "never affects the user." G7 (write impact), G8 (sealer commit < 10 ms), and the new G11 together cover the sealer's three victims (writes, commit latency, reads).

**G11's budget is < 1% read-p99 — this is THE definition (NEW-R6, single definition).** The adversary's R2 sweep found G11 defined twice: benchmark.md §7.2 proposed ≤ +5% read p99 / ≥ 95% model-token; this chapter proposes < 1% read p99 + < 1% token inter-arrival. The adversary recommends this chapter's < 1%, and the coordinator accepts: the directive's "never affects the user" is the harder, honest expression, and G7's 5% is the *write-side* gate — a different victim. benchmark.md's G11 row will be aligned to < 1% at gates.json pin time. One gate number, unambiguous at pin.

**G11 covers the sealer BUILD path, not just the commit.** The coordinator's adversarial point lands here: the sealer's BUILD pass (parse + double-stringify + sha256 hashing over 18 GB ≈ 1–3 min CPU) runs **in the same process as the model stream on a 4-core machine** — CPU contention from build work is the dominant user-visible risk, not the (WAL-protected, microseconds) commit. G11 therefore measures three interactive victims during a full-throttle seal pass:

1. **Interactive render/read p99** (the table above — MessageV2.page+hydrate, readAggregate page, sync-history, session-open replay) — the directive's primary resource.
2. **Write-path p99** (G7 already; the seal BUILD must not move the publish tail either).
3. **Model-token throughput** during a hot seal pass — streaming token inter-arrival p99 must not regress beyond the same < 1% band (a stalled model stream is a user-visible stall even when no read op is in flight). [PROPOSED] measure tokens/s or inter-arrival p99 idle vs sealing.

The read-p99 throttle (§8.2) is the enforcement: it gates the BUILD pass's batch pacing directly (the sealer checks READ_PRESSURE before each BUILD batch, not only before each commit), so CPU contention from parse/hash work yields to interactive pressure — not merely commit-time lock pressure.

Mechanically, SQLite WAL already means the sealer's commit never blocks readers (snapshot reads); the residual impact is **CPU contention + OS page-cache churn + checkpoint I/O** — which is exactly what G11 measures. The sealer's own connection + short batches (SYNTHESIS) are unchanged.

### 8.2 Read-p99-based throttle (the pacing control)

The sealer already yields (`Effect.yieldNow` between batches). Add a **read-pressure signal** the sealer (and the migration rebuild) consults before each batch:

```text
READ_PRESSURE: rolling read-path p99 over the last ~5 s, sampled from the adapter's
               codec-layer counters (frames decoded + op p99).
THROTTLE LADDER:
  normal    p99 < 0.5× budget      → full batch, normal pacing
  slow      p99 ≥ 0.5× budget      → halve batch, double inter-batch delay
  suspend   p99 ≥ budget           → finish current batch, skip next N passes
  resume    p99 < 0.5× budget for 30 s → back to normal
```

Budget = the §1.3 op budgets (or a 2× idle-baseline p99, whichever is lower). This is research §32.3's adaptive control, re-keyed from write-p99 to **read-p99**, shared by sealer and backfill (migration.md §3.2's pacing knobs fold into it).

### 8.3 Backfill under the same gate

The file-swap rebuild's source reads are read-only snapshots (never block the app); its writes go to the NEW file (no contention with the app's DB); its only user-visible cost is CPU/disk/page-cache. G11's "sealer at full throttle" leg includes the rebuild pass so the gate covers migration too. migration.md's `BATCH_BYTES` / idle-window scheduler + the read-p99 throttle together satisfy it.

---

## 9. Write-path statement (no regression from read optimizations)

| Read optimization | Write-path effect |
|---|---|
| Class-adaptive frames, registry `frame_idx/offset`, `value_set`, pre-warm | **Seal-time only.** Publish txn never touches them. |
| Segment value preload, value LRU | **Seal-time tables** (`event_value` rows written in the seal commit; hot writes never see refs). |
| `last_read_ms` touch on history-open | One bookkeeping UPDATE per history-open, gated to seal-candidate aggregates — **not** the publish txn, not event.data. G3 measures the publish path and is unchanged. |
| Dedup promotion (sha256, pending ledger, placeholders) | **Seal-time only** — zero hashing in `commitDurableEvent`'s txn (contract.md §6, storage.md §3, [LOCKED]). |

**Confirmed**: publish txn stays identity, fast, ref-free, hash-free, compress-free. G3 (≤ +5% write p95/p99) unchanged. The only new write-on-read is the amortized `last_read_ms` touch, which is read-side bookkeeping, not publish-path work, and can be dropped entirely if G3 shows any ripple.

---

## 10. Reconciliation with every chapter

### storage.md (oses-arch)

| readpath decision | storage.md effect |
|---|---|
| Tier P at 16 KiB + Tier R at 32 KiB (class-adaptive placement within the locked band) | **CONFIRMS §4.2 (v2, LOCKED)** — 16–32 KiB band accepted; placement inside it is this chapter's addition. The v1 "sweep to 64 KiB" is already withdrawn upstream; this chapter records the read-latency rationale and the placement policy. |
| `event_value.bytes` compressed-by-default (A4/E2, adopted) | **CONFIRMS §1.1/§10.3** — read cost absorbed by the value cache: one decompress per cache residency, splice = memcpy after; answers open Q3 for the read side. |
| Segment value buffer + `value_set` in segment metadata | **ADDS** to §2/§6; answers open Q5 (value-row caching) structurally. |
| `last_read_ms` on `event_aggregate` | **ADDS** audit column family (§3), new eligibility axis for the sealer. |
| Registry `frame_idx/offset` at seal; no global event index in v1 | **ADDS** to §9/§10 (Tier A registry extension); defers the global-index option. |
| Frame is the unit; `frame_count=1` legal; jumbo singleton; fail-closed splice | **CONFIRMS** [LOCKED] — unchanged. |
| Three legacy states row-level branch | **CONFIRMS** — the read path is state-dispatching by row regardless of read optimizations. |

### contract.md (contract-arch)

| readpath decision | contract.md effect |
|---|---|
| Segment-scoped value preload as the value-cache mechanism | **CHANGES §3.2 placement** — buffer-first, LRU-second; same `(aggregate_id, value_id)` key; same G5 guarantee, now structurally met (memcpy splice). |
| Jumbo admission: never cache > 1 MiB in cross-segment LRU | **ANSWERS open Q2.** |
| Point read budget < 500 µs S3 = G4; read-recency keeps interactive history raw | **CONFIRMS** §10.2's projection-only renderer and the adapter-as-only-seam; the renderer surface is untouched. |
| Decoded working-set cache: OFF at event adapter (gated), justified at projection boundary | **CHANGES §3.2's implicit "small value cache" scope** — the event-side cache is byte/frame/value layers; decoded objects belong to the projection lane. |
| `last_read_ms` maintenance on history surfaces | **ADDS** an adapter-read-side touch; wire contract unchanged (full values on the wire always). |
| Rehydration byte-splice, fail-closed, never synthesize | **CONFIRMS** [LOCKED] — unchanged. |

### codec.md (codec-arch)

| readpath decision | codec.md effect |
|---|---|
| zstd l1 = preferred Tier P codec (decode speed) | **CHANGES §2 posture** — from "per-frame adaptive alternative" to "Tier P default"; brotli q1 stays baseline for Tier R. Byte-stable, no parity risk. |
| Decompressed-frame cache is the primary read cache | **CONFIRMS §8's decode-speed bias** ("factor into the adaptive choice for interactively-read classes") as a first-class rule. |
| `event_value.bytes` compressed-by-default | **CONFIRMS §3.5** — value-entry codec (brotli q1, raw when guard fails) landed; read-side requirement recorded: decompress once per value-cache residency, never per splice (this chapter's segment buffer + value LRU make that true). |
| Frame-worth-it guard post-dedup; de-escape rejected; elision ≈0 in warm frames | **CONFIRMS** — unchanged. |
| Golden vectors / capability probe | **CONFIRMS** — unchanged; Tier P adds no new codec surface. |

### corpus.md (benchmark-arch)

| readpath decision | corpus.md effect |
|---|---|
| §1.3 latency budget table | **ADDS** absolute read-latency budgets as gate inputs (feeds G4/G5 pins). |
| G11 seal-must-not-affect-user (< 1% read p99) | **ADDS** a new gate (extends the G7/G8 family). |
| Class-adaptive frame sizing × point-decompress cap | **ADDS** a D7 geometry-sweep dimension (frame-size × point-read p99, per class). |
| Value buffer / LRU hit-rate + jumbo threshold | **ADDS** to D9 (value-cache policy measurement). |
| READ_WARM_WINDOW + read-vs-write recency correlation | **ADDS** to D5 (cooling predicate scan). |
| Measurement discipline (labels, id@version, cold authority, interleaved A/B) | **CONFIRMS** — unchanged; this chapter claims nothing without it. |

### migration.md (migration-arch)

| readpath decision | migration.md effect |
|---|---|
| Backfill slow-but-non-blocking is explicitly fine | **CONFIRMS** §2.2/§3.2 — file-swap rebuild is read-only on legacy; reads unaffected by construction. |
| Read-p99 throttle shared by sealer AND rebuild | **CONFIRMS** §3.2's pacing knobs; unifies the control. |
| Post-swap incremental sealer honors read-recency | **CONFIRMS** — read-heavy sessions seal later; no correctness effect, compression deferred until cool. |
| G11 covers the rebuild pass (D8 rehearsal pair) | **ADDS** a gate leg for the migration path. |
| Reverse export / rollback re-inflates via the splice helper | **CONFIRMS** §5.2 — the same value preload mechanism serves reverse export (the per-aggregate value cache there is this chapter's value LRU). |

---

## 11. Headline decisions (for the coordinator's PLAN.md)

1. **Read-latency budget**: §1.3 table — point sealed event < 500 µs for small logical payloads (< 64 KiB; primary pin at S2, S3 cold secondary, S4 < 2 ms hard bound — G4 triangle resolved in §1.4), **byte-king point reads (≥ 64 KiB materialized payload) scoped to their own documented row (< 25 ms S3 / < 10 ms S2, amortized — NEW-R3; O1 ceiling: ~5–20 µs with the gated stored-logical-digest idempotency fast path)**, readAggregate page < 5 ms, session-open replay < 10 ms/1k, sync-history page < 5 ms, MessageV2.page+hydrate ≤ +0% (projection lane, never OSES). Reference hardware pinned BEFORE the number (corpus §7.3). All pinned at corpus-v1; Linux CI authority; Windows = cold-approx.
2. **Frame geometry**: the 16–32 KiB band is **settled** (storage.md v2, locked). This chapter places the classes inside it: **Tier P point-read frames at 16 KiB with zstd l1 (≤ 8 KiB brotli/low-end cell — sized so the G4 arithmetic closes; the deduped point-read class COMPRESSES to ~1–2 KB stored, so a point-read decompress is tens of µs — guard is the single source of truth, A5 accepted; the compress-vs-raw threshold is the frame size: 16 KiB shell frames compress, sub-MIN_GAIN tiny frames stay raw, NEW-R5)**, **Tier R replay/text frames at the 32 KiB end**. 64 KiB is a measure-only sweep cell. No literal two-copy tiering (rejected: doubles storage, breaks "frame is the unit"). zstd l1 becomes the Tier P default (decode speed, byte-stable).
3. **Splice near-free, mode-aware**: segment-scoped value preload — `value_set` in segment metadata (seal-time, free); **eager full-segment preload ONLY for replay/range** (one query, 1,284× repeat = 1 SELECT + 1,284 memcpys, admission-capped at 16 MiB/segment), **lazy per-ref fetch on the point-read path** (fetch exactly the value_id(s) the decoded event references — never the segment's whole set, so a 200-value × 24 MB segment cannot blow a point read). Jumbo values (> 1 MiB) never enter the cross-segment LRU and are always lazy on point reads.
4. **Cache re-split**: one combined budget raised to ~120 MiB (page 64 + decompressed-frame 32 + value 16 + decoded 8–16 gated), scan-resistant everywhere. **Decoded-object cache: OFF at the event adapter (default), gated on measured re-reads; the projection boundary (MessageV2) is where the renderer's re-reads live — that decoded working-set question is opcl-arch's, now justified by the directive, and it is the ENALBER for OPCL-on-message (absorbs the one-decompress-per-row hydrate cost on the hottest surface; O4).**
5. **Point-read accelerator**: registry rows carry `(frame_idx, event_offset)` at seal (free); segment `value_set`; Tier P placement. **No global per-event sealed index in v1** (segment-first_seq scan + one 16 KiB decompress already fits G4; additive later if gates fail).
6. **Read-recency cooling**: `event_aggregate.last_read_ms` (touch on history-surface open, gated to seal candidates) + in-memory `recentlyRead` set + active-session exclusion. Eligibility = write-cold AND NOT read-warm AND NOT active. Interactively-read history stays raw TEXT; decompression becomes rare, and bounded (Tier P) when it happens.
7. **Pre-warm**: the sealer writes its just-built frames' decompressed bytes + value buffers into the caches (≈ zero marginal cost — it already holds the bytes), marked lowest-priority/evictable. The most-likely-read history is already decoded.
8. **G11 "seal must not affect user"**: **< 1% interactive read-p99 — THE definition (single, NEW-R6; benchmark.md aligned)** with sealer+checkpoint+rebuild at full throttle, **covering the sealer BUILD path (parse/hash CPU contention in-process), write-p99, AND model-token inter-arrival p99**; read-p99-based throttle ladder (normal/slow/suspend) shared by sealer BUILD+commit and backfill.
9. **Write path untouched**: publish txn stays identity, ref-free, hash-free, compress-free (G3 unchanged); the only new write-on-read is the amortized `last_read_ms` touch.

---

## 12. Open questions (readpath lane)

1. **Which production surfaces actually read the event store?** The design's read-recency rationale assumes the renderer is projection-served and the event store is read by replay/sync/warp/idempotency. The call-graph must be confirmed on the real product: does session-open replay the event history (V1) or only the projection? Does the desktop app call sync-history on every open? Does the V2 projector read sealed history on session open? The answer decides how much of the "viewed session stays raw" rule matters and whether the event-side decoded cache gate ever opens. (Ownership: contract-arch confirms at the adapter boundary; this chapter depends on it.)
2. **Does the decoded-object working-set cache pay at the projection boundary?** The research doc's "parse-object caching buys little" was right for the *event adapter*; the directive's "renderer re-reads the same messages" is real at MessageV2.page+hydrate. Whether a bounded decoded page cache pays (memory 2–4× amplification vs repeated scroll-back render hits) needs a page-revisit hit-rate measurement on a real session — D1-adjacent, opcl-arch + benchmark-arch. If it pays, the budget share above (8–16 MiB) is its cap.
3. **`last_read_ms` write-tax and multi-process sealing.** Persist on every history-open (gated to candidates), vs in-memory-only + periodic flush? The G3 ripple of the touch, the TOCTOU window (sealer vs concurrent read), and the CLI-lease sealer's need for a shared signal all interact. The D5 scan (read-recency vs write-recency correlation) also calibrates READ_WARM_WINDOW — is 1–2 h right, or should a read warm the aggregate for the whole day?

**Bonus / dependent:** the jumbo point-read carve-out threshold (> 4 MiB = documented budget exemption) and the 1 MiB value-LRU admission cap both want D9's value-size histogram; the Tier P 16 KiB placement wants D7's frame-size × point-read-p99 sweep on the packaged runtime (zstd vs brotli decode at 16/32 KiB on real shells).

---

## 13. Corrections to prior docs (this lane's record)

1. **SYNTHESIS "microframes serve corruption containment + cache granularity, not point-read latency"** — amended: under read-latency-first, Tier P microframe size is ALSO the point-read latency mechanism (16 KiB placement derived from the G4 decompress allocation).
2. **storage.md v1 §4.2 "sweep to 64 KiB"** — withdrawn by storage.md v2 and **aligned here**: 64 KiB is a measure-only sweep cell; Tier P sits at 16 KiB, Tier R at 32 KiB.
3. **research doc §1.8 "cache decompressed bytes/frames, not parsed object graphs"** — confirmed for the event adapter and *sharpened*: the renderer's repeated re-reads live at the projection boundary, where a decoded working-set cache is now justified by the directive (opcl-arch's lane to evaluate).
4. **codec.md §2 "zstd l1 as a per-frame adaptive alternative"** — promoted for Tier P frames (decode speed is the read-path axis); brotli q1 remains the Tier R baseline and the locked byte-stable default.

### 13.1 Revision record (adversarial strengthening pass)

**Round 1 (adversarial-evaluation.md):**

1. **G4-vs-decompress triangle resolved explicitly (§1.4)** — the cold 32 KiB brotli point-read decompress (0.2–1 ms) exceeds the whole < 500 µs cold gate on its own; the chapter now (a) pins G4's primary target at S2 (warm OS, cold frame cache) with S3 cold secondary and the S4 < 2 ms hard bound, (b) sizes Tier P so the arithmetic closes (16 KiB zstd / ≤ 8 KiB brotli cell; the deduped point-read class **compresses to ~1–2 KB stored** — A5 accepted in storage.md §4.2.3 / codec.md §4, guard is single source of truth — so a point-read decompress is tens of µs), and (c) requires reference hardware pinned before the number (corpus §7.3). Load-bearing for corpus-v1 G4 pinning. **Cross-channel fix:** earlier wording claimed "pure-ref frames skip compression → decompress to ~nothing"; corrected to "compress to ~1–2 KB → decompress tens of µs" (BETTER: a compressed point read is faster than a raw 16 KiB read would be).
2. **Segment value preload is mode-aware (§3.1)** — eager full-segment preload for replay/range only (admission-capped), **lazy per-ref fetch on the point-read path** (a point read pulls only its own event's value_id(s), never the segment's whole set — closes the gigabytes-per-point-read blowup the adversary flagged).
3. **G11 covers the sealer BUILD path (§8.1)** — read p99, write p99, and model-token inter-arrival p99 all gated at < 1% during a full-throttle seal pass; the read-p99 throttle gates BUILD batch pacing, not just commit.

**Round 2 (adversarial-evaluation-r2.md):**

4. **NEW-R3: G4 scoped to small logical-payload point reads (§1.3/§1.4).** The byte-king point-read class (sealed message.updated, full summary materialized on splice: 3.2 KB–548 KB typical, max 24 MB) makes JSON.parse linear ≈ 1–5 ms — 10–100× over the S2 pin and over the S4 < 2 ms hard bound, and no frame-size choice fixes it (it is a payload-materialization cost). Stance adopted: **(a) v1 honesty — G4's primary pin applies to logical payload < 64 KiB; the byte-king class gets its own documented budget row** (fine in practice: byte-king point reads are replay/sync-heavy, and read-recency keeps interactive history raw, so this path is rare/amortized); **(b) gated — per-event STORED LOGICAL DIGEST (128-bit sha256-truncated, 16 B minimum; crc32 never sufficient for the idempotent decision — storage.md pin) enabling a digest-first idempotency fast path**, deferred and G1-differential-covered before shipping.
5. **NEW-R4: stale "raw in v1" spots deleted (§3.4, §10 ×2).** The adopted default is compressed-by-default (A4/E2: OCDB envelope, brotli q1, raw below ~64 KiB, sha256 over raw). The read-path consequence is absorbed by this chapter's own cache: one value decompress per cache residency, then the 1,284× splice is memcpy — identical to the raw case.
6. **NEW-R6: G11 single definition (§8.1).** G11's budget is **< 1% read-p99** — THE definition; benchmark.md's ≤ +5% row will be aligned at gates.json pin (adversary + coordinator accept this chapter's harder number; G7's 5% is the write-side gate, a different victim).
7. **NEW-R10: stale flag removed (§2.4).** The note claiming storage.md §12 still carried the skip-compression line is itself stale (storage.md v3 fixed it).

**Round 3 (adversarial-optimization.md):**

8. **O1 digest-first idempotency folded in (§1.3 byte-king row + §1.4 stance (b)).** The stored logical digest (index-region, **128-bit sha256-truncated, 16 B minimum — crc32 never sufficient for the idempotent decision**, per the storage.md pin) is recorded as the **ceiling for the byte-king point-read class**: sealed-point replay-idempotency check becomes an index slice + digest compare (~5–20 µs) instead of materializing the full summary (1–5 ms). Gated on the G1 differential + benchmark-arch's D10; flips the byte-king budget row whenever it ships. Optimization-adversarial #1. (F1 alignment: the earlier "crc32/sha256, 8–32 B" sketch corrected to the 128-bit pin.)
9. **O4 dependency recorded (§4.4).** The projection decoded working-set cache is the **enabler for OPCL-on-message under read-latency-first**: it absorbs the one-decompress-per-row hydrate cost on the hottest surface (scroll-back over a long session); without it, OPCL-on-message would put a decompress on every framed message re-read. Not optional if O4 ships; 8–16 MiB share is its cap. Projection-lane decision (opcl-arch); this chapter records the dependency.
10. **R4/R10 confirmation (Round-3 reconciliation note was stale).** The adversary's note that readpath still carried "raw in v1" spots predated the R2 edits; verified on disk — the spots were already fixed (§3.4, §10 ×2, §2.4 flag). R1–R10 fully clear on this lane.

---

*Prepared by readpath-arch. Every absolute number is [PROPOSED] and pinned at corpus-v1 per benchmark-arch's rules; nothing here claims population evidence without a corpus id@version. This chapter feeds `PLAN.md` (coordinator).*
