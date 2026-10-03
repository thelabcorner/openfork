import { describe, expect, test } from "bun:test"
import { observeYieldStatistic, type YieldStatisticState } from "@opencode-ai/core/usage/yield-statistics"
import { Capacity } from "@/capacity/capacity"
import type { GoCapacityPrior } from "@/capacity/go-prior"
import * as ProviderCapacity from "../../src/capacity/provider-capacity"
import type { BurnEstimate } from "../../src/capacity/resource-learning"
import type { ProviderResult, ProviderSummary, QuotaResource, UsageWindow } from "../../src/quota/schema"

const prior: GoCapacityPrior.ModelPrior = {
  modelID: "test-model",
  name: "Test Model",
  requests: {
    "5h": { standard: 200 },
    week: { standard: 500 },
    month: { standard: 1000 },
  },
  profile: { input: 100, cached: 0, output: 0 },
  pricing: [{ kind: "flat", prices: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }],
}

const baseResource: Capacity.GoResource = {
  accountID: "acct-a",
  credentialID: "cred-a",
  remainingFraction: 0.5,
  resetAt: 10_000,
  snapshotAt: 100,
  status: "ok",
}

/** One settled request that doubles the typical workload, so the multiplier is 1.5. */
function doubledWorkloadState() {
  return observeYieldStatistic(undefined, {
    sessionID: "s1",
    completedAt: 900,
    tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
  }) as YieldStatisticState
}

function windowFor(
  window: Capacity.GoWindowCapacity["window"],
  estimate: Capacity.GoEstimate,
): Capacity.GoWindowCapacity {
  const found = estimate.windowCapacity.find((entry) => entry.window === window)
  if (!found) throw new Error(`expected a ${window} window projection`)
  return found
}

describe("Go per-window capacity", () => {
  test("publishes full-window capacity for every published prior window", () => {
    const estimate = Capacity.estimateGoModel({ prior, resource: baseResource, at: 1 })

    expect(estimate.windowCapacity.map((entry) => entry.window)).toEqual(["5h", "week", "month"])
    // 5h: 200 published requests at the published prior multiplier of 1.
    expect(windowFor("5h", estimate).pointRequests).toBe(200)
    expect(windowFor("week", estimate).pointRequests).toBe(500)
    expect(windowFor("month", estimate).pointRequests).toBe(1000)
  })

  test("reuses one personalized workload multiplier across windows", () => {
    const estimate = Capacity.estimateGoModel({
      prior,
      resource: baseResource,
      state: doubledWorkloadState(),
      at: 1,
    })

    expect(estimate.workloadMultiplier).toBeCloseTo(1.5, 12)
    // Every window divides its own published limit by the SAME multiplier.
    expect(windowFor("5h", estimate).pointRequests).toBeCloseTo(200 / 1.5, 12)
    expect(windowFor("week", estimate).pointRequests).toBeCloseTo(500 / 1.5, 12)
    expect(windowFor("month", estimate).pointRequests).toBeCloseTo(1000 / 1.5, 12)
  })

  test("never restates the 5h remaining fraction as a weekly one", () => {
    const estimate = Capacity.estimateGoModel({
      prior,
      resource: baseResource,
      state: doubledWorkloadState(),
      at: 1,
    })

    // The 5h window is observed, so it carries remaining capacity...
    const fiveHour = windowFor("5h", estimate)
    expect(fiveHour.remaining?.remainingPercent).toBe(50)
    expect(fiveHour.remaining?.remainingRequests).toBe(66)
    expect(fiveHour.remaining?.status).toBe("ready")
    // ...and the weekly window reports total personalized capacity only. Its
    // consumption is unknown, not zero, so no remaining line is invented.
    const week = windowFor("week", estimate)
    expect(week.remaining).toBeUndefined()
    expect(windowFor("month", estimate).remaining).toBeUndefined()
  })

  test("reports truthful weekly remaining when the official weekly window is observed", () => {
    const estimate = Capacity.estimateGoModel({
      prior,
      resource: {
        ...baseResource,
        observedWindows: [{ window: "week", remainingFraction: 0.1, resetAt: 5_000 }],
      },
      state: doubledWorkloadState(),
      at: 1,
    })

    const week = windowFor("week", estimate)
    expect(week.remaining?.remainingPercent).toBe(10)
    expect(week.remaining?.remainingRequests).toBe(33)
    expect(week.remaining?.resetAt).toBe(5_000)
    // Remaining is bounded by that window's own capacity, not by 5h capacity.
    expect(week.remaining?.remainingRequests).toBeLessThan(week.pointRequests)
    // The 5h window keeps its own observation; observing the week changed nothing.
    expect(windowFor("5h", estimate).remaining?.remainingPercent).toBe(50)
    expect(windowFor("5h", estimate).remaining?.remainingRequests).toBe(66)
    // A real weekly observation still leaves the month window unobserved.
    expect(windowFor("month", estimate).remaining).toBeUndefined()
  })

  test("never applies a window reset boundary or percentage the provider did not report", () => {
    const estimate = Capacity.estimateGoModel({
      prior,
      resource: {
        ...baseResource,
        observedWindows: [{ window: "week", remainingFraction: 0.5 }],
      },
      at: 1,
    })

    const week = windowFor("week", estimate)
    expect(week.remaining?.remainingPercent).toBe(50)
    expect(week.remaining?.resetAt).toBeUndefined()
  })

  test("debits local burn in each window's own request-equivalent units", () => {
    const [next] = Capacity.applyLocalDepletion({
      prior: { models: [prior], fetchedAt: 100, status: "ok" },
      resources: [
        {
          ...baseResource,
          observedWindows: [{ window: "week", remainingFraction: 0.4, resetAt: 20_000 }],
        },
      ],
      settlements: [
        {
          messageID: "msg-burn",
          accountID: "acct-a",
          modelID: prior.modelID,
          completedAt: 110,
          tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        },
      ],
      at: 110,
    })

    // One request worth 2 typical requests: 2/200 of the 5h window, 2/500 of the
    // weekly window. Debiting either window with the other's denominator would
    // make the per-window numbers disagree with the published limits.
    expect(next?.localFractionConsumed).toBeCloseTo(0.01, 12)
    expect(next?.localRequestsApplied).toBe(1)
    expect(next?.remainingFraction).toBeCloseTo(0.49, 12)
    expect(next?.observedWindows?.[0]?.remainingFraction).toBeCloseTo(0.396, 12)
    expect(next?.observedWindows?.[0]?.unnormalizedRequests).toBeUndefined()
  })

  test("excludes a settlement that happened after a window's own reset boundary", () => {
    const [next] = Capacity.applyLocalDepletion({
      prior: { models: [prior], fetchedAt: 100, status: "ok" },
      resources: [
        {
          ...baseResource,
          observedWindows: [{ window: "week", remainingFraction: 0.4, resetAt: 105 }],
        },
      ],
      settlements: [
        {
          messageID: "msg-after-week-reset",
          accountID: "acct-a",
          modelID: prior.modelID,
          completedAt: 110,
          tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        },
      ],
      at: 110,
    })

    expect(next?.remainingFraction).toBeCloseTo(0.49, 12)
    expect(next?.observedWindows?.[0]?.remainingFraction).toBe(0.4)
    // Being outside a window is not ambiguity, so the window must not fail closed.
    expect(next?.observedWindows?.[0]?.unnormalizedRequests).toBeUndefined()
  })

  test("fails an observed window closed on ambiguous burn while capacity stays usable", () => {
    const [next] = Capacity.applyLocalDepletion({
      prior: { models: [prior], fetchedAt: 100, status: "ok" },
      resources: [
        {
          ...baseResource,
          observedWindows: [{ window: "week", remainingFraction: 0.4, resetAt: 20_000 }],
        },
      ],
      settlements: [
        {
          messageID: "msg-unknown-model",
          accountID: "acct-a",
          modelID: "unknown-model@acct-a",
          completedAt: 110,
          tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        },
      ],
      at: 110,
    })
    const estimate = Capacity.estimateGoModel({ prior, resource: next!, at: 110 })

    expect(estimate.projectionStatus).toBe("incomplete-local-accounting")
    expect(windowFor("5h", estimate).remaining?.status).toBe("unavailable")
    expect(windowFor("5h", estimate).remaining?.remainingRequests).toBeNull()
    expect(windowFor("week", estimate).remaining?.status).toBe("unavailable")
    expect(windowFor("week", estimate).remaining?.remainingRequests).toBeNull()
    // Total capacity depends on the published limit and the workload posterior,
    // neither of which the ambiguity touched.
    expect(windowFor("week", estimate).pointRequests).toBe(500)
    expect(windowFor("month", estimate).pointRequests).toBe(1000)
  })

  test("drops an observed window whose reset boundary has passed", () => {
    const snapshot = Capacity.buildGoSnapshot({
      prior: { models: [prior], fetchedAt: 100, status: "ok" },
      resources: [
        { ...baseResource, observedWindows: [{ window: "week", remainingFraction: 0.4, resetAt: 500 }] },
      ],
      entries: [],
      routedAccountID: "acct-a",
      at: 1_000,
    })

    const estimate = snapshot.routed[0]!
    expect(estimate.projectionStatus).toBe("ok")
    expect(windowFor("week", estimate).remaining).toBeUndefined()
    expect(windowFor("week", estimate).pointRequests).toBe(500)
    expect(windowFor("5h", estimate).remaining?.remainingPercent).toBe(50)
  })

  test("projects Go windows onto the shared cross-provider window contract", () => {
    const snapshot = Capacity.buildGoSnapshot({
      prior: { models: [prior], fetchedAt: 100, status: "ok" },
      resources: [
        {
          ...baseResource,
          observedWindows: [{ window: "week", remainingFraction: 0.1, resetAt: 5_000 }],
        },
      ],
      entries: [],
      routedAccountID: "acct-a",
      at: 1,
    })
    const estimate = Capacity.goProviderView(snapshot).defaultEstimates[0]!

    expect(estimate.windows?.map((window) => window.id)).toEqual(["5h", "week", "month"])
    expect(estimate.windows?.map((window) => window.label)).toEqual(["5h", "week", "month"])
    // 33 weekly requests left is the binding observed window; the 5h window has 100.
    expect(estimate.limitingWindow).toBe("week")
    expect(estimate.estimatedRequests).toBe(100)
    const week = estimate.windows!.find((window) => window.id === "week")!
    expect(week.basis).toBe("observed-remaining")
    expect(week.estimatedRequests).toBe(50)
    expect(week.remainingPercent).toBe(10)
    expect(week.resetAt).toBe(5_000)
    const month = estimate.windows!.find((window) => window.id === "month")!
    // A capacity-only window is never presented as a remaining count.
    expect(month.basis).toBe("personalized-total-capacity")
    expect(month.remainingPercent).toBeNull()
    expect(month.resetAt).toBeNull()
    expect(month.estimatedRequests).toBe(1000)
  })

  test("excludes a capacity-only window from the binding selection", () => {
    const snapshot = Capacity.buildGoSnapshot({
      prior: { models: [prior], fetchedAt: 100, status: "ok" },
      resources: [baseResource],
      entries: [],
      routedAccountID: "acct-a",
      at: 1,
    })
    const estimate = Capacity.goProviderView(snapshot).defaultEstimates[0]!

    // The month window holds 1000 requests, the observed 5h window 100. A
    // capacity row must never win the binding role.
    expect(estimate.limitingWindow).toBe("5h")
  })

  test("never attaches the 5h renewal calibration to a full-window total", () => {
    const estimate = Capacity.estimateGoModel({
      prior,
      resource: baseResource,
      state: doubledWorkloadState(),
      at: 1,
    })

    // The deployed range stays exactly where it was validated: the current 5h
    // remaining line. Window totals carry no range, so no window total can
    // inherit a 5h renewal/stopping-time coverage claim.
    expect(estimate.predictiveRange).toBeDefined()
    for (const window of estimate.windowCapacity) {
      expect(window).not.toHaveProperty("predictiveRange")
    }
    const view = Capacity.goProviderView({
      providerID: "opencode-go",
      priorStatus: "ok",
      priorFetchedAt: 1,
      routed: [estimate],
      accounts: [],
    })
    for (const window of view.defaultEstimates[0]?.windows ?? []) {
      expect(window).not.toHaveProperty("lowerRequests")
      expect(window).not.toHaveProperty("upperRequests")
    }
  })
})

const model = {
  id: "test-model",
  name: "Test Model",
  release_date: "2026-01-01",
  attachment: false,
  reasoning: false,
  temperature: true,
  tool_call: true,
  cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1 },
  limit: { context: 200_000, output: 8_000 },
} as any

const catalog = {
  openrouter: {
    name: "OpenRouter",
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
} as any

const summary = (providerId: string): ProviderSummary => ({
  providerId,
  providerName: providerId,
  aliases: [],
  configured: true,
})

const window = (input: {
  remainingPercent?: number | null
  resetAt?: number | null
  windowSeconds?: number | null
  resource?: QuotaResource
}): UsageWindow => ({
  usedPercent: null,
  remainingPercent: input.remainingPercent ?? null,
  windowSeconds: input.windowSeconds ?? null,
  resetAt: input.resetAt ?? null,
  resetAfterSeconds: null,
  valueLabel: null,
  ...(input.resource ? { resource: input.resource } : {}),
})

const result = (
  providerId: string,
  windows: Record<string, UsageWindow>,
): ProviderResult => ({
  providerId,
  providerName: providerId,
  ok: true,
  configured: true,
  planLabel: null,
  usage: { windows },
  fetchedAt: 1_000,
})

const money = (remaining: number): QuotaResource => ({
  kind: "money",
  unit: "USD",
  currency: "USD",
  used: null,
  remaining,
  limit: null,
})

const requests = (remaining: number): QuotaResource => ({
  kind: "requests",
  unit: "request",
  used: null,
  remaining,
  limit: null,
})

describe("generic per-window capacity", () => {
  test("projects each money window independently and keeps the binding one on top", () => {
    const provider = ProviderCapacity.buildProvider({
      summary: summary("openrouter"),
      result: result("openrouter", {
        "5h": window({
          remainingPercent: 50,
          resetAt: 2_000,
          windowSeconds: 18_000,
          resource: money(10),
        }),
        weekly: window({
          remainingPercent: 20,
          resetAt: 900_000,
          windowSeconds: 604_800,
          resource: money(40),
        }),
      }),
      catalog,
      entries: [],
      at: 1_000,
    })

    const estimate = provider.estimates.find((item) => item.modelID === model.id)!
    expect(estimate.windows?.map((entry) => entry.id)).toEqual(["5h", "weekly"])
    expect(estimate.windows?.map((entry) => entry.label)).toEqual(["5h", "1w"])
    const fiveHour = estimate.windows!.find((entry) => entry.id === "5h")!
    const weekly = estimate.windows!.find((entry) => entry.id === "weekly")!
    expect(estimate.limitingWindow).toBe("5h")
    expect(estimate.estimatedRequests).toBe(fiveHour.estimatedRequests)
    // Four times the money in the same window-free divisor, so four times the
    // requests up to per-window flooring.
    expect(Math.abs(weekly.estimatedRequests! - 4 * fiveHour.estimatedRequests!)).toBeLessThanOrEqual(4)
    // Per-window percentages and reset boundaries stay in their own window.
    expect(fiveHour.remainingPercent).toBe(50)
    expect(fiveHour.resetAt).toBe(2_000)
    expect(weekly.remainingPercent).toBe(20)
    expect(weekly.resetAt).toBe(900_000)
    expect(fiveHour.basis).toBe("observed-remaining")
  })

  test("keeps a direct request budget independent per window", () => {
    const provider = ProviderCapacity.buildProvider({
      summary: summary("nvidia"),
      result: result("nvidia", {
        "1m": window({ remainingPercent: 40, resetAt: 2_000, resource: requests(16) }),
        "5h": window({ remainingPercent: 90, resetAt: 20_000, resource: requests(100) }),
      }),
      catalog,
      entries: [],
      at: 1_000,
    })

    const estimate = provider.defaultEstimates[0]!
    expect(estimate.limitingWindow).toBe("1m")
    expect(estimate.estimatedRequests).toBe(16)
    expect(estimate.windows?.map((entry) => entry.estimatedRequests)).toEqual([16, 100])
    expect(estimate.windows?.map((entry) => entry.source)).toEqual([
      "direct-request-budget",
      "direct-request-budget",
    ])
  })

  test("leaves an unreported percentage null instead of inventing one", () => {
    const provider = ProviderCapacity.buildProvider({
      summary: summary("nvidia"),
      result: result("nvidia", {
        "5h": window({ resetAt: 20_000, resource: requests(16) }),
      }),
      catalog,
      entries: [],
      at: 1_000,
    })

    const estimate = provider.defaultEstimates[0]!
    expect(estimate.remainingPercent).toBeNull()
    expect(estimate.windows?.[0]?.remainingPercent).toBeNull()
    expect(estimate.windows?.[0]?.estimatedRequests).toBe(16)
  })

  test("projects every window a learned burn rate covers", () => {
    const burns: BurnEstimate[] = [
      {
        quotaProviderID: "openrouter",
        windowKey: "5h",
        providerID: "openrouter",
        resourceKind: "provider-units",
        unit: "credits",
        burnPerRequest: 5,
        observations: 30,
        effectiveSamples: 12,
        updatedAt: 1_000,
      },
      {
        quotaProviderID: "openrouter",
        windowKey: "weekly",
        providerID: "openrouter",
        resourceKind: "provider-units",
        unit: "credits",
        burnPerRequest: 5,
        observations: 30,
        effectiveSamples: 12,
        updatedAt: 1_000,
      },
    ]
    const provider = ProviderCapacity.buildProvider({
      summary: summary("openrouter"),
      result: result("openrouter", {
        "5h": window({
          remainingPercent: 50,
          resetAt: 20_000,
          resource: { kind: "provider-units", unit: "credits", used: null, remaining: 100, limit: null },
        }),
        weekly: window({
          remainingPercent: 90,
          resetAt: 900_000,
          resource: { kind: "provider-units", unit: "credits", used: null, remaining: 500, limit: null },
        }),
      }),
      catalog,
      entries: [],
      burns,
      at: 1_000,
    })

    const estimate = provider.estimates.find((item) => item.modelID === model.id)!
    expect(estimate.windows?.map((entry) => entry.estimatedRequests)).toEqual([20, 100])
    expect(estimate.limitingWindow).toBe("5h")
    expect(estimate.estimatedRequests).toBe(20)
  })

  test("keeps the hard model cap while adding a bounded window list", () => {
    const models: Record<string, unknown> = {}
    for (let index = 99; index >= 0; index--) {
      models["model-" + String(index).padStart(3, "0")] = { ...model, id: "model-" + String(index).padStart(3, "0") }
    }
    const wideCatalog = {
      openrouter: { name: "OpenRouter", env: [], npm: "x", models },
    } as any
    const provider = ProviderCapacity.buildProvider({
      summary: summary("openrouter"),
      result: result("openrouter", {
        "5h": window({ remainingPercent: 50, resetAt: 20_000, resource: money(10) }),
        weekly: window({ remainingPercent: 20, resetAt: 900_000, resource: money(40) }),
      }),
      catalog: wideCatalog,
      entries: [],
      at: 1_000,
    })

    expect(provider.estimates.length).toBeLessThanOrEqual(ProviderCapacity.MAX_PROVIDER_MODEL_ESTIMATES)
    for (const estimate of provider.estimates) {
      expect(estimate.windows?.length ?? 0).toBeLessThanOrEqual(ProviderCapacity.MAX_CAPACITY_WINDOWS)
    }
  })

  test("bounding window lists always retains the binding window", () => {
    const windows = Array.from({ length: 12 }, (_, index) => ({
      id: `w-${String(index).padStart(2, "0")}`,
      label: `w-${index}`,
      basis: "observed-remaining" as const,
      status: "ready" as const,
      source: "direct-request-budget" as const,
      personalized: false,
      estimatedRequests: index,
      remainingPercent: null,
      resetAt: null,
    }))

    const bounded = ProviderCapacity.boundedCapacityWindows(windows, "w-11")
    expect(bounded).toHaveLength(ProviderCapacity.MAX_CAPACITY_WINDOWS)
    expect(bounded.some((window) => window.id === "w-11")).toBe(true)
    expect(ProviderCapacity.boundedCapacityWindows(windows, "w-00").some((w) => w.id === "w-00")).toBe(true)
    expect(ProviderCapacity.boundedCapacityWindows(windows.slice(0, 3), "w-01")).toHaveLength(3)
  })

  test("derives window labels from real durations only", () => {
    expect(
      ProviderCapacity.windowLabel(
        "mystery",
        window({ resetAt: 10, windowSeconds: 3_600 }),
      ),
    ).toBe("1h")
    expect(
      ProviderCapacity.windowLabel(
        "mystery",
        window({ resetAt: 10, windowSeconds: 604_800 }),
      ),
    ).toBe("1w")
    expect(ProviderCapacity.windowLabel("mystery", window({ resetAt: 10, windowSeconds: null }))).toBe(
      "mystery",
    )
  })
})