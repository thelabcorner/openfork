import { describe, expect, test } from "bun:test"
import { isPendingUnavailableReasoningPrefix, isUnavailableReasoningSentinel } from "@opencode-ai/core/reasoning-sentinel"

describe("provider reasoning sentinel presentation", () => {
  test("hides the exact provider-unavailable response", () => {
    expect(isUnavailableReasoningSentinel("No reasoning available.")).toBe(true)
    expect(isUnavailableReasoningSentinel("  \r\nNo reasoning available.\n")).toBe(true)
  })

  test("hides the observed malformed protocol-suffixed response", () => {
    expect(isUnavailableReasoningSentinel("No reasoning available.<|start|>")).toBe(true)
    expect(isUnavailableReasoningSentinel("\nNo reasoning available.<|start|>\r\n")).toBe(true)
  })

  test("does not erase real reasoning or explanations merely mentioning missing reasoning", () => {
    for (const value of [
      "No reasoning available. The API did not return its trace.",
      "No reasoning available.\n# Investigating a fallback",
      "# Analysis\nNo reasoning available.",
      "There is no reasoning available about this example.",
      "No reasoning available.<|start|>Meaningful data follows",
      "This is an actual reasoning summary.",
      "No reasoning available.\ntool:edit {}",
      "",
    ]) {
      expect(isUnavailableReasoningSentinel(value)).toBe(false)
    }
  })

  test("hides only actual possible in-flight sentinel prefixes", () => {
    for (const partial of ["N", "No", "No reasoning", "No reasoning available.", "No reasoning available.<|sta"]) {
      expect(isPendingUnavailableReasoningPrefix(partial)).toBe(true)
    }
    for (const unrelated of ["Not a sentinel", "No reasoning of my own", "No reasoning available. Genuine reasoning follows", ""]) {
      expect(isPendingUnavailableReasoningPrefix(unrelated)).toBe(false)
    }
  })

  test("does not scan or hide large provider content", () => {
    expect(isUnavailableReasoningSentinel("No reasoning available." + "x".repeat(100_000))).toBe(false)
  })
})
