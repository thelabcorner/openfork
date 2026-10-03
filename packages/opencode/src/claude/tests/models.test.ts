import { describe, it, expect } from "bun:test"
import {
  ClaudeModels,
  MODEL_IDS,
  MODEL_METADATA,
  ALIASES,
  ClaudeModelStatus,
  claudeSubscriptionModelsFromSdk,
  getClaudeSubscriptionModelMetadata,
  recordClaudeSubscriptionModels,
  resetClaudeSubscriptionModelCacheForTest,
  resolveAlias,
} from "../models"
import {
  refreshClaudeSubscriptionModelsFromHandle,
  resetClaudeModelDiscoveryForTest,
} from "../model-discovery"

describe("claude model metadata", () => {
  it("all canonical model IDs have metadata", () => {
    for (const id of MODEL_IDS) {
      expect(MODEL_METADATA[id]).toBeDefined()
      expect(MODEL_METADATA[id]!.id).toBe(id)
      expect(typeof MODEL_METADATA[id]!.name).toBe("string")
      expect(typeof MODEL_METADATA[id]!.family).toBe("string")
    }
  })

  it("aliases cover common reference forms", () => {
    expect(ALIASES["claude/sonnet"]).toBeDefined()
    expect(ALIASES["claude/opus"]).toBeDefined()
    expect(ALIASES["claude/haiku"]).toBeDefined()
    expect(ALIASES["claude/codex"]).toBeDefined()
    // plugin-ported short forms now supported for first-party subscription
    expect(ALIASES["sonnet"]).toBeDefined()
    expect(ALIASES["opus"]).toBeDefined()
    expect(ALIASES["haiku"]).toBeDefined()
    expect(ALIASES["fable"]).toBeDefined()
  })

  it("model status values are from the allowed set", () => {
    for (const id of MODEL_IDS) {
      const meta = MODEL_METADATA[id]!
      const allowed: ClaudeModelStatus[] = ["active", "unavailable", "setup-required", "deprecated"]
      expect(allowed).toContain(meta.status)
    }
  })

  it("capabilities match Claude SDK profile", () => {
    const meta = MODEL_METADATA["claude-sonnet-4-5-20251101"]!
    expect(meta.capabilities.reasoning).toBe(true)
    expect(meta.capabilities.attachment).toBe(true)
    expect(meta.capabilities.toolcall).toBe(true)
    expect(meta.capabilities.input.text).toBe(true)
    expect(meta.capabilities.input.image).toBe(true)
    expect(meta.capabilities.input.pdf).toBe(true)
  })

  it("effort variants are defined for active reasoning models", () => {
    const meta = MODEL_METADATA["claude-opus-4-6"]!
    expect(meta.variants).toBeDefined()
    expect(meta.variants.low).toBeDefined()
    expect(meta.variants.high).toBeDefined()
    expect(meta.variants.max).toBeDefined()
  })

  it("unavailable model has empty variants and zero limits", () => {
    const meta = MODEL_METADATA["claude-codex-4-5"]!
    expect(meta.status).toBe("unavailable")
    expect(meta.variants).toBeDefined()
    expect(meta.contextLimit).toBe(0)
    expect(meta.outputLimit).toBe(0)
  })

  it("keeps moving aliases out of the canonical static model list", () => {
    expect(MODEL_IDS).not.toContain("fable")
    expect(MODEL_IDS).not.toContain("sonnet")
    expect(MODEL_IDS).not.toContain("opus")
    expect(MODEL_IDS).not.toContain("haiku")
    expect(MODEL_IDS).toContain("claude-opus-4-8")
    expect(MODEL_IDS).toContain("claude-sonnet-4-6")
    expect(MODEL_IDS).toContain("claude-haiku-4-5")
  })

  it("normalizes SDK supportedModels into concrete stable IDs and 1M rules", () => {
    const models = claudeSubscriptionModelsFromSdk([
      {
        value: "opus",
        resolvedModel: "claude-opus-5-5",
        supportedEffortLevels: ["low", "high", "not-real"],
      },
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        supportedEffortLevels: ["medium", "high"],
      },
      {
        value: "claude-opus-4-8",
        resolvedModel: "claude-opus-4-8",
        supportedEffortLevels: ["high"],
      },
      { value: "default", resolvedModel: "claude-sonnet-5" },
    ])

    expect(models["claude-opus-5-5[1m]"]?.contextLimit).toBe(1_000_000)
    expect(Object.keys(models["claude-opus-5-5[1m]"]?.variants ?? {})).toEqual(["low", "high"])
    expect(models["claude-sonnet-5"]?.contextLimit).toBe(200_000)
    expect(models["claude-sonnet-5[1m]"]?.contextLimit).toBe(1_000_000)
    expect(models["claude-opus-4-8"]?.contextLimit).toBe(1_000_000)
    expect(models["claude-opus-4-8[1m]"]).toBeUndefined()
    expect(models.default).toBeUndefined()
  })

  it("does not invent effort variants when the SDK reports none", () => {
    const models = claudeSubscriptionModelsFromSdk([
      {
        value: "haiku",
        resolvedModel: "claude-haiku-4-5",
        supportedEffortLevels: [],
      },
    ])
    expect(models["claude-haiku-4-5"]).toBeDefined()
    expect(models["claude-haiku-4-5"]?.variants).toEqual({})
    expect(models["claude-haiku-4-5"]?.capabilities.reasoning).toBe(false)
  })

  it("does not let 200K models.dev metadata collapse an SDK-advertised 1M variant", () => {
    const models = claudeSubscriptionModelsFromSdk(
      [
        {
          value: "sonnet",
          resolvedModel: "claude-sonnet-5",
          supportedEffortLevels: ["high"],
        },
      ],
      {
        id: "anthropic",
        name: "Anthropic",
        env: [],
        models: {
          "claude-sonnet-5": {
            id: "claude-sonnet-5",
            name: "Claude Sonnet 5",
            release_date: "2026-01-01",
            attachment: true,
            reasoning: true,
            temperature: false,
            tool_call: true,
            limit: { context: 200_000, output: 64_000 },
          },
        },
      } as any,
    )
    expect(models["claude-sonnet-5"]?.contextLimit).toBe(200_000)
    expect(models["claude-sonnet-5[1m]"]?.contextLimit).toBe(1_000_000)
    expect(models["claude-sonnet-5[1m]"]?.outputLimit).toBe(128_000)
  })

  it("uses only concrete current models for emergency subscription bootstrap", () => {
    resetClaudeSubscriptionModelCacheForTest()
    const models = getClaudeSubscriptionModelMetadata()
    expect(models["claude-opus-5-5[1m]"]).toBeDefined()
    expect(models["claude-fable-5-1[1m]"]).toBeDefined()
    expect(models["claude-sonnet-5"]).toBeDefined()
    expect(models["claude-sonnet-5[1m]"]).toBeDefined()
    expect(models["claude-haiku-4-5"]).toBeDefined()
    expect(models["claude-opus-4-8"]).toBeDefined()
    expect(models.sonnet).toBeUndefined()
    expect(models.opus).toBeUndefined()
    expect(models.haiku).toBeUndefined()
    expect(models.fable).toBeUndefined()
  })

  it("does not let models.dev expand the subscription entitlement catalog", () => {
    resetClaudeSubscriptionModelCacheForTest()
    const models = getClaudeSubscriptionModelMetadata({
      id: "anthropic",
      name: "Anthropic",
      env: [],
      models: {
        "claude-sonnet-2": {
          id: "claude-sonnet-2",
          name: "Legacy Sonnet",
          release_date: "2024-01-01",
          attachment: true,
          reasoning: false,
          temperature: true,
          tool_call: true,
          limit: { context: 123_456, output: 7_777 },
        },
        "claude-sonnet-5": {
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5 API metadata",
          release_date: "2026-01-01",
          attachment: true,
          reasoning: true,
          temperature: false,
          tool_call: true,
          limit: { context: 999_999, output: 1 },
        },
      },
    } as any)
    expect(models["claude-sonnet-2"]).toBeUndefined()
    expect(models["claude-sonnet-5"]?.contextLimit).toBe(200_000)
    expect(models["claude-sonnet-5"]?.outputLimit).toBe(64_000)
    expect(models["claude-sonnet-5"]?.releaseDate).toBe("2026-01-01")
  })

  it("uses recorded SDK discovery as the subscription catalog and resolves family aliases", () => {
    resetClaudeSubscriptionModelCacheForTest()
    expect(
      recordClaudeSubscriptionModels([
        {
          value: "sonnet",
          resolvedModel: "claude-sonnet-5",
          supportedEffortLevels: ["low", "high"],
        },
        {
          value: "opus",
          resolvedModel: "claude-opus-5-5",
          supportedEffortLevels: ["high"],
        },
      ]),
    ).toBe(true)

    const models = getClaudeSubscriptionModelMetadata()
    expect(models["claude-sonnet-5"]).toBeDefined()
    expect(models["claude-sonnet-5[1m]"]).toBeDefined()
    expect(models["claude-opus-5-5[1m]"]).toBeDefined()
    expect(resolveAlias("sonnet")).toBe("claude-sonnet-5")
    expect(resolveAlias("claude/opus")).toBe("claude-opus-5-5[1m]")
    resetClaudeSubscriptionModelCacheForTest()
  })

  it("throttles failed live-handle discovery instead of retrying every turn", async () => {
    resetClaudeSubscriptionModelCacheForTest()
    resetClaudeModelDiscoveryForTest()
    let calls = 0
    const handle = {
      supportedModels: async () => {
        calls += 1
        return []
      },
    }
    expect(await refreshClaudeSubscriptionModelsFromHandle(handle)).toBe(false)
    expect(await refreshClaudeSubscriptionModelsFromHandle(handle)).toBe(false)
    expect(calls).toBe(1)
    resetClaudeModelDiscoveryForTest()
    resetClaudeSubscriptionModelCacheForTest()
  })

  it("single-flights concurrent live-handle discovery", async () => {
    resetClaudeSubscriptionModelCacheForTest()
    resetClaudeModelDiscoveryForTest()
    let calls = 0
    let release!: (rows: unknown[]) => void
    const pending = new Promise<unknown[]>((resolve) => {
      release = resolve
    })
    const handle = {
      supportedModels: async () => {
        calls += 1
        return pending
      },
    }
    const first = refreshClaudeSubscriptionModelsFromHandle(handle)
    const second = refreshClaudeSubscriptionModelsFromHandle(handle)
    expect(calls).toBe(1)
    release([
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        supportedEffortLevels: ["high"],
      },
    ])
    await Promise.all([first, second])
    expect(calls).toBe(1)
    resetClaudeModelDiscoveryForTest()
    resetClaudeSubscriptionModelCacheForTest()
  })
})
