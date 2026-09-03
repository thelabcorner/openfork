import { describe, expect, test } from "bun:test"
import { bestMatch, normalizeModelName, similarity } from "./string-similarity"

describe("normalizeModelName", () => {
  test("strips trailing free/unlimited/beta/preview/latest noise", () => {
    expect(normalizeModelName("Hy3 (Free)")).toBe(normalizeModelName("Hy3"))
    expect(normalizeModelName("Hy3 Free")).toBe(normalizeModelName("Hy3"))
    expect(normalizeModelName("GLM-5.3 (Beta)")).toBe(normalizeModelName("GLM-5.3"))
    expect(normalizeModelName("Model X (Unlimited) (Latest)")).toBe(normalizeModelName("Model X"))
  })

  test("is case- and punctuation-insensitive", () => {
    expect(normalizeModelName("Claude Sonnet 4.5")).toBe(normalizeModelName("claude-sonnet-4-5"))
  })
})

describe("similarity", () => {
  test("identical strings score 1", () => {
    expect(similarity("hy3", "hy3")).toBe(1)
  })

  test("a free-tier variant scores above the 0.75 confidence bar once normalized", () => {
    const score = similarity(normalizeModelName("Hy3"), normalizeModelName("Hy3 (Free)"))
    expect(score).toBeGreaterThanOrEqual(0.75)
  })

  test("unrelated model names score low", () => {
    const score = similarity(normalizeModelName("Claude Sonnet 4.5"), normalizeModelName("GPT-5.6 Sol"))
    expect(score).toBeLessThan(0.5)
  })

  test("strings shorter than 2 chars fall back to exact equality", () => {
    expect(similarity("a", "a")).toBe(1)
    expect(similarity("a", "b")).toBe(0)
  })
})

describe("bestMatch", () => {
  test("returns the highest-scoring candidate at or above threshold", () => {
    const candidates = [{ name: "Claude Sonnet 4.5" }, { name: "Hy3" }, { name: "GPT-5.6 Sol" }]
    const result = bestMatch(normalizeModelName("Hy3 Free"), candidates, (c) => normalizeModelName(c.name))
    expect(result?.candidate.name).toBe("Hy3")
  })

  test("returns undefined when nothing clears the threshold", () => {
    const candidates = [{ name: "Claude Sonnet 4.5" }, { name: "GPT-5.6 Sol" }]
    const result = bestMatch(normalizeModelName("Hy3 Free"), candidates, (c) => normalizeModelName(c.name))
    expect(result).toBeUndefined()
  })
})
