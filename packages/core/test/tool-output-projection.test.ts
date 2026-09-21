import { describe, expect, test } from "bun:test"
import { ToolOutputProjection } from "../src/tool-output-projection"

describe("ToolOutputProjection", () => {
  test("returns fitting content unchanged", () => {
    const text = "one\ntwo\nthree"
    const result = ToolOutputProjection.project(text, {
      maxLines: 10,
      maxBytes: 100,
      marker: "... truncated ...",
    })
    expect(result.truncated).toBe(false)
    expect(result.content).toBe(text)
    expect(result.omittedBytes).toBe(0)
  })

  test("balanced projection retains beginning and end", () => {
    const text = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n")
    const result = ToolOutputProjection.project(text, {
      maxLines: 7,
      maxBytes: 10_000,
      marker: "[truncated]",
    })
    expect(result.truncated).toBe(true)
    expect(result.content).toContain("line-0")
    expect(result.content).toContain("line-19")
    expect(result.content).toContain("[truncated]")
    expect(ToolOutputProjection.lineCount(result.content)).toBeLessThanOrEqual(7)
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]?.startByte).toBe(0)
    expect(result.segments[1]?.endByte).toBe(result.originalBytes)
  })

  test("single giant line preserves UTF-8-safe head and tail", () => {
    const text = "HEAD-" + "☃".repeat(100) + "-TAIL"
    const result = ToolOutputProjection.project(text, {
      maxLines: 3,
      maxBytes: 96,
      marker: "[cut]",
    })
    expect(result.content.startsWith("HEAD-")).toBe(true)
    expect(result.content.endsWith("-TAIL")).toBe(true)
    expect(result.content).not.toContain("�")
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(96)
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]?.startByte).toBe(0)
    expect(result.segments[1]?.endByte).toBe(result.originalBytes)
  })

  test("marker itself is part of the hard byte and line budget", () => {
    const result = ToolOutputProjection.project("x".repeat(1_000), {
      maxLines: 1,
      maxBytes: 17,
      marker: "RECOVERY-MARKER-IS-LONG",
    })
    expect(ToolOutputProjection.lineCount(result.content)).toBeLessThanOrEqual(1)
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(17)
  })

  test("head and tail overrides remain deterministic", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n")
    const head = ToolOutputProjection.project(text, {
      maxLines: 4,
      maxBytes: 1000,
      marker: "[cut]",
      strategy: "head",
    })
    const tail = ToolOutputProjection.project(text, {
      maxLines: 4,
      maxBytes: 1000,
      marker: "[cut]",
      strategy: "tail",
    })
    expect(head.content).toContain("line-0")
    expect(head.content).not.toContain("line-9")
    expect(tail.content).toContain("line-9")
    expect(tail.content).not.toContain("line-0")
  })

  test("reports no source segments when recovery marker consumes the whole budget", () => {
    const result = ToolOutputProjection.project("abcdef", {
      maxLines: 1,
      maxBytes: 3,
      marker: "RECOVERY",
    })
    expect(result.content).toBe("REC")
    expect(result.retainedBytes).toBe(0)
    expect(result.segments).toEqual([])
  })

  test("head projection uses the full source budget when byte clipping is active", () => {
    const result = ToolOutputProjection.project("x".repeat(10_000), {
      maxLines: 10,
      maxBytes: 1_000,
      marker: "[cut]",
      strategy: "head",
    })
    expect(result.retainedBytes).toBeGreaterThan(900)
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(1_000)
  })

  test("tail projection uses the full source budget when byte clipping is active", () => {
    const result = ToolOutputProjection.project("x".repeat(10_000), {
      maxLines: 10,
      maxBytes: 1_000,
      marker: "[cut]",
      strategy: "tail",
    })
    expect(result.retainedBytes).toBeGreaterThan(900)
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(1_000)
  })

  test("seeded mixed-Unicode projections obey hard bounds and exact segment accounting", () => {
    let state = 0x5eed1234
    const random = () => {
      state |= 0
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const atoms = ["a", "Z", " ", "\n", "é", "☃", "雪", "🙂", "λ", "\t"]

    for (let trial = 0; trial < 250; trial++) {
      const length = 1 + Math.floor(random() * 600)
      let text = ""
      for (let i = 0; i < length; i++) text += atoms[Math.floor(random() * atoms.length)]!
      const maxLines = Math.floor(random() * 20)
      const maxBytes = Math.floor(random() * 400)
      const strategy = (["balanced", "head", "tail"] as const)[Math.floor(random() * 3)]!
      const result = ToolOutputProjection.project(text, {
        maxLines,
        maxBytes,
        marker: "… truncated; recover via archive …",
        strategy,
      })

      expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(maxBytes)
      if (maxLines === 0) expect(result.content).toBe("")
      else expect(ToolOutputProjection.lineCount(result.content)).toBeLessThanOrEqual(maxLines)
      expect(result.retainedBytes + result.omittedBytes).toBe(result.originalBytes)
      expect(
        result.segments.every(
          (segment) => segment.startByte >= 0 && segment.endByte >= segment.startByte && segment.endByte <= result.originalBytes,
        ),
      ).toBe(true)
      expect(
        result.segments.every(
          (segment, index) => index === 0 || result.segments[index - 1]!.endByte <= segment.startByte,
        ),
      ).toBe(true)
      expect(result.segments.reduce((sum, segment) => sum + segment.endByte - segment.startByte, 0)).toBe(
        result.retainedBytes,
      )
    }
  })
})
