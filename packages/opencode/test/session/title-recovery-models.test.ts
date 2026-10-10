import { describe, expect, test } from "bun:test"
import { rankTitleRecoveryModels } from "../../src/session/title-recovery-models"

const model = (
  id: string,
  input: number,
  output: number,
  status = "active",
  toolcall = true,
) => ({ id, status, capabilities: { toolcall }, cost: { input, output } })

describe("title model recovery ranking", () => {
  test("recovers from a deduplicated sole model with cheaper same-provider candidates", () => {
    const models = [
      model("qwen3.8-flash", 0, 0),
      model("other-paid", 0.1, 0.5),
      model("other-free", 0, 0),
    ]
    const result = rankTitleRecoveryModels(models, new Set(["qwen3.8-flash"]))
    expect(result.map((item) => item.id)).toEqual(["other-free", "other-paid"])
  })

  test("rejects models that cannot provide the required terminal tool", () => {
    const models = [
      model("unavailable", 0, 0, "deprecated"),
      model("no-tools", 0, 0, "active", false),
      model("eligible", 2, 3),
      model("experimental", 0, 0, "beta"),
    ]
    expect(rankTitleRecoveryModels(models, new Set()).map((item) => item.id)).toEqual(["eligible"])
  })

  test("has stable ordering on equal cost and strictly bounds fallback work", () => {
    const models = [model("z", 1, 1), model("a", 1, 1), model("b", 1, 1)]
    expect(rankTitleRecoveryModels(models, new Set(), 2).map((item) => item.id)).toEqual(["a", "b"])
    expect(rankTitleRecoveryModels(models, new Set(), 0)).toEqual([])
  })

  test("does not mutate the provider catalog and excludes invalid prices", () => {
    const models = [
      model("valid", 0.2, 1),
      model("negative", -1, 0),
      model("nan", Number.NaN, 0),
    ]
    const before = models.slice()
    expect(rankTitleRecoveryModels(models, new Set()).map((item) => item.id)).toEqual(["valid"])
    expect(models).toEqual(before)
  })
})
