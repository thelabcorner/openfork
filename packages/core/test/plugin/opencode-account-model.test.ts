import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { OpencodeAccountModel } from "@opencode-ai/core/plugin/provider/opencode-account-model"
import type { AccountProviderCapability } from "@opencode-ai/core/plugin/provider/opencode-account-capability"

const providerID = ProviderV2.ID.make("console-test")
const modelID = ModelV2.ID.make("alpha")

const base = ModelV2.Info.make({
  id: modelID,
  providerID,
  family: ModelV2.Family.make("base"),
  name: "Base Alpha",
  api: {
    id: ModelV2.ID.make("wrong-wire-id"),
    type: "aisdk",
    package: "@ai-sdk/openai",
    url: "https://wrong.example/v1",
  },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  request: {
    headers: {
      Authorization: "Bearer wrong-secret",
      "x-base-header": "must-not-survive",
    },
    body: {
      apiKey: "wrong-secret",
      temperature: 0.9,
      staleOption: true,
    },
  },
  variants: [
    {
      id: ModelV2.VariantID.make("stale"),
      headers: { Authorization: "Bearer stale-secret" },
      body: { stale: true },
    },
  ],
  time: { released: 0 },
  cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }],
  status: "active",
  enabled: true,
  limit: { context: 10_000, output: 1_000 },
})

const capability: AccountProviderCapability = {
  id: providerID,
  name: "Exact Account",
  api: "https://exact.example/v1",
  npm: "@ai-sdk/openai-compatible",
  options: {
    baseURL: "https://provider-option.example/v1",
    apiKey: "must-be-stripped",
    headers: { Authorization: "must-be-stripped" },
    providerFlag: true,
  },
  headers: {
    "x-account-provider": "provider",
  },
  models: {
    [modelID]: {
      id: modelID,
      apiID: "wire-alpha",
      providerID,
      config: {
        id: "wire-alpha",
        options: {
          apiKey: "must-be-stripped",
          exactOption: 7,
        },
        headers: {
          Authorization: "must-be-stripped",
          "x-account-model": "model",
        },
        variants: {
          precise: {
            options: { exactVariant: true, apiKey: "must-be-stripped" },
            headers: { "x-variant": "precise", Authorization: "must-be-stripped" },
          },
        },
      },
    },
  },
  configIdentity: "config-exact",
}

describe("OpenCode exact account model compiler", () => {
  test("replaces transport state instead of inheriting active/default account material", () => {
    const compiled = OpencodeAccountModel.compile(base, capability, modelID)
    expect(compiled).toBeDefined()
    if (!compiled) throw new Error("expected compiled account model")

    expect(compiled.api).toEqual({
      id: ModelV2.ID.make("wire-alpha"),
      type: "aisdk",
      package: "@ai-sdk/openai-compatible",
      url: "https://exact.example/v1",
    })
    expect(compiled.request.headers).toEqual({
      "x-account-provider": "provider",
      "x-account-model": "model",
    })
    expect(compiled.request.body).toMatchObject({
      baseURL: "https://provider-option.example/v1",
      providerFlag: true,
      exactOption: 7,
    })
    expect(compiled.request.body).not.toHaveProperty("apiKey")
    expect(compiled.request.body).not.toHaveProperty("staleOption")
    expect(compiled.request.headers).not.toHaveProperty("Authorization")
    expect(compiled.variants).toEqual([
      {
        id: ModelV2.VariantID.make("precise"),
        headers: { "x-variant": "precise" },
        body: { exactVariant: true },
      },
    ])

    const serialized = JSON.stringify(compiled)
    expect(serialized).not.toContain("wrong-secret")
    expect(serialized).not.toContain("stale-secret")
    expect(serialized).not.toContain("must-be-stripped")
  })

  test("fails closed when the committed account capability no longer serves the model", () => {
    expect(OpencodeAccountModel.compile(base, { ...capability, models: {} }, modelID)).toBeUndefined()
  })
})