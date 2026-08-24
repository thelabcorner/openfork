# Physical Structure for Extremely Fast Reads — Design Proposal (readpath-v2, NEW DIRECTION)

**Author:** readpath-v2, swarm `chunkdb-ideation`
**Overrides:** my earlier per-row framing proposal (`readpath-v2-proposal.md`). The coordinator's new direction is the full OSES segment model, not cold-sealer-only per-row framing.
**Hard constraint:** `constraint/client-side-only` — ChunkDB is a CLIENT-SIDE-ONLY optimization inside `opencode.db`. No SSE/wire/V1-API change. The EventStore adapter presents byte-identical data; wire carries full values; refs are storage-local. Reads MUST be fast; writes may be slow + background.
**Builds on:** codec OCDB frame v2 (`json-codec.ts`), storage `event_value` dedup + placeholder-splice (`storage.md`), contract rehydration invariant (`contract.md`), OSES hot-tail=`event` table + 16–32 KiB segments (`storage.md` §4), adversarial G4 latency gates (`readpath.md` §1.3). Real DB: 16.75 GiB / 1.37M events; cold agg 2.5 GB / 772 framed (prototype per-row); max row 32.8 MB.
**Cross-refs:** schema-v2 (canonical single-source topology, multi-table framability registry), seal-v2 (background writer: dedicated conn, one-WAL-tx/batch, worker-pool BUILD, G11 throttle), ops-v2 (read-speed SLOs, db-check, restore).

---

## 1. On-disk layout (the new structure)

Three physical regions, one logical event `{id, aggregate_id, seq, type, data}`:

```
┌─ HOT TAIL ───────────────────────────────────────────────────────┐
│ event(aggregate_id, seq, type, data TEXT)                         │  identity writes, zero decode
│ frontier = event_aggregate.sealed_seq                            │  point read <100µs (index + JSON.parse)
└───────────────────────────────────────────────────────────────────┘
┌─ COLD SEGMENTS ──────────────────────────────────────────────────┐
│ event_segment(metadata, UNCOMPRESSED):                            │  one frame per segment (frame_count=1)
│   aggregate_id, first_seq, frame_directory,                       │  16–32 KiB raw target
│   per-event payload index (offset/len/ordinal/type/ref_list/      │  brotli q1 / zstd l1
│     optional 128-bit digest), value directory (crc32 per value)  │
│ event_segment_blob(frame BLOB — one compressed frame)            │
└───────────────────────────────────────────────────────────────────┘
┌─ VALUE TABLE ────────────────────────────────────────────────────┐
│ event_value(aggregate_id, value_id, sha256, raw_len,             │  O(1) by (aggregate_id, value_id)
│   bytes[OCDB-envelope compressed], refs, time_promoted)           │  dedup key = sha256 over ORIGINAL bytes
│ event_value_pending(ledger for occurrence-1 values)              │
└───────────────────────────────────────────────────────────────────┘
```

**Hot/cold split for READ SPEED:**
- **Hot tail = uncompressed TEXT** → zero decode, sub-100 µs point reads (G4 point-hot < 100 µs S3 / < 50 µs S2). The interactively-read history (active + recently-opened sessions, read-recency) stays TEXT by construction (seal-v2 eligibility excludes read-warm + active).
- **Cold facts = compressed BUT cheap random access**, via three cooperating mechanisms:
  1. **Per-event offset index in the UNCOMPRESSED segment metadata** — locate an event in O(log segments) (range scan on `first_seq`) + binary search the per-event index. No decompression to *plan* the read.
  2. **Small frames (16–32 KiB, `frame_count=1`)** — a point read must decompress the *whole* containing frame (brotli/zstd are stream codecs; you cannot mid-stream decompress). Bounding frame size bounds the decompress tax: 16 KiB zstd ≈ 0.05–0.15 ms; 32 KiB brotli ≈ 0.2–1 ms.
  3. **The deduped point-read class compresses tiny** — `message.updated` shells (post-dedup) are repetitive JSON that brotli/zstd crush ~20–40× to **~1–2 KB stored** (storage.md §4.2, A5). A point read of that frame reads + decompresses ~1–2 KB ≈ **tens of µs**.

**The honest tradeoff (stated, not hidden):** one full-frame decompress per cold point read. This is bounded by frame size + codec and fits G4 for the small point-read class. The byte-king class (≥ 64 KiB materialized payload) gets its own documented budget row (< 25 ms S3 / < 10 ms S2, `readpath.md` NEW-R3) — it is replay/sync-heavy and rare under read-recency, so amortized.

**Columnar vs row:** **ROW-ORIENTED event segments.** Events are always read as whole objects (replay/sync/projector) — there is no column-projection read pattern on `event.data`. The value table *is* the decomposition that removes cross-event redundancy (the "column" split out). Columnar is rejected for events (no benefit; whole-object reads dominate).

---

## 2. Mapping the 12 read paths + V2 cold-resume + sync-history (G4 budgets)

| Path | Region | Decode cost | G4 budget | Meets? |
|---|---|---|---|---|
| 1 readAfter (event.ts) | hot tail TEXT + cold segments | hot = 0; cold = ≤1–2 frame decodes | < 2 ms to first event | ✅ (tail mostly hot) |
| 2 readAggregate (event.ts) page(100) | hot + cold | hot TEXT + ≤1–2 segment decodes | < 5 ms S3 / < 1.5 ms S2 | ✅ |
| 3 full-history (biggest agg, all rows) | hot tail + ~14–34 cold segments* | paged; ~14–34 × ~0.5 ms decompress | session-open replay < 10 ms/1k | ✅ (paged + background) |
| 4 SessionHistory.load (session_message) | projection TEXT | 0 (projection) | MessageV2.page+hydrate +0% | ✅ |
| 5 message page + part hydrate | projection TEXT | 0 | +0% | ✅ |
| 6 usage.ts json_extract(message.data) | message TEXT | SQL json_extract | — | ✅ (TEXT, not framed) |
| 7 credentials.ts backfill json_extract | message TEXT | SQL json_extract | — | ✅ |
| 8 message/part data 0 blobs | TEXT | 0 | — | ✅ |
| 9 full frame audit (CRC+JSON) | cold segments | decompressFrame per row | ops-v2 full db-check | ✅ |
| 10 fail-closed | cold segments | per-event decode boundary | healthy rows unaffected | ✅ |
| 11 sync.ts:76 global history scan page(100) | hot + cold | ≤1–2 segment decodes | < 5 ms | ✅ |
| 12 v1 frame decodability | cold segments | v1 header branch | — | ✅ |
| **V2 cold-resume** (2.5 GB legacy) | hot tail + all cold segments | lazy paging + worker-pool decode | first paint < 100 ms; full < 1–2 s background | ✅ |
| **sync-history** page(100) | cold segments + value splice | ≤1–2 frame decodes + O(1) value fetch | < 5 ms; wire carries full values | ✅ |

\* 6,866 events ÷ (~200–500 events / 32 KiB frame) ≈ 14–34 segments. Each 16–32 KiB compressed. Full decode ≈ 7–17 ms pure decompress, paged + background-decodable.

**Where decode cost lands & how it is hidden:**
- **Hot path:** zero decode (TEXT). Covers the interactive common case (active/recent sessions).
- **Cold point read:** one bounded frame decompress (16–32 KiB) + value splice (O(1) PK + cache). Hidden by: (a) hot tail covers interactive reads; (b) **decode cache** (§4) makes repeats free; (c) **parallel worker pool** (seal-v2's `chunkdb-seal-parallel` pattern, reused for decompression) keeps bulk/cold reads off the main thread; (d) **background** for cold-resume (non-blocking — user sees session from hot tail immediately); (e) **G11 read-p99 throttle** (seal-v2 §4) ensures interactive reads never stall under decode load.

---

## 3. Canonical single-source topology — projection + replay from ONE source without copying

**Canonical source = the event store** (hot `event` + cold segments + `event_value`). The projection (`session_message` / `message` / `part`) is a **derived table required by the V1 API surface** — the client-side-only constraint forbids changing `MessageV2.hydrate`'s read of `message`/`part`. So the projection stays, but the physical layout eliminates the *within-event* redundancy and minimizes the *projection* redundancy:

| Coordinator's redundancy | How the layout removes it |
|---|---|
| repeated `info.summary` (1,284×) | **`event_value` stores it ONCE**; 1,284 events carry a 4-byte ref. ~35–65 % event-byte reduction before compression. |
| `message.data` summary mirrors last event | both reference the **same `value_id`** in `event_value`; the heavy payload lives once. |
| `session.summary_diffs` third copy | same — references the same value. |
| event vs `session_message` projection duplication | accepted as the cost of V1 API compat; minimized by keeping the projection **thin** (message/part shape, not raw events) and by the value table removing the heavy payload from both copies. Projection-side dedup (OPCL / value-ref-in-projection) is a **later stage** (schema-v2 Stage 3), gated on routing-column promotion — it shrinks the projection copy client-side (adapter splices) without a wire change. |

**The adapter is the single seam:** both replay and projection read through the EventStore adapter, which decodes segments + splices values. The projection is a downstream consumer of the canonical source, not a second copy of the canonical bytes.

**Indexes that make both fast:**
- **Replay:** `event(aggregate_id, seq)` PK (hot); `event_segment(aggregate_id, first_seq)` (cold, range scan → segment); per-event index *inside* segment metadata (binary search — no extra B-tree).
- **Value:** `event_value(aggregate_id, value_id)` PK → O(1); `UNIQUE(aggregate_id, sha256)` for dedup lookup at seal.
- **Projection:** `session_message(session_id, seq)`; `message(session_id, time_created, id)`; `part(message_id)`; `idx_message_provider_id` (json_extract on TEXT, unchanged — message.data stays TEXT in v1).
- **Cooling/read-recency:** `event_aggregate.last_read_ms` + in-memory `active_sessions` (seal-v2 §3) keep interactive aggregates hot.

---

## 4. Decode cache design for the new structure

**TWO cooperating caches** (the coordinator's "row_id+crc32 or value_id" → both, distinct layers):

**1. Segment (frame) cache** — key `(segment locator e.g. (aggregate_id, first_seq), crc32_of_frame_header)`.
- Value = decompressed frame bytes (or per-event parsed spans).
- Size: **~32 MiB (mid 16 GiB) / ~16 MiB (low-end 8 GiB)**.
- **CRC32 makes it safe**: the CRC lives in the 14-byte frame header (readable without decompress); a valid CRC ⇒ content-intact, so the cache needs no re-validation. A repeat read of any event in a segment = index + parse only (no decompress).
- Kills the decompress tax on repeat segment reads (replay re-runs, sync re-walks, warp re-exports).

**2. Value cache** — key `(aggregate_id, value_id)` → raw (decompressed) value bytes.
- Size: **~16 MiB (mid) / ~8 MiB (low-end)**.
- O(1) by PK. **Per-value `crc32` tag** (in the segment value directory, storage.md §1.1) is verified on **cache MISS** before splice (C1, ~zero cost) — integrity is checked, not assumed from the key.
- Kills the 1,284× splice fan-out: one decompress per value residency, then memcpy.

**Admission / eviction:** both scan-resistant (2Q/SLRU). **Pre-warm**: the sealer writes its just-built decompressed frame bytes + value buffers into both caches as it seals (≈ 0 marginal cost — it already holds the bytes), marked **lowest-priority / first-evictable** (G5: a user read always displaces them). The 2.5 GB aggregate's ~14–34 segments don't all fit — the cache holds a working subset; a single cold-resume is one-pass, so the cache pays on *re*-resume / sync re-walk (intended).

**Sizing per device class:** low-end 8 GiB → 16 MiB segment + 8 MiB value; mid 16 GiB → 32 MiB + 16 MiB. Total decode-cache budget ≈ 24–48 MiB, within the combined storage-cache budget (`readpath.md` §4.1). Calibrated by D7/D9.

---

## 5. Headline decisions

1. **Layout:** hot tail TEXT (`event`) + cold segments (`event_segment` metadata + `event_segment_blob`, 16–32 KiB, `frame_count=1`) + value table (`event_value`). One logical event from three regions via the adapter.
2. **Cheap random access = per-event offset index (uncompressed metadata) + small frames + deduped point-read class compresses to ~1–2 KB.** One full-frame decompress per cold point read, bounded by frame size + codec — fits G4 for the small class.
3. **All 12 paths + V2 cold-resume + sync-history meet G4:** hot TEXT sub-100 µs; cold point < 500 µs S3 / < 200 µs S2 (small class); byte-king class own budget; projection +0%; wire carries full values.
4. **Canonical single source = event store**; projection is derived (V1 API compat); value table removes within-event redundancy; indexes listed.
5. **Two decode caches:** segment `(locator, crc32)` + value `(aggregate_id, value_id)`, sized per device class, scan-resistant, pre-warm-evictable.

---

## 6. Tradeoffs

- **Full-frame decompress per point read** (stream codecs can't mid-decompress): bounded by 16–32 KiB; acceptable under G4 for the small class. Multi-frame (`frame_count>1`) would allow sub-frame decompress + smaller blast radius but adds machinery — deferred to D7 (`storage.md` §4.3).
- **Row-oriented, not columnar:** whole-object event reads; value table is the decomposition. Columnar rejected for events.
- **Projection remains a derived copy** (V1 API compat): redundancy not fully eliminated on the projection side until OPCL / value-ref-in-projection (later stage, gated on routing-column promotion — schema-v2 Stage 3; opcl-arch removed, needs coordinator re-route).
- **Segment cache can't hold all segments of a 2.5 GB aggregate** (working subset); helps re-reads, intended.
- **Worker pool + G11 throttle:** CPU bounded; low-end shrinks pool to 1–2 workers.

---

## 7. Open questions (5)

1. **`frame_count=1` vs >1:** ship multi-frame segments (sub-frame decompress, smaller blast radius) or keep `frame_count=1` (`storage.md` §4.3 defers multi-frame to D7)? Affects point-read decompress granularity vs v1 implementation surface.
2. **Per-event digest fast-path (O1):** reserve + gate now? Makes the byte-king idempotency check ~5–20 µs (index compare) vs ~1–5 ms materialize — big G4 win for the byte-king class. Gated on G1 differential + D10; digest MUST live in the uncompressed index region (not the compressed stream) or the fast path dies.
3. **Decode-cache sizing per device class:** 32/16 MiB (mid) vs 16/8 MiB (low-end) — calibrate vs D7/D9? Does low-end need smaller, or is 24 MiB total fine?
4. **Projection dedup stage:** when does OPCL / value-ref-in-projection ship to kill the `message.data` / `session.summary_diffs` copies? Needs routing-column promotion (schema-v2 Stage 3) + opcl-arch sign-off (both removed — coordinator re-route).
5. **Cold-resume worker-pool sizing + V2 projector read-on-open:** pool = `floor(availableParallelism()/2)`? And does `SessionV2` read sealed history on open (decides if the pool is warranted vs a simpler single-thread lazy decode)? (my earlier Q2)

---

*Full prior read-path proposal (per-row framing): `readpath-v2-proposal.md`. This document is the coordinator's NEW DIRECTION (segment structure) and supersedes the per-row framing approach for the production physical layout.*
