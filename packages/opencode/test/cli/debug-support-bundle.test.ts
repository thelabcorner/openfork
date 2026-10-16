import { describe, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { SupportBundle } from "@opencode-ai/core/diagnostics/support-bundle"
import { tailLines } from "@/cli/cmd/debug/support-bundle"

/**
 * These tests cover the export surface's own contract, not the core scrubber (the core owns
 * and tests that). What is asserted here is the part this surface is responsible for:
 * the composition is Tier 0, conversation content is structurally unreachable, and what a
 * user shares is described explicitly rather than by omission.
 */

const runtime = {
  version: "1.2.3",
  channel: "dev",
  platform: "win32",
  arch: "x64",
  nodeVersion: "22.0.0",
  executable: "C:\\Users\\Jane\\AppData\\Local\\openfork\\openfork.exe",
  configRoot: "C:\\Users\\Jane\\AppData\\Roaming\\openfork",
  dataRoot: "C:\\Users\\Jane\\AppData\\Local\\openfork",
  uptimeSeconds: 42,
}

describe("debug support-bundle composition", () => {
  test("runtime paths become report-local pseudonyms and no raw private path survives", () => {
    const bundle = SupportBundle.build({ runtime }, { privateValues: ["C:\\Users\\Jane"], pseudonymSeed: "seed" })
    const json = SupportBundle.serialize(bundle, { pretty: true })

    expect(bundle.included).toContain("runtime")
    expect(json).not.toContain("Jane")
    expect(json).not.toContain("C:\\\\Users\\\\Jane")
    expect(bundle.pseudonyms.counts.path).toBeGreaterThan(0)
  })

  test("a raw private path smuggled through an undeclared field is still scrubbed", () => {
    // The allowlist drops undeclared keys; this proves the drop happens before the value
    // could reach the artifact, rather than relying on the field list being short.
    const bundle = SupportBundle.build(
      { runtime: { ...runtime, undeclaredLeak: "C:\\Users\\Jane\\secret.txt" } },
      { privateValues: ["C:\\Users\\Jane"], pseudonymSeed: "seed" },
    )
    expect(SupportBundle.serialize(bundle, { pretty: true })).not.toContain("Jane")
  })

  test("conversation content is reported as refused, never merely absent", () => {
    const bundle = SupportBundle.build({ runtime })
    const conversation = bundle.excluded.find((entry) => entry.id === "conversation")

    expect(conversation).toBeDefined()
    expect(conversation?.reason).toBe("conversation-content-not-consent")
    expect(bundle.sections.conversation.included).toBe(false)
    expect(bundle.sections.conversation.data).toBeNull()
    expect(bundle.policy.conversationContent).toBe(false)
  })

  test("conversation content stays excluded even when facts are supplied without consent", () => {
    const bundle = SupportBundle.build({ runtime, conversation: { texts: ["my private prompt"] } })
    expect(bundle.sections.conversation.included).toBe(false)
    expect(SupportBundle.serialize(bundle)).not.toContain("my private prompt")
  })

  test("config is excluded as instance-scoped rather than as an oversight", () => {
    const bundle = SupportBundle.build({ runtime })
    const config = bundle.excluded.find((entry) => entry.id === "config")

    expect(config).toBeDefined()
    expect(config?.reason).toBe("instance-scoped-not-readable-without-workspace-bootstrap")
    expect(bundle.sections.config.included).toBe(false)
  })

  test("every declared section appears exactly once in included or excluded", () => {
    const bundle = SupportBundle.build({ runtime, logs: { level: "Warn", lines: ["level=Warn something"] } })
    const ids = Object.keys(bundle.sections).toSorted()
    const accounted = [...bundle.included, ...bundle.excluded.map((entry) => entry.id)].toSorted()

    expect(accounted).toEqual(ids)
    expect(new Set(accounted).size).toBe(accounted.length)
  })

  test("every excluded section carries a machine-readable reason", () => {
    const bundle = SupportBundle.build({ runtime })
    expect(bundle.excluded.length).toBeGreaterThan(0)
    for (const entry of bundle.excluded) {
      expect(typeof entry.reason).toBe("string")
      expect(entry.reason.length).toBeGreaterThan(0)
    }
  })

  test("the artifact identifies the product and declares the single secret owner", () => {
    const bundle = SupportBundle.build({ runtime })
    expect(bundle.product).toBe("openfork")
    expect(bundle.schemaVersion).toBe(1)
    expect(bundle.scrub.secretRedactionOwner).toBe("@opencode-ai/core/memory/secrets")
    expect(bundle.scrub.applied).toBe(true)
  })
})

describe("debug support-bundle log tail selection", () => {
  test("keeps the newest lines, because the core projection keeps the first ones it is given", () => {
    const text = Array.from({ length: 10 }, (_, index) => `line-${index}`).join("\n")
    expect(tailLines(text, 3)).toEqual(["line-7", "line-8", "line-9"])
  })

  test("drops blank lines and tolerates a zero or negative limit", () => {
    expect(tailLines("a\n\n\nb\n", 10)).toEqual(["a", "b"])
    expect(tailLines("a\nb", 0)).toEqual([])
    expect(tailLines("a\nb", -1)).toEqual([])
  })

  test("handles CRLF and a missing trailing newline", () => {
    expect(tailLines("a\r\nb", 10)).toEqual(["a", "b"])
  })

  test("returns fewer lines than requested rather than padding", () => {
    expect(tailLines("only", 64)).toEqual(["only"])
  })
})

describe("debug support-bundle Tier 0 inputs", () => {
  test("the runtime facts this surface supplies are process-global, never instance-scoped", () => {
    // These are the exact declarations that make the command Tier 0. If any of them ever
    // became instance-scoped, the command would silently start paying instance bootstrap
    // (or failing) precisely when the product is already broken. This is the canary.
    expect(typeof InstallationVersion).toBe("string")
    expect(typeof InstallationChannel).toBe("string")
    expect(typeof process.platform).toBe("string")
    expect(typeof process.arch).toBe("string")
    expect(typeof process.versions.node).toBe("string")
    expect(typeof process.execPath).toBe("string")
    expect(typeof Global.Path.home).toBe("string")
    expect(typeof Global.Path.config).toBe("string")
    expect(typeof Global.Path.data).toBe("string")
    expect(typeof Global.Path.log).toBe("string")
  })

  test("a log section survives with only the fields the core spec declares", () => {
    const bundle = SupportBundle.build({ runtime, logs: { level: "Error", lines: ["level=Error boom"] } })
    expect(bundle.sections.logs.included).toBe(true)
    expect(bundle.sections.logs.data).toEqual({ level: "Error", lines: ["level=Error boom"] })
  })
})
