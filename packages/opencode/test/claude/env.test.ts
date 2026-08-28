import { describe, test, expect } from "bun:test"
import { AUTH_OVERRIDE_ENV_KEYS, buildChildEnv, homeDir, claudeConfigDir } from "../../src/claude/env"

describe("ClaudeEnv", () => {
  test("buildChildEnv removes credential overrides and preserves everything else", () => {
    const base = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      ANTHROPIC_AUTH_TOKEN: "token-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
      HOME: "/home/u",
    }
    const child = buildChildEnv(base)
    for (const key of AUTH_OVERRIDE_ENV_KEYS) expect(child[key]).toBeUndefined()
    expect(child.PATH).toBe("/usr/bin")
    expect(child.HOME).toBe("/home/u")
  })

  test("buildChildEnv does not mutate the base env", () => {
    const base = { ANTHROPIC_API_KEY: "sk-ant-secret", PATH: "/bin" }
    buildChildEnv(base)
    expect(base.ANTHROPIC_API_KEY).toBe("sk-ant-secret")
  })

  test("homeDir prefers USERPROFILE then HOME then undefined", () => {
    expect(homeDir({ USERPROFILE: "C:\\Users\\u", HOME: "/home/u" })).toBe("C:\\Users\\u")
    expect(homeDir({ HOME: "/home/u" })).toBe("/home/u")
    expect(homeDir({ USERPROFILE: "  " })).toBeUndefined()
    expect(homeDir({})).toBeUndefined()
  })

  test("claudeConfigDir passes through explicit override only", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/custom/claude" })).toBe("/custom/claude")
    expect(claudeConfigDir({})).toBeUndefined()
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "   " })).toBeUndefined()
  })
})
