import { describe, expect, test } from "bun:test"
import { observeYieldStatistic } from "@opencode-ai/core/usage/yield-statistics"
import * as ProviderCapacity from "../../src/capacity/provider-capacity"
import type { ProviderResult, ProviderSummary } from "../../src/quota/schema"

const model = {
  id: "test-model",
  name: "Test Model",
  release_date: "2026-01-01",
  attachment: false,
  reasoning: false,
  temperature: true,
  tool_call: true,
  cost: {
    input: 1,
    output: 2,
    cache_read: 0.1,
    cache_write: 1,
  },
  limit: { context: 200_000, output: 8_000 },
} as any

const catalog = {
  openrouter: {
    name: "OpenRouter",
    env: [],
    npm: "@ai-sdk/openai-compatible",
    models: { [model.id]: model },
  },
  genspark: {
    name: "Genspark",
    env: [],
    npm: "@ai-sdk/openai-compatible",
    models: { [model.id]: model },
  },
  nvidia: {
    name: "NVIDIA",
    env: [],
    npm: "@ai-sdk/openai-compatible",
    models: { [model.id]: model },
  },
  claude: {
    name: "Claude",
    env: [],
    npm: "@ai-sdk/anthropic",
    models: { [model.id]: model },
  },
} as any

const summary = (providerId: string, aliases: string[] = []): ProviderSummary => ({
  providerId,
  providerName: providerId,
  aliases,
  configured: true,
})

const result = (
  providerId: string,
  windows: NonNullable<ProviderResult["usage"]>["windows"],
  extra?: Partial<NonNullable<ProviderResult["usage"]>>,
): ProviderResult => ({
  providerId,
  providerName: providerId,
  ok: true,
  configured: true,
  planLabel: null,
  usage: { windows, ...extra },
  fetchedAt: 1_000,
})

describe("generic provider Capacity", () => {
  test("uses an exact request resource without personal history", () => {
    const provider = ProviderCapacity.buildProvider({
      summary: summary("nvidia"),
      result: result("nvidia", {
        "1m": {
          usedPercent: 60,
          remainingPercent: 40,
          windowSeconds: 60,
          resetAt: 2_000,
          resetAfterSeconds: 1,
          valueLabel: null,
          resource: {
            kind: "requests",
            unit: "request",
            used: 24,
            remaining: 16,
            limit: 40,
          },
        },
      }),
      catalog,
      entries: [],
      at: 1_000,
    })

    expect(provider.defaultEstimates[0]?.status).toBe("ready")
    expect(provider.defaultEstimates[0]?.estimatedRequests).toBe(16)
    expect(provider.defaultEstimates[0]?.source).toBe("direct-request-budget")
  })

  test("prices a monetary balance at n=0 from the standardized cross-provider workload prior", () => {
    const provider = ProviderCapacity.buildProvider({
      summary: summary("openrouter"),
      result: result("openrouter", {
        credits: {
          usedPercent: null,
          remainingPercent: null,
          windowSeconds: null,
          resetAt: null,
          resetAfterSeconds: null,
          valueLabel: "$10",
          resource: {
            kind: "money",
            unit: "USD",
            currency: "USD",
            used: null,
            remaining: 10,
            limit: null,
          },
        },
      }),
      catalog,
      entries: [],
      at: 1_000,
    })

    const estimate = provider.estimates.find((item) => item.modelID === model.id)
    expect(estimate?.status).toBe("ready")
    expect(estimate?.source).toBe("standardized-workload-prior")
    expect(estimate?.personalized).toBe(false)
    expect(estimate?.estimatedRequests).toBeGreaterThan(0)
    expect(estimate?.evidence.observations).toBe(0)
  })

  test("personalizes the monetary prior after the first settled request", () => {
    const state = observeYieldStatistic(undefined, {
      sessionID: "s1",
      completedAt: 900,
      tokens: {
        input: 40_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 8_000,
        reasoning: 0,
      },
    })
    const provider = ProviderCapacity.buildProvider({
      summary: summary("openrouter"),
      result: result("openrouter", {
        credits: {
          usedPercent: null,
          remainingPercent: null,
          windowSeconds: null,
          resetAt: null,
          resetAfterSeconds: null,
          valueLabel: "$10",
          resource: {
            kind: "money",
            unit: "USD",
            currency: "USD",
            used: null,
            remaining: 10,
            limit: null,
          },
        },
      }),
      catalog,
      entries: [{
        key: { providerID: "openrouter", baseModelID: model.id },
        state,
        updatedAt: 900,
      }],
      at: 1_000,
    })

    const estimate = provider.estimates.find((item) => item.modelID === model.id)
    expect(estimate?.status).toBe("ready")
    expect(estimate?.source).toBe("personal-current-price")
    expect(estimate?.personalized).toBe(true)
    expect(estimate?.evidence.observations).toBe(1)
  })

  test("converts published credit pack value without a token-count heuristic", () => {
    const provider = ProviderCapacity.buildProvider({
      summary: summary("genspark"),
      result: result("genspark", {
        credits: {
          usedPercent: null,
          remainingPercent: null,
          windowSeconds: null,
          resetAt: null,
          resetAfterSeconds: null,
          valueLabel: "7,500 credits",
          resource: {
            kind: "credits",
            unit: "credit",
            used: null,
            remaining: 7_500,
            limit: null,
            usdPerUnit: 20 / 7_500,
          },
        },
      }),
      catalog,
      entries: [],
      at: 1_000,
    })

    const estimate = provider.estimates.find((item) => item.modelID === model.id)
    expect(estimate?.status).toBe("ready")
    expect(estimate?.source).toBe("standardized-workload-prior")
    expect(estimate?.estimatedRequests).toBeGreaterThan(0)
  })

  test("keeps opaque relative quota honest until resource burn has been learned", () => {
    const provider = ProviderCapacity.buildProvider({
      summary: summary("claude"),
      result: result("claude", {
        "5h": {
          usedPercent: 30,
          remainingPercent: 70,
          windowSeconds: 18_000,
          resetAt: 2_000,
          resetAfterSeconds: 1,
          valueLabel: null,
          resource: {
            kind: "relative",
            unit: "fraction",
            used: 0.3,
            remaining: 0.7,
            limit: 1,
          },
        },
      }),
      catalog,
      entries: [],
      at: 1_000,
    })

    expect(provider.defaultEstimates[0]?.status).toBe("learning")
    expect(provider.defaultEstimates[0]?.estimatedRequests).toBeNull()
    expect(provider.defaultEstimates[0]?.remainingPercent).toBe(70)
  })
})
