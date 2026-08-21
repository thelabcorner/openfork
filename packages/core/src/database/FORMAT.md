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

## v5 (delta_ref, epoch-4 — IMPLEMENTED, flag-gated)

> **Status: implemented** (codec-frontier-v3, after #8 green). Write path is
> opt-in via `OPENCODE_SEAL_DELTA` (default OFF); the read path decodes v5
> frames whenever present (backward-compatible — old binaries fail-closed on
> version 5). This section is the frame-version extension point owned by
> codec-frontier-v3.

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

### Emission (sealer write-side, #10 lane)

- **Opt-in** via `OPENCODE_SEAL_DELTA` (default OFF). When on, the sealer stores
  a value as a v5 delta_ref frame when the correction is materially smaller than
  a full frame.
- **Base selection**: the sealer tracks the last NON-delta (full-frame) promoted
  value per aggregate (`lastBaseByAggregate` in `runPassV2`); each candidate
  uses that base. A delta_ref value is never itself a base (avoids nested
  deltas — the read path resolves a base via `decodeValueBytesRaw`, which only
  handles v1–v4).
- **Emit decision**: emit v5 only when `delta.byteLength < frame.byteLength ×
  0.7` (the 0.7× margin guards against regressions on non-record-structured
  payloads); otherwise emit a normal v3 frame.
- CRC-over-compressed (v4 pattern) carries cleanly to the correction payload.

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
| 5       | **compressed** correction bytes     | before decompress   | epoch-4 #10: delta_ref sparse-correction frame          |

v3 computes the CRC over the (much smaller) compressed payload, so the
integrity check is far cheaper and runs *before* decompression. All versions
are fail-closed: a CRC mismatch or rawLen mismatch throws `OCDBFrameError`
with a `restoreHint` (`opencode db restore --db <path>`).

## Codec ids

- `1` zstd — default for large payloads (>= 16 KiB).
- `2` brotli — default for small payloads (< 16 KiB); supported for decompress
  forever.
- `3` raw-deflate — supported for decompress forever.

`decompressFrame` / `decodeValueBytes` MUST decode all three codecs (and all
frame versions) forever. New codecs are added as new ids, never by
reassigning existing ones.

## Adaptive codec selection (epoch-3, verified)

`compressText` (no explicit `codec` option) selects by raw byte length via
`chooseCodec` — ONE compress per payload (the per-payload J-score that
compressed with both zstd-1 and zstd-3 was removed: the epoch-3 bench showed
zstd-1 beats zstd-3 on ratio AND speed on the realistic mix, so the J-score
never picked anything but zstd-1 — it only doubled the compress cost, 40 MB/s
adaptive vs 221 MB/s explicit):

- `< 16 KiB`: brotli-q1 — 738 MB/s compress / 671 MB/s decode vs zstd-1's
  172 / 311 on the 50% 8KiB / 30% 32KiB / 20% 128KiB mix, at a ratio within
  ~3% (85.2x vs 87.8x). Absolute bytes saved at these sizes are negligible, so
  CPU is the priority.
- `>= 16 KiB`: zstd-1 — strictly dominates brotli-1 on ratio AND throughput at
  scale (e.g. 1 MiB: 720 vs 558 MB/s compress, 14.6 vs 7.6 ratio).

A negative entropy gate (ANVIL G3) skips compression entirely on
near-max-entropy (incompressible) payloads.

## Threshold & caps

- `THRESHOLD = 4096` UTF-16 code units: rows under this stay TEXT forever.
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

> **value_id scheme:** epoch-2 dedup (this section) uses 2-part `"<aggregate_id>:<seq>"`. The epoch-3 (#8) collapse uses 3-part `"<aggregate_id>:<seq>:<sha8>"` (globally unique). Both coexist in `event_value`; resolution is PK-scoped `(aggregate_id, value_id)` and scheme-agnostic, so a v5 delta_ref base may reference either scheme.

## Epoch gate

`PRAGMA user_version` enforces the epoch gate (schema layer, independent of
frame version). Frame version (1/2/3/4/5) is orthogonal to `user_version`; a v3
frame is readable by any binary that uses this codec module.

## Ops runbook

All ChunkDB behavior is FLAG-GATED and OFF by default:

| flag / env | effect |
|---|---|
| `OPENCODE_SEAL_ENABLED` | on: sealer loop runs (immediate pass, then every 10 min); create-time `page_size=8192` + `auto_vacuum=INCREMENTAL` on FRESH DBs |
| `OPENCODE_SEAL_DEDUP` | on: epoch-2 dedup promotion (`event_value` + `$cdbRef` refs) |
| `OPENCODE_SEAL_WORKERS` | on: compression/decompression run on worker-thread pools (2–4 workers) |
| `OPENCODE_SEAL_DELTA` | on: epoch-4 delta_ref framing — record-structured values stored as a sparse correction against a base value in `event_value` when smaller (default OFF) |
| `OPENCODE_SEAL_BACKFILL` | on (1): epoch-3 (#6) BACKFILL mode — back-to-back passes at 50k cap when a backlog exists; `0` forces maintenance-only (default ON) |
| `OPENCODE_SEAL_COMPACT` | off: epoch-3 (#9) one-shot shrink of an EXISTING DB (`auto_vacuum=0` → `incremental_vacuum` no-op); `VACUUM INTO` + atomic swap |
| `OPENCODE_SEAL_REBUILD` | off: epoch-3 (#8) one-shot collapse of 5 projection stores into `event_value` `$cdbRef` (same table, no second scan) |
| `OPENCODE_SEAL_OPCL` | off: epoch-3 (#8) OPCL read path — resolves `$cdbRef` in collapsed projection columns back to canonical payloads |
| `OPENCODE_SEAL_CACHE_ENTRIES` / `OPENCODE_SEAL_CACHE_BYTES_MB` | per-device hot-value cache sizing (defaults 1024 entries / 64 MB) |
| `CHUNKDB_SEAL_JOURNAL_RETENTION_DAYS` | `occdb_seal` audit-journal retention (default 30) |

Verified (epoch-3 bench, `packages/core/test/bench-chunkdb.ts`, median-3):

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

Operational assumptions (documented, not enforced):

- SINGLE-WRITER: the sealer assumes ONE opencode process owns the DB file at a
  time (the normal deployment). Two processes sealing the same file can both
  plan the same promotion; the loser's batch rolls back atomically and
  converges on the next pass — a wasted batch, never corruption. A
  multi-instance lease was considered and deliberately NOT added: its
  stale-lease crash windows (both sides believing they hold the lease) are
  worse than the collision it prevents at this usage level. Revisit only if
  multi-instance on one file becomes a real deployment.
- Crash recovery: every promotion batch is a single transaction — a crash
  mid-batch rolls back atomically (no dangling `$cdbRef`, no orphan
  `event_value` rows), and re-running the pass after any interruption
  converges to the same state as a clean run. Verified by
  `packages/core/test/database/chunkdb-crash.test.ts` (5 tests: atomicity,
  idempotent restart, partial crash, process restart, fail-closed).
