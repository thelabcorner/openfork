import { describe, expect, test } from "bun:test"
import {
  hasCustomAgent,
  isDelegatableAgent,
  isPrimarySelectableAgent,
  isSubagentMentionableAgent,
  resolveAgent,
} from "./local-agent"

describe("hasCustomAgent", () => {
  test("detects explicitly custom agents", () => {
    expect(hasCustomAgent([{ native: true }, { native: false }])).toBe(true)
  })

  test("ignores built-in and unclassified agents", () => {
    expect(hasCustomAgent([{ native: true }, {}])).toBe(false)
  })
})

describe("resolveAgent", () => {
  const agents = [{ name: "plan" }, { name: "build" }, { name: "custom" }]

  test("uses the requested available agent", () => {
    expect(resolveAgent(agents, "custom")?.name).toBe("custom")
  })

  test("defaults to build", () => {
    expect(resolveAgent(agents)?.name).toBe("build")
    expect(resolveAgent(agents, "missing")?.name).toBe("build")
  })

  test("uses the first agent when build is unavailable", () => {
    expect(resolveAgent([{ name: "custom" }], "missing")?.name).toBe("custom")
  })
})

describe("agent capability filters", () => {
  test("primary selector admits primary and all agents only", () => {
    expect(isPrimarySelectableAgent({ mode: "primary" })).toBe(true)
    expect(isPrimarySelectableAgent({ mode: "all" })).toBe(true)
    expect(isPrimarySelectableAgent({ mode: "subagent" })).toBe(false)
    expect(isPrimarySelectableAgent({ mode: "all", hidden: true })).toBe(false)
  })

  test("@mentions admit subagent and all agents only", () => {
    expect(isSubagentMentionableAgent({ mode: "subagent" })).toBe(true)
    expect(isSubagentMentionableAgent({ mode: "all" })).toBe(true)
    expect(isSubagentMentionableAgent({ mode: "primary" })).toBe(false)
    expect(isSubagentMentionableAgent({ mode: "subagent", hidden: true })).toBe(false)
  })

  test("delegation follows mode and ignores discoverability", () => {
    expect(isDelegatableAgent({ mode: "subagent" })).toBe(true)
    expect(isDelegatableAgent({ mode: "all" })).toBe(true)
    expect(isDelegatableAgent({ mode: "primary" })).toBe(false)
    // Hidden is a chooser flag: it must not take a subagent away from Task.
    expect(isDelegatableAgent({ mode: "subagent", hidden: true })).toBe(true)
    expect(isDelegatableAgent({ mode: "all", hidden: true })).toBe(true)
  })

  test("an unrecognized wire mode falls back to the runtime default for custom agents", () => {
    expect(isPrimarySelectableAgent({ mode: "" })).toBe(true)
    expect(isSubagentMentionableAgent({ mode: "" })).toBe(true)
    expect(isDelegatableAgent({ mode: "" })).toBe(true)
  })
})
