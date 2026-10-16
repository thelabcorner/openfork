import { describe, expect, test } from "bun:test"
import { normalizePromptCorrectionRule, normalizePromptCorrectionRules } from "./prompt-correction-policy"

describe("shared custom spelling rule validation", () => {
  test("accepts exact English ASCII word pairs with canonical casing", () => {
    expect(normalizePromptCorrectionRule("GAOL", "Goal")).toEqual({ from: "gaol", to: "goal" })
    expect(normalizePromptCorrectionRule("Fuction", "Function")).toEqual({ from: "fuction", to: "function" })
  })

  test("rejects invalid lengths, text syntax, self-maps and nonstrings", () => {
    for (const [from, to] of [
      ["a", "word"], ["safe", "x"], ["a".repeat(41), "word"],
      ["gaol", "gaol"], ["file.ts", "file"], ["foo-bar", "baz"],
      ["étude", "study"], ["foo", "package/name"], ["", ""], [null, "word"],
      ["foo", 17], ["not space", "space"],
    ]) expect(normalizePromptCorrectionRule(from, to)).toBeUndefined()
  })

  test("normalizes stale persisted rules without claiming forbidden mappings are enabled", () => {
    expect(normalizePromptCorrectionRules({
      GAOL: "Goal",
      approve: "reject",
      run: "execute",
      fuction: "function",
      "foo-bar": "foo",
      wrong: null,
    })).toEqual({ gaol: "goal", fuction: "function" })
    expect(normalizePromptCorrectionRules(undefined)).toEqual({})
  })

  test("refuses substitutions affecting actions, permissions or negation in either direction", () => {
    for (const pair of [
      ["approve", "reject"], ["gaol", "delete"], ["send", "goal"],
      ["always", "sometimes"], ["no", "yes"], ["start", "stop"],
      ["administrator", "admin"], ["publish", "draft"], ["private", "public"],
      ["commit", "save"], ["permit", "forbid"],
    ]) expect(normalizePromptCorrectionRule(pair[0], pair[1])).toBeUndefined()
  })
})
