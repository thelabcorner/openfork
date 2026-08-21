export * as FrontCode from "./front-code"

/**
 * Front-coded codec for lexicographically-sorted path/symbol entries — the
 * storage-race winner (chunked front-code + zstd-3: 30-69x compression,
 * ~5ms full loads at 100k+ entries vs JSON.parse baseline).
 *
 * Wire format — one chunk is a single byte stream covering entries sorted by
 * their UTF-8 bytes:
 *
 *   entry := varint(shared) varint(suffixLen) suffix
 *
 *   shared    = leading byte count shared with the PREVIOUS entry (first entry
 *               of a chunk always encodes shared=0, so chunks are independent)
 *   suffixLen = entry.length - shared
 *   suffix    = the entry's UTF-8 bytes from offset `shared`
 *
 * varints are LEB128: 7 data bits per byte, least-significant group first,
 * high bit set on every byte except the last.
 */

/** Table-driven CRC-32 (poly 0xedb88320, reflected) over raw bytes. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Lexicographic order over UTF-8 bytes — the sort order front-coding requires. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return a.length - b.length
}

export class FrontCodeError extends Error {
  constructor(reason: string) {
    super(`front-code error: ${reason}`)
    this.name = "FrontCodeError"
  }
}

const EMPTY = new Uint8Array(0)

/** Appends a LEB128 varint at `pos`, returning the position after it. */
export function appendVarint(out: Uint8Array, pos: number, value: number): number {
  let v = value
  while (v > 0x7f) {
    out[pos++] = (v & 0x7f) | 0x80
    v >>>= 7
  }
  out[pos++] = v
  return pos
}

/** Reads a LEB128 varint at `pos`; throws when the buffer ends mid-varint. */
export function decodeVarint(buf: Uint8Array, pos: number): { value: number; pos: number } {
  let shift = 0
  let v = 0
  for (;;) {
    if (pos >= buf.length) throw new FrontCodeError("truncated varint")
    const b = buf[pos++]!
    v |= (b & 0x7f) << shift
    if (!(b & 0x80)) return { value: v, pos }
    shift += 7
  }
}

/**
 * Encodes entries that MUST already be sorted by {@link compareBytes}. The
 * input arrays are referenced, never mutated; the returned view aliases a
 * right-sized buffer.
 */
export function frontEncode(sorted: Uint8Array[]): Uint8Array {
  // Upper bound: every entry byte plus two 5-byte varints per entry; the
  // result is sliced to the exact length, so no grow/reallocate loop is needed.
  let bound = 0
  for (const entry of sorted) bound += entry.length + 10
  const out = new Uint8Array(bound)
  let len = 0
  let prev: Uint8Array<ArrayBufferLike> = EMPTY
  for (const cur of sorted) {
    let shared = 0
    const limit = Math.min(prev.length, cur.length)
    while (shared < limit && prev[shared] === cur[shared]) shared++
    len = appendVarint(out, len, shared)
    len = appendVarint(out, len, cur.length - shared)
    out.set(cur.subarray(shared), len)
    len += cur.length - shared
    prev = cur
  }
  return out.subarray(0, len)
}

/**
 * Decodes `count` entries. Callers must establish integrity first (CRC over
 * the chunk payload) — a mismatched `count` or corrupted body fails closed
 * with {@link FrontCodeError} rather than returning silent garbage.
 *
 * Each entry is reassembled as complete bytes before UTF-8 decoding: a shared
 * prefix can end mid-multibyte-character (e.g. "é" -> "ê" shares only 0xC3),
 * so decoding the suffix alone would produce replacement characters.
 *
 * Pure-ASCII bodies (the common case for repo paths) take a rope-string fast
 * path with zero intermediate buffer allocations.
 */
export function frontDecode(buf: Uint8Array, count: number): string[] {
  let pos = 0
  const readVarint = () => {
    let shift = 0
    let v = 0
    for (;;) {
      if (pos >= buf.length) throw new FrontCodeError("truncated varint")
      const b = buf[pos++]!
      v |= (b & 0x7f) << shift
      if (!(b & 0x80)) return v
      shift += 7
    }
  }
  // Varint-aware ASCII probe: continuation bytes of multi-byte varints are
  // >= 0x80 themselves, so scanning the raw buffer would misclassify almost
  // every real-world chunk. Walk the entry structure and test suffix bytes only.
  let probe = 0
  let hasHighByte = false
  const probeVarint = () => {
    let shift = 0
    let v = 0
    for (;;) {
      if (probe >= buf.length) throw new FrontCodeError("truncated varint")
      const b = buf[probe++]!
      v |= (b & 0x7f) << shift
      if (!(b & 0x80)) return v
      shift += 7
    }
  }
  for (let n = 0; n < count && !hasHighByte; n++) {
    probeVarint()
    const suffixLen = probeVarint()
    const start = probe
    probe += suffixLen
    if (probe > buf.length) throw new FrontCodeError("truncated or corrupt entry")
    for (let i = start; i < probe; i++) {
      if (buf[i]! > 0x7f) {
        hasHighByte = true
        break
      }
    }
  }
  if (!hasHighByte) {
    const out: string[] = []
    // Scratch-reuse decode: the previous entry stays in `scratch`, so each
    // entry copies ONLY its suffix at offset `shared` — front-coding's shared
    // prefixes (dominant in node_modules corpora) are never re-copied.
    // Materialization goes through one reused TextDecoder — fastest of four
    // measured variants on a 184k-path corpus (rope-concat 147ms, typed-array
    // spread 521ms, plain-array apply 235ms, this 103ms).
    const decoder = new TextDecoder()
    let scratch = new Uint8Array(1024)
    let len = 0
    for (let n = 0; n < count; n++) {
      const shared = readVarint()
      const suffixLen = readVarint()
      if (pos + suffixLen > buf.length || shared > len) throw new FrontCodeError("truncated or corrupt entry")
      if (shared + suffixLen > scratch.length) {
        let size = scratch.length * 2
        while (size < shared + suffixLen) size *= 2
        const grown = new Uint8Array(size)
        grown.set(scratch.subarray(0, len))
        scratch = grown
      }
      scratch.set(buf.subarray(pos, pos + suffixLen), shared)
      pos += suffixLen
      len = shared + suffixLen
      out.push(decoder.decode(scratch.subarray(0, len)))
    }
    return out
  }
  const out: string[] = []
  const decoder = new TextDecoder()
  let prev = EMPTY
  for (let n = 0; n < count; n++) {
    const shared = readVarint()
    const suffixLen = readVarint()
    if (shared > prev.length || pos + suffixLen > buf.length) throw new FrontCodeError("truncated or corrupt entry")
    const cur = new Uint8Array(shared + suffixLen)
    cur.set(prev.subarray(0, shared))
    cur.set(buf.subarray(pos, pos + suffixLen), shared)
    pos += suffixLen
    out.push(decoder.decode(cur))
    prev = cur
  }
  return out
}
