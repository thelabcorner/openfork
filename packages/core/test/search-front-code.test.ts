import { describe, expect, test } from "bun:test"
import { FrontCode, compareBytes, crc32, decodeVarint, frontDecode, frontEncode } from "@opencode-ai/core/search/front-code"

const mulberry = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const SEGMENTS = ["src", "packages", "core", "test", "search", "index", "chunk", "store", "a", "bb", "ccc"]
const UNICODE = ["éclair", "êxtreme", "日本語", "emoji-🎉", "ünïcode/päth.ts"]

function randomPaths(rand: () => number, count: number): string[] {
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const segs = 1 + ((rand() * 5) | 0)
    const parts: string[] = []
    for (let s = 0; s < segs; s++) parts.push(SEGMENTS[(rand() * SEGMENTS.length) | 0]!)
    if (rand() < 0.15) parts.push(UNICODE[(rand() * UNICODE.length) | 0]!)
    out.push(parts.join("/") + (rand() < 0.7 ? ".ts" : ""))
  }
  return out
}

const sortedBytes = (paths: string[]) => paths.map((p) => new TextEncoder().encode(p)).sort(compareBytes)

describe("FrontCode", () => {
  test("roundtrips an empty set", () => {
    expect(frontDecode(frontEncode([]), 0)).toEqual([])
  })

  test("roundtrips a single entry", () => {
    const sorted = sortedBytes(["src/index.ts"])
    expect(frontDecode(frontEncode(sorted), 1)).toEqual(["src/index.ts"])
  })

  test("roundtrips entries sharing long prefixes", () => {
    const sorted = sortedBytes([
      "packages/core/src/search/a.ts",
      "packages/core/src/search/ab.ts",
      "packages/core/src/search/abc.ts",
      "packages/core/src/search/b.ts",
      "packages/core/src/searx/z.ts",
    ])
    expect(frontDecode(frontEncode(sorted), sorted.length)).toEqual([
      "packages/core/src/search/a.ts",
      "packages/core/src/search/ab.ts",
      "packages/core/src/search/abc.ts",
      "packages/core/src/search/b.ts",
      "packages/core/src/searx/z.ts",
    ])
  })

  test("roundtrips non-ASCII entries whose shared prefix ends mid-character", () => {
    // "é" (0xC3 0xA9) and "ê" (0xC3 0xAA) share exactly one byte; decoding the
    // suffix alone would produce U+FFFD.
    const sorted = sortedBytes(["éclair", "êxtreme"])
    expect(frontDecode(frontEncode(sorted), 2)).toEqual(["éclair", "êxtreme"])
  })

  test("property: random sorted path sets roundtrip byte-exact", () => {
    const rand = mulberry(1337)
    for (let trial = 0; trial < 50; trial++) {
      const paths = randomPaths(rand, 1 + ((rand() * 500) | 0))
      const sorted = sortedBytes(paths)
      const decoded = frontDecode(frontEncode(sorted), sorted.length)
      expect(decoded).toEqual(paths.map((p) => p).sort((a, b) => compareBytes(new TextEncoder().encode(a), new TextEncoder().encode(b))))
    }
  })

  test("varint roundtrip across the 7/14/21/28-bit boundaries", () => {
    for (const value of [0, 1, 127, 128, 16383, 16384, 2097151, 2097152, 268435455, 268435456]) {
      const buf = new Uint8Array(5)
      const len = FrontCode.appendVarint(buf, 0, value)
      expect(decodeVarint(buf, 0)).toEqual({ value, pos: len })
    }
  })

  test("decode fails closed on truncated input", () => {
    const sorted = sortedBytes(["src/index.ts", "src/other.ts"])
    const encoded = frontEncode(sorted)
    expect(() => frontDecode(encoded.subarray(0, encoded.length - 2), 2)).toThrow()
    expect(() => frontDecode(encoded, 99)).toThrow()
  })

  test("crc32 matches known vectors", () => {
    expect(crc32(new TextEncoder().encode(""))).toBe(0)
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926)
  })
})
