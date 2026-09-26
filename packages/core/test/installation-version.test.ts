import { describe, expect, test } from "bun:test"
import {
  InstallationUserAgent,
  formatInstallationUserAgent,
} from "../src/installation/version"

describe("installation user agent", () => {
  test("matches the upstream OpenCode wire shape", () => {
    expect(formatInstallationUserAgent("1.18.30")).toBe("opencode/1.18.30")
  })

  test("does not encode channel or client as path segments", () => {
    const userAgent = InstallationUserAgent()
    expect(userAgent.startsWith("opencode/")).toBe(true)
    expect(userAgent.split("/")).toHaveLength(2)
  })
})
