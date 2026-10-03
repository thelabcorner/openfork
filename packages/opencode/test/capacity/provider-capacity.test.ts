import { describe, expect, test } from "bun:test"
import { observeYieldStatistic } from "@opencode-ai/core/usage/yield-statistics"
import { compilePricingRegimes, priceWorkload } from "@opencode-ai/schema/model-select/usage-yield"
import { generalPricingWorkload } from "@opencode-ai/schema/model-select/general-yield"
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

/** Six settled requests in six independent sessions: past the ESS maturity gate. */
function matureOpenRouterEntry() {
  let state: ReturnType<typeof observeYieldStatistic> | undefined
  for (let index = 0; index < 6; index++) {
    state = observeYieldStatistic(state, {
      sessionID: "s" + index,
      completedAt: 900 + index,
      tokens: { input: 40_000, cacheRead: 0, cacheWrite: 0, output: 8_000, reasoning: 0 },
    })
  }
  return {
    key: { providerID: "openrouter" as const, baseModelID: model.id },
    state: state!,
    updatedAt: 905,
  }
}

/** A catalog with `count` cheap models, inserted in reverse id order. */
function wideCatalog(providerID: string, count: number) {
  const models: Record<string, unknown> = {}
  for (let index = count - 1; index >= 0; index--) {
    models["model-" + String(index).padStart(3, "0")] = {
      ...model,
      id: "model-" + String(index).padStart(3, "0"),
    }
  }
  return {
    [providerID]: { name: providerID, env: [], npm: "x", models },
  } as any
}

const moneyWindow = () => ({
  credits: {
    usedPercent: null,
    remainingPercent: null,
    windowSeconds: null,
    resetAt: null,
    resetAfterSeconds: null,
    valueLabel: "$10",
    resource: {
      kind: "money" as const,
      unit: "USD",
      currency: "USD",
      used: null,
      remaining: 10,
      limit: null,
    },
  },
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

  test("does not call a single settled request personalized", () => {
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

    // One request is not independent evidence. The price still improves, but it
    // stays attributed to the population prior so the UI cannot label it
    // "your usage with this model".
    const estimate = provider.estimates.find((item) => item.modelID === model.id)
    expect(estimate?.status).toBe("ready")
    expect(estimate?.source).toBe("standardized-workload-prior")
    expect(estimate?.personalized).toBe(false)
    expect(estimate?.evidence.observations).toBe(1)
    expect(estimate?.evidence.sessionEffectiveSamples).toBeCloseTo(1, 10)
  })

  test("personalizes the monetary prior once independent evidence is mature", () => {
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
      // Six independent sessions: request-ESS and session-ESS both clear the
      // MIN_PERSONAL_EFFECTIVE_SAMPLES gate, so the claim is finally supported.
      entries: [matureOpenRouterEntry()],
      at: 1_000,
    })

    const estimate = provider.estimates.find((item) => item.modelID === model.id)
    expect(estimate?.source).toBe("personal-current-price")
    expect(estimate?.personalized).toBe(true)
    expect(estimate?.evidence.observations).toBe(6)
    expect(estimate?.evidence.sessionEffectiveSamples).toBeGreaterThanOrEqual(
      ProviderCapacity.MIN_PERSONAL_EFFECTIVE_SAMPLES,
    )
  })

  test("a long single-session run does not buy the personalized label", () => {
    // Session-cluster ESS, not raw request count, is what makes evidence
    // independent (ledger 22.4). One long session is not six independent ones.
    let state: ReturnType<typeof observeYieldStatistic> | undefined
    for (let index = 0; index < 40; index++) {
      state = observeYieldStatistic(state, {
        sessionID: "one-long-session",
        completedAt: 800 + index,
        tokens: { input: 40_000, cacheRead: 0, cacheWrite: 0, output: 8_000, reasoning: 0 },
      })
    }
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
      entries: [{ key: { providerID: "openrouter", baseModelID: model.id }, state: state!, updatedAt: 900 }],
      at: 1_000,
    })

    const estimate = provider.estimates.find((item) => item.modelID === model.id)
    expect(estimate?.evidence.observations).toBe(40)
    expect(estimate?.evidence.requestEffectiveSamples).toBeGreaterThan(
      ProviderCapacity.MIN_PERSONAL_EFFECTIVE_SAMPLES,
    )
    expect(estimate?.evidence.sessionEffectiveSamples).toBeCloseTo(1, 10)
    expect(estimate?.source).toBe("standardized-workload-prior")
    expect(estimate?.personalized).toBe(false)
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

describe("costForTokens context-tier selection", () => {
  const priced = (cost: Record<string, unknown>) => ({ id: "m", name: "m", cost }) as any
  // Every row prices cache-read and cache-write at $0 so the returned dollar
  // value is exactly `freshInputTokens * selectedTier.input / 1e6` and the tier
  // choice is directly readable from the number. Context size is inflated with
  // cache-read tokens, which therefore never move the price in these tests.
  const tier = (size: number, input: number) => ({
    input,
    output: input * 2,
    cache_read: 0,
    cache_write: 0,
    tier: { type: "context" as const, size },
  })
  // One fresh input token plus `context` cache-read tokens.
  const request = (context: number) => [1, context - 1, 0, 0, 0]
  const dollars = (rate: number) => rate / 1_000_000

  test("uses the base row when no threshold is activated", () => {
    const cost = { input: 3, output: 6, cache_read: 0, cache_write: 0, tiers: [tier(200_000, 6)] }
    expect(ProviderCapacity.costForTokens(priced(cost), request(200_000))).toBeCloseTo(dollars(3), 15)
  })

  test("threshold activation is strict: context == size stays on the cheaper row", () => {
    const cost = { input: 3, output: 6, cache_read: 0, cache_write: 0, tiers: [tier(10, 6)] }
    expect(ProviderCapacity.costForTokens(priced(cost), request(10))).toBeCloseTo(dollars(3), 15)
    expect(ProviderCapacity.costForTokens(priced(cost), request(11))).toBeCloseTo(dollars(6), 15)
  })

  test("selects the LARGEST activated threshold regardless of publication order", () => {
    const rows = [tier(10, 5), tier(100, 20), tier(1_000, 80)]
    const ascending = { input: 1, output: 2, cache_read: 0, cache_write: 0, tiers: rows }
    const descending = { input: 1, output: 2, cache_read: 0, cache_write: 0, tiers: [...rows].reverse() }
    expect(ProviderCapacity.costForTokens(priced(ascending), request(200))).toBeCloseTo(dollars(20), 15)
    expect(ProviderCapacity.costForTokens(priced(descending), request(200))).toBeCloseTo(dollars(20), 15)
  })

  test("skips thresholds above the request's context without falling back down", () => {
    const cost = { input: 3, output: 6, cache_read: 0, cache_write: 0, tiers: [tier(10, 6), tier(500, 30)] }
    // Context 200 activates the 10 tier but not the 500 tier.
    expect(ProviderCapacity.costForTokens(priced(cost), request(200))).toBeCloseTo(dollars(6), 15)
    // Context 600 activates both; the larger threshold wins.
    expect(ProviderCapacity.costForTokens(priced(cost), request(600))).toBeCloseTo(dollars(30), 15)
  })

  test("a tiered model still beats its own 200k fallback row at high context", () => {
    const cost = {
      input: 3,
      output: 6,
      cache_read: 0,
      cache_write: 0,
      context_over_200k: { input: 9, output: 18 },
      tiers: [tier(500_000, 7)],
    }
    // Context 300k exceeds the 500k threshold? No -> 200k fallback row applies.
    expect(ProviderCapacity.costForTokens(priced(cost), request(300_000))).toBeCloseTo(dollars(9), 15)
    // Context 600k activates the tier, which then replaces the 200k fallback.
    expect(ProviderCapacity.costForTokens(priced(cost), request(600_000))).toBeCloseTo(dollars(7), 15)
    // Without any tier the 200k fallback is the only option.
    const untiered = { input: 3, output: 6, cache_read: 0, cache_write: 0, context_over_200k: { input: 9, output: 18 } }
    expect(ProviderCapacity.costForTokens(priced(untiered), request(300_000))).toBeCloseTo(dollars(9), 15)
  })

  test("duplicate thresholds keep the first published row, matching the stable sort", () => {
    const cost = { input: 1, output: 2, cache_read: 0, cache_write: 0, tiers: [tier(10, 5), tier(10, 99)] }
    expect(ProviderCapacity.costForTokens(priced(cost), request(200))).toBeCloseTo(dollars(5), 15)
  })

  test("cache-write tokens count toward the context denominator", () => {
    const cost = { input: 3, output: 6, cache_read: 0, cache_write: 0 }
    // input 1 + cacheWrite 5 => context 6, so a threshold of 6 is NOT exceeded...
    expect(ProviderCapacity.costForTokens(priced({ ...cost, tiers: [tier(5, 11)] }), [1, 0, 5, 0, 0])).toBeCloseTo(
      dollars(11),
      15,
    )
    // ...and had cache-write been ignored the context would have been 1, which
    // activates neither row and would have produced the base rate instead.
    expect(ProviderCapacity.costForTokens(priced({ ...cost, tiers: [tier(6, 11)] }), [1, 0, 5, 0, 0])).toBeCloseTo(
      dollars(3),
      15,
    )
  })

  test("reasoning tokens are billed at the output rate", () => {
    const cost = { input: 1, output: 5, cache_read: 0, cache_write: 0 }
    expect(ProviderCapacity.costForTokens(priced(cost), [0, 0, 0, 1, 2])).toBeCloseTo(dollars(15), 15)
  })

  test("no published pricing fails closed", () => {
    expect(ProviderCapacity.costForTokens({ id: "m", name: "m" } as any, request(10))).toBeUndefined()
  })
})

/**
 * Capacity's per-request pricer and the selector's `priceWorkload` must return
 * the SAME dollar figure for the same workload under the same catalog row.
 *
 * They are the two halves of one shared rule (`selectNativePrices`), and this
 * test is what keeps them one. A drift here is silent and expensive: it means
 * the picker ranks models by a price that the request-budget projection inverts
 * differently, so "requests left" stops matching the economics shown next to it.
 *
 * Deliberately excluded: the OpenCode-hosted DeepSeek peak/off-peak *time*
 * regimes. Capacity reprices already-settled historical observations, which
 * cannot be assigned a peak period after the fact, so it stays on native/flat
 * pricing by design. The two regimes are not supposed to agree there.
 */
describe("native pricing parity with the shared selector economics", () => {
  const catalogCost = (cost: Record<string, unknown>) => ({
    input: cost.input,
    output: cost.output,
    cache_read: (cost as any).cache_read,
    cache_write: (cost as any).cache_write,
    ...((cost as any).tiers ? { tiers: (cost as any).tiers } : {}),
    ...((cost as any).context_over_200k ? { context_over_200k: (cost as any).context_over_200k } : {}),
  })

  // The selector's ModelCost shape is the mirror of the catalog row.
  const modelCost = (cost: Record<string, unknown>) => {
    const rows = (cost as any).tiers
    return {
      input: cost.input as number,
      output: cost.output as number,
      cache: { read: (cost as any).cache_read ?? cost.input, write: (cost as any).cache_write ?? cost.input },
      ...(rows
        ? {
            tiers: rows.map((row: any) => ({
              input: row.input,
              output: row.output,
              cache: { read: row.cache_read ?? row.input, write: row.cache_write ?? row.input },
              tier: row.tier,
            })),
          }
        : {}),
      ...((cost as any).context_over_200k
        ? {
            experimentalOver200K: {
              input: (cost as any).context_over_200k.input,
              output: (cost as any).context_over_200k.output,
              cache: {
                read: (cost as any).context_over_200k.cache_read ?? (cost as any).context_over_200k.input,
                write: (cost as any).context_over_200k.cache_write ?? (cost as any).context_over_200k.input,
              },
            },
          }
        : {}),
    }
  }

  const shared = (cost: Record<string, unknown>, tokens: readonly number[]) =>
    priceWorkload(
      generalPricingWorkload({
        inputTokens: tokens[0] ?? 0,
        cacheReadTokens: tokens[1] ?? 0,
        cacheWriteTokens: tokens[2] ?? 0,
        outputTokens: tokens[3] ?? 0,
        reasoningTokens: tokens[4] ?? 0,
      }),
      compilePricingRegimes({ id: "m", provider: { id: "p" } }, modelCost(cost) as any),
    ).expected

  const both = (cost: Record<string, unknown>, tokens: readonly number[]) => [
    ProviderCapacity.costForTokens({ id: "m", name: "m", cost: catalogCost(cost) } as any, tokens),
    shared(cost, tokens),
  ]

  const flat = { input: 3, output: 6, cache_read: 0.3, cache_write: 4 }
  const tierRow = (size: number, input: number, cache: number) => ({
    input,
    output: input * 2,
    cache_read: cache,
    cache_write: cache,
    tier: { type: "context" as const, size },
  })
  const contexts = [0, 1, 10, 200_000, 200_001, 500_000]

  const workloads: Array<readonly number[]> = [
    [1_000, 40_000, 0, 300, 0],
    [0, 0, 0, 1, 2],
    [120_000, 0, 0, 2_000, 500],
    [1, 300_000, 10_000, 400, 0],
    [0, 0, 0, 0, 0],
  ]

  test("flat catalog rows agree", () => {
    for (const tokens of workloads) expect(both(flat, tokens)[0]).toBeCloseTo(both(flat, tokens)[1]!, 18)
  })

  test("native context tiers agree, including the 200k boundary", () => {
    const cost = {
      input: 3,
      output: 6,
      cache_read: 0.3,
      cache_write: 4,
      context_over_200k: { input: 9, output: 18, cache_read: 0.9, cache_write: 12 },
      tiers: [tierRow(10_000, 5, 0.5), tierRow(250_000, 7, 0.7), tierRow(10_000, 99, 9.9)],
    }
    for (const context of contexts) {
      for (const tokens of workloads) {
        const request = [1, Math.max(0, context - 1), 0, 100, 0]
        const [server, selector] = both(cost, request)
        expect(server).toBeCloseTo(selector!, 18)
      }
    }
  })

  test("a catalog row that omits cache rates stays on the historical server $0 semantics", () => {
    // Capacity reprices settled usage, and an absent cache dimension in the
    // catalog feed means "not metered", not "stale". This is deliberately NOT
    // the selector's conservative fallback (which prices a missing cache rate
    // at the input rate to protect a browser ranking). The two protect
    // different consumers, so this pins the divergence in both directions
    // instead of letting either side drift silently.
    const cost = { input: 4, output: 8 }
    const tokens = [1_000, 500_000, 0, 200, 0]

    const server = ProviderCapacity.costForTokens(
      { id: "m", name: "m", cost: catalogCost(cost) } as any,
      tokens,
    )
    const selector = shared(cost, tokens)

    expect(server).toBeCloseTo((1_000 * 4 + 200 * 8) / 1_000_000, 18)
    expect(selector).toBeCloseTo((1_000 * 4 + 500_000 * 4 + 200 * 8) / 1_000_000, 18)
    expect(server!).toBeLessThan(selector!)
  })

  test("published cache rates agree exactly, so the divergence above is the only one", () => {
    const cost = { input: 4, output: 8, cache_read: 0.4, cache_write: 5 }
    const tokens = [1_000, 500_000, 7_000, 200, 50]
    const [server, selector] = both(cost, tokens)
    expect(server).toBeCloseTo(selector!, 18)
  })

  test("distinct thresholds select identically in any publication order", () => {
    const rows = [tierRow(10_000, 5, 0.5), tierRow(400_000, 11, 1.1), tierRow(200_000, 7, 0.7)]
    const tokens = [1, 500_000 - 1, 0, 10, 0]
    const ascending = both({ ...flat, tiers: rows }, tokens)
    const descending = both({ ...flat, tiers: [...rows].reverse() }, tokens)
    expect(ascending[0]).toBeCloseTo(ascending[1]!, 18)
    expect(descending[0]).toBeCloseTo(descending[1]!, 18)
    // The largest activated threshold (400k) wins in both orders.
    expect(ascending[0]).toBeCloseTo(descending[0]!, 18)
    expect(ascending[0]).toBeCloseTo(((1 * 11) + 499_999 * 1.1 + 10 * 22) / 1_000_000, 18)
  })

  test("a duplicate threshold keeps the first published row", () => {
    // Ties are resolved by publication order on purpose (it is what the stable
    // descending sort produced historically), so this is asserted on one fixed
    // order rather than as an order-independence property.
    const rows = [tierRow(10_000, 5, 0.5), tierRow(400_000, 11, 1.1), tierRow(10_000, 99, 9.9)]
    // Context 50k activates only the duplicated 10k row, not the 400k row.
    const tokens = [1, 49_999, 0, 10, 0]
    const [server, selector] = both({ ...flat, tiers: rows }, tokens)
    expect(server).toBeCloseTo(selector!, 18)
    expect(server).toBeCloseTo(((1 * 5) + 49_999 * 0.5 + 10 * 10) / 1_000_000, 18)
  })
})

describe("bounded provider model projections", () => {
  const observedID = "model-190"

  const observedEntry = () => ({
    key: { providerID: "openrouter" as const, baseModelID: observedID },
    state: observeYieldStatistic(undefined, {
      sessionID: "s",
      completedAt: 900,
      tokens: { input: 1_000, cacheRead: 0, cacheWrite: 0, output: 100, reasoning: 0 },
    }),
    updatedAt: 900,
  })

  test("caps projections at the documented bound and admits observed scopes first", () => {
    const wide = wideCatalog("openrouter", 200)
    const provider = ProviderCapacity.buildProvider({
      summary: summary("openrouter"),
      result: result("openrouter", moneyWindow()),
      catalog: wide,
      entries: [observedEntry()],
      at: 1_000,
    })

    expect(provider.estimates.length).toBe(ProviderCapacity.MAX_PROVIDER_MODEL_ESTIMATES)
    // The observed scope sorts last alphabetically, so it is only present
    // because observed scopes are admitted before the lexicographic fill.
    expect(provider.estimates[0]?.modelID).toBe(observedID)
    // ...and the lexicographic fill starts from the first unobserved id.
    expect(provider.estimates[1]?.modelID).toBe("model-000")
    expect(provider.estimates.at(-1)?.modelID).toBe("model-062")
    expect(provider.estimates.some((item) => item.modelID === "model-199")).toBe(false)
  })

  test("an explicit limit narrows the bound without changing the ordering rule", () => {
    const wide = wideCatalog("openrouter", 200)
    const provider = ProviderCapacity.buildProvider({
      summary: summary("openrouter"),
      result: result("openrouter", moneyWindow()),
      catalog: wide,
      entries: [observedEntry()],
      at: 1_000,
      modelLimit: 3,
    })

    expect(provider.estimates.map((item) => item.modelID)).toEqual([observedID, "model-000", "model-001"])
  })

  test("is independent of catalog insertion order and of repeated calls", () => {
    const ascending = wideCatalog("openrouter", 200)
    const shuffled = {
      openrouter: {
        ...ascending.openrouter,
        models: Object.fromEntries(Object.entries(ascending.openrouter.models).reverse()),
      },
    } as any
    const build = (cat: any) =>
      ProviderCapacity.buildProvider({
        summary: summary("openrouter"),
        result: result("openrouter", moneyWindow()),
        catalog: cat,
        entries: [observedEntry()],
        at: 1_000,
      }).estimates.map((item) => item.modelID)

    expect(build(shuffled)).toEqual(build(ascending))
    expect(build(ascending)).toEqual(build(ascending))
  })

  test("the bound is shared by the credit-conversion path too", () => {
    const wide = wideCatalog("genspark", 200)
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
      catalog: wide,
      entries: [],
      at: 1_000,
    })

    expect(provider.estimates).toHaveLength(ProviderCapacity.MAX_PROVIDER_MODEL_ESTIMATES)
  })

  test("capacityModelCandidates admits an alias catalog under the same bound", () => {
    const wide = wideCatalog("opencode", 200)
    const candidates = ProviderCapacity.capacityModelCandidates({
      providerIDs: ["opencode"],
      catalog: wide,
      entries: [
        {
          key: { providerID: "opencode", baseModelID: observedID },
          state: observedEntry().state,
          updatedAt: 900,
        },
      ],
    })
    expect(candidates).toHaveLength(ProviderCapacity.MAX_PROVIDER_MODEL_ESTIMATES)
    expect(candidates[0]).toMatchObject({ providerID: "opencode", model: { id: observedID }, observed: true })
  })
})

describe("candidate limit normalization", () => {
  const CAP = ProviderCapacity.MAX_PROVIDER_MODEL_ESTIMATES
  const WIDE = 200

  const admit = (limit?: number) =>
    ProviderCapacity.capacityModelCandidates({
      providerIDs: ["openrouter"],
      catalog: wideCatalog("openrouter", WIDE),
      entries: [],
      ...(limit !== undefined ? { limit } : {}),
    })

  test("omitting the limit admits exactly the hard cap", () => {
    expect(admit()).toHaveLength(CAP)
    expect(ProviderCapacity.normalizedCapacityModelLimit()).toBe(CAP)
  })

  test("a limit may narrow the cap but never raise it", () => {
    expect(admit(1)).toHaveLength(1)
    expect(admit(3)).toHaveLength(3)
    expect(admit(CAP)).toHaveLength(CAP)
    // The load-bearing half: a larger catalog, a larger request, and an
    // unbounded request must all stop at the hard cap rather than handing back
    // an unbounded working set and payload.
    expect(admit(WIDE)).toHaveLength(CAP)
    expect(admit(1000)).toHaveLength(CAP)
    expect(admit(Number.POSITIVE_INFINITY)).toHaveLength(CAP)
    expect(ProviderCapacity.normalizedCapacityModelLimit(1000)).toBe(CAP)
    expect(ProviderCapacity.normalizedCapacityModelLimit(Number.POSITIVE_INFINITY)).toBe(CAP)
  })

  test("NaN and negative limits admit nothing instead of crashing or filling the cap", () => {
    expect(admit(Number.NaN)).toEqual([])
    expect(admit(-1)).toEqual([])
    expect(admit(-1000)).toEqual([])
    expect(admit(Number.NEGATIVE_INFINITY)).toEqual([])
    expect(ProviderCapacity.normalizedCapacityModelLimit(Number.NaN)).toBe(0)
    expect(ProviderCapacity.normalizedCapacityModelLimit(-1)).toBe(0)
    expect(ProviderCapacity.normalizedCapacityModelLimit(Number.NEGATIVE_INFINITY)).toBe(0)
  })

  test("a zero limit admits nothing", () => {
    expect(admit(0)).toEqual([])
    expect(ProviderCapacity.normalizedCapacityModelLimit(0)).toBe(0)
  })

  test("a fractional limit floors rather than rounding up", () => {
    expect(admit(1.9)).toHaveLength(1)
    expect(admit(3.99)).toHaveLength(3)
    expect(ProviderCapacity.normalizedCapacityModelLimit(1.9)).toBe(1)
  })

  test("the narrowed cap survives the buildProvider projection too", () => {
    const wide = wideCatalog("openrouter", WIDE)
    // `entries: []` is deliberate here: this asserts the cap, not admission
    // order, so no personally observed scope is needed (and none of the
    // observed-first fixtures are in scope from this describe block).
    const overCap = ProviderCapacity.buildProvider({
      summary: summary("openrouter"),
      result: result("openrouter", moneyWindow()),
      catalog: wide,
      entries: [],
      at: 1_000,
      modelLimit: 1000,
    })
    expect(overCap.estimates).toHaveLength(CAP)

    const unbounded = ProviderCapacity.buildProvider({
      summary: summary("openrouter"),
      result: result("openrouter", moneyWindow()),
      catalog: wide,
      entries: [],
      at: 1_000,
      modelLimit: Number.POSITIVE_INFINITY,
    })
    expect(unbounded.estimates).toHaveLength(CAP)

    const garbage = ProviderCapacity.buildProvider({
      summary: summary("openrouter"),
      result: result("openrouter", moneyWindow()),
      catalog: wide,
      entries: [],
      at: 1_000,
      modelLimit: Number.NaN,
    })
    // A NaN limit drops every catalog-driven row, which leaves the honest
    // "no priced catalog" learning projection rather than an invented bound.
    expect(garbage.estimates).toEqual([])
  })
})

describe("modelProviderIDs alias resolution", () => {
  const aliased = {
    openrouter: { name: "OpenRouter", env: [], npm: "x", models: {} },
    opencode: { name: "OpenCode", env: [], npm: "x", models: {} },
  } as any

  test("keeps the exact id first and drops ids the catalog does not publish", () => {
    expect(ProviderCapacity.modelProviderIDs(summary("openrouter", ["opencode", "nope"]), aliased)).toEqual([
      "openrouter",
      "opencode",
    ])
  })

  test("deduplicates an alias that repeats the quota provider id", () => {
    expect(ProviderCapacity.modelProviderIDs(summary("openrouter", ["openrouter", "openrouter"]), aliased)).toEqual([
      "openrouter",
    ])
  })

  test("falls back to the quota id alone when no candidate exists in the catalog", () => {
    expect(ProviderCapacity.modelProviderIDs(summary("openrouter", ["nope"]), aliased)).toEqual(["openrouter"])
    expect(ProviderCapacity.modelProviderIDs(summary("unknown", []), aliased)).toEqual(["unknown"])
  })

  test("pins the two upstream-operated special cases", () => {
    // Go must not claim the shared `opencode` catalog (Zen owns it), and Zen
    // must resolve to it even though neither id is one of Zen's own aliases.
    expect(ProviderCapacity.modelProviderIDs(summary("opencode-go", ["opencode-go", "opencode"]), aliased)).toEqual([
      "opencode-go",
    ])
    expect(
      ProviderCapacity.modelProviderIDs(summary("opencode-zen", ["zen", "opencode-free"]), aliased),
    ).toEqual(["opencode"])
  })
})
