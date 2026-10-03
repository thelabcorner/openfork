import { describe, expect, test } from "bun:test"
import { projectSessionContextBreakdown } from "./session-context-breakdown"

describe("projectSessionContextBreakdown", () => {
  test("normalizes server scalar categories against authoritative occupancy without a transcript", () => {
    const output = projectSessionContextBreakdown(
      { system: 4, user: 3, synthetic: 5, shell: 0, compaction: 0, assistant: 5, tool: 1, other: 0 },
      20,
    )
    const map = Object.fromEntries(output.map((segment) => [segment.key, segment.tokens]))

    expect(map.system).toBe(4)
    expect(map.synthetic).toBe(5)
    expect(map.other).toBe(2)
    expect(output.reduce((sum, segment) => sum + segment.tokens, 0)).toBe(20)
  })

  test("scales server estimates when current occupancy is smaller than historical estimates", () => {
    const output = projectSessionContextBreakdown(
      { system: 50, user: 100, synthetic: 20, shell: 10, compaction: 30, assistant: 200, tool: 300, other: 0 },
      100,
    )

    expect(output.reduce((sum, segment) => sum + segment.tokens, 0)).toBeLessThanOrEqual(100)
    expect(output.every((segment) => segment.width <= 100)).toBeTrue()
  })

  test("never presents cumulative session usage as current context occupancy", () => {
    // Regression for a long session that has processed >600k tokens cumulatively
    // while the provider reports only ~39k tokens resident in the current 128k
    // context. Composition is a current-footprint visualization, not spend.
    const currentContextTokens = 39_258
    const output = projectSessionContextBreakdown(
      {
        system: 9_500,
        user: 65_000,
        synthetic: 8_000,
        shell: 1_500,
        compaction: 10_000,
        assistant: 160_000,
        tool: 255_000,
        other: 102_851,
      },
      currentContextTokens,
    )

    expect(output.reduce((sum, segment) => sum + segment.tokens, 0)).toBe(currentContextTokens)
    expect(output.reduce((sum, segment) => sum + segment.width, 0)).toBeCloseTo(100, 6)
    expect(output.every((segment) => segment.tokens <= currentContextTokens)).toBeTrue()
  })

  test("uses the full authoritative footprint, including cached and generated tokens, as its denominator", () => {
    const output = projectSessionContextBreakdown(
      { system: 5, user: 10, synthetic: 0, shell: 0, compaction: 0, assistant: 10, tool: 5, other: 0 },
      60,
    )

    const map = Object.fromEntries(output.map((segment) => [segment.key, segment.tokens]))
    expect(map.other).toBe(30)
    expect(output.reduce((sum, segment) => sum + segment.tokens, 0)).toBe(60)
  })
})
