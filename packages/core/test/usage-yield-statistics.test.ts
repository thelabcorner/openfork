import { describe, expect, test } from "bun:test"
import {
  RECENT_VECTOR_LIMIT,
  effectiveSamples,
  emptyYieldStatistic,
  meanVector,
  momentsFor,
  observeYieldStatistic,
  projectLinear,
  sessionMomentsFor,
  snapshotYieldStatistic,
  statisticalKeys,
  tokenVector,
  type YieldObservation,
  type YieldStatisticState,
} from "@opencode-ai/core/usage/yield-statistics"

const observation = (
  sessionID: string,
  completedAt: number,
  input: number,
  output = 0,
  cacheRead = 0,
  cacheWrite = 0,
  reasoning = 0,
): YieldObservation => ({
  sessionID,
  completedAt,
  tokens: { input, output, cacheRead, cacheWrite, reasoning },
})

function replay(values: readonly YieldObservation[]) {
  let state: YieldStatisticState | undefined
  for (const value of values) state = observeYieldStatistic(state, value)
  return state ?? emptyYieldStatistic()
}

describe("Yield Statistics moments", () => {
  test("constant workload has exact mean, zero variance, and bounded effective samples", () => {
    const state = replay(
      Array.from({ length: 64 }, (_, index) =>
        observation("ses_constant", index + 1, 100, 20, 30, 4, 5),
      ),
    )
    const fast = momentsFor(state, 8)!
    expect(meanVector(fast)).toEqual(
      expect.arrayContaining([
        expect.closeTo(100, 10),
        expect.closeTo(30, 10),
        expect.closeTo(4, 10),
        expect.closeTo(20, 10),
        expect.closeTo(5, 10),
      ]),
    )
    const projection = projectLinear(fast, [0.001, 0.0001, 0.0002, 0.002, 0.002])!
    expect(projection.mean).toBeCloseTo(0.1538, 10)
    expect(projection.variance).toBeCloseTo(0, 10)
    expect(projection.effectiveSamples).toBeGreaterThan(1)
    expect(projection.effectiveSamples).toBeLessThanOrEqual(64)
  })

  test("linear repricing matches the weighted empirical distribution exactly", () => {
    const values = [
      observation("ses_a", 1, 10, 2),
      observation("ses_a", 2, 20, 4),
      observation("ses_b", 3, 40, 8),
    ]
    const state = replay(values)
    const moments = momentsFor(state, 8)!
    const coefficients = [2, 0, 0, 3, 0] as const
    const projected = projectLinear(moments, coefficients)!

    const rho = 0.5 ** (1 / 8)
    const weights = [rho * rho, rho, 1]
    const samples = [26, 52, 104]
    const weight = weights.reduce((sum, value) => sum + value, 0)
    const squaredWeight = weights.reduce((sum, value) => sum + value * value, 0)
    const mean = samples.reduce((sum, value, index) => sum + value * weights[index]!, 0) / weight
    const denominator = weight - squaredWeight / weight
    const centered = samples.reduce(
      (sum, value, index) => sum + weights[index]! * (value - mean) ** 2,
      0,
    )
    const variance = centered / denominator

    expect(projected.mean).toBeCloseTo(mean, 10)
    expect(projected.variance).toBeCloseTo(variance, 8)
    expect(projected.effectiveSamples).toBeCloseTo((weight * weight) / squaredWeight, 10)
  })

  test("short horizon adapts materially faster after a workload regime shift", () => {
    const rows: YieldObservation[] = []
    for (let index = 0; index < 40; index++) rows.push(observation("ses_old", index + 1, 100))
    for (let index = 0; index < 16; index++) rows.push(observation("ses_new", 41 + index, 1000))
    const state = replay(rows)

    const fast = meanVector(momentsFor(state, 8)!)![0]
    const long = meanVector(momentsFor(state, 512)!)![0]
    expect(fast).toBeGreaterThan(long)
    expect(Math.abs(1000 - fast)).toBeLessThan(Math.abs(1000 - long))
  })

  test("tracks cluster-level session blocks separately from request-level exposure", () => {
    const state = replay([
      observation("ses_a", 1, 100),
      observation("ses_a", 2, 300),
      observation("ses_b", 3, 1000),
    ])

    expect(state.sessions.completedBlocks).toBe(1)
    expect(state.sessions.completedRequests).toBe(2)
    expect(state.sessions.activeSessionID).toBe("ses_b")
    expect(state.sessions.activeCount).toBe(1)

    const snapshot = snapshotYieldStatistic(state)
    expect(snapshot.sessions.completedBlocks).toBe(2)
    expect(snapshot.sessions.completedRequests).toBe(3)

    const blocks = sessionMomentsFor(snapshot, 8)!
    const blockMean = meanVector(blocks)![0]
    const rho = 0.5 ** (1 / 8)
    expect(blockMean).toBeCloseTo((rho * 200 + 1000) / (rho + 1), 10)
    expect(effectiveSamples(blocks)).toBeGreaterThan(1)
    expect(effectiveSamples(blocks)).toBeLessThanOrEqual(2)
  })

  test("keeps an exact bounded recent-vector sketch for nonlinear repricing", () => {
    const rows = Array.from({ length: RECENT_VECTOR_LIMIT + 9 }, (_, index) =>
      observation("ses_recent", index + 1, index + 1, (index + 1) * 2),
    )
    const state = replay(rows)
    expect(state.version).toBe(3)
    expect(state.recent).toHaveLength(RECENT_VECTOR_LIMIT)
    expect(state.recent[0]).toMatchObject({
      completedAt: 10,
      tokens: [10, 0, 0, 20, 0],
    })
    expect(state.recent.at(-1)).toMatchObject({
      completedAt: RECENT_VECTOR_LIMIT + 9,
      tokens: [RECENT_VECTOR_LIMIT + 9, 0, 0, (RECENT_VECTOR_LIMIT + 9) * 2, 0],
    })
  })

  test("sanitizes invalid negative/non-finite token telemetry instead of poisoning state", () => {
    const vector = tokenVector({
      input: -1,
      cacheRead: Number.NaN,
      cacheWrite: Number.POSITIVE_INFINITY,
      output: 3,
      reasoning: 4,
    })
    expect(vector).toEqual([0, 0, 0, 3, 4])
  })

  test("always updates base-model state and adds only a known account overlay", () => {
    expect(
      statisticalKeys({
        providerID: "opencode-go",
        baseModelID: "deepseek-v4.1-flash",
      }),
    ).toEqual([{ providerID: "opencode-go", baseModelID: "deepseek-v4.1-flash" }])

    expect(
      statisticalKeys({
        providerID: "opencode-go",
        baseModelID: "deepseek-v4.1-flash",
        accountID: "zen-a",
      }),
    ).toEqual([
      { providerID: "opencode-go", baseModelID: "deepseek-v4.1-flash" },
      { providerID: "opencode-go", baseModelID: "deepseek-v4.1-flash", accountID: "zen-a" },
    ])
  })
})
