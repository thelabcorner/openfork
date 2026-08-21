/**
 * Isolated front-coding prototype for ChunkDB discussion.
 *
 * This deliberately does not import or alter production ChunkDB code. It
 * compares chunked front-coded records + zstd-3 against the current
 * event_value shape (one independently compressed, deduplicated value per
 * payload). Run from packages/core: `bun test/bench-frontcode.ts`.
 */
import { createHash } from "node:crypto"
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const N = 2_000
const AGGREGATES = 50
const CHUNK = 64

type Event = { aggregate: string; seq: number; value: string }
type Chunk = { first: number; count: number; bytes: Uint8Array; rawBytes: number }

function payload(i: number): string {
  const repeated = i % 10 < 3
  const text = repeated
    ? "The tool completed successfully. No further action is required. ".repeat(90)
    : `The model inspected src/session/${i % 17}/history.ts and found a stable continuation boundary. `.repeat(35)
  return JSON.stringify({
    type: i % 4 === 0 ? "message.updated" : "session.updated",
    sessionID: `sess_${i % AGGREGATES}`,
    messageID: repeated ? `repeat_${i % 5}` : `msg_${i % 400}`,
    ...(repeated ? {} : { seq: i + 1 }),
    role: i % 4 === 0 ? "assistant" : "user",
    model: "anthropic/claude-sonnet-4-20250514",
    content: text,
    tool: i % 7 === 0 ? { name: "shell", status: "completed", command: "bun test packages/core" } : undefined,
  })
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

function varint(n: number): number[] {
  const out: number[] = []
  do {
    out.push((n & 0x7f) | (n >= 128 ? 0x80 : 0))
    n = Math.floor(n / 128)
  } while (n)
  return out
}

function encodeChunk(events: Event[]): { bytes: Uint8Array; rawBytes: number } {
  const out: number[] = []
  let previous = ""
  let rawBytes = 0
  for (const event of events) {
    rawBytes += encoder.encode(event.value).byteLength
    const prefix = commonPrefix(previous, event.value)
    const suffix = encoder.encode(event.value.slice(prefix))
    out.push(...varint(prefix), ...varint(suffix.byteLength), ...suffix)
    previous = event.value
  }
  const raw = Uint8Array.from(out)
  return {
    bytes: zstdCompressSync(raw, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }),
    rawBytes,
  }
}

function decodeChunk(chunk: Chunk): string[] {
  const raw = zstdDecompressSync(chunk.bytes)
  const values: string[] = []
  let offset = 0
  let previous = ""
  const readVarint = () => {
    let value = 0
    let shift = 0
    for (;;) {
      const byte = raw[offset++]!
      value += (byte & 0x7f) * 2 ** shift
      if (!(byte & 0x80)) return value
      shift += 7
    }
  }
  for (let i = 0; i < chunk.count; i++) {
    const prefix = readVarint()
    const length = readVarint()
    const suffix = decoder.decode(raw.subarray(offset, offset + length))
    offset += length
    previous = previous.slice(0, prefix) + suffix
    values.push(previous)
  }
  return values
}

function ms(fn: () => void): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const events = Array.from({ length: N }, (_, i) => ({ aggregate: `agg_${i % AGGREGATES}`, seq: i, value: payload(i) })).sort((a, b) => a.aggregate.localeCompare(b.aggregate) || a.seq - b.seq)
const rawBytes = events.reduce((sum, event) => sum + encoder.encode(event.value).byteLength, 0)
const chunks: Chunk[] = []
for (let i = 0; i < events.length; i += CHUNK) {
  const encoded = encodeChunk(events.slice(i, i + CHUNK))
  chunks.push({ first: i, count: Math.min(CHUNK, events.length - i), ...encoded })
}

// Current event_value approximation: zstd-3 per unique sha256 payload, with
// the 14-byte OCDB header and a small reference object per event.
const values = new Map<string, Uint8Array>()
for (const event of events) {
  const hash = createHash("sha256").update(event.value).digest("hex")
  if (!values.has(hash)) values.set(hash, zstdCompressSync(encoder.encode(event.value), { params: { [constants.ZSTD_c_compressionLevel]: 3 } }))
}
const currentBytes = [...values.values()].reduce((sum, value) => sum + value.byteLength + 14, 0) + N * 40
const frontBytes = chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength + 16, 0)

const fullFront = median([1, 2, 3].map(() => ms(() => chunks.flatMap(decodeChunk))))
const fullCurrent = median([1, 2, 3].map(() => ms(() => events.map((event) => zstdDecompressSync(values.get(createHash("sha256").update(event.value).digest("hex"))!)))))
const selected = events.filter((event) => event.aggregate === "agg_17")
const selectedFirst = events.findIndex((event) => event.aggregate === "agg_17")
const selectedLast = selectedFirst + selected.length
const selectedChunks = chunks.filter((chunk) => chunk.first < selectedLast && chunk.first + chunk.count > selectedFirst)
const partialFront = median([1, 2, 3].map(() => ms(() => selectedChunks.flatMap(decodeChunk))))
const partialCurrent = median([1, 2, 3].map(() => ms(() => selected.map((event) => zstdDecompressSync(values.get(createHash("sha256").update(event.value).digest("hex"))!)))))

const append = events.slice(-100)
const appendFront = median([1, 2, 3].map(() => ms(() => append.map((event) => encodeChunk([event])))))
const appendCurrent = median([1, 2, 3].map(() => ms(() => append.map((event) => zstdCompressSync(encoder.encode(event.value), { params: { [constants.ZSTD_c_compressionLevel]: 3 } })))))
const updateIndex = 777
const updateFront = median([1, 2, 3].map(() => ms(() => encodeChunk(events.slice(Math.floor(updateIndex / CHUNK) * CHUNK, Math.floor(updateIndex / CHUNK) * CHUNK + CHUNK)))))
const updateCurrent = median([1, 2, 3].map(() => ms(() => zstdCompressSync(encoder.encode(events[updateIndex]!.value), { params: { [constants.ZSTD_c_compressionLevel]: 3 } }))))

const result = {
  corpus: { events: N, aggregates: AGGREGATES, chunkEvents: CHUNK, rawBytes, uniqueValues: values.size },
  storage: { frontCodedZstd3Bytes: frontBytes, currentEventValueApproxBytes: currentBytes, frontVsCurrent: currentBytes / frontBytes, rawVsFront: rawBytes / frontBytes },
  timingsMs: { fullLoadFront: fullFront, fullLoadCurrent: fullCurrent, partialLoadFront: partialFront, partialLoadCurrent: partialCurrent, append100Front: appendFront, append100Current: appendCurrent, updateOneFrontRewriteChunk: updateFront, updateOneCurrentValue: updateCurrent },
}
console.log(JSON.stringify(result, null, 2))
