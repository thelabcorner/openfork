import { describe, expect, test } from "bun:test"
import { parsePluginSpecifier, isClaudeExternalPlugin, CLAUDE_EXTERNAL_PLUGIN, isDeprecatedPlugin, shouldEnableClaudeFirstParty } from "../../src/plugin/shared"

describe("parsePluginSpecifier", () => {
  test("parses standard npm package without version", () => {
    expect(parsePluginSpecifier("acme")).toEqual({
      pkg: "acme",
      version: "latest",
    })
  })

  test("parses standard npm package with version", () => {
    expect(parsePluginSpecifier("acme@1.0.0")).toEqual({
      pkg: "acme",
      version: "1.0.0",
    })
  })

  test("parses scoped npm package without version", () => {
    expect(parsePluginSpecifier("@opencode/acme")).toEqual({
      pkg: "@opencode/acme",
      version: "latest",
    })
  })

  test("parses scoped npm package with version", () => {
    expect(parsePluginSpecifier("@opencode/acme@1.0.0")).toEqual({
      pkg: "@opencode/acme",
      version: "1.0.0",
    })
  })

  test("parses package with git+https url", () => {
    expect(parsePluginSpecifier("acme@git+https://github.com/opencode/acme.git")).toEqual({
      pkg: "acme",
      version: "git+https://github.com/opencode/acme.git",
    })
  })

  test("parses scoped package with git+https url", () => {
    expect(parsePluginSpecifier("@opencode/acme@git+https://github.com/opencode/acme.git")).toEqual({
      pkg: "@opencode/acme",
      version: "git+https://github.com/opencode/acme.git",
    })
  })

  test("parses package with git+ssh url containing another @", () => {
    expect(parsePluginSpecifier("acme@git+ssh://git@github.com/opencode/acme.git")).toEqual({
      pkg: "acme",
      version: "git+ssh://git@github.com/opencode/acme.git",
    })
  })

  test("parses scoped package with git+ssh url containing another @", () => {
    expect(parsePluginSpecifier("@opencode/acme@git+ssh://git@github.com/opencode/acme.git")).toEqual({
      pkg: "@opencode/acme",
      version: "git+ssh://git@github.com/opencode/acme.git",
    })
  })

  test("parses unaliased git+ssh url", () => {
    expect(parsePluginSpecifier("git+ssh://git@github.com/opencode/acme.git")).toEqual({
      pkg: "git+ssh://git@github.com/opencode/acme.git",
      version: "",
    })
  })

  test("parses npm alias using the alias name", () => {
    expect(parsePluginSpecifier("acme@npm:@opencode/acme@1.0.0")).toEqual({
      pkg: "acme",
      version: "npm:@opencode/acme@1.0.0",
    })
  })

  test("parses bare npm protocol specifier using the target package", () => {
    expect(parsePluginSpecifier("npm:@opencode/acme@1.0.0")).toEqual({
      pkg: "@opencode/acme",
      version: "1.0.0",
    })
  })

  test("parses unversioned npm protocol specifier", () => {
    expect(parsePluginSpecifier("npm:@opencode/acme")).toEqual({
      pkg: "@opencode/acme",
      version: "latest",
    })
  })
})

describe("Claude external plugin migration detection", () => {
  test("recognizes exact @openchamber/opencode-claude by pkg identity", () => {
    expect(isClaudeExternalPlugin("@openchamber/opencode-claude")).toBe(true)
    expect(isClaudeExternalPlugin("@openchamber/opencode-claude@0.14.0")).toBe(true)
    expect(isClaudeExternalPlugin("npm:@openchamber/opencode-claude")).toBe(true)
    expect(CLAUDE_EXTERNAL_PLUGIN).toBe("@openchamber/opencode-claude")
  })

  test("does not false-positive on substring or unrelated", () => {
    expect(isClaudeExternalPlugin("my-claude-plugin")).toBe(false)
    expect(isClaudeExternalPlugin("@openchamber/other")).toBe(false)
    expect(isClaudeExternalPlugin("opencode-claude")).toBe(false)
  })

  test("does not deprecate the external claude-code provider", () => {
    const prev = process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY
    try {
      expect(isDeprecatedPlugin("@openchamber/opencode-claude")).toBe(false)
    } finally {
      if (prev !== undefined) process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY = prev
      else delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY
    }
  })

  test("external claude remains available regardless of first-party flag", () => {
    const prev = process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY = "1"
    try {
      expect(isDeprecatedPlugin("@openchamber/opencode-claude")).toBe(false)
      expect(isDeprecatedPlugin("@openchamber/opencode-claude@0.14")).toBe(false)
    } finally {
      if (prev !== undefined) process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY = prev
      else delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY
    }
  })

  test("shouldEnableClaudeFirstParty is the single owned migration contract", () => {
    const prev = process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY
    try {
      expect(shouldEnableClaudeFirstParty()).toBe(true)
      expect(shouldEnableClaudeFirstParty({ disableClaudeCodeFirstParty: false })).toBe(true)
      expect(shouldEnableClaudeFirstParty({ disableClaudeCodeFirstParty: true })).toBe(false)
    } finally {
      if (prev !== undefined) process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY = prev
      else delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY
    }

    process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY = "1"
    try {
      expect(shouldEnableClaudeFirstParty()).toBe(false)
    } finally {
      if (prev !== undefined) process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY = prev
      else delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY
    }
  })

  test("shouldEnableClaudeFirstParty disabled produces safe no-side-effect path (for runtime parity)", () => {
    // This is the contract used by runtime for "disabled" readiness + fast-fail.
    // When false, first-party must not spawn CLI, load SDK, or perform network.
    const prev = process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY = "1"
    try {
      expect(shouldEnableClaudeFirstParty()).toBe(false)
      // Pure check only — no side effects exercised here.
    } finally {
      if (prev !== undefined) process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY = prev
      else delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_FIRST_PARTY
    }
  })
})
