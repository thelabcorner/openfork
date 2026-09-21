import { describe, expect, test } from "bun:test"
import { truncateMonitorLine } from "@/background/monitor-delivery"

const MAX_LINE_BYTES = 16 * 1024

describe("monitor delivery line projection", () => {
  test("returns fitting lines unchanged", () => {
    expect(truncateMonitorLine("hello")).toEqual({ text: "hello", truncated: false })
  })

  test("uses the full deterministic byte envelope without splitting UTF-8", () => {
    const input = "HEAD-" + "雪🙂".repeat(10_000) + "-TAIL"
    const result = truncateMonitorLine(input)
    expect(result.truncated).toBe(true)
    expect(result.text).toStartWith("HEAD-")
    expect(result.text).toEndWith("…[truncated]")
    expect(result.text).not.toContain("�")
    expect(Buffer.byteLength(result.text, "utf-8")).toBeLessThanOrEqual(MAX_LINE_BYTES)
  })

  test("fills to within one UTF-8 code point of the cap", () => {
    const result = truncateMonitorLine("é".repeat(MAX_LINE_BYTES))
    const bytes = Buffer.byteLength(result.text, "utf-8")
    expect(result.truncated).toBe(true)
    expect(bytes).toBeGreaterThanOrEqual(MAX_LINE_BYTES - 3)
    expect(bytes).toBeLessThanOrEqual(MAX_LINE_BYTES)
  })
})
