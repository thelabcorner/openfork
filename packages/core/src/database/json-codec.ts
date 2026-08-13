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
const VERSION = 2
const CODEC_ZSTD = 1
const CODEC_BROTLI = 2
const CODEC_DEFLATE = 3
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

const restoreHint = "run the restore CLI: bun x opencode-restore --db <path>"

export const Frame = { headerBytes: HEADER, version: VERSION } as const

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
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
export function compressText(json: string, options?: { codec?: 1 | 2 | 3; level?: number }): string | Uint8Array {
  if (json.length < THRESHOLD) return json
  const raw = encoder.encode(json)
  if (raw.byteLength > MAX_RAW) return json

  const codec = options?.codec ?? CODEC_BROTLI
  const level = options?.level ?? 1
  const { payload } = compressWith(raw, codec, level)
  // Header + payload must beat raw bytes by at least 24 to be worth framing.
  if (payload.byteLength + HEADER + 24 >= raw.byteLength) return json

  const output = new Uint8Array(HEADER + payload.byteLength)
  output.set(MAGIC)
  output[4] = VERSION
  output[5] = codec
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint32(6, raw.byteLength, true)
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint32(10, crc32(raw), true)
  output.set(payload, HEADER)
  return output
}

/** Decodes a frame v2 (or v1) into its raw UTF-8 string, fail-closed. */
export function decompressFrame(bytes: Uint8Array): string {
  if (bytes.byteLength < 4 || !MAGIC.every((byte, index) => bytes[index] === byte)) {
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
    return decoder.decode(raw)
  }
  if (version !== VERSION) throw new OCDBFrameError(`unsupported version ${version} — ${restoreHint}`)
  const expected = view.getUint32(6, true)
  if (expected > RAWLEN_PRE_CAP) throw new OCDBFrameError(`rawLen ${expected} exceeds pre-cap — ${restoreHint}`)
  const storedCrc = view.getUint32(10, true)
  const raw = decompressWith(bytes.subarray(HEADER), codec)
  if (raw.byteLength !== expected) throw new OCDBFrameError(`corrupt frame: expected ${expected}, got ${raw.byteLength}`)
  if (crc32(raw) !== storedCrc) throw new OCDBFrameError(`CRC mismatch — ${restoreHint}`)
  return decoder.decode(raw)
}

function isFrame(value: Uint8Array): boolean {
  return value.byteLength >= 4 && MAGIC.every((byte, index) => value[index] === byte)
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
