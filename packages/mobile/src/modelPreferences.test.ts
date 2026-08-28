import { describe, expect, test } from "bun:test"
import type { Provider } from "@opencode-ai/sdk/v2/client"
import { applyProviderRailOrder, readProviderRailOrder } from "./modelPreferences"

const provider = (id: string) => ({ id }) as Provider

describe("model preferences", () => {
  test("reads the provider rail order written by the desktop model store", () => {
    const storage = {
      getItem: (key: string) =>
        key === "opencode.global.dat:model"
          ? JSON.stringify({ order: { "section:provider:rail": ["custom", "openai", "anthropic"] } })
          : null,
    }

    expect(readProviderRailOrder(storage)).toEqual(["custom", "openai", "anthropic"])
  })

  test("keeps unranked providers after the desktop-defined order", () => {
    const providers = [provider("anthropic"), provider("openrouter"), provider("openai"), provider("custom")]
    expect(applyProviderRailOrder(providers, ["custom", "openai", "anthropic"]).map((item) => item.id)).toEqual([
      "custom",
      "openai",
      "anthropic",
      "openrouter",
    ])
  })
})
