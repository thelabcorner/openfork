import { describe, expect, test } from "bun:test"
import {
  InstallationOpenCodeCompatibilityVersion,
  InstallationUserAgent,
  OpenCodeHostedUserAgent,
} from "@opencode-ai/core/installation/version"
import { OPEN_CODE_HOSTED_COMPATIBILITY_FALLBACK } from "@opencode-ai/core/installation/upstream-compat"

describe("OpenCode hosted compatibility identity", () => {
  test("unbundled execution uses the sync-verified upstream compatibility fallback", () => {
    expect(InstallationOpenCodeCompatibilityVersion).toBe(OPEN_CODE_HOSTED_COMPATIBILITY_FALLBACK)
  })

  test("uses the exact upstream OpenCode User-Agent shape", () => {
    expect(OpenCodeHostedUserAgent()).toBe(`opencode/${InstallationOpenCodeCompatibilityVersion}`)
    expect(OpenCodeHostedUserAgent().split("/")).toHaveLength(2)
  })

  test("keeps the fork/general identity separate", () => {
    expect(InstallationUserAgent("desktop")).not.toBe(OpenCodeHostedUserAgent())
  })
})