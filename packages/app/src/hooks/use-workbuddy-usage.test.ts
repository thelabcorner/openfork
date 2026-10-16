import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { useWorkBuddyUsage } from "./use-workbuddy-usage"
import type { LimitsState } from "./use-limits"
import type { ProviderResult, WorkBuddyModelLimit } from "@/utils/limits-format"

/**
 * WorkBuddy publishes a per-request credit rate as a short decimal string
 * (`x0.03`, `x1.33`), but the picker also prefers a rate measured from real
 * usage (`creditsObserved / usedObserved`). Dividing two integers yields a raw
 * full-precision float, so without rounding a Hy4 row renders as
 * `x1.563970588235294` while every catalog-priced row stays clean. The rate
 * displayed in the picker must always match the catalog's 2-decimal precision.
 */

function modelEntry(overrides: Partial<WorkBuddyModelLimit>): WorkBuddyModelLimit {
  return {
    model: "hy4-preview",
    canonical: null,
    unit: "credits",
    usedObserved: 0,
    limitEstimate: null,
    remainingEstimate: 100,
    remainingPercent: 100,
    status: "healthy",
    confidence: "medium",
    accuracy: "observed",
    exhaustedObserved: false,
    serverCode: null,
    resetAt: null,
    resetSource: "unknown",
    windowType: "unknown",
    windowStartedAt: null,
    secondsUntilReset: null,
    lastObservationAt: null,
    burnPerHour: null,
    estimatedExhaustionAt: null,
    willLikelyExhaustBeforeReset: null,
    creditsObserved: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheHit: 0,
    tokensCacheMiss: 0,
    creditsPersonalized: false,
    coverage: "opencode-only",
    ...overrides,
  }
}

function usageResult(): ProviderResult {
  return {
    providerId: "workbuddy",
    providerName: "WorkBuddy",
    ok: true,
    configured: true,
    fetchedAt: 0,
    usage: {
      windows: {
        "aggregate:basic": {
          usedPercent: null,
          remainingPercent: 80,
          windowSeconds: null,
          resetAt: null,
          resetAfterSeconds: null,
          valueLabel: "400 / 2000 pts",
        },
        "account:alice:Basic": {
          usedPercent: null,
          remainingPercent: 80,
          windowSeconds: null,
          resetAt: null,
          resetAfterSeconds: null,
          valueLabel: "400 / 2000 pts",
        },
      },
      accountLabels: { "wb-alice": "alice" },
      models: {
        // Catalog-priced rows: published rates that must stay untouched.
        "glm-4.6": { windows: {}, rate: 0.03 },
        "kimi-k2.6": { windows: {}, rate: 1.33 },
        // Personalized row: no published rate, rate comes from measured usage.
        "hy4-preview": { windows: {}, rate: 0 },
      },
      workbuddyAccounts: [
        {
          accountId: "wb-alice",
          label: "alice",
          models: [
            // 266 / 170 = 1.5647058823529412 -> must round to 1.56.
            modelEntry({ model: "hy4-preview", creditsObserved: 266, usedObserved: 170, creditsPersonalized: true }),
            // A measured average that already lands on the catalog precision
            // must come back unchanged, not perturbed by rounding.
            modelEntry({ model: "glm-4.6", creditsObserved: 30, usedObserved: 1000, creditsPersonalized: true }),
          ],
        },
      ],
    },
  } as unknown as ProviderResult
}

function hookWith(result: ProviderResult) {
  const limits = { providers: () => [{ result }] } as unknown as LimitsState
  return createRoot(() => useWorkBuddyUsage({ limits }))
}

describe("useWorkBuddyUsage personalized rate rounding", () => {
  test("rounds a measured credits/request average to the catalog's 2 decimals", () => {
    const workbuddy = hookWith(usageResult())
    // The regression: this used to be 1.5647058823529412.
    expect(workbuddy.rateFor("hy4-preview")?.rate).toBe(1.56)
    expect(workbuddy.forModel("hy4-preview")?.personalized).toBe(true)
    expect(String(workbuddy.rateFor("hy4-preview")?.rate)).not.toContain(".")
    expect(String(workbuddy.rateFor("hy4-preview")?.rate)).toBe("1.56")
  })

  test("leaves already-clean rates almost as the catalog reports them", () => {
    const workbuddy = hookWith(usageResult())
    // Measured average that already equals the catalog value: unchanged.
    expect(workbuddy.rateFor("glm-4.6")?.rate).toBe(0.03)
    // No measured report: the published catalog rate passes through untouched.
    expect(workbuddy.rateFor("kimi-k2.6")?.rate).toBe(1.33)
    expect(workbuddy.forModel("kimi-k2.6")?.personalized).toBe(false)
  })

  test("carries the rounded rate into the model row used by the picker", () => {
    const workbuddy = hookWith(usageResult())
    const row = workbuddy.forModel("hy4-preview")
    expect(row?.rate).toBe(1.56)
    expect(`x${row?.rate}`).toBe("x1.56")
  })
})
