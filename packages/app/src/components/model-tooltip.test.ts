import { describe, expect, test } from "bun:test"
import { parseModelAccount } from "./model-tooltip"

describe("parseModelAccount", () => {
  test("parses WorkBuddy account ids after a context alias", () => {
    expect(parseModelAccount("hy4-preview#ctx-262144@wb-account-a", "workbuddy")).toBe("wb-account-a")
  })

  test("parses Verdent account ids after a context alias", () => {
    expect(parseModelAccount("glm-5.3-flash-free@300k@vd-account-a", "verdent")).toBe("vd-account-a")
  })

  test("does not treat bare or unrelated ids as account-qualified", () => {
    expect(parseModelAccount("hy4-preview", "workbuddy")).toBeUndefined()
    expect(parseModelAccount("glm-5.3-flash-free@300k", "verdent")).toBeUndefined()
    expect(parseModelAccount("foo@bar", "workbuddy")).toBeUndefined()
    expect(parseModelAccount("foo@wb-", "workbuddy")).toBeUndefined()
    expect(parseModelAccount("foo@wb-account", "verdent")).toBeUndefined()
  })

  test("rejects malformed suffixes without a non-empty account id", () => {
    expect(parseModelAccount("@wb-account", "workbuddy")).toBeUndefined()
    expect(parseModelAccount("foo@wb-account@extra", "workbuddy")).toBeUndefined()
  })
})
