import { describe, expect, test } from "bun:test"
import { nextPacedTextEnd, STREAM_BACKLOG_SKIP, STREAM_RENDER_PACE_MS } from "./message-part-pace"

describe("streaming presentation pacing", () => {
  test("short token deltas publish on a single frame, with no fake typing latency", () => {
    const text = "Hello, world!"
    expect(nextPacedTextEnd(text, text.length - 2)).toBe(text.length)
    expect(nextPacedTextEnd(text, text.length)).toBe(text.length)
    expect(STREAM_RENDER_PACE_MS).toBeGreaterThanOrEqual(16)
    expect(STREAM_RENDER_PACE_MS).toBeLessThanOrEqual(50)
  })

  test("provider bursts are smoothed across a bounded sequence, then fully caught up", () => {
    const text = "Many words arrive rapidly. ".repeat(21)
    const first = nextPacedTextEnd(text, 4)
    expect(first).toBeGreaterThan(4)
    expect(first).toBeLessThan(text.length)
    const positions: number[] = [4]
    for (let index = 0; index < 20 && positions.at(-1)! < text.length; index++)
      positions.push(nextPacedTextEnd(text, positions.at(-1)!))
    expect(positions.at(-1)).toBe(text.length)
    expect(positions.every((value, index) => index === 0 || value > positions[index - 1]!)).toBe(true)
    expect(positions.length).toBeLessThan(10)
  })

  test("large delayed backlogs are snapped instead of replayed for seconds", () => {
    const text = "x".repeat(STREAM_BACKLOG_SKIP + 1)
    expect(nextPacedTextEnd(text, 0)).toBe(text.length)
  })

  test("never publishes an unmatched high surrogate, even on a lookahead boundary", () => {
    const text = "x".repeat(32) + "🍒" + "abc".repeat(25)
    const end = nextPacedTextEnd(text, 1)
    expect(end).toBe(34)
    expect(text.slice(0, end).endsWith("🍒")).toBe(true)
  })

  test("never publishes half of a CRLF sequence", () => {
    const text = "x".repeat(32) + "\r\n" + "abc".repeat(30)
    const end = nextPacedTextEnd(text, 0)
    expect(end).toBe(34)
    expect(text.slice(0, end).endsWith("\r\n")).toBe(true)
  })

  test("all boundaries preserve the exact original Unicode source after convergence", () => {
    const text = ("word 🍒 [link](https://example.com)\r\n\r\n").repeat(45)
    let previous = 0
    let turns = 0
    while (previous < text.length) {
      const next = nextPacedTextEnd(text, previous)
      expect(next).toBeGreaterThan(previous)
      expect(next).toBeLessThanOrEqual(text.length)
      const suffix = text.slice(0, next)
      expect(suffix.at(-1)).not.toBe("\r")
      const last = suffix.charCodeAt(suffix.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
      previous = next
      if (++turns > 50) throw new Error("unbounded stream pacing")
    }
    expect(previous).toBe(text.length)
  })
})
