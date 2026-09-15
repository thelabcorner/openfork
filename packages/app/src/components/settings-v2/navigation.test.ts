import { describe, expect, test } from "bun:test"
import { normalizeSettingsTab, safeSettingsReturn } from "./navigation"

describe("routed settings navigation", () => {
  test("normalizes invalid or absent tabs to general", () => {
    expect(normalizeSettingsTab(undefined)).toBe("general")
    expect(normalizeSettingsTab("providers")).toBe("providers")
    expect(normalizeSettingsTab("not-a-tab")).toBe("general")
  })

  test("accepts only internal non-settings return targets", () => {
    expect(safeSettingsReturn("/server/local/session/ses_1?foo=bar#turn")).toBe(
      "/server/local/session/ses_1?foo=bar#turn",
    )
    expect(safeSettingsReturn("https://example.com")).toBe("/")
    expect(safeSettingsReturn("//example.com/path")).toBe("/")
    expect(safeSettingsReturn("/settings?tab=models")).toBe("/")
  })
})
