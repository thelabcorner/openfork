import { describe, expect, test } from "bun:test"
import { modelSwitchSelection } from "./model-switch-selection"

describe("running model switch selection", () => {
  test("uses the visible picker model rather than a stale draft selection", () => {
    const picked = { id: "model-next", provider: { id: "provider-next" } }
    const selection = modelSwitchSelection(picked, "high")
    expect(selection).toEqual({ providerID: "provider-next", modelID: "model-next", variant: "high" })
    expect(selection).not.toMatchObject({ providerID: "provider-old", modelID: "model-old" })
  })

  test("separates account-qualified Zen/Go models from credential identity", () => {
    expect(modelSwitchSelection({ id: "m@zen-889db3308123", provider: { id: "opencode-go" } }, "max")).toEqual({
      providerID: "opencode-go",
      modelID: "m",
      accountID: "zen-889db3308123",
      variant: "max",
    })
  })

  test("preserves literal at-sign model IDs for unrelated providers", () => {
    expect(modelSwitchSelection({ id: "vendor/model@x", provider: { id: "openrouter" } }, "default")).toEqual({
      providerID: "openrouter",
      modelID: "vendor/model@x",
    })
  })

  test("omits default variants and absent selections", () => {
    const picked = { id: "next-model", provider: { id: "next-provider" } }
    expect(modelSwitchSelection(picked, undefined)).toEqual({ providerID: "next-provider", modelID: "next-model" })
    expect(modelSwitchSelection(picked, "default")).toEqual({ providerID: "next-provider", modelID: "next-model" })
    expect(modelSwitchSelection(undefined, "high")).toBeUndefined()
  })
})
