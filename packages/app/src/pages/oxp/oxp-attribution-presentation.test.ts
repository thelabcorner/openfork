import { describe, expect, test } from "bun:test"
import { oxpActivityDict } from "@/i18n/en-oxp-activity"

describe("OXP attribution presentation contract", () => {
  test("labels exposure as modeled rather than provider-reported usage", () => {
    const text = Object.values(oxpActivityDict).join(" ").toLowerCase()
    expect(text).not.toContain("the oxp token usage")
    expect(text).not.toContain("oxp token usage")
    expect(
      oxpActivityDict["oxpActivity.attribution.exposureHelp"].toLowerCase(),
    ).toContain("not provider-reported token usage")
  })

  test("keeps residency sensitivity distinct from causal attribution", () => {
    const note =
      oxpActivityDict["oxpActivity.attribution.methodNote"].toLowerCase()
    expect(note).toContain("context-residency assumption")
    expect(note).toContain("does not infer causal attribution")
    expect(note).toContain("availability/tool-schema prompt tax is separate")
    expect(oxpActivityDict["oxpActivity.attribution.causal"]).toBe(
      "Causal trace",
    )
    expect(oxpActivityDict["oxpActivity.attribution.notMeasured"]).toBe(
      "Not measured",
    )
  })

  test("names exact evidence and historical fallback separately in the UI copy", () => {
    expect(
      oxpActivityDict["oxpActivity.attribution.subtitle"].toLowerCase(),
    ).toContain("exact evidence")
    expect(
      oxpActivityDict["oxpActivity.attribution.subtitle"].toLowerCase(),
    ).toContain("historical fallback")
  })
})