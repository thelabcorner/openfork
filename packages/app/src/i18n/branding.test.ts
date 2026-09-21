import { describe, expect, test } from "bun:test"
import { DESKTOP_MENU } from "../desktop-menu"
import { dict } from "./en"

const UPSTREAM_PRODUCT_NAMES = ["OpenCode Go", "OpenCode Zen"] as const

function stripUpstreamProductNames(value: string) {
  return UPSTREAM_PRODUCT_NAMES.reduce((result, name) => result.replaceAll(name, ""), value)
}

describe("OpenFork branding", () => {
  test("generic user-facing copy does not fall back to the OpenCode product name", () => {
    const offenders = Object.entries(dict)
      .filter(([, value]) => stripUpstreamProductNames(value).includes("OpenCode"))
      .map(([key, value]) => ({ key, value }))

    expect(offenders).toEqual([])
  })

  test("keeps upstream OpenCode Go and OpenCode Zen product names intact", () => {
    expect(dict["usage.go.title"]).toContain("OpenCode Go")
    expect(dict["provider.connect.opencodeZen.line1"]).toContain("OpenCode Zen")
  })

  test("desktop support links belong to the OpenFork GitHub repository", () => {
    const hrefs = DESKTOP_MENU.flatMap((menu) => menu.items ?? [])
      .filter((entry) => entry.type === "item" && entry.href)
      .map((entry) => (entry.type === "item" ? entry.href : undefined))
      .filter((href): href is string => !!href)

    expect(hrefs).toContain("https://github.com/thelabcorner/openfork")
    expect(hrefs.some((href) => href.includes("discord.com/invite/opencode"))).toBe(false)
    expect(hrefs.some((href) => href.includes("github.com/anomalyco/opencode"))).toBe(false)
    expect(hrefs.some((href) => href.includes("opencode.ai/desktop-feedback"))).toBe(false)
  })

  test("error-report copy points users to GitHub", () => {
    expect(dict["error.page.report.prefix"]).toBe("Please report this error to the OpenFork team")
    expect(dict["error.page.report.github"]).toBe("on GitHub")
  })
})
