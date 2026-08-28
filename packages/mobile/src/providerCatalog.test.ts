import { describe, expect, test } from "bun:test"
import type { Provider, ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import { normalizeLegacyProviders } from "./providerCatalog"

const provider = (id: string) => ({ id, name: id, models: {} }) as Provider

describe("normalizeLegacyProviders", () => {
  test("keeps every connected provider from the legacy catalog response", () => {
    const input = {
      all: [provider("anthropic"), provider("custom-one"), provider("custom-two")],
      connected: ["anthropic", "custom-two"],
      default: {},
    } as ProviderListResponse

    expect(normalizeLegacyProviders(input).map((item) => item.id)).toEqual(["anthropic", "custom-two"])
  })

  test("accepts array responses from compatibility servers", () => {
    expect(normalizeLegacyProviders([provider("custom")]).map((item) => item.id)).toEqual(["custom"])
  })
})
