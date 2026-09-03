import { describe, expect, test } from "bun:test"
import { collapseAccountVariants, expandForQuery, groupForModelID, variantForPolicy } from "./dialog-select-model-accounts"

const item = (id: string, name = "Hunyuan 4 Preview") => ({ id, name, provider: { id: "workbuddy", name: "WorkBuddy" } })

describe("collapseAccountVariants", () => {
  test("keeps one canonical row and enrollment order", () => {
    const models = [
      item("hy4-preview@wb-a", "Hunyuan 4 Preview (a@example.com)"),
      item("hy4-preview@wb-b", "Hunyuan 4 Preview (b@example.com)"),
      item("hy4-preview"),
    ]
    const [group] = collapseAccountVariants(models)
    expect(group?.canonical.id).toBe("hy4-preview")
    expect(group?.auto?.id).toBe("hy4-preview")
    expect(group?.variants.map((variant) => variant.accountID)).toEqual(["wb-a", "wb-b"])
    expect(group?.label).toBe("Hunyuan 4 Preview")
  })

  test("does not collapse unrelated providers or at-signs", () => {
    const models = [
      { id: "foo@bar", name: "Foo", provider: { id: "anthropic", name: "Anthropic" } },
      { id: "foo@wb-a", name: "Foo", provider: { id: "anthropic", name: "Anthropic" } },
    ]
    const groups = collapseAccountVariants(models)
    expect(groups).toHaveLength(2)
    expect(groups.every((group) => group.variants.length === 0)).toBe(true)
  })

  test("keeps context aliases in separate groups", () => {
    const groups = collapseAccountVariants([
      item("hy4-preview#ctx-262144@wb-a", "Hunyuan 4 Preview (a@example.com) (256K)"),
      item("hy4-preview#ctx-262144"),
      item("hy4-preview@wb-a", "Hunyuan 4 Preview (a@example.com)"),
      item("hy4-preview"),
    ])
    expect(groups.map((group) => group.key)).toEqual([
      "workbuddy:hy4-preview#ctx-262144",
      "workbuddy:hy4-preview",
    ])
  })

  test("expands a group when searching by account id", () => {
    const groups = collapseAccountVariants([
      item("hy4-preview@wb-dana", "Hunyuan 4 Preview (dana@example.com)"),
      item("hy4-preview@wb-sam", "Hunyuan 4 Preview (sam@example.com)"),
      item("hy4-preview"),
    ])
    expect(expandForQuery(groups, "dana").map((model) => model.id)).toEqual(["hy4-preview@wb-dana"])
    expect(expandForQuery(groups, "hunyuan").map((model) => model.id)).toEqual(["hy4-preview"])
  })

  test("resolves account and policy selections", () => {
    const [group] = collapseAccountVariants([item("hy4-preview@wb-a"), item("hy4-preview")])
    expect(group).toBeDefined()
    expect(variantForPolicy(group!, "wb-a")?.id).toBe("hy4-preview@wb-a")
    expect(variantForPolicy(group!, "headroom")?.id).toBe("hy4-preview@wb-auto:headroom")
    expect(groupForModelID([group!], "workbuddy", "hy4-preview@wb-a")).toBe(group)
  })
})
