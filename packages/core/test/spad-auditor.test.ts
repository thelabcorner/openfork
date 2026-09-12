import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SpadAuditor } from "../src/spad-auditor"

describe("SPAD auditor contract", () => {
  test("auditor is enabled by default and only explicit false disables it", () => {
    expect(SpadAuditor.enabled(undefined)).toBe(true)
    expect(SpadAuditor.enabled(true)).toBe(true)
    expect(SpadAuditor.enabled(false)).toBe(false)
  })

  test("neutral render excludes detector labels and proposed actions", () => {
    const rendered = SpadAuditor.renderCase({
      intentExcerpt: "Explain the benchmark and continue comparing results.",
      contextBefore: "The first implementation measured 18 ns per item.",
      candidateHead: "Approach 1\n- benchmark A\nApproach 2\n- benchmark B",
      candidateTail: "Approach 15\n- benchmark O",
      contentKind: "markdown",
      features: { repeatedBlockLines: 8, growthSteps: 0, duplicateRatio: 0.42 },
    })
    expect(rendered).not.toContain("SPAD")
    expect(rendered).not.toContain("recover")
    expect(rendered).not.toContain("detected loop")
    expect(rendered).not.toContain("expansion")
    expect(rendered.length).toBeLessThanOrEqual(SpadAuditor.MAX_INPUT_CHARS + 64)
  })

  test("render is bounded for adversarially large excerpts", () => {
    const rendered = SpadAuditor.renderCase({
      intentExcerpt: "intent ".repeat(2000),
      contextBefore: "context ".repeat(2000),
      candidateHead: "head ".repeat(2000),
      candidateTail: "tail ".repeat(2000),
      contentKind: "structured-output".repeat(20),
      features: { period: 128, agreement: 0.91 },
    })
    expect(rendered.length).toBeLessThanOrEqual(SpadAuditor.MAX_INPUT_CHARS + 64)
  })

  test("verdict validator rejects confidence outside [0,1]", async () => {
    const good = await Effect.runPromise(
      SpadAuditor.validateVerdict({ decision: "legitimate", confidence: 0.91, reason: "structured_content" }),
    )
    expect(good.decision).toBe("legitimate")
    const bad = await Effect.runPromiseExit(
      SpadAuditor.validateVerdict({ decision: "degenerate", confidence: 1.2, reason: "exact_loop" }),
    )
    expect(bad._tag).toBe("Failure")
  })

  test("only confident legitimate verdict can veto; degenerate can never authorize recovery", () => {
    expect(SpadAuditor.disposition({ decision: "legitimate", confidence: 0.95, reason: "genuine_progress" })).toBe(
      "veto",
    )
    expect(SpadAuditor.disposition({ decision: "legitimate", confidence: 0.79, reason: "structured_content" })).toBe(
      "retain-observation",
    )
    expect(SpadAuditor.disposition({ decision: "degenerate", confidence: 1, reason: "structural_loop" })).toBe(
      "retain-observation",
    )
    expect(SpadAuditor.disposition({ decision: "uncertain", confidence: 1, reason: "insufficient_evidence" })).toBe(
      "retain-observation",
    )
  })
})
