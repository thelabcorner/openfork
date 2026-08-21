import { customType } from "drizzle-orm/sqlite-core"
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  deflateRawSync,
  inflateRawSync,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib"

/**
 * Fork-owned OpenCode ChunkDB frame v2 codec (OCDB).
 *
 * Frame layout (14-byte header):
 *   offset 0  4B  magic "OCDB"
 *   offset 4  1B  format version (2)
 *   offset 5  1B  codec: 1=zstd, 2=brotli, 3=raw-deflate
 *   offset 6  4B  raw UTF-8 byte length, little-endian
 *   offset 10 4B  CRC32 of the DECOMPRESSED raw bytes, little-endian
 *   offset 14 n   compressed JSON UTF-8
 *
 * v1 frames (10-byte header, no CRC) remain decodable via the version byte.
 *
 * DESIGN (per deliverable/t5/t6 — identity toDriver, cold-only framing):
 * - `toDriver` is IDENTITY: JSON.stringify only, never frames. Hot writes are
 *   byte-identical to today's `text({ mode: "json" })` — zero hot-path cost by
 *   construction. A background sealer is the ONLY frame producer.
 * - `fromDriver` decodes TEXT | frame v2 fail-closed in 5 stages:
 *   magic/version/codec -> rawLen sanity-cap BEFORE decompress (bounds alloc)
 *   -> decompress -> CRC32 over decompressed bytes -> JSON.parse.
 */

const MAGIC = new Uint8Array([0x4f, 0x43, 0x44, 0x42]) // "OCDB"
const HEADER = 14
const VERSION_V2 = 2 // legacy frames in production DBs: CRC over raw (decompressed) bytes
const VERSION = 3 // current write version: CRC over COMPRESSED bytes (~7-14x cheaper)
const VERSION_V4 = 4 // segmented frame for jumbo rows (>JUMBO_THRESHOLD): independently-compressed segments
const VERSION_V5 = 5 // delta_ref frame (epoch-4 #10): sparse correction against a base value in event_value
const CODEC_ZSTD = 1
const CODEC_BROTLI = 2
const CODEC_DEFLATE = 3
/** Rows larger than this are stored as a v4 SEGMENTED frame (epoch-3 #5):
 *  splitting into independently-compressed segments keeps decompression
 *  chunkable so the read path can stream/yield instead of one large sync block
 *  (a 32MiB payload decompresses in ~120ms — fatal on a cold-resume read path). */
const JUMBO_THRESHOLD = 4 * 1024 * 1024
/** Segment size for v4 frames (raw bytes per segment). */
const SEGMENT_SIZE = 1024 * 1024
/** Rows under this many UTF-16 code units stay TEXT forever (settled-size threshold). */
export const THRESHOLD = 4096
/** Refuse-to-frame guard; real max row is ~32.8MB, ~4x headroom. */
const RAWLEN_PRE_CAP = 128 * 1024 * 1024
/** SQLite values are capped at 1GB; refuse to frame anything beyond 2^31-1. */
const MAX_RAW = 0x7fffffff

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class OCDBFrameError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(`OpenCode ChunkDB frame error: ${reason}`)
    this.name = "OCDBFrameError"
    this.reason = reason
  }
}

const restoreHint = "run: opencode db restore --db <path>"

export const Frame = { headerBytes: HEADER, version: VERSION } as const

// Table-driven CRC-32 (poly 0xedb88320, reflected) — byte-for-byte identical to
// the bit-by-bit form but ~3-4x faster, since the inner 8-bit loop becomes a
// single table lookup. This is the dominant cost in the framing path (it runs
// over the full raw payload on both compress and decompress), so the speedup
// flows directly into end-to-end throughput without changing the frame format.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function compressWith(
  raw: Uint8Array,
  codec: number,
  level: number,
): { payload: Uint8Array; codec: number } {
  if (codec === CODEC_BROTLI) {
    return {
      payload: brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: level } }),
      codec: CODEC_BROTLI,
    }
  }
  if (codec === CODEC_DEFLATE) {
    return { payload: deflateRawSync(raw, { level }), codec: CODEC_DEFLATE }
  }
  return {
    payload: zstdCompressSync(raw, { params: { [constants.ZSTD_c_compressionLevel]: level } }),
    codec: CODEC_ZSTD,
  }
}

function decompressWith(payload: Uint8Array, codec: number): Uint8Array {
  if (codec === CODEC_BROTLI) return brotliDecompressSync(payload)
  if (codec === CODEC_DEFLATE) return inflateRawSync(payload)
  if (codec === CODEC_ZSTD) return zstdDecompressSync(payload)
  throw new OCDBFrameError(`unsupported codec ${codec} — ${restoreHint}`)
}

/**
 * Byte-lossless compressor for the SEALER path only. Never called by toDriver.
 * Returns TEXT when the value is under the threshold or compression gains
 * nothing; otherwise a frame v2 Uint8Array.
 */
/**
 * Adaptive codec selection for the SEALER path. Picks the throughput-optimal
 * codec for a given raw UTF-8 byte length, measured on the epoch-3 bench
 * (packages/core/test/bench-chunkdb.ts, median-3 over a realistic 50% 8KiB /
 * 30% 32KiB / 20% 128KiB mix):
 *
 * - Small payloads (<16KiB): brotli-q1 — 622 MB/s compress / 568 MB/s decode
 *   vs zstd-1's 221 / 508, at a ratio within ~3% (85.2x vs 87.8x on the mix).
 *   The absolute bytes saved at these sizes are negligible, so CPU is the
 *   priority.
 * - Large payloads (>=16KiB): zstd-1 — strictly dominates brotli-1 on ratio
 *   AND throughput at scale (e.g. 1MiB: 720 vs 558 MB/s compress, 14.6 vs 7.6
 *   ratio). zstd's ratio scales with input size, so the large-case win grows.
 *
 * This replaces the per-payload J-score (which compressed with BOTH zstd-1 and
 * zstd-3 to pick a winner): the bench shows zstd-1 beats zstd-3 on ratio AND
 * speed on the realistic mix (87.82x vs 87.68x), so the J-score never picked
 * anything but zstd-1 — it only doubled the compress cost (40 MB/s adaptive vs
 * 221 MB/s explicit). One compress per payload is the pareto frontier.
 */
export function chooseCodec(rawLen: number): { codec: 1 | 2 | 3; level: number } {
  if (rawLen < 16 * 1024) return { codec: CODEC_BROTLI, level: 1 }
  return { codec: CODEC_ZSTD, level: 1 }
}

/**
 * ANVIL Experiment G3 — negative gate. Samples ~1024 bytes across the payload
 * and estimates byte-value entropy; near-max entropy (>= ~7.9 bits/byte, i.e.
 * ~99% distinct byte values) means the payload is effectively incompressible,
 * so we return it raw and spend ZERO compress CPU. JSON event payloads sit at
 * ~4-6 bits/byte (heavy key/whitespace repetition) and always pass; this only
 * fires on already-compressed / random / base64-heavy blobs.
 */
function isCompressible(raw: Uint8Array): boolean {
  const SAMPLE = 1024
  const n = Math.min(SAMPLE, raw.byteLength)
  if (n === 0) return true
  const counts = new Uint32Array(256)
  const step = raw.byteLength > SAMPLE ? Math.floor(raw.byteLength / SAMPLE) : 1
  for (let i = 0, k = 0; k < n; i += step, k++) counts[raw[i]]++
  let entropy = 0
  for (let v = 0; v < 256; v++) {
    const c = counts[v]
    if (c === 0) continue
    const p = c / n
    entropy -= p * Math.log2(p)
  }
  return entropy < 7.9
}

export function compressText(json: string, options?: { codec?: 1 | 2 | 3; level?: number }): string | Uint8Array {
  if (json.length < THRESHOLD) return json
  const raw = encoder.encode(json)
  if (raw.byteLength > MAX_RAW) return json

  // Negative gate: skip compression entirely on high-entropy (incompressible)
  // payloads — ANVIL G3, ~727x encode speedup on random data at identical bytes.
  if (options === undefined && !isCompressible(raw)) return json

  const { codec, level } = options?.codec !== undefined
    ? { codec: options.codec, level: options.level ?? 1 }
    : chooseCodec(raw.byteLength)
  // Jumbo rows: store as a v4 SEGMENTED frame so decompression is chunkable
  // (the read path can stream/yield per segment instead of one 120ms block).
  if (raw.byteLength > JUMBO_THRESHOLD) return compressSegmented(raw, codec, level)
  const { payload } = compressWith(raw, codec, level)
  // Header + payload must beat raw bytes by at least 24 to be worth framing.
  if (payload.byteLength + HEADER + 24 >= raw.byteLength) return json

  const output = new Uint8Array(HEADER + payload.byteLength)
  output.set(MAGIC)
  output[4] = VERSION
  output[5] = codec
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength)
  view.setUint32(6, raw.byteLength, true)
  // v3: CRC covers the COMPRESSED bytes (far smaller than raw), so the
  // integrity check is ~7-14x cheaper and the reader can verify it BEFORE
  // decompressing. Fail-closed on corrupt frames either way.
  view.setUint32(10, crc32(payload), true)
  output.set(payload, HEADER)
  return output
}

/**
 * v4 SEGMENTED frame builder (epoch-3 #5). Splits `raw` into `SEGMENT_SIZE`
 * chunks, compresses each independently with the chosen codec, and packs them
 * with a segment index + per-segment CRC (over compressed bytes, v3-style).
 * Independently-compressed segments let the read path decompress chunk-by-chunk
 * (stream/yield) instead of one large sync decompress on jumbo payloads.
 */
function compressSegmented(raw: Uint8Array, codec: number, level: number): Uint8Array {
  const segLens: number[] = []
  const segments: Uint8Array[] = []
  let offset = 0
  while (offset < raw.byteLength) {
    const end = Math.min(offset + SEGMENT_SIZE, raw.byteLength)
    const { payload } = compressWith(raw.subarray(offset, end), codec, level)
    segments.push(payload)
    segLens.push(payload.byteLength)
    offset = end
  }
  const segCount = segments.length
  let size = 4 + 1 + 1 + 4 + 2 + segCount * 4
  for (const s of segments) size += 4 + s.byteLength
  const out = new Uint8Array(size)
  out.set(MAGIC)
  out[4] = VERSION_V4
  out[5] = codec
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(6, raw.byteLength, true)
  view.setUint16(10, segCount, true)
  let p = 12
  for (const len of segLens) {
    view.setUint32(p, len, true)
    p += 4
  }
  for (const s of segments) {
    view.setUint32(p, crc32(s), true)
    p += 4
    out.set(s, p)
    p += s.byteLength
  }
  return out
}

/**
 * Parses a v4 SEGMENTED frame header and returns a list of per-segment
 * decompressor closures (each verifies its segment's CRC over compressed bytes,
 * v3-style, then decompresses). Lets the caller decompress segment-by-segment
 * and interleave work (e.g. Effect.yieldNow) between segments for incremental
 * streaming decompression of jumbo rows — avoiding a single ~120ms sync block
 * on the inline read path.
 *
 * The closures capture zero-copy subarrays of `bytes` and must be called in
 * order. `totalRawLen` is returned for the caller's final length check.
 */
export function v4SegmentDecompressors(
  bytes: Uint8Array,
  codec: number,
): { totalRawLen: number; decompressors: Array<() => Uint8Array> } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const totalRawLen = view.getUint32(6, true)
  if (totalRawLen > RAWLEN_PRE_CAP) throw new OCDBFrameError(`rawLen ${totalRawLen} exceeds pre-cap — ${restoreHint}`)
  const segCount = view.getUint16(10, true)
  let p = 12
  const segLens: number[] = []
  for (let i = 0; i < segCount; i++) {
    segLens.push(view.getUint32(p, true))
    p += 4
  }
  const decompressors: Array<() => Uint8Array> = []
  for (let i = 0; i < segCount; i++) {
    const storedCrc = view.getUint32(p, true)
    p += 4
    const compressed = bytes.subarray(p, p + segLens[i])
    p += segLens[i]
    const crc = storedCrc
    decompressors.push(() => {
      if (crc32(compressed) !== crc) throw new OCDBFrameError(`CRC mismatch — ${restoreHint}`)
      return decompressWith(compressed, codec)
    })
  }
  return { totalRawLen, decompressors }
}

/** True when `bytes` is an OCDB v4 (segmented) frame. */
export function isV4Frame(bytes: Uint8Array): boolean {
  return isFrame(bytes) && bytes[4] === VERSION_V4
}

/** Decodes a v4 SEGMENTED frame into its raw UTF-8 bytes, fail-closed. */
function decompressSegmented(bytes: Uint8Array, codec: number): Uint8Array {
  const { totalRawLen, decompressors } = v4SegmentDecompressors(bytes, codec)
  const parts = decompressors.map((d) => d())
  const total = parts.reduce((s, p) => s + p.byteLength, 0)
  if (total !== totalRawLen) throw new OCDBFrameError(`corrupt frame: expected ${totalRawLen}, got ${total}`)
  const out = new Uint8Array(total)
  let o = 0
  for (const part of parts) {
    out.set(part, o)
    o += part.byteLength
  }
  return out
}

/**
 * v5 DELTA_REF frame (epoch-4 #10). Stores a value as a SPARSE CORRECTION
 * against a base value already in `event_value`, for record-structured data
 * (e.g. info.summary.diffs across turns) where consecutive values share most
 * content. Detected by version byte 5 within the "OCDB" magic (isFrame still
 * matches; an old binary encountering 5 fails-closed). The correction payload
 * is an entropy-coded (compressed) stream of COPY/LITERAL ops; rehydration
 * loads the base via (aggregate_id, value_id) and applies the correction.
 * Fail-closed: a missing/dangling base throws OCDBFrameError (quarantined by
 * the ops-v2 repair path) — never silent degrade.
 *
 * Header (variable): magic(4) | version(1)=5 | codec(1) | totalRawLen(4) |
 * baseValueIdLen(4) | baseValueId(n) | crc32(4, over compressed correction) |
 * correction(k, compressed COPY/LITERAL op stream).
 */
const DELTA_TAG_LITERAL = 0x00
const DELTA_TAG_COPY = 0x01
const DELTA_MIN_COPY = 4
const DELTA_MAX_COPY = 65535
const DELTA_MAX_LITERAL = 65535

/** True when `bytes` is an OCDB v5 (delta_ref) frame. */
export function isV5Frame(bytes: Uint8Array): boolean {
  return isFrame(bytes) && bytes[4] === VERSION_V5
}

/**
 * Greedy COPY/LITERAL diff of `newValue` against `base`. Emits a stream of ops:
 *   LITERAL: 0x00 + uint16 len + len bytes
 *   COPY:    0x01 + uint32 offset_in_base + uint16 len
 * The op stream is later compressed by the frame codec (entropy coding). A
 * rolling-window index over `base` makes matching O(n) on average.
 */
export function encodeV5Correction(base: Uint8Array, newValue: Uint8Array): Uint8Array {
  const index = new Map<number, number[]>()
  for (let p = 0; p + DELTA_MIN_COPY <= base.length; p++) {
    const w = (base[p] << 24) | (base[p + 1] << 16) | (base[p + 2] << 8) | base[p + 3]
    let list = index.get(w)
    if (list === undefined) {
      list = []
      index.set(w, list)
    }
    list.push(p)
  }
  const out: number[] = []
  let lit: number[] = []
  const flushLit = () => {
    if (lit.length === 0) return
    for (let s = 0; s < lit.length; s += DELTA_MAX_LITERAL) {
      const chunk = lit.slice(s, s + DELTA_MAX_LITERAL)
      out.push(DELTA_TAG_LITERAL, (chunk.length >> 8) & 0xff, chunk.length & 0xff, ...chunk)
    }
    lit = []
  }
  let i = 0
  while (i < newValue.length) {
    if (i + DELTA_MIN_COPY > newValue.length) {
      lit.push(newValue[i])
      i++
      continue
    }
    const w = (newValue[i] << 24) | (newValue[i + 1] << 16) | (newValue[i + 2] << 8) | newValue[i + 3]
    const candidates = index.get(w)
    let bestLen = 0
    let bestOff = 0
    if (candidates !== undefined) {
      for (const off of candidates) {
        let len = DELTA_MIN_COPY
        while (
          i + len < newValue.length &&
          off + len < base.length &&
          newValue[i + len] === base[off + len] &&
          len < DELTA_MAX_COPY
        ) {
          len++
        }
        if (len > bestLen) {
          bestLen = len
          bestOff = off
        }
      }
    }
    if (bestLen >= DELTA_MIN_COPY) {
      flushLit()
      out.push(
        DELTA_TAG_COPY,
        (bestOff >>> 24) & 0xff,
        (bestOff >>> 16) & 0xff,
        (bestOff >>> 8) & 0xff,
        bestOff & 0xff,
        (bestLen >> 8) & 0xff,
        bestLen & 0xff,
      )
      i += bestLen
    } else {
      lit.push(newValue[i])
      i++
    }
  }
  flushLit()
  return new Uint8Array(out)
}

/**
 * Applies a COPY/LITERAL op stream (from `encodeV5Correction`) to `base`,
 * producing the reconstructed value. Fail-closed: a bad op tag or a final
 * length mismatch throws OCDBFrameError.
 */
export function applyV5Correction(
  base: Uint8Array,
  correction: Uint8Array,
  totalRawLen: number,
): Uint8Array {
  const out: number[] = []
  let p = 0
  while (p < correction.length) {
    const tag = correction[p++]
    if (tag === DELTA_TAG_LITERAL) {
      const len = (correction[p++] << 8) | correction[p++]
      for (let k = 0; k < len; k++) out.push(correction[p++])
    } else if (tag === DELTA_TAG_COPY) {
      const off = (correction[p++] << 24) | (correction[p++] << 16) | (correction[p++] << 8) | correction[p++]
      const len = (correction[p++] << 8) | correction[p++]
      for (let k = 0; k < len; k++) out.push(base[off + k])
    } else {
      throw new OCDBFrameError(`bad delta op tag ${tag} — ${restoreHint}`)
    }
  }
  const raw = new Uint8Array(out)
  if (raw.length !== totalRawLen) {
    throw new OCDBFrameError(`delta length mismatch: expected ${totalRawLen}, got ${raw.length} — ${restoreHint}`)
  }
  return raw
}

/** Parses a v5 delta_ref frame header (pure). */
export function parseV5Header(bytes: Uint8Array): {
  codec: number
  totalRawLen: number
  baseValueId: string
  correction: Uint8Array
  storedCrc: number
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const codec = bytes[5]
  const totalRawLen = view.getUint32(6, true)
  const baseValueIdLen = view.getUint32(10, true)
  let p = 14
  const baseValueId = decoder.decode(bytes.subarray(p, p + baseValueIdLen))
  p += baseValueIdLen
  const storedCrc = view.getUint32(p, true)
  p += 4
  const correction = bytes.subarray(p)
  return { codec, totalRawLen, baseValueId, correction, storedCrc }
}

/** Decodes (CRC-verify + decompress) a v5 correction payload (pure). */
export function decodeV5Correction(correction: Uint8Array, codec: number, storedCrc: number): Uint8Array {
  if (crc32(correction) !== storedCrc) throw new OCDBFrameError(`delta CRC mismatch — ${restoreHint}`)
  return decompressWith(correction, codec)
}

/**
 * Builds a v5 delta_ref frame: `newValue` stored as a sparse correction against
 * `base` (already in event_value under `baseValueId`). Pure — the caller
 * supplies the base bytes; the DB load happens on the read path.
 */
export function compressDeltaRef(
  newValue: Uint8Array,
  base: Uint8Array,
  baseValueId: string,
  codec: number,
  level: number,
): Uint8Array {
  const correction = encodeV5Correction(base, newValue)
  const { payload } = compressWith(correction, codec, level)
  const baseIdBytes = encoder.encode(baseValueId)
  const out = new Uint8Array(14 + baseIdBytes.length + 4 + payload.length)
  out.set(MAGIC)
  out[4] = VERSION_V5
  out[5] = codec
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(6, newValue.length, true)
  view.setUint32(10, baseIdBytes.length, true)
  let p = 14
  out.set(baseIdBytes, p)
  p += baseIdBytes.length
  view.setUint32(p, crc32(payload), true)
  p += 4
  out.set(payload, p)
  return out
}

/** Decodes a frame v2 (or v1) into its raw UTF-8 bytes, fail-closed. */
function decompressFrameRaw(bytes: Uint8Array): Uint8Array {
  if (
    bytes.byteLength < 4 ||
    bytes[0] !== MAGIC[0] ||
    bytes[1] !== MAGIC[1] ||
    bytes[2] !== MAGIC[2] ||
    bytes[3] !== MAGIC[3]
  ) {
    throw new OCDBFrameError(`bad magic — ${restoreHint}`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = bytes[4]
  const codec = bytes[5]
  if (version === 1) {
    // v1: 10-byte header, no CRC.
    const expected = view.getUint32(6, true)
    if (expected > RAWLEN_PRE_CAP) throw new OCDBFrameError(`rawLen ${expected} exceeds pre-cap — ${restoreHint}`)
    const raw = decompressWith(bytes.subarray(10), codec)
    if (raw.byteLength !== expected) throw new OCDBFrameError(`corrupt frame: expected ${expected}, got ${raw.byteLength}`)
    return raw
  }
  if (version === VERSION_V2 || version === VERSION) {
    const expected = view.getUint32(6, true)
    if (expected > RAWLEN_PRE_CAP) throw new OCDBFrameError(`rawLen ${expected} exceeds pre-cap — ${restoreHint}`)
    const storedCrc = view.getUint32(10, true)
    const compressed = bytes.subarray(HEADER)
    if (version === VERSION) {
      // v3: CRC covers the COMPRESSED bytes — verify BEFORE decompress (cheap,
      // ~7-14x less work than CRC-over-raw) and fail-closed on mismatch.
      if (crc32(compressed) !== storedCrc) throw new OCDBFrameError(`CRC mismatch — ${restoreHint}`)
      const raw = decompressWith(compressed, codec)
      if (raw.byteLength !== expected) throw new OCDBFrameError(`corrupt frame: expected ${expected}, got ${raw.byteLength}`)
      return raw
    }
    // v2: CRC covers the raw (decompressed) bytes — backward compat with frames
    // already sealed in production DBs.
    const raw = decompressWith(compressed, codec)
    if (raw.byteLength !== expected) throw new OCDBFrameError(`corrupt frame: expected ${expected}, got ${raw.byteLength}`)
    if (crc32(raw) !== storedCrc) throw new OCDBFrameError(`CRC mismatch — ${restoreHint}`)
    return raw
  }
  if (version === VERSION_V4) return decompressSegmented(bytes, codec)
  throw new OCDBFrameError(`unsupported version ${version} — ${restoreHint}`)
}

/** Decodes a frame v2 (or v1) into its raw UTF-8 string, fail-closed. */
export function decompressFrame(bytes: Uint8Array): string {
  return decoder.decode(decompressFrameRaw(bytes))
}

function isFrame(value: Uint8Array): boolean {
  return (
    value.byteLength >= 4 &&
    value[0] === MAGIC[0] &&
    value[1] === MAGIC[1] &&
    value[2] === MAGIC[2] &&
    value[3] === MAGIC[3]
  )
}

function parseDriverValue(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value)
  let bytes: Uint8Array
  if (value instanceof Uint8Array) bytes = value
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value)
  else throw new OCDBFrameError(`unexpected driver value type ${typeof value}`)
  if (!isFrame(bytes)) return JSON.parse(decoder.decode(bytes))
  return JSON.parse(decompressFrame(bytes))
}

/**
 * Drizzle customType with IDENTITY toDriver. `{ mode: "json" }` is inert for
 * customType in drizzle-orm@1.0.0-rc.2 (verified — no double-encode); it is
 * kept to mirror the stock column signature and freeze future behavior.
 */
export const compressedJson = customType<{
  data: unknown
  driverData: string | Uint8Array
  config: { mode: "json" }
}>({
  dataType() {
    // Keep Drizzle schema and upstream migrations unchanged. Bound Uint8Array
    // still uses SQLite's BLOB storage class despite the TEXT affinity.
    return "text"
  },
  toDriver(value) {
    const text = JSON.stringify(value)
    if (text === undefined) return text
    return text
  },
  fromDriver(value) {
    return parseDriverValue(value)
  },
})

/** Public helper for the sealer: frame a raw JSON string if worth it. */
export const sealJson = compressText

/** Public helper for restore: decode any stored value back to its raw JSON string. */
export function restoreText(stored: string | Uint8Array): string {
  if (typeof stored === "string") return stored
  return decompressFrame(stored)
}

/**
 * Decodes `event_value.bytes` back to its raw JSON string for the read path
 * (readpath-v2) to rehydrate a `{"$cdbRef": "<id>"}` reference into the
 * original payload, byte-exact. The stored bytes may be an OCDB v2 frame
 * (decompress + CRC-verify) or a verbatim JSON UTF-8 BLOB (when compression
 * gained nothing at seal time); the magic check selects the right path. The
 * caller JSON.parses the result to obtain the original object.
 */
export function decodeValueBytes(bytes: Uint8Array): string {
  // Fast-path: a raw JSON BLOB (compression gained nothing at seal time) skips
  // the frame decode entirely. isFrame is a 4-byte compare, no allocation.
  if (isFrame(bytes)) return decompressFrame(bytes)
  return decoder.decode(bytes)
}

/**
 * Decodes `event_value.bytes` to its raw UTF-8 bytes WITHOUT parsing: decompress
 * if framed (CRC-verified), else return the bytes as-is. Used by the worker
 * decompress pool so the parsed object is never structured-cloned across the
 * worker boundary (cloning a large parsed object on the main thread is the
 * dominant cost of a pooled decode — see epoch-3 bench).
 */
export function decodeValueBytesRaw(bytes: Uint8Array): Uint8Array {
  return isFrame(bytes) ? decompressFrameRaw(bytes) : bytes
}

/**
 * FUSED single-pass decode for the rehydration read path (ANVIL Experiment M):
 * decompress (if framed) + parse JSON + expose the raw bytes for sha256
 * validation, in ONE pass. No intermediate JSON string is kept alive beyond the
 * parse, and the integrity digest is computed over the raw decompressed bytes —
 * so the caller pays `encoder.encode(json)` exactly ZERO times (the old path
 * re-encoded the decoded string). Returns the parsed object and the raw bytes.
 */
export function decodeValueBytesObject(bytes: Uint8Array): { value: unknown; raw: Uint8Array } {
  const raw = decodeValueBytesRaw(bytes)
  return { value: JSON.parse(decoder.decode(raw)), raw }
}

/**
 * Decode a stored `event_value.bytes` entry back to its raw JSON string for the
 * epoch-2 dedup layer. The entry may be a compressed frame (OCDB magic) OR raw
 * UTF-8 bytes — this decodes either way ("decompress if needed"). Used by the
 * reverse-export downgrade and the rehydration-sanity paths so a value stored
 * compressed or uncompressed round-trips to the identical original payload.
 */
export function decodeStored(stored: string | Uint8Array): string {
  if (typeof stored === "string") return stored
  return decodeValueBytes(stored)
}
