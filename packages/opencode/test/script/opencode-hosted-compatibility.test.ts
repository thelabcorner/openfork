import { describe, expect, test } from "bun:test"
import manifest from "../../../../keep-manifest.json"
import {
  InstallationOpenCodeCompatibilityVersion,
  OpenCodeHostedUserAgent,
} from "@opencode-ai/core/installation/version"
import { OPEN_CODE_HOSTED_COMPATIBILITY_FALLBACK } from "@opencode-ai/core/installation/upstream-compat"

describe("OpenCode hosted compatibility baseline", () => {
  test("manifest, source fallback, and hosted User-Agent stay aligned", () => {
    const compatibility = manifest.openCodeHostedCompatibility
    expect(compatibility.tag).toBe(`v${compatibility.version}`)
    expect(compatibility.version).toBe(OPEN_CODE_HOSTED_COMPATIBILITY_FALLBACK)
    expect(InstallationOpenCodeCompatibilityVersion).toBe(compatibility.version)
    expect(OpenCodeHostedUserAgent()).toBe(`opencode/${compatibility.version}`)
  })
})