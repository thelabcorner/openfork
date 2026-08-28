import { describe, test, expect } from "bun:test"
import {
  pathCandidates,
  knownCandidates,
  resolveCliPath,
  parseVersionOutput,
  checkAvailability,
} from "../../src/claude/availability"
import type { ClaudeProcessPort, ExecResult } from "../../src/claude/process"

const ok = (stdout = ""): ExecResult => ({ code: 0, signal: null, stdout, stderr: "" })

function fakePort(overrides: Partial<ClaudeProcessPort> = {}): ClaudeProcessPort & { execCalls: Array<{ file: string; args: readonly string[]; env?: Record<string, string | undefined> }> } {
  const execCalls: Array<{ file: string; args: readonly string[]; env?: Record<string, string | undefined> }> = []
  return {
    execCalls,
    async exec(file, args, options) {
      execCalls.push({ file, args, env: options?.env })
      return ok("1.2.3")
    },
    async spawn() {
      throw new Error("not expected")
    },
    ...overrides,
  }
}

describe("ClaudeAvailability resolution", () => {
  test("pathCandidates splits PATH by platform separator and applies extensions", () => {
    const win = pathCandidates("claude", { PATH: "C:\\a;C:\\b" }, "win32")
    expect(win).toEqual(["C:\\a/claude.cmd", "C:\\a/claude.exe", "C:\\a/claude.bat", "C:\\a/claude", "C:\\b/claude.cmd", "C:\\b/claude.exe", "C:\\b/claude.bat", "C:\\b/claude"])
    const posix = pathCandidates("claude", { PATH: "/usr/bin:/usr/local/bin" }, "linux")
    expect(posix).toEqual(["/usr/bin/claude", "/usr/local/bin/claude"])
  })

  test("knownCandidates uses home and skips npm-global on Windows", () => {
    expect(knownCandidates("claude", { HOME: "/home/u" }, "linux")).toEqual(["/home/u/.local/bin/claude", "/home/u/.npm-global/bin/claude"])
    expect(knownCandidates("claude", { USERPROFILE: "C:\\Users\\u" }, "win32")).toEqual(["C:\\Users\\u/.local/bin/claude"])
    expect(knownCandidates("claude", {}, "linux")).toEqual([])
  })

  test("resolveCliPath is static — no process spawns, first existing candidate wins", () => {
    const port = fakePort()
    const existing = new Set(["/usr/local/bin/claude"])
    const found = resolveCliPath({ PATH: "/usr/bin:/usr/local/bin", HOME: "/home/u" }, (p) => existing.has(p), "linux")
    expect(found).toBe("/usr/local/bin/claude")
    expect(port.execCalls.length).toBe(0)
  })

  test("parseVersionOutput extracts semver from noisy output", () => {
    expect(parseVersionOutput("Claude Code v2.14.3 (build 88)")).toBe("2.14.3")
    expect(parseVersionOutput("no version here")).toBeUndefined()
  })
})

describe("checkAvailability aggregation", () => {
  const sdkLoader = async () => ({ query: () => {} })

  test("missing CLI reports missing-cli without spawning anything", async () => {
    const port = fakePort()
    const report = await checkAvailability({ process: port, env: { PATH: "/nowhere" }, exists: () => false, platform: "linux" })
    expect(report.readiness).toBe("missing-cli")
    expect(report.cliInstalled).toBe(false)
    expect(port.execCalls.length).toBe(0)
  })

  test("ready when CLI, SDK, and subscription login all check out", async () => {
    const port = fakePort()
    // Second exec call is `auth status --json`.
    port.exec = async (file, args, options) => {
      port.execCalls.push({ file, args, env: options?.env })
      if (args[0] === "--version") return ok("1.0.0")
      return ok(JSON.stringify({ loggedIn: true, authMethod: "oauth" }))
    }
    const report = await checkAvailability({
      process: port,
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-should-not-leak" },
      exists: () => true,
      platform: "linux",
      loadSdk: sdkLoader,
    })
    expect(report.readiness).toBe("ready")
    expect(report.version).toBe("1.0.0")
    expect(report.loggedIn).toBe(true)
    // Credential overrides are stripped from every child env.
    for (const call of port.execCalls) {
      expect(call.env?.ANTHROPIC_API_KEY).toBeUndefined()
    }
  })

  test("logged-out CLI reports needs-login with SDK available", async () => {
    const port = fakePort()
    port.exec = async (_file, args) => {
      if (args[0] === "--version") return ok("1.0.0")
      return ok(JSON.stringify({ loggedIn: false }))
    }
    const report = await checkAvailability({ process: port, env: { PATH: "/usr/bin" }, exists: () => true, platform: "linux", loadSdk: sdkLoader })
    expect(report.readiness).toBe("needs-login")
    expect(report.sdkAvailable).toBe(true)
    expect(report.loggedIn).toBe(false)
  })

  test("SDK load failure reports missing-sdk with sanitized detail", async () => {
    const port = fakePort()
    const report = await checkAvailability({
      process: port,
      env: { PATH: "/usr/bin" },
      exists: () => true,
      platform: "linux",
      loadSdk: async () => {
        throw new Error("Cannot find module @anthropic-ai/claude-agent-sdk sk-ant-abcsecretkey123")
      },
    })
    expect(report.readiness).toBe("missing-sdk")
    expect(report.cliInstalled).toBe(true)
    expect(report.detail).toContain("[redacted]")
    expect(report.detail).not.toContain("sk-ant-abcsecretkey123")
  })

  test("loader returning a module without query() counts as missing-sdk", async () => {
    const port = fakePort()
    const report = await checkAvailability({
      process: port,
      env: { PATH: "/usr/bin" },
      exists: () => true,
      platform: "linux",
      loadSdk: async () => ({}),
    })
    expect(report.readiness).toBe("missing-sdk")
  })

  test("rollback gate reports disabled with zero side effects, even with CLI present", async () => {
    const port = fakePort()
    const report = await checkAvailability({
      process: port,
      env: { PATH: "/usr/bin" },
      exists: () => true,
      platform: "linux",
      loadSdk: sdkLoader,
      enabled: false,
    })
    expect(report.readiness).toBe("disabled")
    expect(report.cliInstalled).toBe(false)
    expect(report.sdkAvailable).toBe(false)
    expect(report.detail).toContain("OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY")
    // No version probe, no auth status, no SDK load.
    expect(port.execCalls.length).toBe(0)
  })

  test("enabled override re-enables discovery without env mutation", async () => {
    const port = fakePort()
    port.exec = async (_file, args) => {
      if (args[0] === "--version") return ok("1.0.0")
      return ok(JSON.stringify({ loggedIn: true, authMethod: "oauth" }))
    }
    const report = await checkAvailability({
      process: port,
      env: { PATH: "/usr/bin" },
      exists: () => true,
      platform: "linux",
      loadSdk: sdkLoader,
      enabled: true,
    })
    expect(report.readiness).toBe("ready")
  })
})
