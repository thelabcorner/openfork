import { describe, expect, test } from "bun:test"
import {
  formatFreeModelCoverageIssues,
  validateFreeModelCoverage,
  type FreeModelCoverageFixture,
} from "../../script/opencode-free-model-coverage"

const fixture: FreeModelCoverageFixture = {
  version: 1,
  providerID: "opencode",
  capturedAt: "2026-09-25",
  sources: ["https://example.test/evidence"],
  models: ["stealth-free", "suffix-free"],
}

const model = (cost: Record<string, unknown>) => ({ id: "model", cost })

describe("OpenCode free-model build coverage", () => {
  test("accepts exact models with explicit zero base and optional zero cache pricing", () => {
    const issues = validateFreeModelCoverage(
      {
        opencode: {
          models: {
            "stealth-free": model({ input: 0, output: 0, cache_read: 0 }),
            "suffix-free": model({ input: 0, output: 0, cache_read: 0, cache_write: 0 }),
          },
        },
      },
      fixture,
    )
    expect(issues).toEqual([])
  })

  test("fails closed for missing model or missing base pricing", () => {
    const issues = validateFreeModelCoverage(
      {
        opencode: {
          models: {
            "stealth-free": { id: "stealth-free" },
          },
        },
      },
      fixture,
    )
    expect(issues.map((issue) => [issue.modelID, issue.code])).toEqual([
      ["stealth-free", "missing-cost"],
      ["suffix-free", "missing-model"],
    ])
  })

  test("rejects non-zero output, cache, tier, and over-200k pricing", () => {
    for (const cost of [
      { input: 0, output: 1 },
      { input: 0, output: 0, cache_read: 0.1 },
      { input: 0, output: 0, tiers: [{ input: 0, output: 0.2 }] },
      { input: 0, output: 0, tiers: [{ cache_read: 0 }] },
      { input: 0, output: 0, context_over_200k: { input: 0.3, output: 0 } },
      { input: 0, output: 0, context_over_200k: { cache_write: 0 } },
    ]) {
      const issues = validateFreeModelCoverage(
        {
          opencode: {
            models: {
              "stealth-free": model(cost),
              "suffix-free": model({ input: 0, output: 0 }),
            },
          },
        },
        fixture,
      )
      expect(issues).toHaveLength(1)
      expect(issues[0]).toMatchObject({ modelID: "stealth-free", code: "nonzero-cost" })
    }
  })

  test("formats drift without leaking payload contents", () => {
    const text = formatFreeModelCoverageIssues(fixture, [
      { modelID: "stealth-free", code: "missing-model", message: "Missing model stealth-free" },
    ])
    expect(text).toContain("OpenCode free-model coverage drift")
    expect(text).toContain("Missing model stealth-free")
  })
})