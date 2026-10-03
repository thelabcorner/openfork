import { describe, expect, test } from "bun:test"
import { applyPartDelta } from "./session-part-delta"

describe("applyPartDelta", () => {
  test("appends contiguous producer offsets and preserves legacy deltas", () => {
    expect(applyPartDelta("hello", " world", 5)).toEqual({ value: "hello world", applied: true })
    expect(applyPartDelta("hello", " world")).toEqual({ value: "hello world", applied: true })
  })

  test("ignores a fully covered replay and appends only an uncovered matching suffix", () => {
    expect(applyPartDelta("hello world", " world", 5)).toEqual({ value: "hello world", applied: true })
    expect(applyPartDelta("hello wo", " world", 5)).toEqual({ value: "hello world", applied: true })
  })

  test("refuses gaps, conflicting overlap, and invalid offsets so the caller can repair", () => {
    expect(applyPartDelta("hello", "world", 6)).toEqual({ value: "hello", applied: false })
    expect(applyPartDelta("hello X", "world", 5)).toEqual({ value: "hello X", applied: false })
    expect(applyPartDelta("hello", "world", -1)).toEqual({ value: "hello", applied: false })
  })

  test("uses UTF-16 code-unit offsets", () => {
    expect(applyPartDelta("😀", "!", 2)).toEqual({ value: "😀!", applied: true })
  })
})
