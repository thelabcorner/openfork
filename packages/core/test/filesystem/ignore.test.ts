import { describe, expect, test } from "bun:test"
import { Ignore } from "@opencode-ai/core/filesystem/ignore"

describe("Ignore coverage", () => {
  test("default rules ignore generated folders at any depth", () => {
    expect(Ignore.match("packages/app/dist/index.js")).toBe(true)
    expect(Ignore.match("packages/desktop/src/x.ts")).toBe(true)
    expect(Ignore.match("node_modules/pkg/index.js")).toBe(true)
    expect(Ignore.match("packages/app/node_modules/pkg/index.js")).toBe(true)
  })

  test("tracked files override native and callback ignoring", () => {
    const coverage = Ignore.coverage([
      "packages/desktop/src/x.ts",
      "packages/opencode/bin/opencode",
      ".opencode/agent/triage.md",
      "packages/app/src/index.ts",
    ])

    // `.opencode` is top-level and natively ignored, so it must leave the list.
    expect(coverage.overridden).toContain(".opencode")
    expect(Ignore.nativeIgnored(".opencode/agent/triage.md")).toBe(true)
    expect(Ignore.nativeIgnored(".opencode/agent/triage.md", coverage.native)).toBe(false)

    // Nested source folders are delivered natively and only need the callback override.
    expect(coverage.overridden).not.toContain("desktop")
    expect(Ignore.nativeIgnored("packages/desktop/src/x.ts", coverage.native)).toBe(false)
    expect(Ignore.match("packages/desktop/src/x.ts", { whitelist: coverage.whitelist })).toBe(false)

    // Untracked generated output stays ignored (volume bound preserved).
    expect(Ignore.match("packages/app/dist/index.js", { whitelist: coverage.whitelist })).toBe(true)

    expect([...coverage.whitelist].sort()).toEqual([
      ".opencode/**",
      "packages/desktop/**",
      "packages/opencode/bin/**",
    ])
  })

  test("a tracked file overrides a glob rule without unignoring its siblings", () => {
    const coverage = Ignore.coverage(["docs/session.log"])
    expect(coverage.overridden).toContain("**/*.log")
    expect(coverage.whitelist).toContain("docs/session.log")
    expect(Ignore.match("docs/session.log", { whitelist: coverage.whitelist })).toBe(false)
    expect(Ignore.match("docs/other.log", { whitelist: coverage.whitelist })).toBe(true)
  })

  test("normalizes Windows separators before matching", () => {
    expect(Ignore.match("packages\\app\\dist\\index.js")).toBe(true)
    const coverage = Ignore.coverage(["packages\\desktop\\src\\x.ts"])
    expect(Ignore.match("packages\\desktop\\src\\x.ts", { whitelist: coverage.whitelist })).toBe(false)
  })
})
