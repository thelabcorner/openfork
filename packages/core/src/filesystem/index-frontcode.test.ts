import { describe, expect, test } from "bun:test"
import { IndexFrontcode } from "./index-frontcode"

const entries = Array.from({ length: 260 }, (_, index) => ({
  dir: `src/${String(index % 13).padStart(2, "0")}`,
  path: `src/${String(index % 13).padStart(2, "0")}/file-${String(index).padStart(4, "0")}.ts`,
  type: index % 17 === 0 ? "directory" as const : "file" as const,
}))

describe("FileIndex front-coded persistence", () => {
  test("round trips records across chunk boundaries", () => {
    const frame = IndexFrontcode.encodeChunk(entries.slice(0, 128))
    expect(IndexFrontcode.decodeChunk(frame)).toEqual(entries.slice(0, 128))
    const final = IndexFrontcode.encodeChunk(entries.slice(128))
    expect(IndexFrontcode.decodeChunk(final)).toEqual(entries.slice(128))
  })

  test("fails closed for header, truncation and compressed corruption", () => {
    const frame = IndexFrontcode.encodeChunk(entries)
    for (const damaged of [frame.slice(0, 12), Uint8Array.from(frame, (value, index) => index === 4 ? value ^ 1 : value)]) {
      expect(() => IndexFrontcode.decodeChunk(damaged)).toThrow()
    }
  })

  test("rejects a corrupted front-code length instead of returning a prefix", () => {
    const frame = IndexFrontcode.encodeChunk(entries.slice(0, 2))
    const damaged = frame.slice()
    damaged[9] = 3
    damaged[10] = 0
    damaged[11] = 0
    damaged[12] = 0
    expect(() => IndexFrontcode.decodeChunk(damaged)).toThrow()
  })

  test("rejects forged raw length and record count metadata", () => {
    const frame = IndexFrontcode.encodeChunk(entries.slice(0, 8))

    // The header is authenticated by the manifest at the snapshot layer, but
    // decodeChunk must still reject metadata that disagrees with decompression.
    const wrongRawLength = frame.slice()
    new DataView(wrongRawLength.buffer, wrongRawLength.byteOffset, wrongRawLength.byteLength).setUint32(5, 0, true)
    expect(() => IndexFrontcode.decodeChunk(wrongRawLength)).toThrow()

    const tooManyRecords = frame.slice()
    new DataView(tooManyRecords.buffer, tooManyRecords.byteOffset, tooManyRecords.byteLength).setUint32(9, 9, true)
    expect(() => IndexFrontcode.decodeChunk(tooManyRecords)).toThrow()

    const absurdRawLength = frame.slice()
    new DataView(absurdRawLength.buffer, absurdRawLength.byteOffset, absurdRawLength.byteLength).setUint32(5, 0xffffffff, true)
    expect(() => IndexFrontcode.decodeChunk(absurdRawLength)).toThrow()
  })

  test("rejects invalid entry types rather than returning corrupted records", () => {
    const invalid = [{ dir: "src", path: "src/a.ts", type: "symlink" }] as unknown as IndexFrontcode.FrontEntry[]
    expect(() => IndexFrontcode.decodeChunk(IndexFrontcode.encodeChunk(invalid))).toThrow()
  })

  test("digest changes for every persisted byte mutation", () => {
    const frame = IndexFrontcode.encodeChunk(entries.slice(0, 8))
    const damaged = frame.slice()
    damaged[damaged.length - 1] ^= 1
    expect(IndexFrontcode.chunkDigest(frame)).not.toBe(IndexFrontcode.chunkDigest(damaged))
  })
})
