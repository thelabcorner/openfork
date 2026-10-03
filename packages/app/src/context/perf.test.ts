import { describe, expect, test } from "bun:test"
import { formatLongAnimationFrame, longFrameEntryType, type LongAnimationFrameEntry } from "./perf"

describe("renderer long-frame attribution", () => {
  test("prefers LoAF and retains longtask fallback when unsupported", () => {
    expect(longFrameEntryType(["longtask", "long-animation-frame"])).toBe("long-animation-frame")
    expect(longFrameEntryType(["longtask"])).toBe("longtask")
    expect(longFrameEntryType(undefined)).toBe("longtask")
  })

  test("reports bounded render/script attribution without source payloads", () => {
    const privatePayload = "x".repeat(10_000)
    const scripts = Array.from({ length: 20 }, (_, index) => ({
      duration: 20 - index,
      invoker: `callback-${index}-${privatePayload}`,
      sourceURL: `https://example.test/chunk-${index}.js?token=${privatePayload}`,
    }))
    const entry = {
      entryType: "long-animation-frame",
      name: "long-animation-frame",
      startTime: 100,
      duration: 180,
      blockingDuration: 95,
      renderStart: 110,
      styleAndLayoutStart: 140,
      scripts,
    } as LongAnimationFrameEntry

    const formatted = formatLongAnimationFrame(entry)!
    expect(formatted).toContain("blocking 95ms")
    expect(formatted).toContain("render 170ms")
    expect(formatted).toContain("style/layout 140ms")
    expect((formatted.match(/chunk-\d+\.js/g) ?? []).length).toBeLessThanOrEqual(3)
    expect(formatted).not.toContain(privatePayload)
    expect(formatted.length).toBeLessThan(600)
    expect(formatLongAnimationFrame({ ...entry, duration: 49 })).toBeUndefined()
  })
})
