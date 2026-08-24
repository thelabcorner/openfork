# Storage Engine Architecture — OSES segments + aggregate exact-value dedup

**Author:** oses-arch, swarm `chunkdb-ideation` (architecture-planning phase)
**Corpus authority:** `corpus/ground-truth-v2` (18 GB snapshot, 1,377,243 events) + `../ideation/event-destructuring-real-corpus.md` (the correction) + benchmark-arch `corpus.md` (tiers T0–T3, deliverables D2/D3/D4/D5). **No claim below without a corpus anchor where one exists.**
**Companions:** `../ideation/oses.md` (prior lane — superseded where noted), `event-codec.md`, `event-destructuring.md` (v1 — superseded), migration-arch's chapter, contract-arch's chapter, codec-arch's chapter.
**Status:** architecture design (ideation + design; illustrative DDL/pseudocode only — no implementation code).

---

## 0. The corpus verdict, restated for the storage engine

Measured (ground-truth-v2, correction doc):

| versionedType | rows | bytes share | payload character |
|---|---|---|---|
| `message.part.updated.1` | 68.6% | ~9.8% | **unique streaming text** (tool parts grow monotonically; 0% byte-identical-consecutive) |
| `message.updated.1` | 24.2% | **~85–90%** | 95–100% `info.summary.diffs` = full git diff patches; **per-session exact-duplicate summary values repeat 500–1,284×** |
| `session.updated.1` | 7.1% | remainder | also carries `info.summary` |
| `session.created.1` | 0.1% | ~0 | — |
| `session.next.*` (V2) | 0.015% | ~0 | steer class — effectively absent |

**The corrected Pareto (event subsystem):**
- **(A) per-aggregate exact-value dedup of `summary.diffs`** → 50–98% of message.updated bytes, ~35–65% of ALL event bytes, **before any compression** — THE headline move.
- **(B) shared-window LZ frames (OSES segments)** → captures part.updated unique text + post-dedup message.updated remainder.
- **(C) structural encoding + sessionID elision** → ~2–3% on this corpus (kept as free/cheap hooks, demoted from primary).
- **(D) semantic deltas** → dead (measured ≈ full-state post-LZ).

This chapter is the storage engine that makes (A) transactional, crash-safe, corruption-contained, and composed with (B) + everything else in `oses.md` that survives.

### 0.1 What survives from `oses.md` (unchanged), what the corpus overturns

| oses.md decision | Verdict after corpus |
|---|---|
| Hot tail = existing `event` table; `event_sequence` untouched (sync fence) | **Survives.** Values are a sealed-history concern; hot writes stay identity raw. |
| Event-ID zigzag-delta packing (mod-2^48 clock + 84-bit suffix) | **Survives.** Unaffected by dedup. |
| `type_set` exact delta-varint; RLE type stream | **Survives.** |
| Sync append-ordinal = per-segment base + per-event rowid uvarint deltas | **Survives.** The value table adds a per-event ref index stream, not an ordinal change. |
| Tier A packed ID registry | **Survives.** |
| Sealer = generalized ChunkSealer (frontier rule, own connection, `oses_seal` journal, append-safe prefix commit); fork sealer retires before Stage B | **Survives.** Promotion to the value table runs inside this lifecycle (§7). |
| Microframe 16–32 KiB | **Survives and is reinforced** — post-dedup frames are unique-text-dominated, where the LZ window IS the mechanism (§5). |
| `frame_count=1` legal; microframe independence optional | **Survives.** |
| sessionID elision (provable invariant) | **Survives as free** but corpus-demoted: ~0.2% on diff-dominated payloads; it remains a cold-start/first-frame win and the OPCL per-row win (event-codec.md §2.4). |
| Structural encoding / field ordinals (the "segment table" interning in event-destructuring.md v1) | **Retracted for this corpus.** Diff patches have no field structure to save; ~2%. The v1 "segment table decouples compression from window size" insight does NOT apply to unique text — the value table is the real cross-frame dedup mechanism, and it works at any frame size (correction doc §4). |
| Structural/trained dictionaries | **Reserved, not v1.** `dictionary_id` hook stays in the format; no dictionary machinery ships for events in v1 (event-codec.md §3.5). |
| Semantic deltas | **Dead.** Not in the storage design. |

---

## 1. The aggregate value table — `event_value`

### 1.1 Exact schema (kept stable for benchmark-arch's D2/D3/D4 sizing scans)

```sql
-- Per-aggregate content-addressed value store. Exact bytes, sha256 identity, per-aggregate scope.
CREATE TABLE IF NOT EXISTS event_value (
  aggregate_id  TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
  value_id      INTEGER NOT NULL,               -- per-aggregate ordinal, assigned at promotion
  sha256        BLOB NOT NULL,                  -- dedup key over EXACT ORIGINAL value bytes (always raw)
  raw_len       INTEGER NOT NULL,               -- byte length of the value (pre-compression)
  bytes         BLOB NOT NULL,                  -- value bytes; OCDB-envelope compressed, raw only
                                                --   when the worth-it guard fails (A4/LOS-1)
  refs          INTEGER NOT NULL DEFAULT 1,     -- audit refcount (see §8 — not load-bearing for GC)
  time_promoted INTEGER NOT NULL,               -- first-promotion wall clock (audit/cooling probes)
  PRIMARY KEY (aggregate_id, value_id),
  UNIQUE (aggregate_id, sha256)
);
```

- `value_id` is a per-aggregate ordinal assigned at promotion time (monotonic across seals). A frame ref is `value_id` as a uvarint (1–4 bytes) — compact, and `aggregate_id` is implicit from the segment.
- `sha256` is the dedup key over the **exact original value bytes** — always over the *raw* bytes, whether or not `bytes` is compressed (dedup key is invariant under storage encoding). Deterministic serialization is guaranteed by the Effect schema encoder for *canonical* rows; the original-span rule (§1.3) makes the invariant unconditional for non-canonical rows too. The `UNIQUE(aggregate_id, sha256)` index is the encode-side lookup.
- `bytes` is **compressed by default — ALL promoted values ≥ 1 KiB (adversarial LOS-1, accepted;**
  replaces the earlier "raw below ~64 KiB" tier, which was a ~20× loss on the 1–64 KiB band) with
  the existing OCDB envelope (brotli q1; **zstd l1 default-flip candidate at D7** per codec-arch,
  byte-stable, ~1.5–2× faster decode, better ratio on the dominant text class); a value is stored
  **raw only when the worth-it guard fails** (incompressible content). Rationale: the headline
  mechanism must not leave its own largest residual footprint raw — the heavy session's ~1.25 GB
  distinct values compress to ~50–75 MB at the measured 0.042–0.061. The read cost is absorbed by
  the value cache: decompress once per (value_id, cache-miss), then the 1,284× splice is memcpy —
  there is no read-path reason for a raw tier. Codec choice owned by codec-arch (OCDB envelope,
  value-entry bench).
- **Per-value integrity tag (A5/C1, accepted):** the per-segment value directory (§2) carries `crc32(raw bytes)` per distinct `value_id` (4 B). Decode verifies the tag on cache-miss before splice — converts a silently-corrupted value row into a detected fail-closed error at ~4 B/value + one crc32 per cache residency. This is a *frame-format* addition, not an `event_value` column — the frozen schema is untouched.
- `refs` is an **audit counter, not a GC mechanism** (see §8).
- **Schema freeze:** benchmark-arch's D2/D3/D4 (dedup sizing) and D5 (cooling) scans depend on this shape. Do not renumber or rename columns during the corpus-v1 scans. (The tag lives in the frame format, so the freeze holds.)

### 1.2 What qualifies for promotion — the ruleset

Promotion is **ruleset-driven and per-path**, not a generic "dedup anything big":

```text
promotion ruleset = (versionedType, JSON path) -> policy
  message.updated.1   -> ["info","summary"]   promote-on-second            (corpus: 500-1284x repeats)
  session.updated.1   -> ["info","summary"]   promote-on-second            (same field, scan-pending)
  <any other path>    -> (none) until the bounded scan finds evidence      (info.metadata, tool.input,
                                                                           result are scan candidates, not defaults)
```

Qualification policy (starting values — benchmark-arch's D2/D3/D4 set them precisely):

```text
SIZE_THRESHOLD   >= 1 KiB serialized         (below this: table row + index overhead not worth it)
RECURRENCE       >= 2 occurrences            (promote-on-second, see 1.3)
JUMBO_PROMOTE    >= 1 MiB                    (promote-on-FIRST for evidence-backed paths — gated on
                                              D3's first-copy-waste fraction; see adversarial A7)
```

- **Dedup-key consequence of original-span storage (adversarial A1, explicit):** `sha256` is over the
  **original span bytes** of the sub-value. Logically-equal-but-byte-different values therefore do
  **not** dedup — this is safe and conservative by construction. It costs no dedup rate on the real
  corpus because the 1,284× repeats are already byte-identical (they are the same serialized
  `info.summary` re-carried by every message version).
- **Why per-aggregate, not global:** (a) session hard-delete cascades cleanly with zero cross-aggregate orphan work; (b) the corpus evidence is per-session (the 1,284× repeats are *within* a session); (c) the `sha256` index stays small and local. **A3/E8 (adversarial, accepted):** "diffs are session-specific" is plausible but was N=2 assertion — the D2/D3 scan now includes a **bounded cross-aggregate hash histogram** across same-workspace sessions. If the cross-aggregate duplicate byte share is material (> ~5%), a global table with refcount GC becomes a v1.1 item with evidence; per-aggregate is confirmed otherwise. Refcount-GC complexity remains a legitimate secondary reason to stay per-aggregate.
- **Why not arbitrary sub-values:** the extraction ruleset is per `(versionedType, path)`, derived from corpus evidence and property-tested (same discipline as the elision manifest — never a generic "hash every big string" rule, which would fill the table with single-use part.updated text, exactly the 0%-recurrence class). **C4/E9 (adversarial, accepted):** part.updated's exclusion was justified by the *consecutive*-identical statistic (0%), which is the wrong statistic — dedup never required consecutiveness. D4 now scans `part.updated` sub-values (`tool.input`, `tool.result`) for **non-consecutive** repeats (retry-replay class) before the exclusion is locked; the ruleset extends if repeats are found.

### 1.3 Promotion mechanics — the pending-ledger (identical for backfill and incremental)

The sealer can only know a value recurs after it has seen it twice. The self-regulating policy:

```text
for each candidate sub-value at a ruleset path (size >= SIZE_THRESHOLD):
  span = byte span of the sub-value in the ORIGINAL event TEXT      -- span-walker (not re-serialization)
  raw  = original span bytes
  h    = sha256(raw)                                                 -- ALWAYS over original bytes
  1. h in event_value (aggregate, h)?            -> emit value-ref(value_id); refs += 1        (occurrence >= 2)
  2. h in event_value_pending (aggregate)?       -> PROMOTE NOW: insert row (new value_id), emit ref;   -- occurrence 2
                                                   remove from pending
  3. else (JUMBO_PROMOTE path AND raw_len >= 1 MiB)?
                                                -> PROMOTE NOW (first occurrence; evidence-backed path)
  4. else                                        -> insert into event_value_pending; emit value INLINE
                                                   in the frame (raw bytes, no ref)                (occurrence 1)
```

```sql
-- Persistent per-aggregate ledger of values seen inline-but-not-yet-promoted. Survives restarts.
CREATE TABLE IF NOT EXISTS event_value_pending (
  aggregate_id  TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
  sha256        BLOB NOT NULL,
  first_seen_seq INTEGER NOT NULL,              -- hot seq where first (inline) occurrence was sealed
  raw_len       INTEGER NOT NULL,
  PRIMARY KEY (aggregate_id, sha256)
);
```

- **Original-span storage + a REAL encode guard (adversarial A1/A2, accepted):** the stored value
  bytes are the **original span bytes** extracted by a JSON span-walker (path → byte span) from the
  event's original TEXT, never the sealer's re-serialization. The guard is now real:
  `original_span_bytes == canonical_re-serialization(sub-value)` — on mismatch, store the original
  span bytes anyway (dedup stays correct, byte-exactness preserved). This makes the byte-for-byte
  splice invariant **unconditional** (a row written by a serializer that emitted `1e21`/`-0`/
  `1.2300`/`1e400` round-trips exactly) and keeps the G1/G2 byte-identity gates passable. The old
  guard (re-serialization hashed against its own sha256) was vacuous — it could only fire on a
  collision, never on original-vs-canonical mismatch — and is deleted. Ref-free events keep their
  original TEXT bytes untouched (no re-serialization) (A2).
- **Semantic span guard (adversarial NEW-R1, accepted):** the canonical-equality guard cannot detect
  a span-WALKER mislocation (a wrong-but-canonical-round-tripping span passes it and silently
  corrupts every read — replay catches it, readAggregate/sync-history serve wrong data). The sealer
  already parses each event for elision, so the fix is near-free: `JSON.parse(span)`
  **deep-equal** `parsed_event[path]`. A span failing EITHER check (canonical equality OR semantic
  deep-equal) falls back to inline storage — never stored as a value. Two independent checks, both
  must pass.
- **Span-walker byte space (adversarial NEW-R2, accepted):** the walker operates on the **exact
  stored TEXT bytes as a `Uint8Array`** (UTF-8-aware), producing **UTF-8 BYTE offsets** — never on
  the decoded JS string, whose indices are UTF-16 code units (astral content — emoji, CJK beyond
  BMP — would diverge and the splice would land mid-character). The splice list offsets are
  UTF-8 byte offsets into the frame payload. Golden vectors include **astral-boundary cases**
  (value spans starting/ending at a multi-byte code point boundary).
- The **first** occurrence of a recurring value is stored inline in a frame (original bytes). The dedup win begins at occurrence 2. For a value recurring k times the cost is `1 inline + 1 table row + (k−1) refs` instead of `k inline` — at k=1,284 the single wasted first copy is negligible.
- **JUMBO_PROMOTE waste (adversarial A7, accepted):** promote-on-first is insurance that costs bytes when a jumbo value never recurs (same bytes stored in the table, plus row+ref overhead). **Gate JUMBO_PROMOTE on D3's first-copy-waste fraction** — the threshold stays PROPOSED, not locked, until that measurement.
- The pending ledger is what makes cross-seal recurrence visible: the corpus's repeats span *thousands of events apart* (across seals), so recurrence detection cannot be per-seal. Ledger size = distinct values per aggregate ≈ 40 B/hash → 225 distinct values ≈ 9 KB for the heaviest session. Trivial.
- **Backfill and incremental sealing use the SAME algorithm** — the initial 1.37M-event migration runs the identical promote loop over legacy rows. No two-pass special case (a two-pass "count then promote" is an optional optimization only if D2/D3 shows the single-pass wastes too many first copies).
- Crash safety: promotion writes happen only inside the seal commit txn (§7.3). A crash before commit → pending ledger + hot rows intact; after commit → value rows + refs + segments all present. `INSERT OR IGNORE` + `refs = refs + 1` on the `UNIQUE(aggregate_id, sha256)` makes re-promotion idempotent.

---

## 2. Value-refs inside frames — the placeholder-splice

### 2.1 Where refs live

**Refs live inside the frame's per-event index stream, not as a separate read structure.** The sealed segment remains the single unit that fully describes its events; `event_value` is a referenced side-table, read on demand. The ref is *positional*:

```text
frame payload = JSON text (elided) with each promoted sub-value REPLACED by a minimal
                valid-JSON placeholder (the 4-byte token "null")
per-event payload index entry gains an optional ref list:
  ref = { placeholder_offset (uvarint, offset of the placeholder in the reduced payload)
        , placeholder_len   (uvarint, 4 in v1 — the "null" span)
        , value_id          (uvarint, into event_value for the segment's aggregate) }
per-event index entry also carries (adversarial O1, RESERVED in v1):
  has_digest flag + optional 128-bit digest (sha256 truncated to 128 bits over the CANONICAL
  rehydrated logical data — post-splice, post-elision), computed at seal
segment value directory (one per segment, in the index region):
  value_id -> { crc32 of the value's ORIGINAL raw bytes }     -- integrity tag, 4 B/value (C1, accepted)
```

- **Per-event logical digest (adversarial O1, accepted — format-reserved NOW):** the replay
  idempotency/divergence check on a sealed event is the byte-king point read (R3: materializing a
  548 KB `summary` ≈ 1–5 ms, busts the latency budget). A per-event digest in the **UNCOMPRESSED
  index region** (where ID/type/ordinal/ref streams already live — NOT inside the compressed frame,
  or the fast path would need a full segment decompress) turns the decision into a digest-compare:
  zero frame decompress, zero value fetch, ~5–20 µs. Digest is 128-bit (sha256 truncated) — a
  64-bit digest could false-positive-match and silently drop a divergent replay (correctness bug);
  128-bit is collision-negligible at any realistic scale. **Correctness contract:** the digest is a
  FAST PATH ONLY for the idempotent case — digest-match (plus exact ID/type from the index) →
  idempotent return; any mismatch → fall through to the full materialization +
  `isDeepStrictEqual` (the authority), preserving exact divergence errors. A false negative costs
  the full compare; a false positive is astronomically unlikely. The field is `has_digest` +
  optional 16 B, **empty until gated** — reserving it in v1 avoids a format break later. Gated on
  the G1 differential (identical idempotent/divergent outcomes with the fast path on/off; full
  compare retained in a test config) + corpus deliverable D10.

**Reconciliation with contract-arch §3.3 (byte-offset splice vs marker token):** this IS a
byte-offset splice — the ref is a positional `(value_id, byte_offset, byte_length)` tuple in the
per-event index, and the sub-value bytes are removed from the payload and re-inserted at the known
offset after brotli decompression. The 4-byte `null` is a *placeholder occupying the spliced span*,
NOT a marker token: it is never searched for in the payload text, so **no collision with user
content is possible** (a user payload can contain the literal text `null` freely — it is never
interpreted). The placeholder exists only so the reduced payload remains valid JSON end-to-end
(§2.1 advantages below). A pure zero-byte removal (contract-arch's alternative) would leave
`"summary":}` — invalid JSON — for zero byte savings; the placeholder is adopted.

Decode contract:

```text
read event bytes from frame
for each ref in order (value fetched lazily per ref on point reads; eagerly per
                       segment only for full-segment replay):
  fetch event_value.bytes for (aggregate_id, value_id)            -- cache-miss: decompress + tag-check
  verify crc32(raw bytes) == segment value directory tag          -- BEFORE splice (C1, ~zero cost)
  splice raw bytes over payload[offset .. offset+4]               -- exact byte replacement
JSON.parse(spliced payload) -> object
rehydrate elided fields (sessionID from envelope)
schema decode
```

- **Read policy (adversarial B2, accepted; composed with readpath-arch):** point reads fetch
  exactly the `value_id`(s) the decoded event references — never a segment-scoped eager preload of
  every referenced value (a ~200-event segment can reference up to ~200 distinct values up to
  24 MB each — gigabytes on a single point read). Eager preload happens only when the caller does a
  full-segment replay (one load, then memcpy per event). Both sit behind the existing LRU value
  cache `(aggregate_id, value_id) -> raw bytes`, with a per-value cache admission cap so a 24 MB
  value is never admitted wholesale without a policy decision.

- **Why a JSON placeholder instead of removing bytes:** removing the sub-value leaves invalid JSON (`"summary":}`); the 4-byte `null` keeps every frame payload valid JSON end-to-end. That gives: (a) the compression path unchanged (brotli over JSON text — the frame codec needs no new mode); (b) a *degraded-read* property — a reader that ignores refs sees `null` at that position, which is fail-visible, never silent corruption; (c) trivial splicing (positional, length-driven — no ambiguity, no parser dependency for the splice).
- The ref list rides the existing per-event payload-index stream (frame_ordinal, offset, length, flags) — add `ref_count` + ref entries. Cost: ~6–10 B per ref. For message.updated with one summary ref: ~8 B/event.

### 2.2 Replay exactness (the isDeepStrictEqual contract)

The replay/divergence check (`commitDurableEvent`) compares `stored.data` against the re-encoded event via `isDeepStrictEqual`. For a sealed event, `stored.data` is the **spliced + parsed + rehydrated object** — the adapter must run the full splice before handing the object to the replay comparison (and before schema decode). Order is load-bearing:

```text
splice value bytes -> JSON.parse -> rehydrate elided sessionID -> isDeepStrictEqual(decoded, encoded)
```

- **Encode-side exactness guard (seal time, real — A1):** the guard is `original_span_bytes ==
  canonical_re-serialization(sub-value)`; on mismatch the original span bytes are stored anyway
  (byte-exactness preserved). The `sha256` column then matches the stored bytes by construction.
  The previous guard (re-serialization hashed against its own sha256) was vacuous and is deleted.
- **Decode-side guard:** splice produces exactly the stored value bytes; the resulting object deep-equals the schema-encoded value by construction. Full sha256 is NOT re-hashed on every read; the cheap `crc32` tag in the segment value directory IS verified before splice (see §2.3).

### 2.3 Corruption containment for a value-ref

| Failure | Required behavior |
|---|---|
| `value_id` missing from `event_value` (row deleted without cascade, corruption) | **Fail closed** with a typed storage error naming `(aggregate_id, value_id, segment_id, ordinal)`. Never synthesize, never "read without the value", never substitute another value. Repair tooling can locate the exact missing value from the `oses_seal` journal + segment index. |
| `value_id` present but `bytes` wrong (tamper/SQLite corruption) | **Caught by the per-value integrity tag before splice** (C1, accepted): the segment value directory stores `crc32(raw bytes)` per `value_id` (4 B/value); decode verifies on cache-miss and fails closed on mismatch — a corrupted value row can no longer silently poison the 1,284 events that reference it. The tag is checked once per value per cache residency (not per event read), so the cost is ~zero. `event_value.sha256` remains the offline audit key (repair tool rehashes and compares). Add this case to the G10 fault-injection suite. |
| frame ref list malformed / offset out of range | Segment CRC + index bounds validation (existing OSES validation order §22.9) rejects before splice. |
| `event_value` row orphaned (no segment refs it) | Only possible via corruption (segments are immutable; refs never die). Detected by the `refs` audit (§8). |

**Blast radius:** one value row is shared by every occurrence *within one aggregate* (per-aggregate scope), so a corrupt value damages one session's history — never another session's (matches the no-cross-aggregate-chunks invariant). A missing value breaks the logical replay of the affected segment deterministically (fail-closed, not skip).

---

## 3. Hot tail reconciliation — values are a sealed-history concern

The hot tail is unchanged from `oses.md` §1:

- **Hot rows never carry value-refs.** `event.data` stays raw JSON TEXT on the identity write path (or OCDB-framed if the fork sealer ran — the mixed-state read path in §9). A hot jumbo `summary.diffs` stays raw TEXT until it seals. Reasons: (a) hot-path cost is zero by construction (the fork's identity-write prototype); (b) hot replay/idempotency compares `stored.data` directly with no splice; (c) the sync fence, ID registry, and `(aggregate_id, seq)` indexes are untouched.
- **`event_aggregate` gains two audit columns** (sealer-maintained, same as `hot_count`/`hot_raw_bytes`):

```sql
ALTER TABLE event_aggregate ADD COLUMN value_count INTEGER NOT NULL DEFAULT 0;   -- distinct values promoted
ALTER TABLE event_aggregate ADD COLUMN value_bytes INTEGER NOT NULL DEFAULT 0;   -- sum of raw_len
```

  These are seal-time accounting (never hot-write-path), used for seal planning (is dedup active?) and whole-DB space accounting.

- **Reconciliation matrix** (what the value table does NOT change):

| oses.md mechanism | Interaction with `event_value` |
|---|---|
| event-ID packing | none — refs are an orthogonal stream |
| `type_set` | none — value refs carry no type information |
| sync append-ordinal | none — the ordinal covers every event regardless of refs; the ref list is added to the same per-event index entry |
| Tier A ID registry | none — a sealed event's registry row is unchanged; refs are inside the segment blob |
| `remove(aggregateID)` | `event_value` + `event_value_pending` cascade via the `event_sequence` FK (§8) |
| replay / strictOwner | hot: direct compare; sealed: splice + compare (identical semantics) |

---

## 4. Segment geometry on real payloads — unique-text-dominated frames

### 4.1 What remains in frames after dedup

- `message.updated.1`: the summary is a value-ref (4-byte placeholder); the frame carries the ~200–600 B shell (path/tokens/ids + ref). These are **tiny, highly repetitive shells** — trivial for any LZ window.
- `part.updated.1` (68.6% of rows, ~9.8% of bytes): **unique streaming text** — the dominant frame content.
- `session.updated.1`: summary → value-ref too; small remainder.
- steers: ~0% on this corpus.

**Post-dedup, frames are unique-text-dominated.** The value table decouples the *cross-frame repetition* (the summary.diffs that LZ could never reach); it does **nothing** for the *in-window repetition* of part.updated text — there, the LZ window IS the mechanism.

### 4.2 Which geometry advice survives — the direct answer

- **"Raise microframes to 16–32 KiB" (event-codec.md, window-sensitivity §2.3) survives.** Window sensitivity on the count-dominant text class: 0.193 (2 KiB) → 0.044 (64 KiB) → 0.036 one-shot. The v1 destructuring claim ("8–16 KiB + segment table makes small frames ratio-neutral") is **retracted with structural encoding** — the interning table that made small frames cheap is gone, and the value table does not substitute for LZ window reach on unique text.
- **Recommendation: microframe raw target is 16–32 KiB — LOCKED, not swept to 64 KiB.** Three reasons, the first now a hard constraint (read-latency-is-critical, coordinator):
  1. **Read-latency budget bounds frame size.** A point read decompresses exactly one containing frame (frame index → one decompress). 32 KiB of brotli ≈ 0.2–1 ms on desktop hardware; 64 KiB doubles that. With point reads on the critical resource, 32 KiB is the decompression ceiling that fits the budget on low-end machines; 64 KiB is measure-only (sweep cell), never a default.
  2. **The sensitivity curve flattens after 32 KiB**: 0.047 (32 KiB) vs 0.044 (64 KiB) is only ~6% — 32 KiB captures ~94% of the 64 KiB ratio at half the decompression cost. The Pareto knee is at 32 KiB for unique text.
  3. **The sealer is async, so more/smaller frames cost nothing user-visible at write time.** Frame-count overhead (index bytes, resets) is a seal-time cost paid in the background; it cannot justify inflating the read-decompression bound. The only write-side cost is a few extra bytes of index — irrelevant against the read budget.
  - **Correction (adversarial A5, accepted): the "pure-ref frames skip compression" instruction is
    DELETED.** A 16–32 KiB frame of `message.updated` shells (path/tokens/ids + `null` markers) is
    repetitive JSON that brotli crushes ~20–40× (to ~1–2 KB stored); skipping compression would
    store 16–32 KiB where brotli stores 1–2 KB, and the point-read benefit comes from the *stored*
    frame being small — which requires compressing (decompress of 1–2 KB ≈ tens of µs). The
    codec.md §4 post-dedup worth-it guard is the **single source of truth** for the compress-or-raw
    decision; it naturally keeps a genuinely tiny frame raw via MIN_GAIN.
  - `frame_count=1` is the **v1 policy for ALL segments** (§4.3, adversarial A6) — not just low-volume aggregates. The 128–512 event-count sweep stays (a 32 KiB text frame holds ~200–500 part events; index budget unaffected).
- **Type-homogeneity is a soft hint, not a rule:** mixing deduped shells (message.updated) with text (part.updated) in one frame is fine — shells compress anywhere; the frame builder may prefer same-class runs "where cheap" but must not split on it (that is event-codec.md §3.1: tiny events are never framed individually; the frame is the unit).
- **Codec:** brotli q1 default (byte-stable cross-runtime, frozen registry per codec-arch); brotli q4 for text-heavy frames (2× ratio on steer/snapshot probes, CPU is free in the sealer); zstd as a per-frame adaptive alternative only where it wins on the real corpus (event-codec.md found brotli beating zstd on the 64 KiB tool stream). Per-frame worth-it guard against `sum(raw) + index` stays.
- **Value bytes do not distort geometry:** a 24 MB value is a 4-byte placeholder in the frame — jumbo-frame decisions are now about *non-promotable* jumbo (unique tool output), not diffs.

### 4.3 v1 frame policy: `frame_count = 1` (adversarial A6, accepted)

**Ship v1 with `frame_count = 1` — one frame per segment at the locked 16–32 KiB raw size.** The
`frame_count` format field is kept (so the D7 sweep can flip the policy later without a format
change), but the multi-frame machinery (frame directory, per-frame codec override, per-frame CRC,
RLE type runs, per-event frame-ordinal mapping) is **deferred to D7**. Rationale:

- Under read-latency-first, decompression cost is bounded by frame *size*, not frame count — a
  single-frame 32 KiB segment decompresses in the same ~0.2–1 ms as a 32 KiB microframe.
- Corruption blast radius is already bounded at one *per-aggregate* segment (no cross-session
  damage); microframe granularity must be quantified against that before it is built.
- This removes real v1 implementation + golden-vector surface. The value-splice, jumbo-singleton,
  and worth-it-guard mechanisms are unchanged (they operate per segment in v1).
- Consequence: "segment" and "frame" are the same unit in v1; the earlier 32–128 KiB segment
  backstop from oses.md is superseded — segments are 16–32 KiB raw.

### 4.4 Page-size alignment on the born-fresh file (adversarial LOS-3, accepted — D7-gated)

The rebuild's new file is **born fresh** (migration-arch's file-swap), so `page_size` is chosen at
creation with **zero migration cost** — no VACUUM over 18 GB. Promote page_size from "offline
VACUUM control" to a **first-class new-file parameter, D7-gated**: a 16 KiB page holds a whole
16 KiB frame → a segment-BLOB fetch drops from ~8 pages to 1; a 32 KiB page (SQLite max 65536)
aligns with the 32 KiB frame lock the same way. The D7 geometry sweep adds `page_size ∈ {4, 8, 16,
32} KiB` as a dimension, correlated with the frame-size lock (frame ≤ page → 1-page BLOB fetch).
**Coordinated with migration-arch** (the rebuild creates the file; page_size is set at
`PRAGMA page_size` on the empty new file before any write). The pristine legacy file keeps its
4 KiB pages — page_size only applies to the born-fresh OSES file.

---

## 5. Jumbo policy + the externalization challenge

### 5.1 The 24 MB `summary.diffs` — what happens to it

| Scenario | Policy |
|---|---|
| 24 MB summary, recurs (≥2 or ≥1 MiB on an evidence-backed path) | **Value-table dedup** — the frame holds a 4-byte placeholder + ref; the 24 MB lives once in `event_value.bytes`. This is the corpus's actual behavior (top value ×1,284). |
| 24 MB diff, single occurrence | Below `JUMBO_PROMOTE` evidence only if the path ruleset says promote-on-second → it stays **inline in a jumbo singleton frame** (current oses.md §2.5 jumbo policy), or stays hot as raw TEXT while within the safety tail. |
| Unique jumbo tool output (part.updated, max observed 32.8 MB) | Not a dedup candidate (0% recurrence) → existing jumbo policy: singleton frame (>64 KiB), singleton segment (>128 KiB raw), or stay hot. |
| `RAWLEN_PRE_CAP` (128 MiB) / `MAX_RAW` (2^31−1) | The 24 MB and 32.8 MB rows are far under both. **Value promotion has a stricter, format-level cap**: a single value row must not exceed the segment/frame raw caps' intent — treat `bytes` > 64 MiB as an externalization trigger (below), not a frame concern (refs are tiny). |

### 5.2 Challenge: SQLite value table vs file-backed `Storage` externalization for large diffs

The correction doc says "not the file-backed Storage service — this stays inside SQLite." I endorse that for v1, with the boundary made explicit:

**Why SQLite wins v1 (transactional-replay constraints):**
1. **Object-creation durability before event commit** — the research doc §F.15 requirement. A value referenced by a sealed segment must be durable *in the same commit*; a file-backed write is a second, non-transactional resource. The value table's insert happens in the seal commit txn — atomicity is free.
2. **No event can reference a missing object after crash** — SQLite WAL gives this; a file store needs a manifest + journal protocol that doesn't exist yet.
3. **Backup/restore coherence** — a self-contained `opencode.db` backup includes `event_value`. Externalization forces multi-resource snapshotting (research doc §25.7 explicitly defers that).
4. **Reverse export / rollback** — splice from the table is trivial; externalized refs need file access in the rollback path.
5. **The dedup win dominates**: 1,284 copies → 1. The remaining single copy (~24 MB) is not the storage problem; SQLite handles multi-MB BLOBs fine (rows up to 1 GB).

**The boundary (when externalization becomes right):** only if post-dedup per-aggregate distinct-value bytes grow pathological — e.g. a session with >10,000 *distinct* multi-MB summaries. Two gates:
- per-aggregate `value_bytes` cap (tunable, e.g. 4 GiB) — beyond it, move that aggregate's values to file-backed Storage under a future F.15-compliant protocol (durable-before-commit, ref-counted, manifest-aware backup);
- single value row > 64 MiB → externalize that value.

**Benchmark decision (benchmark-arch D2/D3/D4):** the distinct-value byte totals per aggregate on the real corpus settle this — if no aggregate approaches the cap, externalization stays off the roadmap.

---

## 6. Sealing lifecycle with value promotion

Promotion runs inside the existing sealer; it is the **same commit txn** as the segment, never a separate pass:

```text
BUILDING (own connection, outside any write txn):
  1. eligibility: seq <= event_sequence.seq AND owner_id IS NULL (+ cooling, §D5 — see oses.md §6.4;
     the event-ID clock remains a candidate cooling predicate)
  2. read contiguous hot prefix [sealed_seq+1 .. cutoff_seq]
  3. for each event:
       a. parse JSON (already needed for elision)
       b. for each ruleset path present: extract serialized sub-value
       c. hash -> event_value / event_value_pending / inline decision (§1.3)
       d. emit physical payload: elide sessionID; replace promoted sub-values with "null" placeholders
       e. record per-event ref list
  4. build frames (16–32 KiB target; jumbo singletons for non-promotable jumbo)
  5. compress frames (brotli q1/q4; per-frame worth-it guard)
  6. encode container: ID stream, type stream, frame directory, payload index (with ref lists), frames

COMMITTING (BEGIN IMMEDIATE):
  re-read event_aggregate generation/sealed_seq; verify contiguity and no overlap
  INSERT OR IGNORE event_value rows (new values; refs=1) ; UPDATE refs=refs+1 for promoted refs
  DELETE event_value_pending rows consumed by promotion
  INSERT event_segment (metadata incl. type_set, crcs)
  INSERT event_segment_blob
  INSERT event_id_registry rows
  INSERT oses_seal journal rows
  UPDATE event_aggregate: sealed_seq=cutoff_seq, hot_count-=N, hot_raw_bytes-=raw,
        value_count/value_bytes updated, last_append_ms
  DELETE hot prefix rows
COMMIT
```

- **Append safety unchanged:** normal appends above `cutoff_seq` never invalidate the candidate; a value promoted by the candidate is only referenced by *that* candidate's segments, so a discarded/retried BUILDING never leaves orphan refs (nothing is inserted until COMMITTING).
- **Sealer COMMIT is PINNED to a dedicated connection (adversarial B3, accepted):** the BUILDING
  AND COMMITTING phases both run on the `withBackfillDb(filename)`-style own connection — the
  "shared connection / busy retry" alternative is REMOVED. A multi-MB value+segment commit on the
  semaphore-serialized `Database.Service` connection could stall an interactive write up to
  `busy_timeout = 5000 ms` (the fork's ChunkSealer inherited this — the earlier adversarial pass's
  I2). The dedicated connection is the proven in-codebase fix (FTS backfill already uses it) and is
  the only allowed commit path. `SQLITE_BUSY` on the own connection → BACKOFF with re-read.
- **VALUE_DEDUP is a feature gate independent of the storage EPOCH** (contract-arch §3.3): refs are decodable from READ_OSES onward, and a segment may legally contain a mix of frames with refs and frames with full values (mixed-segment decode must work). Rollback to a lower epoch = stop promoting; already-promoted values remain in `event_value` (harmless, and reverse-export re-inlines them to plain JSON TEXT). This keeps the gate reversible and lets the corpus scans ship before the epoch flip.
- **Concurrency:** same as oses.md §6.5 — global sealing concurrency 1, `SQLITE_BUSY` → BACKOFF, `UNIQUE(aggregate_id, first_seq)` + generation guard for multi-process.
- **Backfill = the same loop over legacy rows** (pristine TEXT or OCDB-framed — §9), one algorithm for both paths.

---

## 7. Delete / GC

```text
remove(aggregateID):
  DELETE event_sequence WHERE aggregate_id = ?      -- one cascade covers ALL of:
  event, event_value, event_value_pending, event_segment, event_segment_blob,
  event_id_registry, event_aggregate, oses_seal
```

- **Cascade-only GC in v1.** Sealed segments are immutable, so a value's `refs` can never decrease within a live aggregate — refcount-driven GC has nothing to do. `refs` exists as an **audit counter**: the sealer asserts `Σ refs in sealed segments (by value_id) == event_value.refs` as an integrity invariant; drift = corruption signal for the repair tooling.
- **No history GC** (research doc §33.13 / oses.md): archive ≠ delete; hard session delete is the only path that removes values, and the cascade makes it atomic.
- **Future note:** if a checkpoint-based history-prune feature ever ships, `refs` becomes load-bearing (prune segments → decrement refs → delete value rows at 0). Not v1; the column exists so the schema doesn't churn.

---

## 8. The three legacy states — how the storage engine reads each

The migration and the read path must handle three on-disk states for `event.data` (ground-truth-v2 §6: the 18 GB snapshot is pristine TEXT; the fork's sealer has NOT run on it; other deployments may be partially framed; post-cutover is OSES):

| State | Detection | Read path |
|---|---|---|
| **pristine TEXT** *(primary — the 18 GB snapshot and live DB are both pristine; no fork framing has run)* | `storage_epoch = legacy` AND `typeof(event.data) = 'text'` | `JSON.parse(event.data)` directly |
| **OCDB-framed** | `typeof(event.data) = 'blob'` with `OCDB` magic (first 4 bytes) | `decompressFrame(bytes)` → raw JSON → `JSON.parse` (fork json-codec.ts; v1/v2 header variants both handled) |
| **OSES sealed** | `storage_epoch = oses` AND `seq <= event_aggregate.sealed_seq` | segment decode: decompress frame → splice value refs → parse → rehydrate elision |

Pristine TEXT is the design's primary path (corpus-verified: ground-truth-v2 §6 — the sanctioned snapshot and live DB carry zero framed rows); OCDB-framed is a defensive branch for deployments where the fork sealer ran; OSES is the post-cutover path. The branch is row-level and cheap (`typeof` + magic probe).

- **One row-level branch, one code path.** The adapter's `StoredRow` production is: (a) hot row → TEXT-or-frame branch; (b) sealed → segment decode. Migration's backfill runs the identical reader (so a partially framed DB backfills correctly without a separate "unframe" mode — though migration-arch's reverse-export unframe list still governs rollback).
- **Epoch independence:** reads never depend on which *other* rows are in which state — a DB can be mid-migration (mixed legacy rows + OSES segments) and every read resolves per-row. This is the property that lets the rebuild (file-swap or in-place) run without a read fence: the rebuild writes OSES rows/segments from the legacy file read-only, and any reader of either file resolves each row independently. Consistent with migration-arch's file-swap rebuild (the new file is born with OSES rows + copied legacy hot rows coexisting).

---

## 9. Adapter / read-path deltas (contract-arch chapter alignment)

The `EventStore` adapter from oses.md §9.2 is unchanged in shape; the value table adds:

- `readRange` / `readAt` / `history` must run the **splice step** for sealed events before returning `StoredRow` (replay-exactness order from §2.2).
- `removeAggregate` now cascades the two new tables (schema-level, no adapter code).
- Sync-history `(seq, ordinal)` merge is unchanged — refs add per-event index bytes, not ordering.
- **Hot path:** `insertHot` and `uniqueID` never touch `event_value` — no hot-path delta.

---

## 10. Open questions

1. **Per-path promotion thresholds** — SIZE_THRESHOLD (1 KiB?), JUMBO_PROMOTE (1 MiB?), and promote-on-second vs on-first per path. These are the D2/D3/D4 numbers; the design holds for a wide range, but the *table's waste* (promoted-never-recurs rows) and *the first-copy inline cost* both scale with the thresholds.
2. **Does `session.updated.1`'s `info.summary` repeat like message.updated's?** (7.1% of rows; same field.) If yes, the same ruleset path pays off; if no (summaries only updated when diffs change), its values stay inline and the table only serves message.updated. D2 must measure both paths.
3. **Value-entry codec — RESOLVED (adversarial A4 + LOS-1, accepted; owned by codec-arch):** `event_value.bytes` is **compressed by default — ALL promoted values ≥ 1 KiB** (OCDB envelope, brotli q1; zstd l1 default-flip candidate at D7; raw only when the worth-it guard fails); sha256 stays over raw bytes; decode = one decompress per cache-miss, then the 1,284× splice is memcpy. The old raw-in-v1 default AND the "raw below ~64 KiB" tier are both retracted (the tier was a ~20× loss on the 1–64 KiB band with no read-path justification — the value cache absorbs decode). Per-value codec choice + bench owned by codec-arch.
4. **Per-aggregate value-table growth cap** — distinct-value bytes per session grow monotonically (segments are immutable). The corpus's heaviest session ≈ 1.25 GB distinct. Is a cap + externalization gate (≥4 GiB aggregate value_bytes, §5.2) sufficient, or does a pathological session need an in-aggregate eviction policy (e.g. "promote only if recurrence proven within a window")? Needs D4's distinct-value distributions.
5. **Value-row read caching** — replay of a long message.updated history hits the same `value_id` rows repeatedly (1284 refs → 1 row). A small value-row cache (LRU over `(aggregate_id, value_id) → raw bytes`) turns replay into memcpy; where does it live (sealer-side vs read-path) and what budget (it competes with the frame cache, §8 of oses.md)? Composed with the adversarial B2 rule: point reads fetch per-ref lazily; eager preload only for full-segment replay; per-value cache admission cap (§2.1).

---

## 11. What benchmark-arch's bounded scan must answer (the value-table threshold)

From the correction doc's actionable step 1–3 + D2/D3/D4:

1. **Whole-DB elimination fraction** — bounded per-aggregate scan of `message.updated` + `session.updated` (sum distinct-value bytes vs total, per aggregate) → the true (A)-class win before any compression. This validates §0's "35–65%".
2. **Distinct-value histograms per path** — for `message.updated.1/info.summary` and `session.updated.1/info.summary`: distinct count, byte-size distribution, multiplicity distribution. These set SIZE_THRESHOLD and JUMBO_PROMOTE.
3. **Other-path scan** — does anything else repeat at ≥1 KiB with ≥2 occurrences (`info.metadata`, `tool.input`, `result`)? Expands (or confirms) the ruleset.
4. **part.updated NON-consecutive repeat scan (adversarial C4, accepted)** — `part.updated` sub-values (`tool.input`, `tool.result`) scanned for non-consecutive repeats (the retry-replay class). The current exclusion rests on the *consecutive*-identical statistic (0%), which is the wrong statistic for dedup; scan before locking the exclusion.
5. **Cross-aggregate duplicate-rate probe (adversarial A3, accepted)** — bounded global hash histogram across same-workspace sessions; < ~5% cross-aggregate byte share confirms per-aggregate scope, material share → global table with refcount GC becomes a v1.1 item with evidence.
6. **Per-aggregate distinct-value byte totals** — sizes the `event_value` table, sets the externalization gate (§5.2), and answers open Q4.
7. **First-copy waste** — of values that recur ≥2, the fraction that appear only once in the scan window (the promote-on-second / JUMBO_PROMOTE tuning input; gates JUMBO_PROMOTE, adversarial A7).

---

## 12. Headline decisions (for the coordinator)

1. **`event_value` per-aggregate exact-value table is the headline storage move** — schema frozen for D2/D3/D4: `(aggregate_id, value_id, sha256, raw_len, bytes, refs, time_promoted)`, per-aggregate scope, promote-on-second with a persistent `event_value_pending` ledger (JUMBO_PROMOTE ≥1 MiB on evidence-backed paths, gated on D3 first-copy-waste), **`bytes` compressed by default (ALL values ≥ 1 KiB; raw only when the worth-it guard fails; sha256 over raw)**, cascade-only GC, audit refcount. **Stored values are ORIGINAL span bytes** (span-walker, not re-serialization) with a real encode guard. ~35–65% event-subsystem reduction before compression.
2. **Value-refs live INSIDE frames as positional placeholders** — promoted sub-values become a 4-byte valid-JSON `null` + a per-event ref-list entry in the payload index, plus a per-segment value directory carrying a crc32 integrity tag per value; decode verifies the tag, splices exact stored bytes before `JSON.parse` and schema decode. Frame payloads stay JSON (codec path unchanged); missing/corrupt value = fail-closed (tag makes "valid-but-wrong" detected); replay `isDeepStrictEqual` sees the rehydrated object.
3. **Hot tail is untouched — values are sealed-history-only.** Hot `summary.diffs` stays raw TEXT; identity writes, sync fence, ID registry, `(aggregate_id, seq)` indexes all unchanged. `event_aggregate` gains `value_count`/`value_bytes` audit columns.
4. **Geometry is locked at 16–32 KiB, one frame per segment in v1** (`frame_count=1`; 64 KiB = measure-only, never default; multi-frame machinery deferred to D7) — post-dedup frames are unique-text-dominated (part.updated), where the LZ window is the mechanism, but the read-latency budget bounds frame decompression (32 KiB ≈ 0.2–1 ms; curve flattens after 32 KiB, only ~6% better at 64); the sealer is async so more/smaller frames cost nothing user-visible. **Shell/pure-ref frames COMPRESS** (brotli crushes them 20–40× to ~1–2 KB stored; decompress tens of µs) — the codec.md §4 worth-it guard is the single source of truth, the earlier "pure-ref frames skip compression" instruction is deleted (adversarial A5). "Small frames + segment table" advice dies with structural encoding. brotli q1/q4; zstd per-frame where it wins.
5. **SQLite value table beats externalization for v1** — transactional-replay, crash, backup, and rollback constraints all favor in-DB dedup; externalization is gated behind per-aggregate `value_bytes` (≥4 GiB) and single-value (≥64 MiB) caps.
6. **Three legacy states (pristine TEXT / OCDB-framed / OSES) read through one row-level branch** — migration backfill and the adapter share the identical reader, so mid-migration mixed DBs resolve per-row.

---

## 13. Corrections to prior docs (for the record)

1. `oses.md` §5 (elision) — corpus-demoted: ~0.2% on diff-dominated payloads; keep the rule (free, provable) as cold-start/first-frame + OPCL per-row optimization, not a headline.
2. `oses.md` §2 / `event-codec.md` — 16–32 KiB microframes CONFIRMED (not 8–16); `event-destructuring.md` v1's "segment table makes 8–16 KiB ratio-neutral" is retracted with structural encoding (no table remains; the value table does not extend LZ reach on unique text).
3. `event-destructuring.md` v1's structural-encoding-as-primary is fully retracted for this corpus (~2%); structural encoding stays a future V2-steer-class feature only.
4. `architecture-research.md` §19.5/§1.2 "defer large-object dedup until measured" — the measurement exists; the gate is met; the design is this chapter.
5. New constraint on benchmark-arch: **`event_value` schema is frozen during D2/D3/D4** (their handoff asks the same — recorded here so the storage chapter and corpus chapter agree).
6. **Read-latency-is-critical (user hard constraint, post-chapters):** frame geometry in this chapter is LOCKED at 16–32 KiB (§4.2) — the earlier "sweep to 64 KiB for text-heavy frames" wording is withdrawn. 64 KiB remains a measure-only sweep cell, never a default. Rationale: the read-latency budget bounds one-frame decompression, the window-sensitivity curve flattens after 32 KiB (~6% to 64), and the async sealer means smaller frames have no user-visible write cost. readpath-arch's chapter layers the full latency budget on top; this is the storage-side resolution of the frame-size reconciliation point.
7. **Adversarial pass acceptances (Round 1 + Round 2 + Round 3, all folded):** A1/A2 original-span storage + real encode guard (§1.3, §2.2); A4 + LOS-1 value bytes compressed by default — ALL values ≥ 1 KiB, raw only when the worth-it guard fails, sha256 over raw (§1.1, §10.3, §12.1); A5 pure-ref-skip instruction DELETED, worth-it guard is the single source of truth (§4.2, §12.4); A6 v1 `frame_count=1`, multi-frame machinery deferred to D7 (§4.3); A7 JUMBO_PROMOTE gated on D3 first-copy-waste (§1.3); A3 cross-aggregate probe added to scan spec (§11.5); C1 per-value crc32 integrity tag verified before splice, G10 case added (§2.1, §2.3); C4 part.updated non-consecutive scan added (§11.4); B2 lazy per-ref value fetch, eager only for full-segment replay, admission cap (§2.1); B3 sealer COMMIT pinned to dedicated connection, shared alternative removed (§6); C2 event-ID canonical detection requires 12 LOWERCASE hex (packer spec `ideation/oses.md` §3.2); NEW-R1 semantic span guard (`JSON.parse(span)` deep-equal `parsed_event[path]`, fail-any → inline, never store); NEW-R2 span-walker pinned to UTF-8 BYTE offsets over the exact stored TEXT `Uint8Array` (+ astral-boundary golden vectors); **O1 per-event 128-bit logical digest RESERVED in the v1 format's UNCOMPRESSED index region** (has_digest flag + optional 16 B, empty until D10-gated — enables the digest-first replay-idempotency fast path, §2.1/§2.2); **LOS-3 page_size 8/16/32 KiB as a first-class born-fresh-file parameter** (D7-gated, frame ≤ page → 1-page BLOB fetch, coordinated with migration-arch, §4.4); **O5 global value table + O6 truncated sha256 key = v1.1-gated** on the D2/D3 cross-aggregate histogram + value-count scale (no v1 action, §11.5). The value-directory tag and ref-list are frame-format additions — the frozen `event_value` schema is untouched.
