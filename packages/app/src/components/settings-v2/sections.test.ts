import { describe, expect, test } from "bun:test"
import { normalizeSettingsSection, sectionsForTab, settingsSectionQuery, settingsSectionRegistry } from "./sections"

describe("Settings section registry", () => {
  test("maintains unique, stable section IDs for each configured parent", () => {
    for (const tab of ["general", "oxp", "telegram"] as const) {
      const entries = sectionsForTab(tab)
      const ids = entries.map((entry) => entry.id)
      expect(ids.length).toBeGreaterThan(1)
      expect(new Set(ids).size).toBe(ids.length)
      expect(entries).toEqual(settingsSectionRegistry[tab])
    }
  })

  test("normalizes unrecognized or stale links within their parent tab", () => {
    expect(normalizeSettingsSection("general", undefined)).toBe("basics")
    expect(normalizeSettingsSection("general", "appearance")).toBe("appearance")
    expect(normalizeSettingsSection("general", "quota")).toBe("basics")
    expect(normalizeSettingsSection("oxp", undefined)).toBe("connection")
    expect(normalizeSettingsSection("oxp", "agents")).toBe("agents")
    expect(normalizeSettingsSection("oxp", "quota")).toBe("connection")
    expect(normalizeSettingsSection("telegram", "quota")).toBe("quota")
    expect(normalizeSettingsSection("telegram", "appearance")).toBe("connection")
    expect(normalizeSettingsSection("providers", "connection")).toBeUndefined()
  })

  test("preserves source route, server and session context when choosing a child section", () => {
    const initial = "?tab=general&section=appearance&server=local&directory=%2Fworkspace&session=ses_1&from=%2Fserver%2Flocal%2Fsession%2Fses_1%3Ffoo%3Dbar"
    const query = settingsSectionQuery(initial, "telegram", "quota")
    expect(query.get("tab")).toBe("telegram")
    expect(query.get("section")).toBe("quota")
    expect(query.get("server")).toBe("local")
    expect(query.get("directory")).toBe("/workspace")
    expect(query.get("session")).toBe("ses_1")
    expect(query.get("from")).toBe("/server/local/session/ses_1?foo=bar")
    const parent = settingsSectionQuery(query.toString(), "oxp")
    expect(parent.get("tab")).toBe("oxp")
    expect(parent.has("section")).toBe(false)
    expect(parent.get("server")).toBe("local")
    const other = settingsSectionQuery(initial, "providers", "quota")
    expect(other.has("section")).toBe(false)
  })

  test("keeps domain services under Telegram instead of merging into bot setup", () => {
    const ids = sectionsForTab("telegram").map((entry) => entry.id)
    expect(ids).toContain("connection")
    expect(ids).toContain("delivery")
    expect(ids).toContain("quota")
    expect(ids).toContain("management")
  })
})
