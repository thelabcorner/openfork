import { describe, expect, test } from "bun:test"
import { BoundedTextTail } from "@/session/spad/text-tail"

describe("SPAD bounded text tail", () => {
  test("matches exact string slicing across arbitrary streaming chunks", () => {
    let source = ""
    const tail = new BoundedTextTail(127)
    for (let i = 0; i < 300; i++) {
      const chunk = `chunk-${i}:${"x".repeat(i % 19)}|`
      source += chunk
      tail.push(chunk)
      expect(tail.length).toBe(Math.min(127, source.length))
      expect(tail.toString()).toBe(source.slice(-127))
    }
  })

  test("oversized append replaces history with the exact bounded suffix", () => {
    const tail = new BoundedTextTail(8)
    tail.push("old")
    tail.push("0123456789abcdef")
    expect(tail.length).toBe(8)
    expect(tail.toString()).toBe("89abcdef")
  })

  test("reset drops retained chunks", () => {
    const tail = new BoundedTextTail(8)
    tail.push("abcdefghij")
    tail.reset()
    expect(tail.length).toBe(0)
    expect(tail.toString()).toBe("")
  })
})
