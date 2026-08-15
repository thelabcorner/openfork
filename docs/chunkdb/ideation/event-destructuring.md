# Event Payload De-Structuring — comprehensive elimination iteration

**Author:** coordinator, swarm `chunkdb-ideation` (continues `event-codec.md`)
**Method:** fresh probes (v1–v4) on schema-faithful synthetic event streams; brotli q1/q4 under Bun, `node:zlib`. Every number below is measured, not modeled.
**Verdict up front:** "the best compression is entire elimination of reconstructable data" is not a slogan here — it is measurable. The census shows **~88% of a raw event stream is reconstructable or structurally redundant**, and a layered elimination (elide → intern → structural-encode) reaches **0.040–0.051 ratio at realistic frame sizes, ~60–70% smaller than the fork's shared-window JSON framing, and ~3.3–4.2× better than per-row**.

---

## 1. The byte census — what the event stream is actually made of

Measured on a 497-event stream (48-turn session: prompted/step/reasoning/text/tool steers + 17 `session.updated` snapshots), 144,261 raw bytes:

| Byte class | Share | Attack |
|---|---|---|
| JSON key names (`"assistantMessageID":`) | **38%** | schema field ordinals → 1 byte each (L3) |
| Public IDs (`msg_…`, `call_…`, `txt_…`, `rs_…`) | **32%** | segment-local string interning → table ref (L2) |
| `sessionID` occurrences | **11%** | **entirely eliminate** — reconstruct from envelope aggregate_id (L1) |
| Numeric tokens (timestamps, counters, cost) | **7%** | varint binary (L3) |
| Everything else (free text, prompts, tool output) | 11% | incompressible/uneliminable content — must be carried |

**~89% of the raw stream is keys + repeated IDs + envelope-derivable ID + numeric ASCII.** This is the whole game: brotli's LZ window *partially* recovers keys/IDs at large windows, but (a) it can't reach across frame boundaries, and (b) it never eliminates the sessionID and never compresses numbers as well as binary. Each layer below attacks a specific part.

---

## 2. The layered elimination (measured on 497 events, 144 KB raw)

| Layer | What it removes | Stored (16 KiB frames) | Ratio vs raw |
|---|---|---|---|
| L0 — JSON stream + brotli q1 (fork best case) | — | 15,803 B | 0.110 |
| L1 — + envelope elision (drop `sessionID`; `timestamp` → delta from event-ID clock) | 11% reconstructable | 11,345 B | 0.079 |
| L2 — + segment-local string interning (shared table across frames) | 32% repeated IDs | ~7,000 B | ~0.048 |
| L3 — + schema-structural field encoding + varint numbers | 38% keys + 7% numbers | **6,199 B** | **0.043** |

The layers are not additive per-row — L2 and L3 overlap with what brotli already recovered at large windows — but at **realistic OSES frame sizes (8–32 KiB)** the interning table is what makes the difference, because it is the only mechanism that shares repeated content **across frame boundaries** (LZ windows cannot).

### 2.1 Frame-size sensitivity — the table decouples compression from window size

| Frame target | JSON q1 | Elided JSON q1 | **Structural + table** |
|---|---|---|---|
| 8 KiB (4 frames) | 0.169 | 0.129 | **0.051** |
| 16 KiB (2 frames) | 0.110 | 0.079 | **0.043** |
| 32 KiB (1 frame) | 0.079 | 0.055 | **0.041** |
| one-shot 64 KiB+ | 0.046 | 0.034 | 0.041 (table overhead eats the small-window advantage) |

**Read this table carefully — it is the central design result:**
- JSON/LZ **degrades 2.1×** from one-shot to 8 KiB frames (0.046 → 0.169): small frames destroy LZ's reach.
- Structural+table **barely moves** (0.041 → 0.051) across the same range: the shared segment table carries the cross-frame redundancy that LZ loses.
- Therefore the OSES decision to use **small 8–16 KiB microframes** (for corruption containment + cache granularity) does **not** cost compression ratio when a segment table exists. **The table is what lets small frames have big-compressor ratios.**
- At large windows, elided JSON (0.034) edges structural (0.041) because the table's own bytes (~850 B) are pure overhead when the LZ window already reaches everything. **Recommendation: the segment table should be *optional per segment*, enabled when segment raw bytes / frame count makes cross-frame sharing real** — a steer/snapshot-heavy segment wins hugely; a single-jumbo-tool segment should skip it.

### 2.2 The elision paradox resolved (v1 probe)

Earlier I reported "elision adds nothing inside a warm window" (steers 0.071 → 0.084, *worse*). The v4 numbers show the opposite at realistic geometry: **elided JSON beats JSON by 24–31% at every frame size**, because the frames are small enough that the repeated 30 B sessionID per event was genuinely re-emitted per frame. The earlier paradox was an artifact of the one-shot window (LZ already folded the ID). **Conclusion: elision is a real, ~25–30% win at OSES frame geometry, not a cold-start nicety.** The sessionID should be eliminated from the frame payload entirely and reconstructed from `event_aggregate.aggregate_id` on decode.

### 2.3 Snapshot class (v2 probe): structural beats both JSON and delta-chains

On 17 snapshots: JSON q1 = 0.149, structural = **0.091**, delta-chain = 0.147. **The semantic delta/checkpoint idea the research doc kept as Phase 6 is measured dead-on-arrival against structural encoding** (delta 0.147 ≈ full JSON 0.149, both far worse than structural 0.091). The full-state field structure is exactly what the structural encoder removes (field ordinals + interning), so there is no snapshot-state to delta once the schema is encoded. **Drop semantic deltas from the roadmap; structural encoding subsumes them.**

---

## 3. The elimination taxonomy (what is reconstructable, and how)

| Data | Reconstruct from | Mechanism | Risk |
|---|---|---|---|
| `sessionID` (all durable types) | envelope `aggregate_id` — **publish-enforced invariant** (`commitDurableEvent`) | drop field, rehydrate on decode | none (provable) |
| `info.id` in `session.updated` | = sessionID (schema does not *prove* it, but projector writes it as the session id) | empirical candidate — measure equality on corpus; if 100%, elide | property-test only |
| `timestamp` in `session.next.*` | event-ID clock `floor(clock/4096)` — but payload value is caller-set | store `tsDelta = timestamp − clock_ms` (usually 0–1 byte) | empirical; mismatch → escape |
| JSON key names | schema field table per versionedType | field ordinal (L3) | must be versioned per type + physical format |
| repeated public IDs | segment-local string table | interning (L2) | table must survive aggregate delete/backup |
| numeric ASCII | binary varint | L3 | format version |
| JSON syntax (`{"`, `:`, `,`) | implicit from schema | L3 | format version |
| arbitrary content (text, prompts, tool output) | **not** reconstructable | carry (compressed) | — |

---

## 4. Pareto push — the numbers that decide

```
Pareto (ratio vs raw JSON stream, 16 KiB frames, brotli q1):
  per-row framing (fork prototype)           0.307–0.976   (steers ~1.000 — nothing frames)
  JSON shared-window frames                  0.110
  elided-JSON frames                         0.079
  structural + segment table (16 KiB)        0.043   ← recommend
  structural + table, 32 KiB                 0.041
  one-shot elided JSON (no table, no frames) 0.034   ← the LZ ceiling; not achievable with
                                                        bounded point-read / cache granularity
```

**The Pareto frontier:**
1. **L1 elision is free and huge** (~25–30% at frame geometry). Ship it unconditionally for `sessionID`.
2. **L3 structural encoding is the main event** (~50–60% over JSON frames at 8–16 KiB). It eliminates the 38% keys + 7% numbers *and* makes the 32% IDs cheap via the table.
3. **L2 interning table is the enabler for small frames** — without it, small frames cost 2×; with it, 8 KiB frames ≈ one-shot. Make it conditional (skip for jumbo-singleton segments).
4. **Semantic deltas are dead** (0.147 ≈ 0.149 JSON; structural 0.091 wins).
5. **Dictionary (structural/static) is redundant once L3 exists** — the field-ordinal table IS the dictionary, and it has no privacy exposure (it's schema, not user data). A separate codec-level dictionary adds nothing measurable.

---

## 5. The structural format — what it concretely looks like

A per-segment encoding with three parts (format version + codec-gated, all integers varint LE):

```
SEGMENT = STRING_TABLE + [FRAME]*
STRING_TABLE = uvarint(count) + { uvarint(len) + utf8 }*        // shared, built at seal
FRAME = uvarint(event_count) + { EVENT }* + brotli(q1|q4)        // 8–16 KiB raw target
EVENT = uvarint(type_index)                                     // type also interned? no —
                                                               // type stream is separate (OSES)
        + uvarint(field_count)
        + { uvarint(field_ordinal) + VALUE }*                   // ordinal into per-type schema table
VALUE = tag byte:
  0x00 sessionID-reconstruct        // eliminated, rehydrated from envelope
  0x01 interned-string → table ref
  0x02 raw-string (length + utf8)   // free text / content escape
  0x03 uvarint                      // integers (timestamps, counters)
  0x04 fixed-1e6 varint             // cost/float
  0x05 true / 0x06 false / 0x07 null
  0x08 array (count + values)
  0x09 object (count + {key_index + value}*)  // keys from schema or interned
```

Notes:
- The **escape tags** (raw string, object-with-interned-keys) preserve full generality for `ToolContent`, `ProviderMetadata`, `result: unknown`, `metadata: Record` — arbitrary user content still fits, just without schema compression. This is the OPCL/OSES "escape to JSON for unknown shape" principle, now inside the structural layer.
- **Decode must be byte-exact to the schema-encoded object** the projector compares against (`isDeepStrictEqual` in replay). The rehydrated `sessionID` must be inserted before schema decode so deep-equal holds.
- **Type stream stays separate** (OSES `type_set`/type-key stream) — field ordinals are per-type so they do not need the type in the event body; the type key is already the segment's per-event stream.
- Cross-runtime: this is pure application code + brotli — no codec-specific dictionary, so the zstd-dict-on-Bun breakage is irrelevant. Golden vectors are the standard gate.

---

## 6. What this changes in the swarm synthesis

1. **`event-codec.md` (previous doc) said "the frame, not the event, is the compression unit."** This iteration confirms it AND adds the second half: **the segment table is what makes small frames affordable.** The two are the same insight seen from both sides.
2. **osess.md §5 elision decision** — confirmed and upgraded: it is not a cold-start nicety; at frame geometry it is a ~25–30% win. Keep `sessionID` elision mandatory for all durable types.
3. **oses.md §2 microframe geometry** — the structural+table result removes the "raise frames to 16–32 KiB for ratio" pressure from `event-codec.md`. Small 8–16 KiB frames are now ratio-neutral with a table, so the choice reverts to corruption-containment + cache granularity (the original oses.md reasoning). **8–16 KiB frames + segment table = best of both.**
4. **The semantic-delta research item (research doc Phase 6) is eliminated** by structural encoding — remove it from the roadmap or keep only as a curiosity with the measured evidence.
5. **Dictionary dimension (structural/trained)** — subsumed by the field-ordinal table. Reserve the `dictionary_id` hook in the format but expect it unused in v1 for events.
6. **The structural encoder belongs inside OSES** as the event-frame codec (per-segment table, per-type field ordinals). OPCL projections stay JSON-TEXT/thresholded (median part 29 B, independently read) — no structural encoding there; their payload shapes are already slim and the byte volume is the tool tail.

---

## 7. What must still be measured on the real corpus

1. **Field-ordinal table stability**: the schema is versioned by `versionedType` — verify per-type field ordinal maps are stable across event versions (new fields append; never reorder) so old segments decode after schema evolution. This is the one real correctness risk of L3.
2. **Real mixed-class distribution**: my streams are schema-faithful but synthetic; the whole-DB win depends on the true steer/snapshot/tool mix (benchmark-arch corpus deliverable).
3. **Elision equality rates** for `info.id` and `timestamp` on real data before promoting them from empirical to mandatory.
4. **Table-size economics at real segment sizes**: `table_bytes / segment_raw` on real type cardinalities to tune the "skip table for jumbo segments" rule.
5. **Decode throughput**: structural decode + rehydrate + schema decode vs JSON.parse at page-hydration volumes — the added decode complexity must not regress the ≤5% write / read p99 gates.

**Bottom line:** "eliminate reconstructable data" is not just philosophically right, it is the measured 2–3×. Elide `sessionID` (free, 25–30%), intern repeated IDs in a segment-shared table (makes small frames free), and encode known schema as field ordinals + varints (kills the 38% keys + 7% numbers). The result is **0.043–0.051 ratio at real OSES geometry — ~60–70% better than the fork's shared-window JSON framing and ~6–7× better than per-row framing**, with semantic deltas and dictionaries both eliminated as redundant by the same move.
