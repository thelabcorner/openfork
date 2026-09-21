# ChunkDB Frame & Reference Format

Durable spec for the OpenCode ChunkDB OCDB framing layer
(`packages/core/src/database/json-codec.ts`). The sealer is the ONLY frame
producer; hot writes (`toDriver`) stay identity `JSON.stringify` TEXT.

## Frame header (v2 / v3)

Fixed 14-byte header, little-endian:

| offset | size | field            | meaning                                            |
|--------|------|------------------|----------------------------------------------------|
| 0      | 4    | magic            | `"OCDB"` (`0x4f 0x43 0x44 0x42`)                   |
| 4      | 1    | version          | `2` or `3`                                         |
| 5      | 1    | codec            | `1` = zstd, `2` = brotli, `3` = raw-deflate        |
| 6      | 4    | rawLen           | decompressed UTF-8 byte length (sanity-capped pre-decompress) |
| 10     | 4    | crc32            | integrity checksum (see per-version semantics)     |
| 14     | n    | payload          | compressed JSON UTF-8                              |

### v1 (legacy, 10-byte header, no CRC)

| offset | size | field   | meaning                              |
|--------|------|---------|--------------------------------------|
| 0      | 4    | magic   | `"OCDB"`                             |
| 4      | 1    | version | `1`                                  |
| 5      | 1    | codec   | `1` = zstd, `2` = brotli, `3` = deflate |
| 6      | 4    | rawLen  | decompressed UTF-8 byte length       |
| 10     | n    | payload | compressed JSON UTF-8                |

No CRC; integrity relies on SQLite page checksums only.

### v4 (segmented, for jumbo rows > 4 MiB)

Used for payloads above `JUMBO_THRESHOLD` (4 MiB) so decompression is
chunkable — the read path can stream/yield per segment instead of one large
sync decompress. All segments share one codec.

| offset | size             | field         | meaning                                          |
|--------|------------------|---------------|--------------------------------------------------|
| 0      | 4                | magic         | `"OCDB"`                                         |
| 4      | 1                | version       | `4`                                              |
| 5      | 1                | codec         | `1` = zstd, `2` = brotli, `3` = deflate          |
| 6      | 4                | totalRawLen   | total decompressed UTF-8 byte length             |
| 10     | 2                | segmentCount  | number of segments                               |
| 12     | segmentCount × 4 | segTable      | compressed length of each segment (LE uint32)    |
| 12 + segTable | per segment: 4 (crc32 over the segment's **compressed** bytes) + compressed bytes | | |

Each segment is independently compressed; its CRC (over compressed bytes,
v3-style) is verified *before* decompressing that segment. A corrupt segment
throws `OCDBFrameError`. Total decompressed length is checked against
`totalRawLen` at the end.

## v5 (delta_ref — historical reader compatibility)

> **Status: reader-supported, new emission retired.** Databases can contain v5
> frames written by earlier builds, so the decoder, integrity verifier,
> dependency graph and transitive GC support remain durable compatibility
> requirements. Current `runPassV2` does not emit new v5 values and
> `OPENCODE_SEAL_DELTA` is ignored with a warning. Reference-capable databases
> remain fenced at storage epoch 5 so pre-v5 readers fail at DB open rather than
> discovering an unsupported representation lazily during replay.

Used for record-structured values (e.g. `info.summary.diffs` across turns)
where consecutive values share most content. Instead of storing a full frame,
the value is stored as a **sparse correction** against a base value already in
`event_value`. Detected by version byte `5` within the existing `"OCDB"` magic
(the `isFrame` 4-byte compare still matches; the decoder routes by version,
same as v1–v4 — an old binary encountering `5` fails-closed rather than
misdecode).

| offset | size | field          | meaning                                                  |
|--------|------|----------------|----------------------------------------------------------|
| 0      | 4    | magic          | `"OCDB"`                                                 |
| 4      | 1    | version        | `5`                                                      |
| 5      | 1    | codec          | `1` = zstd, `2` = brotli, `3` = deflate (correction)     |
| 6      | 4    | totalRawLen    | decompressed length of the RECONSTRUCTED value (sanity)  |
| 10     | n    | baseValueIdLen | byte length of `base_value_id` UTF-8 string              |
| 10+n   | m    | baseValueId    | `"<aggregate_id>:<seq>"` ref to base in `event_value`    |
| 10+n+m | 4    | crc32          | CRC over the **compressed** correction bytes (v4-style)  |
| 14+n+m | k    | correction     | compressed correction payload                            |

The `correction` payload is an entropy-coded mask of copied phrase spans
(from the base) + residual literals — a sparse patch, not a full re-encode.

### Rehydration (fail-closed)

1. Decoder detects version `5` (delta_ref).
2. Reads `baseValueId`, loads the base via the existing `(aggregate_id,
   value_id)` PK from `event_value`.
3. **Missing/dangling base → fail-closed**: throw `OCDBFrameError` (corrupt);
   the ops-v2 `repair` path quarantines it. NEVER silent degrade or fallback to
   a partial value.
4. Decode `correction` (decompress + CRC-verify over compressed bytes, v4
   pattern).
5. Apply the sparse correction to the base → reconstructed value `V`.
6. Verify `V.length === totalRawLen`; mismatch → fail-closed.
7. Return `V` (raw JSON string), byte-exact.

### Historical emission contract

Earlier writers selected a prior non-delta value in the same aggregate as the
base and emitted v5 only when the correction was materially smaller than the
independent frame. Nested v5 bases were outside the format contract. Readers must
continue enforcing those constraints because already-written databases remain
valid; writers must not infer from reader support that v5 emission is still
enabled.

### ANVIL Exp E target

-9.6% bytes on record-structured data (`info.summary.diffs` across turns) at
~21× encode speed vs a full v3 frame.

## CRC semantics per version

| version | CRC covers                          | verified            | notes                                  |
|---------|-------------------------------------|---------------------|----------------------------------------|
| 1       | — (none)                            | —                   | legacy                                 |
| 2       | **raw** (decompressed) bytes        | after decompress    | frames already sealed in production DBs |
| 3       | **compressed** bytes                | before decompress   | ~7–14x cheaper; fail-closed earlier    |
| 4       | **compressed** bytes, per segment   | before decompress   | segmented; chunkable decompression     |
| 5       | **compressed** correction bytes     | before decompress   | #10: delta_ref sparse-correction frame                  |

v3 computes the CRC over the (much smaller) compressed payload, so the
integrity check is far cheaper and runs *before* decompression. All versions
are fail-closed: a CRC mismatch or rawLen mismatch throws `OCDBFrameError`
with a `restoreHint` (`opencode db restore --db <path>`).

## Codec ids

- `1` zstd — current ordinary large-value codec family; supported forever.
- `2` brotli — current ordinary <=64-KiB codec family; supported forever.
- `3` raw-deflate — supported for decompress forever.

`decompressFrame` / `decodeValueBytes` MUST decode all three codecs (and all
frame versions) forever. New codecs are added as new ids, never by
reassigning existing ones.

## Current codec selection

`compressText` is ratio-first on cold maintenance data, but the audited
candidate frontier is deliberately narrow:

- `<= 64 KiB` raw: **Brotli-11 once**. On the bounded current
  post-semantic-prune corpus it won every ordinary-value comparison, so racing
  Brotli-9 / zstd candidates was pure CPU.
- `> 64 KiB` ordinary values: compare **zstd-19 and zstd-9** and keep the
  smaller payload. zstd-9 still wins rare values by a few bytes.
- v4 jumbo values remain split into 1-MiB raw segments; each segment keeps the
  fuller zstd **19/15/9/1** byte-minimizing frontier. A measured segment had
  zstd-15 beat both 19 and 9, so the ordinary fast frontier must not be applied
  mechanically to jumbo storage.

`chooseCodec()` remains a single-candidate hint for compatibility/helpers; it
does not describe the full ordinary `compressText()` candidate race.

A negative entropy gate (ANVIL G3) skips compression entirely on
near-max-entropy (incompressible) payloads.

## Threshold & caps

- `SMALL_TEXT_THRESHOLD = 512` UTF-16 code units: cold values from
  **512..4095** are independently framed inline with Brotli-5 using the same v3
  OCDB representation. They never enter `event_value`.
- `THRESHOLD = 4096` UTF-16 code units: values at/above this boundary enter the
  ordinary large-value sealer, which may inline-frame or externalize them.
- The 512 boundary is evidence-owned: a real post-semantic-prune physical A/B
  found 256 produced a larger SQLite file once frame/journal cardinality was
  counted; Brotli-9 saved only ~40 KiB beyond Brotli-5 on the ~174 MiB residual.
- Small-row compression remains background-only. The elected maintenance owner
  waits for a cross-process `PRAGMA data_version` quiet window before writer
  slices; foreground writers retain priority.
- `RAWLEN_PRE_CAP = 128 MiB`: rawLen sanity cap checked BEFORE decompress
  (bounds the allocation).
- `MAX_RAW = 0x7fffffff`: refuse to frame anything beyond 2^31-1.

## Reference / dedup contract (epoch-2)

When `Flag.OPENCODE_SEAL_DEDUP` is on, a promoted payload is replaced inline
in `event.data` by a reference:

```json
{ "$cdbRef": "<value_id>" }
```

where `value_id = "<aggregate_id>:<seq>"` (unique & deterministic per event).
The canonical bytes live once in `event_value`
(`aggregate_id, value_id, sha256, raw_len, bytes, refs, ...`), deduplicated
by `sha256` within an aggregate. Rehydration (read path) resolves the
`$cdbRef` against `event_value` and decodes `bytes` back to the original JSON
string via `decodeValueBytes` (which handles both OCDB frames and verbatim
JSON UTF-8 BLOBs). Byte-exact rehydration is required
(`isDeepStrictEqual`).

Architecturally, `event_value` is a **canonical large-value heap with
exact-dedup capability**. On the audited post-semantic-prune stratified corpus,
2,350 promotions produced zero repeats and every retained canonical row had
`refs=1`; consumers must not assume dedup is the table's dominant benefit.

> **value_id scheme:** epoch-2 dedup (this section) uses 2-part `"<aggregate_id>:<seq>"`. The epoch-3 (#8) collapse uses 3-part `"<aggregate_id>:<seq>:<sha8>"` (globally unique). Both coexist in `event_value`; resolution is PK-scoped `(aggregate_id, value_id)` and scheme-agnostic, so a v5 delta_ref base may reference either scheme.

## Staged jumbo foreground payloads

Foreground event bodies above the cooperative staging threshold use a separate
content-addressed `$eventPayload` representation instead of making one giant
semantic writer transaction:

1. bounded text chunks are staged under a SHA-256 payload id;
2. `event_payload_meta` starts at `refs=0` while staging is unreachable;
3. the final semantic event transaction inserts the tiny reference and atomically
   increments committed ownership;
4. replay validates chunk count/order, SHA-256 and JSON fail-closed;
5. semantic prune and aggregate deletion atomically release committed ownership;
6. zero-ref chunks are reclaimed only after a 24-hour grace with an IMMEDIATE
   ownership recheck. Reclaim runs at Event-service startup and on the dedicated
   low-priority maintenance connection.

Refcount decrement underflow or missing lifecycle metadata is corruption and
fails closed; it is never silently clamped to zero.

## Semantic compaction (storage epoch 4)

When ChunkDB sealing is enabled, semantic elimination runs before ordinary
dedup/compression for the full-snapshot event classes currently covered by the
projection proof policy. It is enabled by default; set
`OPENCODE_SEAL_PRUNE=0`/`false` as an emergency writer kill switch. A superseded
snapshot is deleted only after the latest snapshot for the same entity is proven
to match the authoritative materialized projection and the aggregate is
local/unowned and outside the hot tail.

Deleted durable positions are not stored as physical event rows. One dense BLOB
in `event_compaction` records one bit per compacted aggregate sequence. Local
readers naturally traverse sparse physical sequences. Boundaries that require a
contiguous durable stream (`/sync/history`, remote session warp/replay) synthesize
deterministic `event.compacted.1` no-op fillers from the bitmap. New receivers
consume those fillers back into the bitmap without inserting an event row.

Legacy storage-epoch-3 databases that contain physical `event.compacted.1` rows
are migrated in bounded, idempotent batches into `event_compaction`, then the
physical marker rows are deleted. `PRAGMA user_version=4` is the compatibility
fence for sparse durable sequences.

## Epoch gate

`PRAGMA user_version` enforces the storage-capability gate. Frame version
(1/2/3/4/5) remains a distinct codec concept: storage epoch 4 fences sparse
durable sequences, while storage epoch 5 fences reference-capable databases
whose `event_value` rows may contain v5 delta refs. The epoch-5 fence is
intentionally broader than “delta currently enabled”: early v5 writers shipped
while dedup databases were still stamped at epoch 2, and the writer flag is
runtime-readable. A pre-v5 reference reader must therefore be rejected at open,
not allowed to discover incompatibility lazily during replay.

## Ops runbook

ChunkDB behavior is controlled by the following flags and defaults:

| flag / env | effect |
|---|---|
| `OPENCODE_SEAL_ENABLED` | on: sealer loop runs (immediate pass, then every 10 min); create-time `page_size=8192` + `auto_vacuum=INCREMENTAL` on FRESH DBs |
| `OPENCODE_SEAL_DEDUP` | on: epoch-2 dedup promotion (`event_value` + `$cdbRef` refs) |
| `OPENCODE_SEAL_PRUNE` | default ON when sealing runs; `0`/`false` disables new semantic writes. Obsolete snapshot rows become bits in `event_compaction`, with deterministic wire-only `event.compacted.1` fillers. Sparse read/replay support remains available when the writer is disabled. |
| `OPENCODE_SEAL_WORKERS` | on: compression/decompression run on worker-thread pools (2–4 workers) |
| `OPENCODE_SEAL_DELTA` | legacy configuration only: new v5 emission is retired; when set, the sealer warns and ignores it. Historical v5 reader/integrity/GC support remains active and storage-epoch-5 fenced. |
| `OPENCODE_SEAL_BACKFILL` | on (1): epoch-3 (#6) BACKFILL mode — back-to-back passes at 50k cap when a backlog exists; `0` forces maintenance-only (default ON) |
| `OPENCODE_SEAL_COMPACT` | off: epoch-3 (#9) one-shot shrink of an EXISTING DB (`auto_vacuum=0` → `incremental_vacuum` no-op); `VACUUM INTO` + atomic swap |
| `OPENCODE_SEAL_REBUILD` | off: epoch-3 (#8) one-shot collapse of 5 projection stores into `event_value` `$cdbRef` (same table, no second scan) |
| `OPENCODE_SEAL_OPCL` | off: epoch-3 (#8) OPCL read path — resolves `$cdbRef` in collapsed projection columns back to canonical payloads |
| `OPENCODE_SEAL_CACHE_ENTRIES` / `OPENCODE_SEAL_CACHE_BYTES_MB` | decoded-value cache admission (defaults 1024 entries / 64 MiB of source `raw_len`). The byte value is **not** a JS heap/RSS cap; parsed objects can retain several times their source bytes. |
| `CHUNKDB_SEAL_JOURNAL_RETENTION_DAYS` | `ocdb_seal` audit-journal retention (default 30) |

Historical epoch-3 synthetic benchmark
(`packages/core/test/bench-chunkdb.ts`, median-3; useful for regression shape,
not current-population sizing):

- Compression efficacy: 3.83x smaller on-disk vs plain TEXT (56.4 MB -> 14.7 MB,
  freelist drained, WAL checkpointed) on 2000 events / 50 aggregates with 30%
  repeated payloads; 29.3% of events collapse to dedup refs.
- Promotion: ~930 rows/s (batched dedup lookup: one row-value `IN` query per
  batch instead of a per-candidate SELECT).
- Rehydration: byte-exact, p99 ~0.4–0.8 ms per aggregate; jumbo (32 MiB) batch
  decode 1.0–1.5x faster on the worker pool (main thread stays free during
  decompress — the pool's real value is preventing read-path clogs).
- Worker compress pool: 1.8x sealer compress throughput.

Known limits (honest):

- `auto_vacuum=INCREMENTAL` is CREATE-TIME ONLY. Existing DBs (created before
  this feature) keep `auto_vacuum=0`, so `incremental_vacuum` is a no-op and
  the file never shrinks — reclaiming space on an existing DB requires a
  file-swap rebuild (roadmap #9), not the sealer.
- The decompress pool is only a win for payloads >= 64 KiB (worker round-trip
  overhead exceeds the decode time below that); smaller payloads decode
  synchronously.
- Restore path for corrupt frames: `opencode db restore --db <path>`.

Operational ownership:

- Multiple foreground hosts can open the same WAL database. ChunkDB elects one
  maintenance owner with a DB-local cross-process `Flock`; maintenance then
  uses its own SQLite connection with effectively non-blocking writer admission,
  a cross-process `data_version` quiet gate, and bounded retry/yield. Foreground
  writers own priority.
- Any foreground transaction that reads before a possible write must reserve the
  writer with `BEGIN IMMEDIATE`; `busy_timeout` cannot repair
  `SQLITE_BUSY_SNAPSHOT` (extended code 517).
- Crash recovery: every promotion batch is a single transaction — a crash
  mid-batch rolls back atomically (no dangling `$cdbRef`, no orphan
  `event_value` rows), and re-running the pass after any interruption
  converges to the same state as a clean run. Verified by
  `packages/core/test/database/chunkdb-crash.test.ts` (5 tests: atomicity,
  idempotent restart, partial crash, process restart, fail-closed).
