# OSES — OpenCode Segmented Event Store: physical design ideation

Author: `oses-arch` (swarm `chunkdb-ideation`, openfork branch)
Base: v1.18.18 + openfork additions, commit `fc19430c2c`
Companion docs: `docs/chunkdb/architecture-research.md` (source of truth, §20/22/23/24/F/33), `docs/chunkdb/ideation/migration.md`, `docs/chunkdb/ideation/benchmark.md`

This document ideates the durable event store physical design beyond the research doc.
It is a design proposal with open questions and benchmark requirements — **not implementation
code**. Any DDL/pseudocode below is illustrative and must be validated against the real corpus
before it becomes production schema.

---

## 0. Grounding facts verified against the openfork codebase (differences from the research doc)

The research doc was written against upstream v1.18.18. The fork differs in ways that change the
OSES design materially. All of the following were verified by reading the source:

| Fact | Evidence | Consequence for OSES |
|---|---|---|
| `event` table is 5 columns, TEXT PK id, **no `time_created`**, no fork columns | `packages/core/src/event/sql.ts` | The research doc's `event_hot` DDL invents a `time_created` column that does not exist today. We can get a timestamp for free from the event-ID clock instead (see §3). |
| Indexes: `UNIQUE(aggregate_id, seq)` and `(aggregate_id, type, seq)` | same | The second index exists to serve `readAggregate`'s `type IN (...)` filter. Any design that removes rows from `event` shrinks this index; sealed history must prefilter via `type_set`. |
| The fork **already ships an OCDB frame codec + cold-row sealer** (`chunk-sealer.ts`, `json-codec.ts`): magic `OCDB`, 14-byte header (version, codec 1=zstd/2=brotli/3=deflate-raw, rawLen LE u32, CRC32 of decompressed bytes), threshold 4096, in-place `UPDATE event SET data = frame`, journal `ocdb_seal(table_name,row_id,raw_bytes,stored_bytes,time_sealed)`, partial index `idx_event_seal_candidates ON event(aggregate_id,seq) WHERE typeof(data)='text' AND length(data)>=4096` | `packages/core/src/database/json-codec.ts`, `chunk-sealer.ts` | **The research doc does not mention any of this.** The fork's real event table is already TEXT|OCDB-BLOB mixed in any DB the sealer has run against (migration-arch confirmed). OSES must treat legacy `event.data` as opaque payload and decode frames first. The OCDB envelope is the natural predecessor of the OSES frame envelope — reuse its header shape instead of inventing a second one. |
| `event_sequence(aggregate_id TEXT PK, seq, owner_id)` is the **sync-fence authority**: `fence.ts` serializes it into the sync `State = Record<aggregateID, seq>` header; `control-plane/workspace.ts` reads it for sync export and waits on it | `packages/opencode/src/server/shared/fence.ts`, `packages/opencode/src/control-plane/workspace.ts` | **The research doc's proposal to replace aggregate strings with integer surrogate keys at the hot layer breaks the sync protocol.** `event_sequence` must stay byte-identical. OSES aggregate accounting must be a *separate* extension table keyed by the same TEXT aggregate_id. |
| Publish is one `BEGIN IMMEDIATE` transaction that runs **projectors and the commit hook inside it**, then inserts the event row; replay/idempotency compares id + versioned type + `isDeepStrictEqual(data)`; event-ID uniqueness is a PK `SELECT ... WHERE id = ?` inside the txn | `packages/core/src/event.ts` `commitDurableEvent` | OSES must preserve: (a) projectors+commit hook+event insert in one txn — no sealing work may enter this txn; (b) exact idempotent-replay comparison; (c) exact global ID uniqueness. |
| `commitDurableEvent` **enforces `event.data[durable.aggregate] === aggregateID`** and every durable event in the current manifest has `durable.aggregate = "sessionID"` | `packages/core/src/event.ts` line ~219; `packages/schema/src/session-event.ts` options block; `packages/schema/src/v1/session.ts` options block | **The strongest semantic-elision rule is provable, not heuristic**: `data.sessionID === aggregate_id` is a publish-time invariant for all current durable types. See §5. |
| Event IDs: `evt_` + 12 hex + 14 base62; hex = **low 48 bits** of `Date.now()*4096 + counter` (the full value is 53-bit; the generator truncates the top 5 bits!); suffix = `bytes[i] % 62` per random byte | `packages/schema/src/identifier.ts` | Research doc's "48-bit timestamp × 4096 + counter" is right *about the stored bits* but wrong about the semantics — it's `(ts*4096+counter) mod 2^48`, not the true 48-bit value. Consequences for delta encoding: monotonicity is mod-2^48, wraparound every ~2^36 ms of continuous counter advance (~2.1 yr), delta can go negative; the suffix string is a base-62 numeral < 62^14 < 2^84, so 84 bits exact packing works. See §3. |
| `readAggregate` filters `type IN (manifest versioned-type keys)`, `seq > after`, orders by seq, `limit+1` for `hasMore` | `packages/core/src/event.ts` | `type_set` must answer "does this segment contain ANY of a requested key set" exactly. See §4. |
| Sync `history` reads **all** `event` rows across aggregates with per-aggregate `(id, seq) <= exclude` watermark exclusions, ordered by global `seq` asc; `control-plane/workspace.ts` sync export reads all events per session in batches of 10; both hit `EventTable` directly | `packages/opencode/src/server/routes/instance/httpapi/handlers/sync.ts`, `control-plane/workspace.ts` | OSES needs a storage-neutral cross-aggregate iterator that preserves the exact current ordering/watermark semantics, or these consumers break when rows move to segments. See §9. |
| SQLite access: one connection, `Semaphore(1)` serializes every query; `cache_size = -64000` (64 MiB); WAL, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`; a second maintenance connection pattern exists (`withBackfillDb`) used by FTS backfill | `packages/core/src/database/database.ts`, `sqlite.bun.ts`, `sqlite.node.ts` | Sealing must use its own connection (fork pattern already proven). No incremental BLOB I/O is exposed by either binding — metadata/BLOB separation is the way to avoid materializing payloads. |
| Real DB scale: 1.37M event rows on the fork's heavy aggregate; largest observed row ~32.8 MB | `chunk-sealer.ts` comments | The research doc's reference corpus is **50 events / 23 KB** — useless for geometry tuning. Every geometry/cache/locator number in the research doc is a hypothesis against a tiny sample. |
| Fork-adjacent idempotent DDL pattern: raw `CREATE TABLE/INDEX IF NOT EXISTS` + ad-hoc expression index (`idx_message_provider_id ON message(json_extract(data,'$.providerID'))`) run outside the shared migration stream | `chunk-sealer.ts`, `packages/core/src/session/usage.ts` | OSES tables/indexes should follow the same fork-adjacent pattern so they cannot conflict with upstream migrations (`migration/*.ts` stream is upstream-owned). |

### 0.1 What the research doc gets right (endorsed, not repeated)

- Rowid hot tail over `WITHOUT ROWID` for payload-bearing rows.
- Exact packed event IDs, escape representation for non-canonical historical IDs.
- `type_set` exact delta-varint set instead of a vague bitmap or Bloom.
- Sealing outside the write txn with a guarded commit txn; immutable-prefix append safety.
- Microframes bound point-read decompression; per-frame adaptive raw/compressed decision.
- One shared storage-cache budget (SQLite page cache + decompressed frames).
- Codec/dictionary identity as immutable format-level IDs; capability-gate Zstd.
- No cross-aggregate segments; no in-place mutation of sealed segments; archive ≠ delete.
- Shadow-store migration with epoch flip (extended by migration-arch).

### 0.2 Where this document diverges from the research doc (headlines)

1. **The hot tail is the existing `event` table, not a new `event_hot` table with integer surrogate keys.** Zero hot-path migration, sync fence untouched, fork prototype (identity writes) preserved, and the surrogate-key win is captured where it matters: *inside sealed segment metadata*, not in the hot table. (§1)
2. **Aggregate accounting is a sealer-owned extension of `event_sequence`, not a rewrite of it.** (§1)
3. **Microframe independence is real but optional** in the format (`frame_count = 1` is legal), and the starting microframe size is raised to 16–32 KiB. Point reads are rare in this workload; the fork's own experience is that replay/range reads dominate. (§2)
4. **Semantic elision ships exactly one provable rule first**: elide `data[durable.aggregate]` (currently always `sessionID`) for every durable versioned type, because the publish path enforces equality. Everything else is benchmarked empirical candidates with property tests. (§5)
5. **The event-ID registry replaces today's `event.id` TEXT PK index** — it is strictly *cheaper* than the status quo, not new cost; Tier B (fingerprint) is a later optimization. (§7)
6. **The fork's OCDB frame envelope is reused as the single-event/jumbo frame format** inside OSES segments; OSES adds the multi-event frame + container layers. The `ocdb_seal` journal is renamed/reused as the sealing journal. (§6)

---

## 1. Hot tail: keep `event`, extend around it

### 1.1 Decision

Do **not** create `event_hot`. The current `event` table is already an append-friendly rowid table
(`id TEXT PRIMARY KEY` is the rowid alias), already has the exact read indexes OSES needs
(`UNIQUE(aggregate_id,seq)`, `(aggregate_id,type,seq)`), already carries the FK cascade from
`event_sequence`, and already tolerates framed BLOB payloads (the fork sealer writes them today).
Rewriting it into `event_hot` with `aggregate_key`/`type_key` integer columns:

- breaks the `event_sequence` FK and the sync fence protocol that reads `event_sequence` directly;
- forces a hot-path migration with zero measured benefit (the hot tail is bounded by the safety tail);
- duplicates what the fork's identity-write prototype already ships.

The integer-surrogate win (repeated 30-byte session IDs, repeated versioned type strings) belongs in
**sealed segment metadata**, where 99% of history lives.

### 1.2 The hot contract (unchanged semantics, explicit)

Hot rows are authoritative and must keep satisfying:

```text
readAggregate(aggregateID, after, typeSet, limit):
  SELECT ... WHERE aggregate_id=? AND seq>? [AND type IN (...)] ORDER BY seq LIMIT limit+1
readAfter(aggregateID, after):                      -- durable() stream
  SELECT ... WHERE aggregate_id=? AND seq>? ORDER BY seq
replayCheck(aggregateID, seq):                      -- idempotency / divergence
  SELECT ... WHERE aggregate_id=? AND seq=?   -> compare id, type, deepStrictEqual(data)
idUnique(eventID):                                  -- global uniqueness inside publish txn
  SELECT ... WHERE id=?
```

`event.data` is opaque: `TEXT JSON | OCDB frame v2`. The adapter decodes via
`decompressFrame` when it sees the `OCDB` magic. (The fork's `compressedJson` customType is the
embryo of this; it is defined but not yet wired to the event table — the adapter should absorb it.)

### 1.3 New tables (fork-adjacent DDL, outside the upstream migration stream)

```sql
-- Sealer-owned aggregate accounting. 1:1 with event_sequence.aggregate_id.
-- event_sequence stays THE authority for latest_seq / owner_id (sync fence reads it).
CREATE TABLE IF NOT EXISTS event_aggregate (
  aggregate_id    TEXT PRIMARY KEY REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
  sealed_seq      INTEGER NOT NULL DEFAULT -1,   -- largest seq covered by a committed segment
  hot_count       INTEGER NOT NULL DEFAULT 0,
  hot_raw_bytes   INTEGER NOT NULL DEFAULT 0,
  last_append_ms  INTEGER NOT NULL DEFAULT 0,
  generation      INTEGER NOT NULL DEFAULT 0    -- bumped only by representation-changing ops
);

-- Sealed segment metadata (no payload). type_set prefilter without loading BLOBs.
CREATE TABLE IF NOT EXISTS event_segment (
  segment_id      INTEGER PRIMARY KEY,
  aggregate_id    TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
  first_seq       INTEGER NOT NULL,
  event_count     INTEGER NOT NULL,
  frame_count     INTEGER NOT NULL,
  raw_len         INTEGER NOT NULL,
  stored_len      INTEGER NOT NULL,
  format_version  INTEGER NOT NULL,
  codec_id        INTEGER NOT NULL,              -- segment default; frames may override
  dictionary_id   INTEGER NOT NULL DEFAULT 0,
  type_set        BLOB NOT NULL,                 -- sorted delta-varint type keys, §4
  header_crc32    INTEGER NOT NULL,
  payload_crc32   INTEGER NOT NULL,
  time_sealed     INTEGER NOT NULL,
  UNIQUE (aggregate_id, first_seq)
);
CREATE INDEX IF NOT EXISTS event_segment_aggregate_seq_idx ON event_segment(aggregate_id, first_seq);

-- Payload separation (keeps event_segment scan-cheap; leaves future room for native partial BLOB I/O).
CREATE TABLE IF NOT EXISTS event_segment_blob (
  segment_id      INTEGER PRIMARY KEY REFERENCES event_segment(segment_id) ON DELETE CASCADE,
  payload         BLOB NOT NULL
);

-- Sealing journal: reuse the fork's ocdb_seal shape, renamed + widened.
CREATE TABLE IF NOT EXISTS oses_seal (
  segment_id      INTEGER NOT NULL,
  row_id          TEXT NOT NULL,                 -- event id (packed BLOB or string) for audit
  raw_bytes       INTEGER NOT NULL,
  stored_bytes    INTEGER NOT NULL,
  time_sealed     INTEGER NOT NULL,
  PRIMARY KEY (segment_id, row_id)
);
```

Notes:

- **No `event_hot`, no `event_type` table needed at the hot layer.** Type keys are assigned
  inside the sealer (see §4); hot rows keep the versioned TEXT type exactly as today. A
  `event_type(type_key INTEGER PK, type_name TEXT UNIQUE)` table is created lazily on first seal
  (or during backfill) — it is a sealed-storage dictionary, not a hot-path dependency.
- `event_aggregate.hot_count` / `hot_raw_bytes` are maintained by the sealer. If a later benchmark
  shows the publish path wants them live (to avoid a `COUNT(*)`/`SUM` scan at seal-scheduling),
  the publish txn can maintain them — but that adds a write to the hot txn for zero read benefit
  until sealing exists. **Start: sealer-computed; publish does not touch `event_aggregate`.**
- The ID registry (§7) replaces the `event.id` PK for sealed rows only after those rows leave
  `event`. Hot rows keep the existing PK (which *is* the current global ID index).

---

## 2. Macro-segment × microframe geometry (challenging the 64 KiB / 8–16 KiB defaults)

### 2.1 What is actually known

- Reference corpus: 50 events, 23.3 KB `event.data` total ≈ **466 B/event average**. Useless for tuning.
- Fork real DB: 1.37M event rows, max row ~32.8 MB. Event sizes span ~50 B (small `session.next.*`
  steers) to MBs (tool output). The 4 KiB sealer threshold exists because most rows are small.
- SQLite page size 4096; page cache 64 MiB. A 64 KiB segment = 16 pages; a 16 KiB frame = 4 pages.

### 2.2 Challenges to the research doc numbers

1. **The 128-event/segment ceiling is not derived from anything.** Its only purpose is to bound the
   per-event index streams. Per-event index cost is ~5–10 B (frame ordinal, offset, length, flags,
   type varint). Bounding the index at ~4 KiB → 400–800 events/segment. A fixed 128 is fine as a
   conservative default but should be expressed as *an index-bytes budget*, and swept 128–512.
2. **8–16 KiB microframes over-favor a point-read rate this workload does not have.** Point reads
   are: the replay idempotency check (by `(aggregate,seq)`), the ID-uniqueness check, and (rarely)
   the durable-stream tail. Range scans dominate (`readAggregate`, `readAfter`, sync history).
   Larger frames (16–32 KiB raw) give better compression (larger LZ window, fewer resets) and fewer
   index entries. **Raise the microframe target to 16–32 KiB, ceiling 64 KiB**, and treat microframe
   independence as a *corruption-containment + cache-granularity* feature, not a latency feature.
3. **Microframes should be optional in the format.** `frame_count = 1` is a legal segment. This
   makes the geometry a runtime policy choice (swept by benchmark) rather than a format constraint,
   and lets tiny aggregates seal as one frame without paying frame-index overhead. It also makes a
   partially-built segment resumable: a segment can be extended with an additional frame *before the
   seal commit* (never after — sealed segments are immutable).
4. **The segment target should be stated in *stored* bytes, not raw.** Raw 64 KiB of JSON compresses
   to ~8–20 KiB stored; the DB row + WAL frames scale with stored bytes. Two segments with the same
   raw target but different compressibility have very different DB costs. Policy: build to a stored
   byte budget (e.g. 8–16 KiB stored) with a raw ceiling as a backstop.
5. **Jumbo handling stays as research doc** (§24.7): `raw_len > frame_ceiling` → singleton frame;
   `raw_len > segment_raw_target` → singleton segment (or stay hot as an OCDB frame — the fork
   already does in-place framing for ≥4 KiB rows, which is a *cheaper* home for jumbo rows that are
   still in the safety tail).

### 2.3 Starting geometry (hypotheses for the sweep, not constants)

```text
segment stored target:    8–16 KiB stored      (raw backstop 32–128 KiB)
microframe raw target:    16–32 KiB            (ceiling 64 KiB except jumbo)
event count ceiling:      256 (derived from index-bytes budget, sweep 128–512)
frame independence:       optional (frame_count=1 legal)
jumbo frame:             >64 KiB raw singleton frame
jumbo segment:           >128 KiB raw singleton segment (or stays hot)
frame alignment:         event-boundary only, never byte-split
```

### 2.4 Codec policy for OSES frames (from codec-arch, incorporated)

The shipped OCDB registry is **frozen and append-only** — this overrides research doc §22.2:

```text
codec 1 = zstd (dict-less baseline)
codec 2 = brotli (q1 default; q4 optional)
codec 3 = raw-deflate (interoperable-only compat; NOT byte-stable across runtimes)
```

Consequences for OSES frames and segments:

- **Byte-stability tiers** (measured Bun 1.3.14 vs Node v22.23.2 by codec-arch): brotli q1/q4 and
  dict-less zstd are byte-identical across runtimes; deflate is not. Golden-vector policy is
  two-tier: byte-equality fixtures only for brotli/zstd-dict-less; logical-equality for deflate.
- **OSES segment/frame default codec = brotli q1** (fork's shipped default, byte-stable). zstd at
  higher levels is a sweep candidate; deflate only when the runtime intersection forces it.
- **Dictionaries**: trained zstd dictionaries are **gated** (broken both ways on Bun 1.3.14 —
  silently ignored on compress, Node-written dict frames undecodable even with dict). The only
  cross-runtime-safe dictionary today is a **structural deflate dictionary** (schema-only, zero
  privacy). OSES's dictionary dimension is therefore `{none, structural deflate dict}` in v1; the
  trained-dictionary experiment is gated behind the capability probe.
- **Capability probe at startup**: writers emit only the *intersection* of all shipped runtimes'
  codecs. `dictionary_id` stays in the frame header; unknown `dictionary_id` = hard decode error
  (never "retry without dict").
- **CRC32**: over decompressed bytes, LE u32, via `node:zlib.crc32` (native, matches the fork's
  hand-rolled result). Reuse the OCDB 14-byte envelope for single-event/jumbo frames; OSES adds the
  multi-event frame header (codec_id, dictionary_id, raw_len, stored_len, crc) and the container
  layer on top.

### 2.5 Is microframe independence worth it? — direct answer

**Yes, but for the right reasons.** It is worth it for (a) corruption containment — one damaged
frame does not take down a 64 KiB segment's worth of history and diagnostics can name
`aggregate/segment/frame/ordinal`; (b) cache granularity — a replay that only touches the tail of a
segment does not evict the whole segment's worth of frames; (c) resumability during seal *build*
(before commit). It is **not** worth much for point-read latency, because point reads are rare and
even a 64 KiB decompression is ~1 ms on desktop hardware. The benchmark must separate these: measure
point-read p99 *and* frame-damage blast radius *and* cache hit rate under a range-scan workload.

---

## 3. Event-ID packing (verified against `packages/schema/src/identifier.ts`)

### 3.1 What the generator actually does

```ts
current = BigInt(timestamp) * 0x1000n + BigInt(counter)   // ts=Date.now(), counter 1..4095
value   = descending ? ~current : current
time    = 12 hex chars of (value >> (40 - 8*i)) & 0xff for i in 0..5   // LOW 48 bits, BE
suffix  = 14 chars of chars[bytes[i] % 62] over 14 crypto.random bytes
```

Verified facts:

- The hex field is the **low 48 bits** of `ts*4096 + counter`. The full value is ~53 bits today
  (ts ≈ 2^40.8 → value ≈ 2^52.7), so the top ~5 bits are **silently truncated by the generator**.
  The hex is therefore `(ts*4096 + counter) mod 2^48`, not a true 48-bit timestamp. The research
  doc's phrasing "48-bit timestamp × 4096 + counter" is accurate about the stored bits only.
- `descending()` (bitwise-complement) exists but EventV2 uses `ascending()` (`create: () =>
  schema.make("evt_" + ascending())` in `packages/schema/src/event.ts`), so IDs are monotone in the
  low-48-bit value while no wraparound occurs. **The packer must treat the hex field as opaque
  bits** — a historical ID created with `descending()` is bitwise-NOTed and delta encoding against
  it must not assume plain timestamp semantics (zigzag + escape covers it; the decoder round-trips
  the exact bits, never interprets them).
- The suffix is `bytes[i] % 62` — a lossy modulo map of random bytes, NOT a canonical base-62
  encoding of a uniform 84-bit value. That is irrelevant for packing: we pack the *string* as a
  base-62 numeral. Any 14-char string over the 62-symbol alphabet is an integer in `[0, 62^14)`,
  and `62^14 < 2^84`, so 84 bits stores it exactly, leading zeros included.

### 3.2 Packed representation (concrete)

```text
first event in segment:
  clock0:  u48 BE = parseHex(id[0..12])               // 6 bytes
  suffix0: u84 LE = base62Decode14(id[12..26])        // 10.5 bytes -> 11 bytes
  -> 17 bytes

subsequent event i:
  delta:   uvarint(clock_i - clock_{i-1})             // 1–5 bytes
  suffix:  u84 LE                                     // 11 bytes
  -> 12–16 bytes

non-canonical / wraparound escape:
  flag byte 0x00 followed by exact UTF-8 bytes of the full ID string
  (or: signed-delta form for negative deltas — see below)
```

Decoder must reproduce the exact 26-char body: format the u48 back to exactly 12 lowercase hex,
and the u84 back to exactly 14 base-62 symbols with **leading-zero preservation** (a suffix whose
first symbols are `0` must not lose them). Canonical detection (adversarial C2, accepted): `evt_`
prefix, body length 26, `[0..12]` **all LOWERCASE hex** (a..f only — uppercase hex is NOT
canonical), `[12..26]` ∈ base62 alphabet. **Anything else — uppercase hex, wrong length,
non-base62 suffix — takes the escape path** (exact UTF-8 bytes, byte-exact round-trip); a
non-canonical-but-valid ID must never be silently lowercased/rewritten. Golden vectors must
include an uppercase-hex ID proving it escapes (and round-trips byte-for-byte) rather than being
re-emitted in lowercase. This is the research doc's F.5 with three corrections: (a) the clock is
mod-2^48 so deltas can wrap negative; (b) the generator's truncation means two IDs created >2^48
clock-units apart (≈2.1 yr of continuous advance, or across a 2^48 wraparound) have *small* delta
in the raw values but a huge/negative delta in the stored hex — the escape form must handle it
deterministically; (c) canonical hex is strictly lowercase (C2).

**Delta-encoding recommendation:** encode `delta = clock_i - clock_{i-1}` as a **zigzag uvarint**
(signed) instead of the research doc's "positive/nonnegative with separate escape". Zigzag is one
bit of overhead on the common positive case, and makes negative (wraparound) deltas first-class
with no separate escape path. A per-segment flag selects zigzag vs unsigned if the sweep shows a
byte difference worth it; default zigzag.

### 3.3 Cost model

- Typical burst (events in the same ms): delta = counter delta, 1 byte → **12 B/event**.
- Burst across a few seconds: delta ≈ dt·4096 ≈ 4k–200k → 2–3 bytes → **13–14 B/event**.
- Sparse (events minutes apart): delta ≈ 1e6–1e8 → 3–5 bytes → **14–16 B/event**.
- First event of a segment: 17 B.
- vs 30 ASCII bytes today → **~2.1–2.5×** on the ID stream alone, and the ID is the *only* field
  with per-event global-uniqueness indexing, so this is the stream the locator index shares.

### 3.4 Open question

Should the suffix be compressed further (e.g. store 84 bits but allow the *string* to be
reconstructed from a shorter canonical form)? No — the string is the API surface; byte-exactness is
a hard requirement and 84 bits is already within 1 byte of the 82-bit information bound. Stop here.

---

## 4. `type_set` and the readAggregate type filter

### 4.1 What the filter actually is

`readAggregate` runs `WHERE ... AND type IN (<versioned manifest keys>)` where the keys are the
*current* `durable` manifest keys (e.g. `session.updated.1`, `session.next.tool.called.1`). The
`(aggregate_id, type, seq)` index serves this on the hot table. The `durable()` stream
(`readAfter`) has **no type filter** — it reads everything above `after`.

So OSES needs two prefilter capabilities:

1. **Type-filtered**: skip sealed segments whose `type_set` has no requested key — *before* loading
   the payload BLOB. (This is the point of the metadata/BLOB split.)
2. **Unfiltered**: `readAfter` cannot skip any segment.

### 4.2 Encoding

`type_set` = sorted unique type keys, first absolute, then deltas, all uvarint (research doc F.6,
endorsed). One addition: cache the *decoded* set with the segment metadata in memory keyed by
`segment_id` — it is tiny (< 40 B for realistic type cardinality) and the read path touches it on
every type-filtered call.

Per-event type stream inside the container: because adjacent events in a segment frequently share a
type (tool.progress bursts, step/text lifecycle), the per-event encoding should be **RLE of type
key ordinals** (run length + key) as the default, falling back to per-event uvarint keys when RLE
loses. The frame index then carries the type run boundaries. This makes `type_set` construction
nearly free at seal time (the runs ARE the set).

### 4.3 Mapping to the filter

```text
requested keys (versioned strings) -> requested type keys (via event_type dict)
per segment: type_set ∩ requested != ∅ ? load payload : skip
within segment: binary-search the type stream for the first event of each requested key
  >= first requested ordinal, then decode only frames containing requested events
```

Correctness constraint: `type_set` must be *exact* (no false negatives — a segment that contains a
requested type must never be skipped). Bloom filters are rejected for exactly this reason
(false-negative risk at segment granularity violates read semantics); the research doc's exact-set
stance is right, and RLE makes exact sets cheap.

---

## 5. Semantic elision manifest (grounded in real types + the projector)

### 5.1 The one rule that is provable today

`commitDurableEvent` **dies** if `event.data[definition.durable.aggregate] !== aggregateID`
(`packages/core/src/event.ts`). Every durable event in the current manifest — all of
`SessionV1.Event.*` (Created/Updated/Deleted/MessageUpdated/MessageRemoved/PartUpdated/PartRemoved,
`durable.aggregate = "sessionID"`) and all of `SessionEvent.DurableDefinitions` (`session.next.*`,
`durable.aggregate = "sessionID"`) — carries `data.sessionID === envelope aggregate_id`.

Therefore:

```ts
// Derived at build time from the durable-event-manifest, not hand-maintained.
// Rule: for every versionedType whose definition.durable.aggregate = "sessionID",
// elide data["sessionID"] and rehydrate from the envelope aggregate_id.
```

This is *not* a field-name heuristic. It is an invariant enforced by the publish path, and the rule
is versioned per `(versionedType, physicalFormatVersion)`. If a future event version changes its
aggregate field name, the manifest entry changes and old segments decode with their recorded rule
generation. **Ship this rule for all current durable types.** It removes the single most repeated
per-aggregate string from every sealed payload, at zero semantic risk.

### 5.2 Why this matters more than the research doc says

The research doc treats elision as one option among several for recovering structural redundancy.
The sharper argument: **a shared/trained dictionary cannot contain per-aggregate IDs.** Session IDs
are user data (privacy — no release dictionary may embed them) and cardinality is unbounded (a
trained dictionary is frozen at build time). codec-arch's measurement strengthens this: trained
zstd dictionaries are **broken cross-runtime on Bun today**, so the ship-first dictionary is a
*structural* deflate dictionary (schema keys only) — which by construction cannot contain any
session ID. So the sessionID — 30 bytes repeated in *every* event of an aggregate — is exactly the
string that (a) the compressor re-emits at every frame boundary (frames reset LZ state), (b) no
shared dictionary can help with, and (c) no structural dictionary will ever cover. Elision is the
*only* mechanism that removes it from the sealed representation. This makes elision a first-class
pillar of the format, not a nice-to-have.

### 5.3 Empirical candidates (benchmark, then decide — never elide on "usually equal")

Ground-truth payload shapes (from the projector + schemas):

| versionedType | payload field | derivable from envelope? | verdict |
|---|---|---|---|
| all durable types | `sessionID` | **yes — publish-enforced invariant** | **elide now** |
| `session.created.1` / `session.updated.1` | `info.id` | schema does **not** prove `info.id === sessionID` (projector stores `info.id` as the session row id, but the event source is not constrained to equal the envelope) | empirical candidate — measure equality rate on corpus; only with property tests |
| `session.next.*.1` | `timestamp` | event-ID clock gives `floor(clock/4096)` ≈ creation ms, but payload `timestamp` is set by the caller — not enforced | do NOT elide; the ID clock is already a free approximate timestamp |
| `message.updated.1` | `info.sessionID` | yes (invariant) — note the projector already strips it into `message.data` | elide via the generic rule (field path `info.sessionID`) |
| `message.updated.1` | `info.id` | `msg_*` id not in envelope | keep |
| `part.updated.1` | `part.sessionID` | yes (invariant) | elide (path `part.sessionID`) |
| `part.updated.1` | `part.messageID`, `part.id` | not in envelope | keep |

The generic rule needs a *path*, not just a field: the manifest entry is
`versionedType -> [path...]` where `path = [durable.aggregate field name]` for the flat types
(`["sessionID"]`), `["info","sessionID"]` for `message.updated`, `["part","sessionID"]` for
`part.updated`. All derivable from the manifest + schema at codegen.

### 5.4 Encode/decode contract

```text
encode: for each rule(versionedType, physicalVersion):
          actual = readPath(data); expected = envelope.aggregate_id
          if deepEqual(actual, expected): mark elided bit in the event flags stream, delete path
          else: keep the value AND set the no-elision bit (must round-trip byte-identically)
decode: rehydrate elided paths from the envelope BEFORE schema decoding
```

The elided/not-elided decision is per-event and recorded in the per-event flags — a segment built
from mixed-version events must decode each event with its own rule generation. Failure to validate a
rule → preserve the field (never corrupt). All research-doc §20.9 validation requirements (golden
vectors, property tests over missing/null/wrong-typed values, old/new fixtures, intentional
mismatch cases, cross-runtime byte identity) apply.

### 5.5 What about the projector's duplicated strings?

The projector writes `message.data` / `part.data` with sessionID/msg/part ids stripped
(`messageData`/`partData` strip `id, sessionID, messageID` — `projector.ts`). The durable event
still carries them; the projection rows do not. So the search_text/FTS duplication is a *projection*
concern (OPCL lane), not OSES. OSES elision only affects the durable event payload.

---

## 6. Sealing state machine (append-safe immutable-prefix conversion)

### 6.1 Sealer = the fork's ChunkSealer, generalized

The fork already implements 70% of the sealer skeleton. OSES reuses:

- **Frontier rule** (proven on the real DB): `seq <= event_sequence.seq AND owner_id IS NULL`
  (settled = committed and not claimed by a sync owner). Keep as the eligibility gate.
- **Cooling**: the fork uses `session.time_updated <= now - 48h` because `event` has no timestamp.
  OSES can additionally use the event-ID clock (`floor(clock/4096)`) as a free per-event timestamp
  — candidate for the cooling predicate; benchmark against `session.time_updated` (which is a
  *projection* timestamp, updated by any session write, not just durable events).
- **Second-connection pattern**: sealing runs on `withBackfillDb(filename)`-style own connection so
  it never contends with the live semaphore-serialized client. Proven by the FTS backfill.
- **Per-batch txn + yield between batches** to keep interactive reads interleaved.
- **Journal**: rename `ocdb_seal` semantics into `oses_seal` (§1.3) — same
  raw_bytes/stored_bytes accounting, keyed by segment.

### 6.2 State machine (research doc F.10, made concrete for this codebase)

```text
IDLE
  -> SCHEDULED   watermark/idle trigger (see 6.3)
SCHEDULED
  -> BUILDING    global compression slot acquired (own connection, outside any write txn)
BUILDING
  -> READY       segment + blob + locators encoded; candidate prefix [sealed_seq+1 .. cutoff_seq]
  -> IDLE        no net-positive candidate (small aggregates stay hot — bounded)
READY
  -> COMMITTING  BEGIN IMMEDIATE on the shared connection (or own connection w/ busy retry)
COMMITTING
  -> IDLE        success
  -> BACKOFF     generation conflict / SQLITE_BUSY / overlap discovered -> re-read, retry
```

### 6.3 Commit transaction (the append-safe part)

```sql
BEGIN IMMEDIATE;
-- 1. re-read event_aggregate for aggregate_id: sealed_seq, generation (FOR the candidate range)
-- 2. verify candidate prefix still contiguous and unclaimed:
--      SELECT count(*) FROM event WHERE aggregate_id=? AND seq BETWEEN sealed_seq+1 AND cutoff_seq
--      AND (no segment row already covers any of first_seq..cutoff_seq)
--      AND event_sequence.owner_id IS NULL (still settled)
-- 3. INSERT event_segment (metadata incl. type_set, crcs)
-- 4. INSERT event_segment_blob
-- 5. INSERT event_id_registry rows for the sealed events
-- 6. INSERT oses_seal journal rows
-- 7. DELETE FROM event WHERE aggregate_id=? AND seq BETWEEN sealed_seq+1 AND cutoff_seq
-- 8. UPDATE event_aggregate SET sealed_seq=cutoff_seq, hot_count-=N, hot_raw_bytes-=rawBytes
COMMIT;
```

Ordinary appends above `cutoff_seq` do **not** invalidate the candidate (they never touch the
prefix). The `UNIQUE(aggregate_id, seq)` index on `event` is the natural overlap guard: if another
sealer (or a migration) already removed the range, the DELETE matches 0 rows and the commit must
abort via a count check. `generation` bumps only for representation-changing operations
(migration/rebuild/epoch flip), so a competing sealer or a migration bumps it and the COMMITTING
step re-reads it.

Crash semantics (unchanged from research doc, restated for the fork): crash during BUILDING → no DB
mutation, hot rows authoritative; crash before COMMIT → rollback, hot prefix authoritative; crash
after COMMIT → segment authoritative and the hot prefix is gone atomically. Exactly one of {hot
prefix, segment} covers any seq at any time — the invariant `event_aggregate.sealed_seq` +
`event` rows above it + `event_segment` rows below it is the correctness statement.

### 6.4 Triggers

```text
primary:  hot_raw_bytes >= 128 KiB / aggregate        (sealer-computed, §1.3)
guard:    hot_count >= 256                             (tiny-event bursts)
idle:     last_append_ms older than IDLE_SEAL_DELAY    (30 s start) and hot_count > 0
sweep:    startup maintenance pass for legacy hot history beyond bounds
safety tail: keep newest ~8–32 events or ~16–32 KiB hot, whichever larger (per aggregate,
             while the aggregate is active); a low-volume aggregate may simply stay hot
```

### 6.5 Concurrency and multi-process

Desktop Node and Bun CLI can legitimately write the same DB (WAL). The sealer must treat
`SQLITE_BUSY` (busy_timeout is 5000 ms on the main connection) as BACKOFF, and must not hold the
write txn open while compressing. Global sealing concurrency starts at 1; the fork's
`chunkdb-seal-parallel.ts` / `chunkdb-seal-worker.ts` bench files already explore worker dispatch
(benchmark-arch's harness note) — worker *strategy* is runtime policy, never part of the on-disk
format.

---

## 7. Event-ID locator: Tier A vs Tier B (pinned for benchmark-arch)

### 7.1 Reframe: the current schema already pays a global ID index

`event.id TEXT PRIMARY KEY` is a full B-tree index over 26-byte keys for **all** events today. OSES
does not add index cost; it *replaces* the existing index with a cheaper one. The correct
comparison baseline is "today's event.id PK index", not "no index".

### 7.2 Tier A — exact packed registry (recommended default)

```sql
CREATE TABLE IF NOT EXISTS event_id_registry (
  event_id     BLOB PRIMARY KEY,     -- packed exact ID (§3), ~12–17 B
  storage_kind INTEGER NOT NULL,     -- 0 = hot (event row), 1 = segment
  storage_id   INTEGER NOT NULL,     -- event rowid (hot) or segment_id (sealed)
  ordinal      INTEGER NOT NULL,     -- event ordinal within segment; 0 for hot
  UNIQUE (storage_kind, storage_id, ordinal)
);
```

- Global uniqueness = registry PK, enforced inside the same publish/seal txns as today's PK check.
- ~2.1–2.5× smaller keys than today's TEXT index; one row per event; grows monotonically; shrinks
  only on aggregate delete (cascade).
- Authoritative exact bytes live in the *source* (hot `event` row / segment ID stream); the
  registry is derived but must never diverge (maintained in the same txn as the source write).

### 7.3 Tier B — fingerprint locator + exact verify (later optimization)

```sql
-- same table, event_id column = 8-byte (or 16-byte) keyed fingerprint
```

- Lookup: fingerprint(requested ID) → candidate rows → for each candidate, **re-derive the exact
  packed ID from the source** (segment ID stream / hot row) → byte-compare → only then
  match/duplicate.
- Safety: collision can create extra work, never a false match — the verify path is mandatory and
  uses the packed stream as the exact-verify source (§0.2/3, answer to benchmark-arch).
- Birthday math: at 1M events, 64-bit fingerprint → expected collision *candidates* ≈
  n²/2^65 ≈ 2.7e-8 (essentially zero); at 1e9 events ≈ 2.7%. 128-bit removes even the
  adversarial case. Use a **keyed** fingerprint (key stored with the DB) if imported event IDs are
  in the threat model.
- The benchmark's three scales (~1k/100k/1M) should measure: registry bytes (`dbstat`), candidate
  verify-hit rate, point-lookup p50/p99, replay-insert latency. If 100k/1M verify-hit rate is 0 and
  registry bytes drop ≥2×, Tier B wins; otherwise ship Tier A. **Tier A is the v1 format decision;
  the registry table shape supports both so Tier B is a column-type change, not a schema change.**

### 7.4 Answer to benchmark-arch's open Q (stream vs registry cost split)

"Can the sealed-history registry be lazy/derived, since the packed-ID stream is authoritative?"

- **The authoritative bytes are always the streams** (hot `event` row / segment ID stream). The
  registry is a derived accelerator and *could* be rebuilt by scanning segments — a rebuild tool
  doubles as a corruption/integrity check (re-derive every packed ID from the streams, compare to
  the registry). Record that rebuild path in the bench's cost model; it is cheap and gives free
  verification.
- **But the uniqueness check must stay O(1)-ish on publish**: `publish` does
  `SELECT WHERE id = ?` inside the txn to reject ID reuse across *different* aggregates (sync
  replay protection). A lazy registry would turn the first lookup into a full history scan —
  unacceptable. So the registry is **maintained eagerly in the seal txn** (one bulk INSERT of
  packed IDs per seal, cheap relative to segment build/compression) and covers both hot and sealed.
- Bench should record the **split**: packed-ID bytes in segment streams vs registry rows. That
  number decides whether a future format version can drop the registry for sealed events (e.g. if
  replay-insert latency with a *bloom-cached* stream probe is within gate, and the registry bytes
  dominate). v1 keeps the registry.

---

## 8. Cache policy

- **One budget** (research doc, endorsed): SQLite page cache (today −64000 ≈ 64 MiB) + OSES
  decompressed-frame cache ≤ storage budget. Start OSES cache at 8–16 MiB and *reduce* the SQLite
  cache only if measurements show benefit — do not add 16 MiB on top.
- **Cache bytes/frames, not parsed objects.** JSON.parse cost dominates reads
  (`readAggregate` decodes every event); parsed-object caching buys little and adds GC pressure.
- **Scan-resistant admission** (2Q/SLRU-style): a long replay or sync history scan must not evict
  interactive hot rows. The safety tail (§6.4) exists partly so interactive reads hit hot rows in
  the *SQLite* page cache, not the OSES frame cache.
- **Key**: `(segment_id, frame_ordinal, format_version, dictionary_id)`. Value: decompressed frame
  bytes + the tiny validated frame index.
- **WAL**: no explicit FULL/RESTART checkpoints on interactive paths (research doc). Reuse the
  fork's measured PASSIVE auto-checkpoint behavior (1000 pages default); benchmark whether sealing
  bursts justify a larger threshold or idle-scheduled PASSIVE checkpoints. The fork's
  `wal_autocheckpoint` behavior with multi-MB segment commits is a *required* measurement — a
  single seal commit can add hundreds of WAL frames.
- **Sealing CPU**: compression runs on the sealer's own connection and yields between batches
  (fork pattern); worker dispatch is runtime policy (§6.5). The bench harness note
  (cold-cache only deterministic on Linux drop_caches; Windows cold-approx) is accepted.

---

## 9. Storage-neutral adapter: how EventV2 maps onto OSES

### 9.1 The API that must be preserved (from `packages/core/src/event.ts`)

| API | Storage shape today | Adapter requirement |
|---|---|---|
| `publish(def, data, opts)` | one txn: seq read → replay check → id-uniqueness → projectors → commit hook → upsert `event_sequence` → insert `event` | **unchanged write path while `storage_epoch=legacy`**; post-cutover the insert becomes "insert hot row (or hand to segment builder on idle path)". Projectors + commit hook stay INSIDE the txn. |
| `readAggregate(id, after, limit, manifest)` | `event` SELECT with type IN, order seq, limit+1 | merge hot rows + sealed segments; type prefilter via `type_set`; exact `hasMore`; decode elision + OCDB frames |
| `durable(id, after)` stream | `readAfter` SELECT | same merge, no type filter |
| `latestSequence(id)` | `event_sequence` SELECT | unchanged (sync fence — **never** moved) |
| `replay(event, opts)` / `replayAll` | seq-range checks + idempotency compare | replay against hot OR sealed (adapter reads the event at `(aggregate, seq)` from whichever side owns it); `strictOwner`/owner semantics unchanged |
| `claim(id, owner)` | `event_sequence` UPDATE | unchanged |
| `remove(id)` | delete `event_sequence` (cascade) + `event` | cascade must ALSO cover `event_segment`, `event_segment_blob`, `event_id_registry`, `event_aggregate`, `oses_seal` (FK cascade chain) |
| `all()` / `listen` | pubsub only | unaffected (in-memory) |
| sync `history` / workspace export | direct `EventTable` reads (2 call sites) | new adapter iterator `history(afterByAggregate?)` preserving exact watermark + global-seq ordering semantics; golden-tested against legacy |

### 9.2 Adapter shape

```ts
// packages/core/src/event/store.ts (illustrative interface — no implementation here)
export interface EventStore {
  // write side (called INSIDE the publish txn — projectors already ran)
  readonly insertHot: (row: { id: ID; aggregateID: string; seq: number; type: string; data: unknown }) => Effect.Effect<void>
  // E3 needs the existing row's location, not a boolean: event.ts throws
  // "Event <id> already exists at aggregate <aggregateID> sequence <seq>".
  readonly uniqueID: (id: ID) => Effect.Effect<{ aggregateID: string; seq: number } | undefined>
  readonly readAt: (aggregateID: string, seq: number) => Effect.Effect<StoredRow | undefined>  // replay check
  // read side (storage-neutral merge)
  readonly readRange: (input: { aggregateID: string; after: number; types?: string[]; limit: number }) => Effect.Effect<{ rows: StoredRow[]; hasMore: boolean }>
  readonly history: (exclude?: Array<[string, number]>) => Effect.Effect<StoredRow[]>
  // lifecycle
  readonly removeAggregate: (aggregateID: string) => Effect.Effect<void>
}
```

- The adapter decides hot vs sealed per query: `seq > event_aggregate.sealed_seq` → hot `event`;
  else → greatest `event_segment.first_seq <= seq` → decode frames. For range reads it plans across
  both regions and merges by seq.
- `StoredRow` is the logical `{ id, aggregateID, seq, type, data }` after frame decode + elision
  rehydration. `event.ts` then runs the existing `decodeSerializedEvent` / manifest schema decode.
- **Layering**: `EventStore` depends on `Database`; `EventV2` depends on `EventStore` (write side
  stays in the same layer/txn as today). Sync handlers migrate from `EventTable` to
  `EventStore.history`. Tests keep a `storage_epoch=legacy` path so existing `EventTable`-based
  tests remain valid during staging (differential harness, research doc §31.2).

### 9.3 What breaks (call these out explicitly)

1. **`sync/history` + `workspace.ts` sync export** read `EventTable` directly — they silently lose
   sealed rows unless migrated to the adapter iterator. Migration gate for cutover.
2. **`ocdb_seal` / `chunk-sealer`** — the fork sealer's eligibility SELECT reads `event.data` with
   `typeof(data)='text'`; it must be **gated off before Stage B shadow backfill arms** (§9.4 — not
   at the Stage C flip), after which its journal is frozen and becomes reclaim inventory
   (migration-arch's Stage E). The partial index `idx_event_seal_candidates` shrinks as OSES
   sealing deletes rows; harmless but reclaimable. Note (contract-arch): `ocdb_seal` is not just a
   delete list — it is the **reverse-export decode manifest** (which rows hold framed data and
   their raw/stored byte counts), so it must be an *input* to the rollback/reverse-export path
   before it is reclaimed.
3. **Tests** that `select().from(EventTable)` (event.test.ts, session-*.test.ts) must either run in
   legacy epoch or be rewritten against the adapter. Keep the legacy path until the differential
   suite passes (research doc §31.2).
4. **`event_sequence` must never change** (fence + workspace sync read it raw). Any design that
   replaces it breaks control-plane sync — this is the strongest structural constraint.
5. **`event` rows leaving the table shrink `(aggregate_id, type, seq)` and the PK index** — all
   query plans that touch `event` change shape; benchmark readAggregate/readAfter before/after on a
   partially sealed DB.

### 9.4 Sync-history append-ordinal (answer to contract-arch)

Contract (contract-arch verified): `/sync/history` orders by `(seq ASC, global_append_ordinal ASC)`,
where the ordinal today is the `event` table's hidden `rowid` (global insert order; `id` is a TEXT
PK so it is not the rowid alias). When a row is sealed it leaves `event` and its rowid is lost —
OSES must carry the ordinal into the segment or the sealed+hot merge cannot reproduce the contract.

**Recommendation: per-segment base + per-event positive uvarint deltas.**

- The sealer captures `rowid` for every sealed event at read time (cheap — the eligibility SELECT
  reads the row anyway). Store `base_rowid` (u64) in the segment fixed header and
  `uvarint(rowid_i - rowid_{i-1})` per event (deltas are always ≥ 1 because inserts per aggregate
  are strictly append-ordered; cross-aggregate interleaving only makes gaps larger, never negative).
- Cost: ~2–5 B/event. Within an aggregate, rowid gaps are bounded by the aggregate's own activity
  between two of its events — typically 1–100 rows, i.e. 1–2 bytes. A per-event full u64 (8 B × 256
  events = 2 KiB/segment index) is rejected; a new write-path `append_ordinal` column is deferred
  (hot-write-path change) and only if corpus deltas prove large.
- **The frame index must expose per-event ordinals to the iterator, not just the segment base**
  (contract-arch retention): a `(seq, ordinal)` tie can be between a *sealed* event of one
  aggregate and a *hot* row of another aggregate. The delta stream is the source — the iterator
  decodes `base_rowid + Σ deltas` per event and materializes it into the merge, so per-event
  ordinals survive to the k-way merge. The per-event frame-index entries therefore carry the
  cumulative ordinal delta (or the index exposes a per-event ordinal column), never merely the
  segment base.
- The merge then reproduces the contract exactly: read hot rows in rowid order and sealed events in
  carried-ordinal order, k-way merge on `(seq, ordinal)`, apply the per-aggregate `(id, seq) <=`
  exclusion watermarks, preserve `limit` semantics.
- Integrity side-benefit: carried ordinals give the sealer/reader a free check that a segment's
  events really came from the expected physical positions.
- **Fork-sealer race** (contract-arch Q, reconciled with migration-arch/opcl-arch): the retired
  `chunk-sealer` must be **gated off before Stage B shadow backfill arms** — not at the Stage C
  flip. `ocdb_seal` is then FROZEN from Stage B shadow-arm and serves as the complete
  reverse-export decode manifest (every row it lists is still a hot, framed row at flip time —
  nothing was sealed away from under the journal). This gives the backfill a quiescent
  representation: legacy rows stay in the representation the backfill read (no TEXT→frame churn
  mid-verification), Stage C catch-up sees only new TEXT appends, and post-flip the OSES sealer is
  the only frame producer AND the only row remover. The OSES sealer still decodes OCDB frames when
  it touches rows framed *before* Stage B. `generation` + `UNIQUE(aggregate_id, first_seq)` remain
  the overlap guards for multi-process OSES sealers after the flip.

---

## 10. Open questions (for the swarm)

1. **Does microframe independence survive the real-corpus benchmark?** The format allows
   `frame_count = 1`; if the geometry sweep shows single-frame segments at 16–32 KiB stored win on
   both ratio and p99 (because point reads are rare), the format feature stays but the *policy*
   default becomes "one frame per segment". Blast-radius and cache-granularity arguments must be
   quantified before spending format complexity on multi-frame logic.
2. **Can the sealing frontier use the event-ID clock instead of `session.time_updated` for
   cooling?** The ID clock is per-event and free; `session.time_updated` is a projection timestamp
   updated by any session write. If the ID clock correlates with durability (it does — IDs are
   created at publish), it is the more precise predicate. Needs a corpus correlation check.
3. **Where exactly do `location` and `metadata` go?** Today they are dropped at the DB layer (the
   `event` row stores only id/aggregate/seq/type/data). OSES can keep dropping them — but if sync
   or future consumers need them, the physical format must decide now (they are not in any current
   read path; keep dropping them, note in format doc).
4. **Sync `history` ordering across sealed+hot.** The current query orders by global `seq` with
   per-aggregate exclusions. With sealed history, the adapter must produce the same deterministic
   order. Is "order by (aggregate_id, seq) as stored per side, merged by seq, tie-break by
   aggregate_id insertion order" acceptable, or must the legacy behavior be reproduced exactly?
   (Recommend: reproduce exactly; golden tests.)
5. **Multi-process sealer**: two OSES-capable processes (Node desktop + Bun CLI) both run sealers.
   `UNIQUE(aggregate_id, first_seq)` + generation guard make overlapping segments impossible, but
   wasted BUILDING work on contention is real. Acceptable at concurrency 1? (Recommend: yes, with
   BACKOFF; revisit only if measured.)

---

## 11. Alternatives considered (and why rejected)

| Alternative | Verdict |
|---|---|
| Research doc's `event_hot` rewrite with integer surrogate keys | **Rejected for v1** — breaks `event_sequence` FK + sync fence, adds hot-path migration with no measured benefit; surrogate keys live inside segments instead |
| Keep only per-row OCDB framing (fork's current prototype) as the final design | **Rejected as final** — captures zero cross-event redundancy (sessionID per frame, JSON key repetition), keeps full per-row B-tree/index overhead; it is the correct *first step* and the payload codec *inside* OSES, not the destination |
| One compressor frame per whole aggregate | **Rejected** (research doc §33.2) — blast radius + no resumability + poor cache granularity |
| 4–8 event microchunks as the final unit | **Rejected** (research doc §33.3) — retains too much per-row overhead |
| `WITHOUT ROWID` hot table | **Rejected** (research doc §33.4) — large payloads |
| Content-defined chunking | **Rejected** (research doc §33.7) — seq+byte-bounded frames give deterministic locality |
| Tier B fingerprint as v1 | **Rejected for v1** — Tier A replaces today's TEXT PK at 2.1–2.5× smaller; Tier B is a column-type change away |
| Semantic elision for `info.id` / `timestamp` in v1 | **Rejected for v1** — not provable from schema; empirical candidates only, behind property tests |
| Storing `time_created` in hot rows | **Rejected** — event-ID clock is a free timestamp; no schema change |

---

## 12. What must be benchmarked (coordination with benchmark-arch)

Prioritized against the fork's 1.37M-row corpus (never the 50-event reference):

1. **Geometry sweep** (benchmark-arch's two-stage protocol): segment stored targets {8, 16, 32} KiB
   × frame raw targets {8, 16, 32, 64} KiB × codec {brotli q1, zstd dict-less l1/l9, deflate-raw
   (interop only)} × dictionary {none, structural deflate dict}. Trained zstd dict is a *gated*
   experiment (codec-arch: broken on Bun both ways) — probe-gated, never a ship-first dimension.
   Metrics: stored bytes, seal CPU, replay p95/p99, point-read p99, cache hit rate under range
   scans, frame-damage blast radius (fuzz). Golden vectors: byte-equality only for
   brotli/zstd-dict-less; logical-equality for deflate.
2. **Elision delta**: with vs without `sessionID` elision — ratio, encode/decode p99, and
   especially *first-frame* size (dictionary priming). Expect the gap to widen as frame count grows.
3. **ID packing**: bytes/event by delta distribution (per-ms bursts vs sparse sessions), registry
   `dbstat` footprint at ~1k/100k/1M, verify-hit rate for Tier B, replay-insert latency.
4. **Seal throughput + WAL**: rows/s on the heavy aggregate, WAL bytes per seal commit, checkpoint
   p99 interference with live writes (desktop hardware), SQLITE_BUSY rate with a second writer.
5. **Hot-tail bound**: safety-tail size vs page-cache hit rate for interactive reads
   (durable-stream tail). Tail {8, 16, 32} events × {16, 32} KiB.
6. **Epoch-cutover differential**: readAggregate/readAfter/durable-stream/replay parity between
   legacy `event` and OSES on a partially sealed DB (the adapter merge is the riskiest code).
7. **OCDB-frame decode in the backfill path**: decompressFrame throughput on a corpus of framed
   rows — this is a hard prerequisite for migration, not an optimization.

---

## 13. Headline decisions (for the coordinator)

1. **Hot tail = the existing `event` table**; no `event_hot`, no integer surrogate keys at the hot
   layer. `event_sequence` is the sync fence and stays byte-identical. Surrogate keys + type keys
   live only inside sealed segment metadata. (§1)
2. **Elide `data[sessionID]` for every durable type now** — it is a publish-enforced invariant
   (`commitDurableEvent`), the only rule that survives adversarial review, and the only mechanism
   that can remove the per-aggregate string no shared dictionary can cover. Everything else is a
   property-tested empirical candidate. (§5)
3. **Event-ID packing verified against `identifier.ts`**: 48-bit clock (actually `(ts*4096+counter)
   mod 2^48` — top 5 bits truncated by the generator, wraparound possible) + 84-bit base-62 suffix,
   zigzag-delta uvarints, escape for non-canonical. ~12–17 B/event vs 30 B ASCII. (§3)
4. **Tier A packed ID registry as v1 locator** — it replaces today's `event.id` TEXT PK index and
   is strictly cheaper; Tier B fingerprint is a column-type change later, with the packed segment
   stream as the exact-verify source. (§7, answered for benchmark-arch)
5. **Microframes optional in the format (frame_count=1 legal), 16–32 KiB default, geometry is
   runtime policy** — microframe independence is for corruption containment and cache granularity,
   not point-read latency; the fork's workload is range-scan dominated. (§2)
6. **Sealer = fork ChunkSealer generalized**: same frontier rule (`seq <= event_sequence.seq AND
   owner_id IS NULL`), own connection, per-batch txn + yield, `oses_seal` journal reusing the
   `ocdb_seal` accounting shape; OCDB frame envelope reused as the single-event/jumbo frame format
   inside segments. (§6)

---

## 14. Corrections to the research doc (for the record)

1. §20.3/§F.2 `event_hot` with `hot_id`, `aggregate_key`, `type_key`, `time_created`: unnecessary
   rewrite; the real `event` table has no `time_created`; the sync fence constrains `event_sequence`.
2. §1.5/§22.5 "48-bit timestamp × 4096 + counter": the stored hex is the low 48 bits of a 53-bit
   value — generator truncation, not a clean 48-bit clock. Delta encoding must handle mod-2^48
   wraparound (zigzag).
3. §1.2/§13 reference corpus (50 events) is not representative of the fork (1.37M rows, 32.8 MB max
   row); all geometry/ratio numbers in the research doc are hypotheses against that sample.
4. Research doc never mentions the fork's existing OCDB frame codec, `chunk-sealer.ts`, `ocdb_seal`
   journal, or partial candidate index — the "legacy event table" is already mixed TEXT/BLOB where
   the sealer ran, and the OSES envelope design should reuse the OCDB header shape.
5. §20.8/§F.5 Tier-A-vs-B framing misses that today's `event.id` PK is already a full global ID
   index; the registry replaces it (cheaper), it does not add cost.
6. §20.9 semantic elision: the research doc's example rules for `session.updated.1`/`info.id` are
   correct to be cautious about — the schema does not prove `info.id === sessionID`. The generic
   `data[durable.aggregate]` rule IS provable, which is stronger than the research doc claims.
7. §22.2 codec numbering (1=deflate, 2=brotli, 3=zstd) **conflicts with the shipped OCDB registry**
   (1=zstd, 2=brotli, 3=raw-deflate) already on disk in `json-codec.ts` — the shipped registry is
   frozen, append-only (codec-arch). Also §1.6's "Zstd is experimental risk" is superseded by
   codec-arch's measurements: dict-less zstd and brotli are byte-stable cross-runtime; deflate is
   not; zstd+dict is broken on Bun — a structural deflate dictionary is the only safe dict.
8. §23.9 sync-history "preserve current deterministic behavior" — the behavior is now pinned:
   `(seq ASC, rowid ASC)` where rowid is the global append ordinal (contract-arch verified). OSES
   segments must carry it (per-segment base + per-event deltas, §9.4); the research doc does not
   identify the rowid tie-break at all.
