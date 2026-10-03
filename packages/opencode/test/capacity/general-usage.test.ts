import { describe, expect, test } from "bun:test"
import { observeYieldStatistic, type YieldStatisticState } from "@opencode-ai/core/usage/yield-statistics"
import type { UsageYield } from "@opencode-ai/core/usage/yield"
import * as GeneralUsage from "../../src/capacity/general-usage"

type Row = {
  sessionID: string
  completedAt: number
  input: number
  cacheRead?: number
  cacheWrite?: number
  output?: number
  reasoning?: number
}

function stateFor(rows: readonly Row[]) {
  let state: YieldStatisticState | undefined
  for (const row of rows) {
    state = observeYieldStatistic(state, {
      sessionID: row.sessionID,
      completedAt: row.completedAt,
      tokens: {
        input: row.input,
        cacheRead: row.cacheRead ?? 0,
        cacheWrite: row.cacheWrite ?? 0,
        output: row.output ?? 0,
        reasoning: row.reasoning ?? 0,
      },
    })
  }
  return state!
}

function entry(
  providerID: string,
  baseModelID: string,
  state: YieldStatisticState,
  accountID?: string,
): UsageYield.Entry {
  return {
    key: { providerID, baseModelID, ...(accountID ? { accountID } : {}) },
    state,
    updatedAt: state.lastCompletedAt ?? 0,
  }
}

describe("GeneralUsage", () => {
  test("falls back to the bounded standardized corpus with no personal evidence", () => {
    const result = GeneralUsage.build([])

    expect(result.source).toBe("standardized-workload-prior")
    expect(result.corpus).toHaveLength(16)
    expect(result.typical.contextTokens).toBeGreaterThan(0)
    expect(result.models).toEqual([])
    expect(result.evidence).toEqual({
      observations: 0,
      requestEffectiveSamples: 0,
      sessionEffectiveSamples: 0,
    })
  })

  test("excludes account overlays from global evidence and sparse direct-model output", () => {
    const rows = Array.from({ length: 16 }, (_, index) => ({
      sessionID: "session-" + index,
      completedAt: index + 1,
      input: 40_000 + index * 1_000,
      cacheRead: 10_000,
      output: 1_000,
    }))
    const state = stateFor(rows)
    const result = GeneralUsage.build([
      entry("opencode-go", "model-a", state),
      entry("opencode-go", "model-a", state, "account-a"),
    ])

    expect(result.source).toBe("personal-general")
    expect(result.models).toHaveLength(1)
    expect(result.observedModelScopes).toBe(1)
    expect(result.evidence.observations).toBe(16)
    expect(result.corpus.length).toBeLessThanOrEqual(16)
    expect(result.corpus.length).toBeGreaterThan(0)
    expect(result.models[0]?.source).toBe("personal-model")
  })

  test("fails closed when many requests come from only one session cluster", () => {
    const state = stateFor(
      Array.from({ length: 32 }, (_, index) => ({
        sessionID: "one-session",
        completedAt: index + 1,
        input: 120_000,
        output: 2_000,
      })),
    )
    const result = GeneralUsage.build([entry("provider-a", "model-a", state)])

    expect(result.evidence.requestEffectiveSamples).toBeGreaterThan(4)
    expect(result.evidence.sessionEffectiveSamples).toBeCloseTo(1, 10)
    expect(result.source).toBe("standardized-workload-prior")
    expect(result.typical).toEqual(GeneralUsage.STANDARDIZED_WORKLOAD)
    expect(result.models).toEqual([])
    expect(result.observedRequestBand).toBeUndefined()
    expect(result.observedScopeBand).toBeUndefined()
  })

  test("does not label a one-request model as a personalized direct estimate", () => {
    const state = stateFor([
      {
        sessionID: "single",
        completedAt: 1,
        input: 900_000,
        cacheRead: 50_000,
        output: 20_000,
      },
    ])
    const result = GeneralUsage.build([entry("provider-a", "model-a", state)])

    expect(result.models).toEqual([])
    expect(result.observedModelScopes).toBe(0)
    expect(result.source).toBe("standardized-workload-prior")
  })

  test("uses recent independent physical requests for the personal-general workload", () => {
    const rows: Row[] = []
    for (let index = 0; index < 8; index++) {
      rows.push({
        sessionID: "old-" + index,
        completedAt: index + 1,
        input: 10_000,
        output: 200,
      })
    }
    for (let index = 0; index < 16; index++) {
      rows.push({
        sessionID: "new-" + index,
        completedAt: 100 + index,
        input: 120_000,
        cacheRead: 20_000,
        output: 2_000,
        reasoning: 500,
      })
    }

    const result = GeneralUsage.build([entry("provider-a", "model-a", stateFor(rows))])

    expect(result.source).toBe("personal-general")
    expect(result.typical.contextTokens).toBeGreaterThan(100_000)
    expect(result.typical.generationTokens).toBeGreaterThan(2_000)
    expect(result.observedRequestBand?.requests).toBe(24)
    expect(result.evidence.sessionEffectiveSamples).toBeGreaterThanOrEqual(4)
  })

  test("is deterministic across materialized-state ordering", () => {
    const a = entry(
      "provider-b",
      "model-b",
      stateFor(
        Array.from({ length: 12 }, (_, index) => ({
          sessionID: "b-" + index,
          completedAt: 50 + index,
          input: 80_000 + index * 100,
          output: 900,
        })),
      ),
    )
    const b = entry(
      "provider-a",
      "model-a",
      stateFor(
        Array.from({ length: 12 }, (_, index) => ({
          sessionID: "a-" + index,
          completedAt: 100 + index,
          input: 100_000 + index * 100,
          output: 1_100,
        })),
      ),
    )

    const first = GeneralUsage.build([a, b])
    const second = GeneralUsage.build([b, a])

    expect(first.fingerprint).toBe(second.fingerprint)
    expect(first.corpus).toEqual(second.corpus)
    expect(first.models).toEqual(second.models)
  })

  test("caps mature direct model output at 128 while still reporting every mature scope", () => {
    const scopeCount = 200
    const entries = Array.from({ length: scopeCount }, (_, index) =>
      entry(
        "provider-" + (index % 4),
        "model-" + String(index).padStart(3, "0"),
        stateFor(
          Array.from({ length: 16 }, (_, position) => ({
            sessionID: "scope-" + index + "-session-" + position,
            completedAt: 10_000 + index * 100 + position,
            input: 40_000 + index * 10,
            cacheRead: 8_000,
            output: 900,
          })),
        ),
      ),
    )

    const result = GeneralUsage.build(entries)

    expect(result.source).toBe("personal-general")
    // observedModelScopes is an honest population count and is not capped.
    expect(result.observedModelScopes).toBe(scopeCount)
    expect(result.observedScopeBand?.scopeCount).toBe(scopeCount)
    // The wire array is bounded even though far more scopes are mature.
    expect(result.models).toHaveLength(128)

    const identities = result.models.map((model) => model.providerID + "/" + model.modelID)
    expect(new Set(identities).size).toBe(128)
    expect(identities).toEqual([...identities].sort())
    for (const model of result.models) {
      expect(model.source).toBe("personal-model")
      expect(model.personalized).toBe(true)
    }

    const reversed = GeneralUsage.build([...entries].reverse())
    expect(reversed.fingerprint).toBe(result.fingerprint)
    expect(reversed.models).toEqual(result.models)
    expect(reversed.observedModelScopes).toBe(result.observedModelScopes)
  })

  test("account overlays consume neither direct model slots nor global observations", () => {
    const scopeRows = (scope: number): Row[] =>
      Array.from({ length: 16 }, (_, position) => ({
        sessionID: "overlay-" + scope + "-session-" + position,
        completedAt: 50_000 + scope * 100 + position,
        input: 60_000 + scope,
        cacheRead: 15_000,
        output: 1_200,
      }))

    const direct = Array.from({ length: 128 }, (_, index) =>
      entry("provider-" + (index % 4), "direct-" + String(index).padStart(3, "0"), stateFor(scopeRows(index))),
    )
    const overlays = Array.from({ length: 200 }, (_, index) =>
      entry(
        "provider-" + (index % 4),
        "overlay-" + String(index).padStart(3, "0"),
        stateFor(scopeRows(1_000 + index)),
        "account-" + String(index).padStart(3, "0"),
      ),
    )

    const withoutOverlays = GeneralUsage.build(direct)
    const withOverlays = GeneralUsage.build([...direct, ...overlays])

    expect(withoutOverlays.source).toBe("personal-general")
    expect(withoutOverlays.observedModelScopes).toBe(128)
    expect(withoutOverlays.models).toHaveLength(128)

    // Overlays repeat the same physical requests; they are skipped before the
    // global pool and before the direct-model candidate list is measured.
    expect(withOverlays.source).toBe(withoutOverlays.source)
    expect(withOverlays.observedModelScopes).toBe(withoutOverlays.observedModelScopes)
    expect(withOverlays.models).toEqual(withoutOverlays.models)
    expect(withOverlays.evidence).toEqual(withoutOverlays.evidence)
    expect(withOverlays.corpus).toEqual(withoutOverlays.corpus)
    expect(withOverlays.typical).toEqual(withoutOverlays.typical)
    expect(withOverlays.fingerprint).toBe(withoutOverlays.fingerprint)
    expect(withOverlays.evidence.observations).toBeLessThanOrEqual(128)
  })

  test("bounds generalized evidence and corpus when physical requests exceed the recent limit", () => {
    const entriesPerScope = 4
    const requestsPerScope = 128
    const physicalRequests = entriesPerScope * requestsPerScope
    expect(physicalRequests).toBeGreaterThan(128)

    const entries = Array.from({ length: entriesPerScope }, (_, scope) =>
      entry(
        "provider-" + scope,
        "model-" + scope,
        stateFor(
          Array.from({ length: requestsPerScope }, (_, index) => ({
            // Interleave scopes in time and repeat sessions so both the recency
            // bound and the session-cluster bound are exercised with real work.
            sessionID: "session-" + (index % 16),
            completedAt: scope + index * entriesPerScope,
            input: 90_000,
            cacheRead: 12_000,
            output: 1_500,
            reasoning: 300,
          })),
        ),
      ),
    )

    const result = GeneralUsage.build(entries)

    expect(result.source).toBe("personal-general")
    expect(result.evidence.observations).toBeLessThanOrEqual(128)
    expect(result.evidence.observations).toBe(128)
    expect(result.observedRequestBand?.requests).toBe(128)
    expect(result.evidence.requestEffectiveSamples).toBeGreaterThanOrEqual(4)
    expect(result.evidence.sessionEffectiveSamples).toBeGreaterThanOrEqual(4)
    expect(result.corpus).toHaveLength(16)
    expect(result.corpus.length).toBeLessThanOrEqual(16)

    // Retaining exactly the newest bound is itself a stable, order-independent
    // property: the overlapping synthetic timestamps cannot change the corpus.
    const shuffled = GeneralUsage.build([...entries].reverse())
    expect(shuffled.evidence).toEqual(result.evidence)
    expect(shuffled.corpus).toEqual(result.corpus)
    expect(shuffled.observedRequestBand).toEqual(result.observedRequestBand)
    expect(shuffled.fingerprint).toBe(result.fingerprint)
  })
})
