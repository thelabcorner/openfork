import { describe, expect, test } from "bun:test"
import {
  observeYieldStatistic,
  statisticalKeyID,
  type YieldStatisticState,
} from "@opencode-ai/core/usage/yield-statistics"
import { Capacity } from "@/capacity/capacity"
import type { GoCapacityPrior } from "@/capacity/go-prior"

const prior: GoCapacityPrior.ModelPrior = {
  modelID: "test-model",
  name: "Test Model",
  requests: {
    "5h": { standard: 200 },
    week: { standard: 500 },
    month: { standard: 1000 },
  },
  profile: { input: 100, cached: 0, output: 0 },
  pricing: [
    {
      kind: "flat",
      prices: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    },
  ],
}

const resource: Capacity.GoResource = {
  accountID: "acct-a",
  credentialID: "cred-a",
  remainingFraction: 0.5,
  resetAt: 10_000,
  snapshotAt: 100,
  status: "ok",
}

function stateFor(requests: Array<{ sessionID: string; input: number }>) {
  let state: YieldStatisticState | undefined
  requests.forEach((request, index) => {
    state = observeYieldStatistic(state, {
      sessionID: request.sessionID,
      completedAt: index + 1,
      tokens: {
        input: request.input,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
      },
    })
  })
  return state!
}

describe("Capacity", () => {
  test("uses the published model prior exactly at zero personal samples", () => {
    const estimate = Capacity.estimateGoModel({ prior, resource, at: 1 })
    expect(estimate.baselineRequests).toBe(200)
    expect(estimate.estimatedRequests).toBe(100)
    expect(estimate.workloadMultiplier).toBe(1)
    expect(estimate.workloadSource).toBe("published-prior")
    expect(estimate.personalized).toBe(false)
    expect(estimate.evidence.personalWeight).toBe(0)
    expect(estimate.evidence.baseObservations).toBe(0)
    expect(estimate.evidence.accountObservations).toBe(0)
  })

  test("subtracts only attributed post-snapshot local resource burn in quota-fraction units", () => {
    const resources = Capacity.applyLocalDepletion({
      prior: { models: [prior], fetchedAt: 100, status: "ok" },
      resources: [resource],
      settlements: [
        {
          accountID: "acct-a",
          modelID: prior.modelID,
          completedAt: 90,
          tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        },
        {
          accountID: "other",
          modelID: prior.modelID,
          completedAt: 110,
          tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        },
        {
          credentialID: "cred-a",
          modelID: prior.modelID,
          completedAt: 120,
          tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        },
      ],
      at: 120,
    })

    expect(resources).toHaveLength(1)
    expect(resources[0]?.remainingFraction).toBeCloseTo(0.49, 12)
    expect(resources[0]?.localRequestsApplied).toBe(1)
    expect(resources[0]?.localFractionConsumed).toBeCloseTo(0.01, 12)
  })

  test("personalizes after the first settled request with one prior-equivalent of shrinkage", () => {
    const estimate = Capacity.estimateGoModel({
      prior,
      resource,
      state: stateFor([{ sessionID: "s1", input: 200 }]),
      at: 1,
    })
    expect(estimate.personalized).toBe(true)
    expect(estimate.evidence.requestEffectiveSamples).toBeCloseTo(1, 12)
    expect(estimate.evidence.sessionEffectiveSamples).toBeCloseTo(1, 12)
    expect(estimate.evidence.personalWeight).toBeCloseTo(0.5, 12)
    expect(estimate.evidence.basePersonalWeight).toBeCloseTo(0.5, 12)
    expect(estimate.evidence.accountPersonalWeight).toBe(0)
    expect(estimate.workloadSource).toBe("personal-base")
    expect(estimate.workloadMultiplier).toBeCloseTo(1.5, 12)
    expect(estimate.estimatedRequests).toBe(66)
  })

  test("does not count many correlated requests in one session as independent evidence", () => {
    const state = stateFor(
      Array.from({ length: 8 }, () => ({ sessionID: "same-session", input: 200 })),
    )
    const estimate = Capacity.estimateGoModel({ prior, resource, state, at: 1 })
    expect(estimate.evidence.requestEffectiveSamples).toBeGreaterThan(1)
    expect(estimate.evidence.sessionEffectiveSamples).toBeCloseTo(1, 12)
    expect(estimate.evidence.personalWeight).toBeCloseTo(0.5, 12)
    expect(estimate.estimatedRequests).toBe(66)
  })

  test("independent session evidence increases personalization weight", () => {
    const state = stateFor([
      ...Array.from({ length: 4 }, () => ({ sessionID: "s1", input: 200 })),
      ...Array.from({ length: 4 }, () => ({ sessionID: "s2", input: 200 })),
    ])
    const estimate = Capacity.estimateGoModel({ prior, resource, state, at: 1 })
    expect(estimate.evidence.sessionEffectiveSamples).toBeGreaterThan(1)
    expect(estimate.evidence.personalWeight).toBeGreaterThan(0.5)
    expect(estimate.workloadMultiplier).toBeGreaterThan(1.5)
    expect(estimate.estimatedRequests).toBeLessThan(66)
  })

  test("withholds numeric predictive ranges while session-aware evidence is still learning", () => {
    const estimate = Capacity.estimateGoModel({
      prior,
      resource,
      state: stateFor([{ sessionID: "s1", input: 100 }]),
      at: 1,
    })

    expect(estimate.predictiveRange.status).toBe("learning")
    expect(estimate.predictiveRange.effectiveSamples).toBeCloseTo(1, 12)
    expect(estimate.predictiveRange.matureAt).toBe(12)
  })

  test("exposes a calibrated renewal range after mature independent-session evidence", () => {
    const state = stateFor(
      Array.from({ length: 24 }, (_, index) => ({ sessionID: `s-${index}`, input: 100 })),
    )
    const estimate = Capacity.estimateGoModel({ prior, resource, state, at: 1 })

    expect(estimate.estimatedRequests).toBe(100)
    expect(estimate.predictiveRange.status).toBe("calibrated")
    if (estimate.predictiveRange.status !== "calibrated") throw new Error("expected calibrated range")
    expect(estimate.predictiveRange.effectiveSamples).toBeGreaterThanOrEqual(12)
    expect(estimate.predictiveRange.calibrationBudget).toBe(100)
    expect(estimate.predictiveRange.targetCoverage).toBe(0.8)
    expect(estimate.predictiveRange.heldOutCoverage).toBeCloseTo(0.8011976047904191, 12)
    expect(estimate.predictiveRange.lowerRequests).toBe(46)
    expect(estimate.predictiveRange.upperRequests).toBe(206)
  })

  test("selects predictive renewal budgets by multiplicative distance", () => {
    const state = stateFor(
      Array.from({ length: 24 }, (_, index) => ({ sessionID: `s-${index}`, input: 100 })),
    )
    const small = Capacity.estimateGoModel({
      prior,
      resource: { ...resource, remainingFraction: 0.025 },
      state,
      at: 1,
    })
    const medium = Capacity.estimateGoModel({
      prior,
      resource: { ...resource, remainingFraction: 0.1 },
      state,
      at: 1,
    })

    expect(small.predictiveRange.status).toBe("calibrated")
    expect(medium.predictiveRange.status).toBe("calibrated")
    if (small.predictiveRange.status !== "calibrated" || medium.predictiveRange.status !== "calibrated") {
      throw new Error("expected calibrated ranges")
    }
    expect(small.predictiveRange.calibrationBudget).toBe(5)
    expect(small.predictiveRange.lowerRequests).toBe(4)
    expect(small.predictiveRange.upperRequests).toBe(21)
    expect(medium.predictiveRange.calibrationBudget).toBe(20)
    expect(medium.predictiveRange.lowerRequests).toBe(13)
    expect(medium.predictiveRange.upperRequests).toBe(54)
  })

  test("a sparse account overlay keeps uncertainty in learning even when the base model is mature", () => {
    const baseState = stateFor(
      Array.from({ length: 24 }, (_, index) => ({ sessionID: `base-${index}`, input: 100 })),
    )
    const accountState = stateFor([{ sessionID: "account-one", input: 100 }])
    const estimate = Capacity.estimateGoModel({ prior, resource, state: baseState, accountState, at: 1 })

    expect(estimate.workloadSource).toBe("account-hierarchical")
    expect(estimate.predictiveRange.status).toBe("learning")
    expect(estimate.predictiveRange.effectiveSamples).toBeCloseTo(1, 12)
  })

  test("uses an account overlay when present and otherwise falls back to the base-model state", () => {
    const baseState = stateFor([{ sessionID: "base", input: 100 }])
    const accountState = stateFor([{ sessionID: "account", input: 200 }])
    const snapshot = Capacity.buildGoSnapshot({
      prior: { models: [prior], fetchedAt: 5, status: "ok" },
      resources: [
        resource,
        { ...resource, accountID: "acct-b" },
      ],
      entries: [
        {
          key: { providerID: "opencode-go", baseModelID: prior.modelID },
          state: baseState,
          updatedAt: 1,
        },
        {
          key: { providerID: "opencode-go", baseModelID: prior.modelID, accountID: "acct-a" },
          state: accountState,
          updatedAt: 1,
        },
      ],
      routedAccountID: "acct-a",
      at: 1,
    })

    const routed = snapshot.routed[0]
    expect(routed?.accountID).toBe("acct-a")
    expect(routed?.workloadSource).toBe("account-hierarchical")
    expect(routed?.workloadMultiplier).toBeCloseTo(34 / 33, 12)
    expect(routed?.evidence.basePersonalWeight).toBeCloseTo(0.5, 12)
    expect(routed?.evidence.accountPersonalWeight).toBeCloseTo(1 / 33, 12)
    expect(routed?.evidence.personalWeight).toBeCloseTo(17 / 33, 12)
    const accountB = snapshot.accounts.find((entry) => entry.accountID === "acct-b")
    expect(accountB?.estimates[0]?.workloadSource).toBe("personal-base")
    expect(accountB?.estimates[0]?.workloadMultiplier).toBeCloseTo(1, 12)

    const ids = snapshot.accounts.map((entry) => statisticalKeyID({
      providerID: "opencode-go",
      baseModelID: prior.modelID,
      accountID: entry.accountID,
    }))
    expect(new Set(ids).size).toBe(2)
  })

  test("never falls back to a credential UUID when authoritative routed account identity disagrees", () => {
    const [next] = Capacity.applyLocalDepletion({
      prior: { models: [prior], fetchedAt: 100, status: "ok" },
      resources: [resource],
      settlements: [{
        messageID: "msg-mismatch",
        accountID: "acct-other",
        credentialID: "cred-a",
        modelID: prior.modelID,
        completedAt: 120,
        tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      }],
      at: 120,
    })

    expect(next?.remainingFraction).toBe(0.5)
    expect(next?.localRequestsApplied).toBe(0)
    expect(next?.localFractionConsumed).toBe(0)
    expect(next?.localUnnormalizedRequests).toBe(0)
  })

  test("attributes direct/provider-backed requests by stable account without requiring a vault UUID", () => {
    const [next] = Capacity.applyLocalDepletion({
      prior: { models: [prior], fetchedAt: 100, status: "ok" },
      resources: [{ ...resource, credentialID: undefined }],
      settlements: [{
        messageID: "msg-direct",
        accountID: "acct-a",
        modelID: prior.modelID,
        completedAt: 120,
        tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      }],
      at: 120,
    })

    expect(next?.localRequestsApplied).toBe(1)
    expect(next?.localFractionConsumed).toBeCloseTo(0.01, 12)
    expect(next?.remainingFraction).toBeCloseTo(0.49, 12)
  })

  test("uses the materialized canonical base model before any raw account-qualified transport id", () => {
    const [next] = Capacity.applyLocalDepletion({
      prior: { models: [prior], fetchedAt: 100, status: "ok" },
      resources: [resource],
      settlements: [{
        messageID: "msg-canonical-model",
        accountID: "acct-a",
        modelID: "transport-alias-that-is-not-a-prior@zen-a",
        baseModelID: prior.modelID,
        completedAt: 120,
        tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      }],
      at: 120,
    })

    expect(next?.localRequestsApplied).toBe(1)
    expect(next?.localUnnormalizedRequests).toBe(0)
    expect(next?.localFractionConsumed).toBeCloseTo(0.01, 12)
  })

  test("uses exact open snapshot/reset boundaries for local depletion", () => {
    const [next] = Capacity.applyLocalDepletion({
      prior: { models: [prior], fetchedAt: 100, status: "ok" },
      resources: [resource],
      settlements: [
        {
          messageID: "at-snapshot",
          accountID: "acct-a",
          modelID: prior.modelID,
          completedAt: resource.snapshotAt,
          tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        },
        {
          messageID: "after-snapshot",
          accountID: "acct-a",
          modelID: prior.modelID,
          completedAt: resource.snapshotAt + 1,
          tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        },
        {
          messageID: "before-reset",
          accountID: "acct-a",
          modelID: prior.modelID,
          completedAt: resource.resetAt - 1,
          tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        },
        {
          messageID: "at-reset",
          accountID: "acct-a",
          modelID: prior.modelID,
          completedAt: resource.resetAt,
          tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        },
      ],
      at: resource.resetAt - 1,
    })

    expect(next?.localRequestsApplied).toBe(2)
    expect(next?.localFractionConsumed).toBeCloseTo(0.02, 12)
    expect(next?.remainingFraction).toBeCloseTo(0.48, 12)
  })

  test("a newer official snapshot supersedes every earlier local settlement", () => {
    const [next] = Capacity.applyLocalDepletion({
      prior: { models: [prior], fetchedAt: 150, status: "ok" },
      resources: [{ ...resource, snapshotAt: 150 }],
      settlements: [
        {
          messageID: "before-new-snapshot",
          accountID: "acct-a",
          modelID: prior.modelID,
          completedAt: 149,
          tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        },
        {
          messageID: "after-new-snapshot",
          accountID: "acct-a",
          modelID: prior.modelID,
          completedAt: 151,
          tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        },
      ],
      at: 160,
    })

    expect(next?.localRequestsApplied).toBe(1)
    expect(next?.localFractionConsumed).toBeCloseTo(0.01, 12)
    expect(next?.remainingFraction).toBeCloseTo(0.49, 12)
  })

  test("deduplicates local depletion by settled message identity", () => {
    const settlement = {
      messageID: "msg-once",
      credentialID: "cred-a",
      modelID: prior.modelID,
      completedAt: 120,
      tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    }
    const [next] = Capacity.applyLocalDepletion({
      prior: { models: [prior], fetchedAt: 100, status: "ok" },
      resources: [resource],
      settlements: [settlement, settlement],
      at: 120,
    })

    expect(next?.localRequestsApplied).toBe(1)
    expect(next?.localFractionConsumed).toBeCloseTo(0.01, 12)
    expect(next?.remainingFraction).toBeCloseTo(0.49, 12)
  })

  test("fails the request-count projection closed when attributed local burn cannot be normalized", () => {
    const [next] = Capacity.applyLocalDepletion({
      prior: { models: [prior], fetchedAt: 100, status: "ok" },
      resources: [resource],
      settlements: [{
        messageID: "msg-unknown-model",
        accountID: "acct-a",
        modelID: "unknown-model@acct-a",
        completedAt: 120,
        tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      }],
      at: 120,
    })
    expect(next?.remainingFraction).toBe(0.5)
    expect(next?.localUnnormalizedRequests).toBe(1)

    const estimate = Capacity.estimateGoModel({ prior, resource: next!, at: 120 })
    expect(estimate.projectionStatus).toBe("incomplete-local-accounting")
    expect(estimate.estimatedRequests).toBe(0)
    expect(estimate.predictiveRange.status).toBe("unavailable")
    expect(estimate.evidence.localUnnormalizedRequests).toBe(1)
  })

  test("unattributed post-snapshot consumption invalidates every plausible account projection", () => {
    const resources = Capacity.applyLocalDepletion({
      prior: { models: [prior], fetchedAt: 100, status: "ok" },
      resources: [resource, { ...resource, accountID: "acct-b", credentialID: "cred-b" }],
      settlements: [{
        messageID: "msg-unattributed",
        modelID: prior.modelID,
        completedAt: 120,
        tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      }],
      at: 120,
    })

    expect(resources.map((entry) => entry.localUnnormalizedRequests)).toEqual([1, 1])
  })

  test("uses the promotion regime at each settlement timestamp", () => {
    const promoted: GoCapacityPrior.ModelPrior = {
      ...prior,
      requests: {
        ...prior.requests,
        "5h": { standard: 200, promoted: 400 },
      },
      promotionEndsAt: 150,
    }
    const resources = Capacity.applyLocalDepletion({
      prior: { models: [promoted], fetchedAt: 100, status: "ok" },
      resources: [resource],
      settlements: [
        {
          messageID: "msg-promo",
          accountID: "acct-a",
          modelID: `${prior.modelID}@zen-a`,
          completedAt: 140,
          tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        },
        {
          messageID: "msg-post-promo",
          accountID: "acct-a",
          modelID: prior.modelID,
          completedAt: 160,
          tokens: { input: 200, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        },
      ],
      at: 160,
    })

    expect(resources[0]?.localFractionConsumed).toBeCloseTo(0.015, 12)
    expect(resources[0]?.remainingFraction).toBeCloseTo(0.485, 12)
  })

  test("never projects an official resource after its represented 5h window has reset", () => {
    const snapshot = Capacity.buildGoSnapshot({
      prior: { models: [prior], fetchedAt: 100, status: "ok" },
      resources: [{ ...resource, resetAt: 120 }],
      entries: [],
      routedAccountID: "acct-a",
      at: 120,
    })

    expect(snapshot.routed).toEqual([])
    expect(snapshot.accounts).toEqual([])
  })
})
