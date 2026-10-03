import { describe, expect, test } from "bun:test"
import {
  CAPACITY_WINDOW_BAND_LOWER_QUANTILE,
  CAPACITY_WINDOW_BAND_UPPER_QUANTILE,
  MAX_CAPACITY_WINDOW_SAMPLES,
  MIN_CAPACITY_WINDOW_SAMPLES,
  capacityWindowQuantile,
  capacityWindowRange,
  type CapacityWindowPoint,
} from "./model-capacity-window-range"
import { generalPricingWorkload, type GeneralWorkload } from "@opencode-ai/schema/model-select/general-yield"
import { priceWorkload } from "@opencode-ai/schema/model-select/usage-yield"

/**
 * Flat pricing keeps the arithmetic in these tests readable: every $/request is
 * proportional to the workload, so the center/corpus ratio is exactly the ratio
 * a reader would compute by hand.
 */
const FLAT_COST = { input: 3, output: 15, cache: { read: 0.3, write: 0 } } as const

const workload = (contextTokens: number, outputTokens = 200): GeneralWorkload => ({
  inputTokens: Math.round(contextTokens * 0.05),
  cacheReadTokens: Math.round(contextTokens * 0.95),
  cacheWriteTokens: 0,
  outputTokens,
  reasoningTokens: 0,
})

const MODEL = { id: "test-model", provider: { id: "opencode-go" } }

const corpusOf = (contexts: number[]) => contexts.map((context) => workload(context))

const WINDOWS: CapacityWindowPoint[] = [
  { window: "5h", pointRequests: 20_000 },
  { window: "week", pointRequests: 74_000 },
]

const base = (overrides: Partial<Parameters<typeof capacityWindowRange>[0]> = {}) => ({
  model: MODEL,
  cost: FLAT_COST,
  contextLimit: 1_000_000,
  center: workload(40_000),
  corpus: corpusOf([10_000, 20_000, 40_000, 80_000, 160_000]),
  windows: WINDOWS,
  ...overrides,
})

describe("capacityWindowQuantile", () => {
  test("interpolates between order statistics and clamps the tails", () => {
    expect(capacityWindowQuantile([10, 20, 30, 40], 0)).toBe(10)
    expect(capacityWindowQuantile([10, 20, 30, 40], 1)).toBe(40)
    expect(capacityWindowQuantile([10, 20, 30, 40], 0.5)).toBe(25)
    expect(capacityWindowQuantile([10, 20, 30, 40], 0.1)).toBeCloseTo(13)
    expect(capacityWindowQuantile([10, 20, 30, 40], -1)).toBe(10)
    expect(capacityWindowQuantile([10, 20, 30, 40], 2)).toBe(40)
  })

  test("an empty sample set has no quantile", () => {
    expect(capacityWindowQuantile([], 0.5)).toBeNaN()
  })

  test("a single sample is its own quantile at every depth", () => {
    expect(capacityWindowQuantile([7], 0.1)).toBe(7)
    expect(capacityWindowQuantile([7], 0.9)).toBe(7)
  })
})

describe("capacityWindowRange", () => {
  test("keeps every server-owned point untouched and draws a workload-sensitivity band around it", () => {
    const result = capacityWindowRange(base())
    expect(result.usable).toBe(true)
    expect(result.samples).toBe(5)
    expect(result.considered).toBe(5)
    expect(result.bands.map((band) => [band.window, band.point])).toEqual([
      ["5h", 20_000],
      ["week", 74_000],
    ])
    for (const band of result.bands) {
      expect(band.lower).toBeLessThanOrEqual(band.point)
      expect(band.upper).toBeGreaterThanOrEqual(band.point)
    }
  })

  test("changing the center workload changes sensitivity but never re-personalizes the server point", () => {
    const ordinary = capacityWindowRange(base())
    const result = capacityWindowRange(base({ center: workload(80_000) }))
    const ordinaryFiveHour = ordinary.bands.find((band) => band.window === "5h")!
    const fiveHour = result.bands.find((band) => band.window === "5h")!
    expect(fiveHour.point).toBe(20_000)
    expect(fiveHour.lower).toBeGreaterThan(ordinaryFiveHour.lower)
    expect(fiveHour.upper).toBeGreaterThan(ordinaryFiveHour.upper)
  })

  test("the band always contains the authoritative published point", () => {
    const skewed = capacityWindowRange(
      base({ corpus: corpusOf([1_000, 1_100, 1_200, 400_000, 500_000]), center: workload(40_000) }),
    )
    for (const band of skewed.bands) {
      expect(band.lower).toBeLessThanOrEqual(band.point)
      expect(band.upper).toBeGreaterThanOrEqual(band.point)
    }
  })

  test("the band is a central 10th-90th percentile, not min/max", () => {
    const wide = capacityWindowRange(
      base({ corpus: corpusOf([1_000, 2_000, 40_000, 600_000, 900_000]), center: workload(40_000) }),
    )
    const fiveHour = wide.bands.find((band) => band.window === "5h")!
    // Capacity varies reciprocally with request cost. Compute the full extrema
    // under the same flat-pricing workload shapes and ensure Q10/Q90 trim them.
    const regimes = [{ kind: "flat" as const, prices: FLAT_COST }]
    const centerCost = priceWorkload(generalPricingWorkload(workload(40_000)), regimes).expected
    const capacities = [1_000, 2_000, 40_000, 600_000, 900_000]
      .map((context) => {
        const cost = priceWorkload(generalPricingWorkload(workload(context)), regimes).expected
        return (20_000 * centerCost) / cost
      })
      .sort((a, b) => a - b)
    expect(fiveHour.lower).toBeGreaterThan(capacities[0]!)
    expect(fiveHour.upper).toBeLessThan(capacities.at(-1)!)
    expect(CAPACITY_WINDOW_BAND_LOWER_QUANTILE).toBe(0.1)
    expect(CAPACITY_WINDOW_BAND_UPPER_QUANTILE).toBe(0.9)
  })

  test("requires at least the minimum priced sample count", () => {
    expect(MIN_CAPACITY_WINDOW_SAMPLES).toBe(4)
    const tooFew = capacityWindowRange(base({ corpus: corpusOf([10_000, 20_000, 40_000]) }))
    expect(tooFew.usable).toBe(false)
    expect(tooFew.bands).toEqual([])
    expect(tooFew.samples).toBe(3)

    const justEnough = capacityWindowRange(base({ corpus: corpusOf([10_000, 20_000, 40_000, 80_000]) }))
    expect(justEnough.usable).toBe(true)
    expect(justEnough.samples).toBe(4)
  })

  test("prices at most the corpus cap and reports how many were offered", () => {
    const many = Array.from({ length: 40 }, (_, index) => workload(10_000 * (index + 1)))
    const result = capacityWindowRange(base({ corpus: many }))
    expect(MAX_CAPACITY_WINDOW_SAMPLES).toBe(16)
    expect(result.considered).toBe(16)
    expect(result.samples).toBe(16)
  })

  test("drops corpus workloads that cannot fit the target's context window", () => {
    const result = capacityWindowRange(
      base({ contextLimit: 100_000, corpus: corpusOf([10_000, 20_000, 40_000, 80_000, 400_000]) }),
    )
    expect(result.samples).toBe(4)
    expect(result.usable).toBe(true)
  })

  test("drops a corpus that does not fit the target at all", () => {
    const result = capacityWindowRange(
      base({ contextLimit: 5_000, corpus: corpusOf([40_000, 80_000, 160_000, 320_000]) }),
    )
    expect(result.samples).toBe(0)
    expect(result.usable).toBe(false)
  })

  test("a free target yields no band rather than an infinite one", () => {
    const free = capacityWindowRange(base({ cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }))
    expect(free.usable).toBe(false)
    expect(free.bands).toEqual([])
  })

  test("no published window totals means no band, never a synthesized one", () => {
    const result = capacityWindowRange(base({ windows: [] }))
    expect(result.usable).toBe(false)
    expect(result.bands).toEqual([])
    expect(result.samples).toBe(5)
  })

  test("skips a window whose published total is not a usable number", () => {
    const result = capacityWindowRange(
      base({
        windows: [
          { window: "5h", pointRequests: 0 },
          { window: "week", pointRequests: Number.NaN },
          { window: "month", pointRequests: 100 },
        ],
      }),
    )
    expect(result.bands.map((band) => band.window)).toEqual(["month"])
  })

  test("carries an observed remaining count only when the owner really reported one", () => {
    const observed = capacityWindowRange(
      base({
        windows: [
          { window: "5h", pointRequests: 20_000, remainingRequests: 412 },
          { window: "week", pointRequests: 74_000, remainingRequests: null },
          { window: "month", pointRequests: 100_000 },
        ],
      }),
    )
    expect(observed.bands.find((band) => band.window === "5h")!.remaining).toBe(412)
    expect(observed.bands.find((band) => band.window === "week")!.remaining).toBeUndefined()
    expect(observed.bands.find((band) => band.window === "month")!.remaining).toBeUndefined()
  })

  test("compiles the target's pricing regimes, so a context tier changes the band", () => {
    const flat = capacityWindowRange(base())
    const tiered = capacityWindowRange(
      base({
        // Anything above 50k context bills at 10x, so the corpus median moves and
        // the band widens around a cheaper point. Both tier rows are required:
        // a lone threshold row is rejected as malformed and silently falls back
        // to flat pricing.
        thresholdPricing: [
          { thresholdTokens: 50_000, operator: "<=", cost: FLAT_COST as never },
          {
            thresholdTokens: 50_000,
            operator: ">",
            cost: { input: 30, output: 150, cache: { read: 3, write: 0 } },
          },
        ],
      }),
    )
    expect(tiered.usable).toBe(true)
    // The center and the corpus median sit in the SAME tier, so the rescaled point
    // is unchanged; what the tier changes is how many times the expensive-shape
    // samples fit, i.e. the width of the band.
    const flatFiveHour = flat.bands.find((band) => band.window === "5h")!
    const tieredFiveHour = tiered.bands.find((band) => band.window === "5h")!
    expect(tieredFiveHour.point).toBe(flatFiveHour.point)
    // The expensive >50k shapes fit fewer times, so the low-capacity side of
    // the distribution moves down. The light side remains governed by the same
    // price row and need not move at all.
    expect(tieredFiveHour.lower).toBeLessThan(flatFiveHour.lower)
    expect(tieredFiveHour.upper).toBeCloseTo(flatFiveHour.upper, 9)
  })
})