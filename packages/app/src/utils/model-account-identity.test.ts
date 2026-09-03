import { describe, expect, test } from "bun:test"
import {
  accountShortLabel,
  canonicalModelName,
  isAccountQualified,
  joinAccountModelID,
  splitMultiAccountModelID,
} from "./model-account-identity"

const vectors = [
  ["hy4-preview", "hy4-preview", undefined],
  ["hy4-preview#ctx-262144", "hy4-preview#ctx-262144", undefined],
  ["hy4-preview@wb-3f1c9a", "hy4-preview", "wb-3f1c9a"],
  ["hy4-preview#ctx-262144@wb-3f1c9a", "hy4-preview#ctx-262144", "wb-3f1c9a"],
  ["hy4-preview@wb-auto:headroom", "hy4-preview", "wb-auto:headroom"],
  ["glm-5.3-flash-free@vd-ab12cd", "glm-5.3-flash-free", "vd-ab12cd"],
  ["weird@model-name", "weird@model-name", undefined],
  ["a@wb-", "a@wb-", undefined],
  ["@wb-x", "@wb-x", undefined],
  ["", "", undefined],
] as const

describe("account model identity", () => {
  for (const [input, base, accountID] of vectors) {
    test(`splits ${JSON.stringify(input)}`, () => {
      const result = splitMultiAccountModelID(input)
      expect(result).toEqual(accountID ? { baseModelID: base, accountID } : { baseModelID: base })
      expect(joinAccountModelID(result.baseModelID, result.accountID)).toBe(input)
    })
  }

  test("shortens email labels without changing nicknames", () => {
    expect(accountShortLabel("dana@example.com")).toBe("dana")
    expect(accountShortLabel("Dana")).toBe("Dana")
  })

  test("removes only an exact account decoration", () => {
    const labels = { "wb-account": "jack@example.com" }
    expect(
      canonicalModelName(
        { id: "hy4-preview@wb-account", name: "Hunyuan 4 Preview (jack@example.com)", providerID: "workbuddy" },
        labels,
      ),
    ).toBe("Hunyuan 4 Preview")
    expect(
      canonicalModelName(
        { id: "hy4-preview#ctx-262144@wb-account", name: "Hunyuan 4 Preview (jack@example.com) (256K)", providerID: "workbuddy" },
        labels,
      ),
    ).toBe("Hunyuan 4 Preview (256K)")
    expect(
      canonicalModelName(
        { id: "hy4-preview@wb-account", name: "Hunyuan 4 Preview (256K)", providerID: "workbuddy" },
        labels,
      ),
    ).toBe("Hunyuan 4 Preview (256K)")
  })

  test("does not qualify unrelated at-signs", () => {
    expect(isAccountQualified("weird@model-name")).toBe(false)
    expect(isAccountQualified("hy4-preview@wb-account")).toBe(true)
  })
})
