import { describe, expect, test } from "bun:test"
import {
  capacityWindowQuantile,
  capacityWindowRange,
  CAPACITY_WINDOW_BAND_LOWER_QUANTILE,
  CAPACITY_WINDOW_BAND_UPPER_QUANTILE,
  MAX_CAPACITY_WINDOW_SAMPLES,
  MIN_CAPACITY_WINDOW_SAMPLES,
  type CapacityWindowRangeInput,
} from "../src/model-select/capacity-window-range"
import { compilePricingRegimes, priceWorkload } from "../src/model-select/usage-yield"
import { generalPricingWorkload, type GeneralWorkload } from "../src/model-select/general-yield"

const flatCost = { input: 3, output: 15, cache: { read: 0.03, write: 0 } }
const model = { id: "cheap", provider: { id: "openai" } }

/** A cache-heavy coding-agent request shape. */
const workload = (fresh: number, read: number, write: number, out: number, reasoning = 0): GeneralWorkload => ({
  inputTokens: fresh,
  cacheReadTokens: read,
  cacheWriteTokens: write,
  outputTokens: out,
  reasoningTokens: reasoning,
})

/**
 * The center workload. Under flat per-token pricing cost is exactly linear in
 * these token counts, so every shape below is an exact cost multiple of it —
 * which is what lets these tests assert exact ratios instead of "less than".
 */
const center = workload(1_000, 20_000, 0, 200)

const scale = (w: GeneralWorkload, factor: number): GeneralWorkload => ({
  inputTokens: w.inputTokens * factor,
  cacheReadTokens: w.cacheReadTokens * factor,
  cacheWriteTokens: w.cacheWriteTokens * factor,
  outputTokens: w.outputTokens * factor,
  reasoningTokens: w.reasoningTokens * factor,
})

const base = (overrides: Partial<CapacityWindowRangeInput> = {}): CapacityWindowRangeInput => ({
  model,
  cost: flatCost,
  center,
  corpus: [0.5, 0.75, 1, 1.5, 2].map((f) => scale(center, f)),
  windows: [{ window: "week", pointRequests: 1_000 }],
  ...overrides,
})

const weekOf = (overrides: Partial<CapacityWindowRangeInput> = {}) =>
  capacityWindowRange(base(overrides)).bands[0]!

describe("capacityWindowRange", () => {
  test("the published point is passed through untouched, never re-personalized", () => {
    // The server already applied its own workload posterior to pointRequests.
    // Multiplying it by any "personalization ratio" here would publish a second,
    // different answer for the same window.
    for (const pointRequests of [1, 137, 1_000, 15_240, 5_000.5]) {
      const band = weekOf({ windows: [{ window: "week", pointRequests }] })
      expect(band.point).toBe(pointRequests)
      expect(band.lower).toBeLessThanOrEqual(band.point)
      expect(band.upper).toBeGreaterThanOrEqual(band.point)
    }

    // A center workload far from the corpus median must not move the point. This
    // is the regression that a corpus-median re-centering would break.
    const ordinary = weekOf()
    const lopsided = weekOf({ center: scale(center, 37.5) })
    expect(ordinary.point).toBe(lopsided.point)
    // ...it may move the spread, because that is what the band is for.
    expect(lopsided.lower).toBeGreaterThan(ordinary.lower)
  })

  test("a sample costing 0.5x the center buys 2x the requests, and 2x costs buys 0.5x", () => {
    // Two samples at half price, two at double, so the 10th and 90th percentiles
    // land exactly on the two extremes rather than interpolating between them.
    const band = weekOf({
      corpus: [scale(center, 0.5), scale(center, 0.5), scale(center, 2), scale(center, 2)],
      windows: [{ window: "week", pointRequests: 1_000 }],
    })
    expect(band.point).toBe(1_000)
    expect(band.lower).toBeCloseTo(500, 9) // 2x center cost -> half the requests
    expect(band.upper).toBeCloseTo(2_000, 9) // 0.5x center cost -> twice the requests

    // The point scales the band without changing its shape.
    const ten = weekOf({
      corpus: [scale(center, 0.5), scale(center, 0.5), scale(center, 2), scale(center, 2)],
      windows: [{ window: "week", pointRequests: 10_000 }],
    })
    expect(ten.point).toBe(10_000)
    expect(ten.lower / band.lower).toBeCloseTo(10, 9)
    expect(ten.upper / band.upper).toBeCloseTo(10, 9)
  })

  test("monotonicity catches an inverted capacity/cost ratio", () => {
    // A dearer request must fit fewer times. Walk the samples in ascending COST
    // order and require the capacity to fall at every step: an inverted ratio
    // would climb instead, which is the exact bug this guards.
    const regimes = compilePricingRegimes(model, flatCost)
    const centerCost = priceWorkload(generalPricingWorkload(center), regimes).expected
    const byCost = [0.5, 1, 2, 4]
      .map((f) => {
        const sampleCost = priceWorkload(generalPricingWorkload(scale(center, f)), regimes).expected
        return { sampleCost, capacity: (1_000 * centerCost) / sampleCost }
      })
      .sort((a, b) => a.sampleCost - b.sampleCost)
    for (let i = 1; i < byCost.length; i++) {
      expect(byCost[i]!.sampleCost).toBeGreaterThan(byCost[i - 1]!.sampleCost)
      expect(byCost[i]!.capacity).toBeLessThan(byCost[i - 1]!.capacity)
    }

    // Holding the point fixed, a uniformly heavier corpus buys strictly fewer
    // requests. The lower bound is the observable: it never needs the clamp.
    const previous = { lower: Number.POSITIVE_INFINITY }
    for (const factor of [1, 2, 4, 8]) {
      const band = weekOf({
        corpus: [0.5, 0.5, 2, 2].map((f) => scale(center, f * factor)),
        windows: [{ window: "week", pointRequests: 1_000 }],
      })
      expect(band.lower).toBeLessThan(previous.lower)
      previous.lower = band.lower
    }

    // A corpus straddling the center must put the point strictly inside, not at
    // an edge: an inverted ratio would push both bounds the wrong way and clamp
    // the whole band onto the point.
    const straddling = weekOf({ corpus: [0.5, 0.5, 2, 2].map((f) => scale(center, f)) })
    expect(straddling.lower).toBeLessThan(straddling.point)
    expect(straddling.upper).toBeGreaterThan(straddling.point)
  })

  test("each sample is priced by the shared pricer and quantiled as a capacity", () => {
    const corpus = [0.5, 0.75, 1, 1.5, 2, 3].map((f) => scale(center, f))
    const pointRequests = 640
    const result = capacityWindowRange(base({ corpus, windows: [{ window: "week", pointRequests }] }))
    const band = result.bands[0]!

    const regimes = compilePricingRegimes(model, flatCost)
    const centerCost = priceWorkload(generalPricingWorkload(center), regimes).expected
    const capacities = corpus
      .map((sample) => (pointRequests * centerCost) / priceWorkload(generalPricingWorkload(sample), regimes).expected)
      .sort((a, b) => a - b)

    expect(result.samples).toBe(corpus.length)
    expect(result.considered).toBe(corpus.length)
    expect(result.usable).toBe(true)
    // n=6 -> h = 5q, so .10 is halfway between the 1st and 2nd capacities.
    expect(band.lower).toBeCloseTo(capacities[0]! + (capacities[1]! - capacities[0]!) * 0.5, 9)
    // .90 -> h = 4.5, halfway between the 5th and 6th.
    expect(band.upper).toBeCloseTo(capacities[4]! + (capacities[5]! - capacities[4]!) * 0.5, 9)
  })

  test("threshold tiers, cache-write, and reasoning reach the band through the shared pricer", () => {
    const thresholdPricing = [
      { thresholdTokens: 200_000, operator: "<=" as const, cost: flatCost },
      { thresholdTokens: 200_000, operator: ">" as const, cost: { input: 6, output: 30, cache: { read: 0.6, write: 6 } } },
    ]
    // Only the two heaviest shapes cross 200k (12x21k = 252k, 16x21k = 336k), so
    // tiering charges the expensive tail: fewer requests for heavy shapes, and a
    // bit-identical 90th percentile because the light shapes are untouched.
    const crossingCorpus = [0.5, 0.75, 1, 12, 16].map((f) => scale(center, f))
    const crossing = weekOf({ corpus: crossingCorpus, thresholdPricing })
    const flat = weekOf({ corpus: crossingCorpus })

    expect(crossing.lower).toBeLessThan(flat.lower)
    expect(crossing.lower).toBeLessThan(crossing.point)
    expect(crossing.upper).toBe(flat.upper)

    // Reasoning tokens are billed as output, so reasoning is worth exactly the
    // output it displaces. The center is heavier than the corpus shapes, and the
    // corpus mixes one reasoning-bearing shape with four plain ones, so the 10th
    // percentile is driven by BOTH and the difference is observable rather than
    // hidden behind the point clamp.
    const heavyCenter = scale(center, 4)
    const reasoningShape = workload(8_000, 160_000, 0, 800, 800)
    const outputShape = workload(8_000, 160_000, 0, 1_600)
    const cheapShape = workload(1_000, 20_000, 0, 100)
    // Three copies of the shape under test plus two cheap ones: at n=5 the 10th
    // percentile lands exactly on the shape's own capacity, so the bound moves
    // with that shape instead of being pinned to the point by the clamp.
    const mixed = (shape: GeneralWorkload) =>
      weekOf({ center: heavyCenter, corpus: [shape, shape, shape, cheapShape, cheapShape] })
    expect(mixed(reasoningShape)).toEqual(mixed(outputShape))
    expect(mixed(reasoningShape).lower).toBeLessThan(mixed(cheapShape).lower)
    // The 90th percentile is set by the cheap shapes alone, so it cannot move.
    expect(mixed(reasoningShape).upper).toBe(mixed(cheapShape).upper)

    // Cache-write tokens are charged AND count toward context. With a write rate
    // equal to the input rate they price identically to fresh input tokens; with
    // a dearer write rate they do not.
    const flatWrite = { input: 2, output: 8, cache: { read: 0.2, write: 2 } }
    const wrote = workload(1_000, 20_000, 5_000, 200)
    const asFresh = workload(6_000, 20_000, 0, 200)
    expect(weekOf({ cost: flatWrite, center: heavyCenter, corpus: Array.from({ length: 6 }, () => wrote) })).toEqual(
      weekOf({ cost: flatWrite, center: heavyCenter, corpus: Array.from({ length: 6 }, () => asFresh) }),
    )

    const dearWrite = { input: 2, output: 8, cache: { read: 0.2, write: 20 } }
    const charged = weekOf({ cost: dearWrite, center: heavyCenter, corpus: Array.from({ length: 6 }, () => wrote) })
    const uncharged = weekOf({ cost: dearWrite, center: heavyCenter, corpus: Array.from({ length: 6 }, () => workload(1_000, 20_000, 0, 200)) })
    expect(charged.upper).toBeLessThan(uncharged.upper)
    expect(charged.lower).toBeLessThan(uncharged.lower)
  })

  test("overflowing, zero-cost, and unpriceable corpus entries are excluded", () => {
    const zero = workload(0, 0, 0, 0)
    const garbage = workload(Number.NaN, -1, 0, Number.NaN)

    // A corpus overflowing the target's context window cannot be served by this
    // model, so it must not describe a request shape the user will ever send.
    const limited = capacityWindowRange(
      base({
        contextLimit: 60_000,
        corpus: [scale(center, 0.5), scale(center, 1), scale(center, 2), scale(center, 8), scale(center, 32), zero, garbage],
      }),
    )
    expect(limited.samples).toBe(3)
    expect(limited.considered).toBe(7)
    expect(limited.usable).toBe(false)
    expect(limited.bands).toEqual([])

    // Without a limit the overflowing shapes become usable samples.
    const unlimited = capacityWindowRange(
      base({ corpus: [scale(center, 0.5), scale(center, 1), scale(center, 2), scale(center, 8), scale(center, 32), zero, garbage] }),
    )
    expect(unlimited.samples).toBe(5)
    expect(unlimited.usable).toBe(true)

    // A center that does not fit takes the whole band down, not just its own row.
    const overflowCenter = capacityWindowRange(base({ contextLimit: 60_000, center: scale(center, 8) }))
    expect(overflowCenter.usable).toBe(false)
    expect(overflowCenter.samples).toBeGreaterThanOrEqual(MIN_CAPACITY_WINDOW_SAMPLES)

    // Zero-cost and all-zero-rate models price to nothing, so there is no ratio
    // to form and no band may be drawn.
    const unpriceable = capacityWindowRange(base({ cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } }))
    expect(unpriceable.usable).toBe(false)
    expect(unpriceable.bands).toEqual([])
    expect(unpriceable.samples).toBe(0)
  })

  test("fewer than four priced samples yields no band at all", () => {
    expect(MIN_CAPACITY_WINDOW_SAMPLES).toBe(4)

    for (const count of [0, 1, 3]) {
      const result = capacityWindowRange(base({ corpus: [0.5, 1, 2].slice(0, count).map((f) => scale(center, f)) }))
      expect(result.samples).toBe(count)
      expect(result.usable).toBe(false)
      expect(result.bands).toEqual([])
    }

    const exactly = capacityWindowRange(base({ corpus: [0.5, 1, 2, 3].map((f) => scale(center, f)) }))
    expect(exactly.usable).toBe(true)
    expect(exactly.samples).toBe(MIN_CAPACITY_WINDOW_SAMPLES)
  })

  test("the corpus is capped without disturbing the counted samples", () => {
    const corpus = Array.from({ length: MAX_CAPACITY_WINDOW_SAMPLES + 10 }, (_, i) => scale(center, 0.5 + i * 0.25))
    const capped = capacityWindowRange(base({ corpus }))
    expect(capped.considered).toBe(MAX_CAPACITY_WINDOW_SAMPLES)
    expect(capped.samples).toBe(MAX_CAPACITY_WINDOW_SAMPLES)
    expect(capped.usable).toBe(true)

    // Dropping the tail only removes the most expensive shapes, so the cheap-side
    // bound is unchanged and the expensive-side bound only ever tightens.
    const uncapped = capacityWindowRange(
      base({ corpus: corpus.slice(0, MAX_CAPACITY_WINDOW_SAMPLES), windows: [{ window: "week", pointRequests: 1_000 }] }),
    )
    expect(capped.bands[0]!.point).toBe(uncapped.bands[0]!.point)
    expect(capped.bands[0]!.lower).toBe(uncapped.bands[0]!.lower)
  })

  test("the band always contains the point, including for a one-sided corpus", () => {
    // Every sample heavier than the center: both raw quantiles sit below the
    // anchor, so the corpus-priced lower bound is kept and the upper is expanded
    // onto the point.
    const heavier = weekOf({ corpus: [4, 6, 8, 12].map((f) => scale(center, f)) })
    expect(heavier.lower).toBeLessThan(heavier.point)
    expect(heavier.upper).toBe(heavier.point)

    // Every sample lighter: the mirror image.
    const lighter = weekOf({ corpus: [0.02, 0.05, 0.08, 0.12].map((f) => scale(center, f)) })
    expect(lighter.lower).toBe(lighter.point)
    expect(lighter.upper).toBeGreaterThan(lighter.point)

    for (const corpus of [
      [4, 6, 8, 12].map((f) => scale(center, f)),
      [0.02, 0.05, 0.08, 0.12].map((f) => scale(center, f)),
      [0.5, 1, 1.5, 2].map((f) => scale(center, f)),
    ]) {
      const band = weekOf({ corpus })
      expect(band.lower).toBeLessThanOrEqual(band.point)
      expect(band.upper).toBeGreaterThanOrEqual(band.point)
    }
  })

  test("windows are independent, and an unusable point drops only its own row", () => {
    const result = capacityWindowRange(
      base({
        windows: [
          { window: "5h", pointRequests: 200 },
          { window: "week", pointRequests: 5_000 },
          { window: "month", pointRequests: 0 },
          { window: "bad", pointRequests: Number.NaN },
          { window: "negative", pointRequests: -5 },
        ],
      }),
    )
    expect(result.usable).toBe(true)
    expect(result.bands.map((b) => b.window)).toEqual(["5h", "week"])
    // Each window keeps its own published point; the band shape follows from the
    // corpus, not from the window.
    const ratio = result.bands[1]!.point / result.bands[0]!.point
    expect(ratio).toBeCloseTo(25, 9)
    expect(result.bands[1]!.lower / result.bands[0]!.lower).toBeCloseTo(ratio, 6)
    expect(result.bands[1]!.upper / result.bands[0]!.upper).toBeCloseTo(ratio, 6)

    // No window at all is not a band.
    expect(capacityWindowRange(base({ windows: [] })).usable).toBe(false)
  })

  test("remainingRequests passes through unchanged and is never rescaled", () => {
    const all = capacityWindowRange(
      base({
        windows: [
          { window: "week", pointRequests: 1_000, remainingRequests: 137 },
          { window: "fractional", pointRequests: 1_000, remainingRequests: 12.5 },
          { window: "unknown", pointRequests: 1_000, remainingRequests: null },
          { window: "negative", pointRequests: 1_000, remainingRequests: -1 },
          { window: "nan", pointRequests: 1_000, remainingRequests: Number.NaN },
          { window: "absent", pointRequests: 1_000 },
        ],
      }),
    )
    const byWindow = new Map(all.bands.map((b) => [b.window, b]))
    // Passed through exactly: no rounding, and no multiplication by the corpus
    // ratio. It is a different quantity from the window total.
    expect(byWindow.get("week")!.remaining).toBe(137)
    expect(byWindow.get("fractional")!.remaining).toBe(12.5)
    // Unknown stays absent rather than becoming zero.
    expect(byWindow.get("unknown")!.remaining).toBeUndefined()
    expect(byWindow.get("negative")!.remaining).toBeUndefined()
    expect(byWindow.get("nan")!.remaining).toBeUndefined()
    expect(byWindow.get("absent")!.remaining).toBeUndefined()
    // Every row shares the corpus spread regardless of its remaining count.
    expect(byWindow.get("week")!.lower).toBe(byWindow.get("absent")!.lower)
  })

  test("quantiles are deterministic and independent of corpus order", () => {
    const corpus = [0.5, 0.75, 1, 1.5, 2, 3, 4].map((f) => scale(center, f))
    const first = capacityWindowRange(base({ corpus }))
    expect(capacityWindowRange(base({ corpus }))).toEqual(first)
    expect(capacityWindowRange(base({ corpus: [...corpus].reverse() }))).toEqual(first)
    const shuffled = [corpus[3]!, corpus[0]!, corpus[6]!, corpus[2]!, corpus[5]!, corpus[1]!, corpus[4]!]
    expect(capacityWindowRange(base({ corpus: shuffled }))).toEqual(first)
    // Duplicating the corpus is deliberately NOT equal: repeating a shape
    // re-weights the distribution, so the quantiles are allowed to move.
    expect(capacityWindowRange(base({ corpus: [...corpus, ...corpus] })).samples).toBe(corpus.length * 2)
  })
})

describe("capacityWindowQuantile", () => {
  test("interpolates linearly and clamps its quantile", () => {
    expect(capacityWindowQuantile([], 0.5)).toBeNaN()
    expect(capacityWindowQuantile([7], 0.9)).toBe(7)
    expect(capacityWindowQuantile([1, 2, 3, 4], 0)).toBe(1)
    expect(capacityWindowQuantile([1, 2, 3, 4], 1)).toBe(4)
    expect(capacityWindowQuantile([1, 2, 3, 4], -5)).toBe(1)
    expect(capacityWindowQuantile([1, 2, 3, 4], 5)).toBe(4)
    // h = (n-1)q = 1.5 -> halfway between 2 and 3.
    expect(capacityWindowQuantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 12)
    expect(capacityWindowQuantile([1, 2, 3, 4], 0.1)).toBeCloseTo(1.3, 12)
    expect(capacityWindowQuantile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 12)
  })

  test("is order-insensitive over a permutation of the same samples", () => {
    const sorted = [10, 20, 30, 40, 50]
    for (const quantile of [CAPACITY_WINDOW_BAND_LOWER_QUANTILE, 0.5, CAPACITY_WINDOW_BAND_UPPER_QUANTILE]) {
      const reference = capacityWindowQuantile(sorted, quantile)
      for (const permutation of [[50, 10, 40, 20, 30], [20, 40, 10, 50, 30], [30, 50, 20, 40, 10]]) {
        expect(capacityWindowQuantile([...permutation].sort((a, b) => a - b), quantile)).toBe(reference)
      }
    }
  })
})
