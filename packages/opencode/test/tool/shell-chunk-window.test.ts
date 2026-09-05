import { describe, expect, test } from "bun:test"
import { makeChunkWindow } from "../../src/tool/shell"

// Reference implementation of the pre-optimization Array.shift() eviction,
// kept here to prove behavioral equivalence of the head-index window.
function reference(chunks: string[], keepBytes: number): { text: string; cut: boolean } {
  const list: Array<{ text: string; size: number }> = []
  let used = 0
  let cut = false
  for (const text of chunks) {
    const size = Buffer.byteLength(text, "utf-8")
    list.push({ text, size })
    used += size
    while (used > keepBytes && list.length > 1) {
      const item = list.shift()
      if (!item) break
      used -= item.size
      cut = true
    }
  }
  return { text: list.map((item) => item.text).join(""), cut }
}

function mulberry(seed: number) {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe("chunk window", () => {
  test("retains everything under budget without cutting", () => {
    const window = makeChunkWindow(1024)
    window.push("hello")
    window.push(" world")
    expect(window.cut).toBe(false)
    expect(window.text()).toBe("hello world")
  })

  test("evicts oldest chunks beyond budget but always keeps one", () => {
    const window = makeChunkWindow(10)
    window.push("aaaaa")
    window.push("bbbbb")
    window.push("ccccc")
    expect(window.cut).toBe(true)
    // Two newest 5-byte chunks fit exactly; the oldest is gone.
    expect(window.text()).toBe("bbbbbccccc")
  })

  test("keeps a single oversized chunk alone without cutting", () => {
    const window = makeChunkWindow(4)
    window.push("way-too-long")
    expect(window.cut).toBe(false)
    expect(window.text()).toBe("way-too-long")
  })

  test("matches the legacy shift algorithm on scripted workloads", () => {
    const workloads: Array<{ chunks: string[]; keep: number }> = [
      { chunks: [], keep: 100 },
      { chunks: ["a"], keep: 100 },
      { chunks: ["ab", "cd", "ef"], keep: 4 },
      { chunks: ["hello", " ", "world", "!"], keep: 6 },
      { chunks: Array.from({ length: 5000 }, (_, i) => `line-${i}\n`), keep: 4096 },
      { chunks: ["x".repeat(10000)], keep: 100 },
      { chunks: ["é".repeat(100), "z".repeat(100)], keep: 150 },
    ]
    for (const { chunks, keep } of workloads) {
      const window = makeChunkWindow(keep)
      for (const chunk of chunks) window.push(chunk)
      const expected = reference(chunks, keep)
      expect({ text: window.text(), cut: window.cut }).toEqual(expected)
    }
  })

  test("matches the legacy shift algorithm on seeded random workloads", () => {
    const random = mulberry(42)
    for (let trial = 0; trial < 20; trial++) {
      const keep = 1 + Math.floor(random() * 500)
      const count = 1 + Math.floor(random() * 300)
      const chunks = Array.from({ length: count }, () => {
        const length = 1 + Math.floor(random() * 60)
        return Array.from({ length }, () => String.fromCharCode(32 + Math.floor(random() * 95))).join("")
      })
      const window = makeChunkWindow(keep)
      for (const chunk of chunks) window.push(chunk)
      const expected = reference(chunks, keep)
      expect({ text: window.text(), cut: window.cut }).toEqual(expected)
    }
  })
})
