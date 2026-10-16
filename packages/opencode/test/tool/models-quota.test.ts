import { describe, expect, test } from "bun:test"
import type { ProviderResult, UsageWindow, WorkBuddyModelLimit } from "../../src/quota/schema"
import { ModelsQuota } from "../../src/models/quota"

const window = (remainingPercent: number | null): UsageWindow => ({
  usedPercent: remainingPercent === null ? null : 100 - remainingPercent,
  remainingPercent,
  windowSeconds: 18_000,
  resetAt: 1_800_000_000_000,
  resetAfterSeconds: null,
  valueLabel: null,
})
const result = (usage: NonNullable<ProviderResult["usage"]>): ProviderResult => ({
  providerId: "opencode-go",
  providerName: "OpenCode Go",
  ok: true,
  configured: true,
  usage,
  fetchedAt: 1_700_000_000_000,
})
const modelLimit = (exhaustedObserved: boolean): WorkBuddyModelLimit => ({
  model: "deepseek-v3", canonical: "deepseek-v3", unit: "credits",
  usedObserved: 10, limitEstimate: 100, remainingEstimate: exhaustedObserved ? 0 : 90,
  remainingPercent: exhaustedObserved ? 0 : 90, status: exhaustedObserved ? "depleted" : "healthy",
  confidence: "high", accuracy: "server-confirmed", exhaustedObserved,
  serverCode: exhaustedObserved ? 6004 : null,
  resetAt: 1_800_000_000_000, resetSource: "server-6004",
  windowType: "server-defined", windowStartedAt: null, secondsUntilReset: null,
  lastObservationAt: null, burnPerHour: null, estimatedExhaustionAt: null,
  willLikelyExhaustBeforeReset: null,
  creditsObserved: 0, tokensInput: 0, tokensOutput: 0, tokensCacheHit: 0, tokensCacheMiss: 0,
  creditsPersonalized: false, coverage: "opencode-only",
})

describe("models advisory quota projection", () => {
  test("shared OpenCode Go windows do not masquerade as model-specific refusal", () => {
    const projection = ModelsQuota.projectQuota(result({ windows: {
      "5h": window(0),
      "owner@example.com - private": window(40),
    } }), new Set(["deepseek-v3"]))
    expect(projection.windows).toHaveLength(2)
    expect(projection.windows[0]).toMatchObject({ name: "5h", remainingPercent: 0 })
    expect(projection.windows[1]?.name).toBe("window-2")
    expect(JSON.stringify(projection)).not.toContain("owner@example.com")
    expect(projection.models["deepseek-v3"]).toBeUndefined()
  })
  test("exact per-model windows only: zero is an observed advisory hint", () => {
    const projection = ModelsQuota.projectQuota(result({
      windows: {}, models: { "deepseek-v3": { windows: { weekly: window(0), daily: window(10) } } },
    }), new Set(["deepseek-v3"]))
    expect(projection.models["deepseek-v3"]).toMatchObject({
      advisory: true, state: "exhausted-window", source: "model-windows", remainingPercent: 0,
    })
  })
  test("separate observed accounts preserve viable alternatives without identifiers", () => {
    const projection = ModelsQuota.projectQuota(result({
      windows: {},
      workbuddyAccounts: [
        { accountId: "secret-a", label: "account-a@example.com", models: [modelLimit(true)] },
        { accountId: "secret-b", label: "account-b@example.com", models: [modelLimit(false)] },
      ],
    }), new Set(["deepseek-v3"]))
    expect(projection.models["deepseek-v3"]).toMatchObject({
      state: "remaining", knownAccounts: 2, exhaustedObservedAccounts: 1, remainingPercent: 90,
    })
    expect(JSON.stringify(projection)).not.toMatch(/secret-|account-[ab]@/)
  })
  test("all reported observed accounts exhausted is evidence, not hard routing authority", () => {
    const projection = ModelsQuota.projectQuota(result({
      windows: {}, workbuddyAccounts: [{ accountId: "hidden", label: "hidden", models: [modelLimit(true)] }],
    }), new Set(["deepseek-v3"]))
    expect(projection.models["deepseek-v3"]?.state).toBe("exhausted-window")
    expect(projection.source).toBe("provider-account-advisory-not-route-authority")
  })
  test("unavailable snapshot never manufactures exhaustion", () => {
    const snapshot = result({ windows: { daily: window(0) }, models: { "deepseek-v3": { windows: { daily: window(0) } } } })
    const projection = ModelsQuota.projectQuota({ ...snapshot, ok: false }, new Set(["deepseek-v3"]))
    expect(projection.state).toBe("unavailable")
    expect(projection.models["deepseek-v3"]).toBeUndefined()
  })
})
