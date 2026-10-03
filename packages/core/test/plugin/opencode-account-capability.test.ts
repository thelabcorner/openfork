import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { projectAccountCapabilities } from "@opencode-ai/core/plugin/provider/opencode-account-capability"
import type { Snapshot } from "@opencode-ai/core/plugin/provider/opencode-account-config"

const snapshot = (config: unknown, overrides: Partial<Snapshot> = {}): Snapshot => ({
  scope: "realm-a",
  credentialID: Credential.ID.make("cred_a"),
  credentialRevision: 4,
  server: "https://console.example",
  orgID: "org-a",
  version: 9,
  fetchedAt: 100,
  expiresAt: 200,
  config: Schema.decodeUnknownSync(ConfigV1.Info)(config),
  ...overrides,
})

describe("OpenCode account capability projection", () => {
  test("indexes account-specific providers and models without collapsing transport definitions", () => {
    const result = projectAccountCapabilities(
      snapshot({
        provider: {
          opencode: {
            api: "https://api-a.example/v1",
            npm: "@ai-sdk/openai-compatible",
            models: {
              alpha: { id: "served-alpha", cost: { input: 1, output: 2 } },
              beta: { cost: { input: 3, output: 4 } },
            },
          },
        },
      }),
    )

    expect(result.scope).toBe("realm-a")
    expect(result.credentialRevision).toBe(4)
    expect(result.configVersion).toBe(9)
    expect(result.servesModel("opencode", "alpha")).toBe(true)
    expect(result.servesModel("opencode", "beta")).toBe(true)
    expect(result.providers.opencode?.models.alpha?.apiID).toBe("served-alpha")
    expect(result.providers.opencode?.api).toBe("https://api-a.example/v1")
  })

  test("removes credential-bearing options and headers from the retained capability snapshot", () => {
    const result = projectAccountCapabilities(
      snapshot({
        provider: {
          opencode: {
            options: {
              apiKey: "{env:OPENCODE_CONSOLE_TOKEN}",
              access_token: "do-not-retain",
              baseURL: "https://safe.example/v1",
              headers: {
                Authorization: "Bearer do-not-retain",
                "x-api-key": "do-not-retain",
                "x-safe": "safe",
              },
            },
            models: {
              alpha: {
                headers: {
                  authorization: "Bearer do-not-retain",
                  "x-safe-model": "safe-model",
                },
              },
            },
          },
        },
      }),
    )

    const provider = result.providers.opencode!
    const serialized = JSON.stringify(provider)
    expect(serialized).not.toContain("OPENCODE_CONSOLE_TOKEN")
    expect(serialized).not.toContain("do-not-retain")
    expect(provider.options.baseURL).toBe("https://safe.example/v1")
    expect(provider.headers).toEqual({ "x-safe": "safe" })
    expect(provider.models.alpha?.config.headers).toEqual({ "x-safe-model": "safe-model" })
  })

  test("config identity is deterministic for semantically identical object key ordering", () => {
    const a = projectAccountCapabilities(
      snapshot({
        provider: {
          opencode: {
            api: "https://same.example/v1",
            options: { z: 1, a: 2 },
            models: { alpha: { options: { z: true, a: false } } },
          },
        },
      }),
    )
    const b = projectAccountCapabilities(
      snapshot({
        provider: {
          opencode: {
            models: { alpha: { options: { a: false, z: true } } },
            options: { a: 2, z: 1 },
            api: "https://same.example/v1",
          },
        },
      }),
    )

    expect(a.providers.opencode?.configIdentity).toBe(b.providers.opencode?.configIdentity)
  })

  test("different account transport definitions produce different non-secret config identities", () => {
    const a = projectAccountCapabilities(
      snapshot({
        provider: {
          opencode: {
            api: "https://account-a.example/v1",
            models: { alpha: { cost: { input: 1, output: 2 } } },
          },
        },
      }),
    )
    const b = projectAccountCapabilities(
      snapshot(
        {
          provider: {
            opencode: {
              api: "https://account-b.example/v1",
              models: { alpha: { cost: { input: 5, output: 8 } } },
            },
          },
        },
        { credentialID: Credential.ID.make("cred_b") },
      ),
    )

    expect(a.providers.opencode?.configIdentity).not.toBe(b.providers.opencode?.configIdentity)
    expect(a.servesModel("opencode", "alpha")).toBe(true)
    expect(b.servesModel("opencode", "alpha")).toBe(true)
  })

  test("empty or absent account config advertises no route capability", () => {
    const result = projectAccountCapabilities(snapshot({}))
    expect(result.providers).toEqual({})
    expect(result.servesModel("opencode", "anything")).toBe(false)
  })
})
