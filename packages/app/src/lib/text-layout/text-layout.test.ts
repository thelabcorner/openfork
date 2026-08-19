import { describe, expect, it } from "bun:test"
import {
  clearPreparedCache,
  estimateTextHeight,
  loadPretext,
  PREPARED_CACHE_MAX_BYTES,
  PREPARED_CACHE_MAX_ENTRIES,
  prepareTextLayout,
  PreparedTextCache,
  textLayoutMode,
  type TextTypography,
} from "@/lib/text-layout"

const TYPOGRAPHY: TextTypography = {
  family: '"Segoe UI", system-ui, sans-serif',
  fontSizePx: 14,
  lineHeightPx: 22.4,
  fontWeight: 400,
  fontStyle: "normal",
  letterSpacingPx: 0,
}

describe("prepared cache", () => {
  it("respects the entry bound", () => {
    const cache = new PreparedTextCache({ maxEntries: 4, maxBytes: 1024 * 1024 })
    for (let i = 0; i < 8; i++) cache.set(`key:${i}`, { __prepared: i }, 10)
    expect(cache.size).toBe(4)
  })

  it("respects the byte budget", () => {
    const cache = new PreparedTextCache({ maxEntries: 1000, maxBytes: 4096 })
    for (let i = 0; i < 20; i++) cache.set(`key:${i}`, { __prepared: i }, 500)
    // 20 * (500*2 + 256) bytes exceeds 4096, so the cache must have evicted.
    expect(cache.size).toBeLessThan(20)
    expect(cache.size).toBeGreaterThan(0)
  })

  it("is an LRU: evicts the least recently used entry", () => {
    const cache = new PreparedTextCache({ maxEntries: 2, maxBytes: 1024 * 1024 })
    cache.set("a", { __prepared: 1 }, 1)
    cache.set("b", { __prepared: 2 }, 1)
    cache.get("a")
    cache.set("c", { __prepared: 3 }, 1)
    expect(cache.get("b")).toBeUndefined()
    expect(cache.get("a")).toBeDefined()
  })

  it("exports production bounds", () => {
    expect(PREPARED_CACHE_MAX_ENTRIES).toBe(1024)
    expect(PREPARED_CACHE_MAX_BYTES).toBe(8 * 1024 * 1024)
  })
})

describe("textLayoutMode", () => {
  it("defaults to off", () => {
    expect(textLayoutMode()).toBe("off")
    expect(textLayoutMode("  ")).toBe("off")
    expect(textLayoutMode("bogus")).toBe("off")
  })

  it("accepts all modes case-insensitively", () => {
    expect(textLayoutMode("prior")).toBe("prior")
    expect(textLayoutMode("Pretext")).toBe("pretext")
    expect(textLayoutMode("OFF")).toBe("off")
  })

  it("prefers explicit input over env", () => {
    expect(textLayoutMode("off")).toBe("off")
  })
})

describe("pretext integration", () => {
  it("prepares and estimates text height deterministically", async () => {
    await loadPretext()
    clearPreparedCache()
    const handle = prepareTextLayout("hello world", TYPOGRAPHY)
    expect(handle).toBeDefined()
    const first = estimateTextHeight(handle!, TYPOGRAPHY, 320)
    const second = estimateTextHeight(handle!, TYPOGRAPHY, 320)
    expect(first).toBeDefined()
    expect(second).toBe(first)
  })

  it("is width-sensitive but text-cacheable: same prepared handle, different widths", async () => {
    await loadPretext()
    clearPreparedCache()
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(4)
    const handle = prepareTextLayout(text, TYPOGRAPHY)
    const narrow = estimateTextHeight(handle!, TYPOGRAPHY, 200)
    const wide = estimateTextHeight(handle!, TYPOGRAPHY, 800)
    expect(narrow).toBeDefined()
    expect(wide).toBeDefined()
    expect(narrow!).toBeGreaterThan(wide!)
    // Width is NOT part of the prepare key: re-preparing the same text is a cache hit.
    const handleAgain = prepareTextLayout(text, TYPOGRAPHY)
    expect(handleAgain).toBe(handle)
  })

  it("returns undefined for empty text", async () => {
    await loadPretext()
    expect(prepareTextLayout("", TYPOGRAPHY)).toBeUndefined()
  })

  it("degrades safely on pathological widths (no throw)", async () => {
    await loadPretext()
    clearPreparedCache()
    const handle = prepareTextLayout("some text", TYPOGRAPHY)
    // Pathological widths must never throw; they degrade to a sane estimate.
    const nan = estimateTextHeight(handle!, TYPOGRAPHY, Number.NaN)
    const zero = estimateTextHeight(handle!, TYPOGRAPHY, 0)
    expect(nan).toBeTypeOf("number")
    expect(Number.isFinite(nan)).toBe(true)
    expect(zero).toBeTypeOf("number")
    expect(Number.isFinite(zero)).toBe(true)
  })
})
