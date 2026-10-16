import { describe, expect, test } from "bun:test"
import { normalizeSettingsTab, safeSettingsReturn } from "./navigation-model"
import { normalizeSettingsSection, sectionsForTab } from "./sections"

describe("routed settings navigation", () => {
  test("normalizes invalid or absent tabs to general", () => {
    expect(normalizeSettingsTab(undefined)).toBe("general")
    expect(normalizeSettingsTab("providers")).toBe("providers")
    expect(normalizeSettingsTab("oxp")).toBe("oxp")
    expect(normalizeSettingsTab("special-agents")).toBe("special-agents")
    expect(normalizeSettingsTab("wakatime")).toBe("wakatime")
    expect(normalizeSettingsTab("telegram")).toBe("telegram")
    expect(normalizeSettingsTab("not-a-tab")).toBe("general")
  })

  test("defines stable, scoped section URLs without collisions across parent tabs", () => {
    expect(sectionsForTab("general").map((section) => section.id)).toEqual([
      "basics", "appearance", "notifications", "sounds", "updates", "display", "advanced", "danger-zone",
    ])
    expect(sectionsForTab("telegram").map((section) => section.id)).toEqual([
      "connection", "delivery", "quota", "management",
    ])
    expect(normalizeSettingsSection("general", "appearance")).toBe("appearance")
    expect(normalizeSettingsSection("telegram", "quota")).toBe("quota")
    expect(normalizeSettingsSection("telegram", "appearance")).toBe("connection")
    expect(normalizeSettingsSection("general", "quota")).toBe("basics")
    expect(normalizeSettingsSection("providers", "quota")).toBeUndefined()
    expect(normalizeSettingsSection("general", undefined)).toBe("basics")
    expect(normalizeSettingsSection("telegram", "removed-legacy-section")).toBe("connection")
  })

  test("registered subsection identities are unique within each tab", () => {
    for (const tab of ["general", "telegram"] as const) {
      const ids = sectionsForTab(tab).map((section) => section.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
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
