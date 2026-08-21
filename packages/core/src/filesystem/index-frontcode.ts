import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { Hash } from "../util/hash"

const MAGIC = new Uint8Array([0x46, 0x49, 0x44, 0x58])
const VERSION = 1
const HEADER = 13
const MAX_RAW_BYTES = 16 * 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export type FrontEntry = { dir: string; path: string; type: "file" | "directory" }
export type FrontChunk = { name: string; first: number; count: number; rawBytes: number; storedBytes: number; sha256: string }
export type FrontManifest = {
  format: "file-index-frontcode"
  version: 1
  generation: string
  builtAt: number
  root: string
  rootStat: { mtimeMs: number; size: number; ino: number }
  chunks: FrontChunk[]
}

export function encodeChunk(entries: readonly FrontEntry[]): Uint8Array {
  const pieces: number[] = []
  let previous = new Uint8Array()
  for (const entry of entries) {
    const current = encoder.encode(JSON.stringify(entry))
    let prefix = 0
    while (prefix < previous.length && prefix < current.length && previous[prefix] === current[prefix]) prefix++
    appendVarint(pieces, prefix)
    appendVarint(pieces, current.length - prefix)
    pieces.push(...current.subarray(prefix))
    previous = current
  }
  const raw = Uint8Array.from(pieces)
  if (raw.length > MAX_RAW_BYTES) throw new Error("front-coded file-index chunk exceeds read bound")
  const compressed = zstdCompressSync(raw, { params: { [constants.ZSTD_c_compressionLevel]: 3 } })
  const frame = new Uint8Array(HEADER + compressed.length)
  frame.set(MAGIC)
  frame[4] = VERSION
  new DataView(frame.buffer).setUint32(5, raw.length, true)
  new DataView(frame.buffer).setUint32(9, entries.length, true)
  frame.set(compressed, HEADER)
  return frame
}

export function decodeChunk(frame: Uint8Array): FrontEntry[] {
  if (frame.length < HEADER || !MAGIC.every((value, index) => frame[index] === value) || frame[4] !== VERSION) throw new Error("invalid file-index chunk header")
  const rawLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(5, true)
  const count = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(9, true)
  if (rawLength > MAX_RAW_BYTES || count > 100_000) throw new Error("file-index chunk exceeds bounds")
  const raw = zstdDecompressSync(frame.subarray(HEADER), { maxOutputLength: rawLength })
  if (raw.length !== rawLength) throw new Error("file-index chunk length mismatch")
  const output: FrontEntry[] = []
  let offset = 0
  let previous = new Uint8Array()
  for (let index = 0; index < count; index++) {
    const prefix = readVarint(raw, () => offset++)
    const length = readVarint(raw, () => offset++)
    if (prefix > previous.length || length > raw.length - offset) throw new Error("invalid file-index front-code record")
    const current = new Uint8Array(prefix + length)
    current.set(previous.subarray(0, prefix))
    current.set(raw.subarray(offset, offset + length), prefix)
    offset += length
    const entry = JSON.parse(decoder.decode(current)) as FrontEntry
    if (!entry || typeof entry.dir !== "string" || typeof entry.path !== "string" || (entry.type !== "file" && entry.type !== "directory")) throw new Error("invalid file-index entry")
    output.push(entry)
    previous = current
  }
  if (offset !== raw.length) throw new Error("trailing file-index chunk bytes")
  return output
}

export function chunkDigest(bytes: Uint8Array): string {
  return Hash.sha256(Buffer.from(bytes))
}

export function chunkRawBytes(frame: Uint8Array): number {
  if (frame.length < HEADER) throw new Error("invalid file-index chunk header")
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(5, true)
}

export function manifestDigest(manifest: FrontManifest): string {
  return Hash.sha256(Buffer.from(JSON.stringify(manifest)))
}

function appendVarint(output: number[], value: number) {
  do {
    output.push((value & 0x7f) | (value >= 128 ? 0x80 : 0))
    value = Math.floor(value / 128)
  } while (value)
}

function readVarint(raw: Uint8Array, next: () => number): number {
  let value = 0
  let shift = 0
  for (;;) {
    const byte = raw[next()]
    if (byte === undefined || shift > 28) throw new Error("invalid file-index varint")
    value += (byte & 0x7f) * 2 ** shift
    if (!(byte & 0x80)) return value
    shift += 7
  }
}

export * as IndexFrontcode from "./index-frontcode"
