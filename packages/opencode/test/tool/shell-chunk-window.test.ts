import { describe, expect, test } from "bun:test"
import { makeChunkWindow } from "../../src/tool/shell"
import { ToolOutputProjection } from "@opencode-ai/core/tool-output-projection"

function reference(chunks: string[], keepBytes: number) {
  const all = chunks.join("")
  const bytes = Buffer.byteLength(all, "utf-8")
  const headBudget = Math.ceil(keepBytes / 2)
  const tailBudget = Math.floor(keepBytes / 2)
  if (bytes <= keepBytes) {
    return { all, cut: false }
  }
  return {
    head: ToolOutputProjection.takePrefixBytes(all, headBudget),
    tail: ToolOutputProjection.takeSuffixBytes(all, tailBudget),
    cut: true,
  }
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

  test("retains deterministic head and tail beyond budget", () => {
    const window = makeChunkWindow(10)
    window.push("aaaaa")
    window.push("bbbbb")
    window.push("ccccc")
    expect(window.cut).toBe(true)
    expect(window.snapshot()).toMatchObject({ head: "aaaaa", tail: "ccccc", totalBytes: 15 })
    expect(window.text()).toContain("middle output omitted")
  })

  test("bounds a single oversized chunk and preserves both edges", () => {
    const window = makeChunkWindow(4)
    window.push("way-too-long")
    expect(window.cut).toBe(true)
    expect(window.snapshot()).toMatchObject({ head: "wa", tail: "ng", totalBytes: 12 })
    expect(Buffer.byteLength(window.snapshot().head + window.snapshot().tail, "utf-8")).toBeLessThanOrEqual(4)
  })

  test("matches the bounded head-tail reference on scripted workloads", () => {
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
      const snapshot = window.snapshot()
      if (expected.cut) expect(snapshot).toMatchObject(expected)
      else {
        expect(snapshot.cut).toBe(false)
        expect(snapshot.head + snapshot.tail).toBe(expected.all!)
      }
      expect(Buffer.byteLength(window.snapshot().head + window.snapshot().tail, "utf-8")).toBeLessThanOrEqual(keep)
    }
  })

  test("matches the bounded head-tail reference on seeded random workloads", () => {
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
      const snapshot = window.snapshot()
      if (expected.cut) expect(snapshot).toMatchObject(expected)
      else {
        expect(snapshot.cut).toBe(false)
        expect(snapshot.head + snapshot.tail).toBe(expected.all!)
      }
      expect(Buffer.byteLength(window.snapshot().head + window.snapshot().tail, "utf-8")).toBeLessThanOrEqual(keep)
    }
  })

  test("tracks total lines independently of retained memory", () => {
    const window = makeChunkWindow(8)
    window.push("one\ntwo\n")
    window.push("three\nfour")
    expect(window.totalLines).toBe(4)
    expect(window.totalBytes).toBe(Buffer.byteLength("one\ntwo\nthree\nfour"))
  })
})
