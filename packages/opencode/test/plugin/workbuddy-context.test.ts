import { describe, expect, test } from "bun:test"
import { decodeWorkBuddyContextModel, parseWorkBuddyContextWindows } from "@/plugin/workbuddy"

describe("WorkBuddy context windows", () => {
  test("reads explicit selectable lengths and preserves the default", () => {
    expect(
      parseWorkBuddyContextWindows(
        { defaultLength: 131_072, supportedLengths: [32_768, { tokens: 65_536 }, 131_072] },
        131_072,
      ),
    ).toEqual([32_768, 65_536, 131_072])
  })

  test("ignores range bounds and malformed values", () => {
    expect(
      parseWorkBuddyContextWindows(
        { minLength: 1, maxLength: 1_048_576, lengths: ["bad", 0, 262_144] },
        131_072,
      ),
    ).toEqual([131_072, 262_144])
  })

  test("decodes context aliases without disturbing account affinity", () => {
    expect(decodeWorkBuddyContextModel("hy4-preview#ctx-262144")).toEqual({
      model: "hy4-preview",
      contextWindowTokens: 262_144,
    })
    expect(decodeWorkBuddyContextModel("hy4-preview@wb-account-a")).toEqual({
      model: "hy4-preview@wb-account-a",
    })
  })
})
