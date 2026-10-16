import { describe, expect, test } from "bun:test"
import { oxpActivityDict } from "@/i18n/en-oxp-activity"

describe("OXP attribution presentation contract", () => {
  test("labels OXP payload tokens as an estimate without a residency multiplier", () => {
    const help = oxpActivityDict["oxpActivity.attribution.oxpTokensHelp"].toLowerCase()
    expect(help).toContain("requests and results")
    expect(help).toContain("counted once")
    expect(help).toContain("no context-residency multiplier")
  })

  test("keeps upstream usage explicitly empirical and distinct from provider reporting", () => {
    const surrounding = oxpActivityDict["oxpActivity.attribution.surroundingTokensHelp"].toLowerCase()
    const total = oxpActivityDict["oxpActivity.attribution.totalTokensHelp"].toLowerCase()
    expect(surrounding).toContain("learned from paired openfork")
    expect(total).toContain("not provider-reported chatgpt usage")
  })

  test("documents the measured boundary and the learned outer estimate separately", () => {
    const note = oxpActivityDict["oxpActivity.attribution.methodNote"].toLowerCase()
    expect(note).toContain("request/result payload openfork actually observes")
    expect(note).toContain("separate empirical estimate")
    expect(note).toContain("never assumes old oxp payloads remain resident")
    expect(note).toContain("availability/tool-schema prompt tax is separate")
  })

  test("no production attribution copy carries obsolete geometric-residency wording", () => {
    const copy = Object.entries(oxpActivityDict)
      .filter(([key]) => key.startsWith("oxpActivity.attribution."))
      .map(([, value]) => value)
      .join(" ")
      .toLowerCase()
    for (const obsolete of ["amplification", /\brho\b/, "unique tokens", "exposure tokens"]) {
      expect(copy).not.toMatch(obsolete)
    }
    // The only permitted mention of residency is the explicit negation.
    expect(copy).toContain("there is no context-residency multiplier")
    expect(copy.match(/residency/g) ?? []).toHaveLength(1)
  })
})
