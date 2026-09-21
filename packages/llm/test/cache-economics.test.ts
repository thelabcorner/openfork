import { describe, expect, test } from "bun:test"

/**
 * GPT-5.6+ normalized input-cost model from current OpenAI prompt-caching docs.
 * Units are ordinary uncached input-token cost, so prices cancel out.
 */
const price = {
  ordinary: 1,
  read: 0.1,
  write: 1.25,
} as const

const weighted = (input: { ordinary?: number; read?: number; write?: number }) =>
  (input.ordinary ?? 0) * price.ordinary + (input.read ?? 0) * price.read + (input.write ?? 0) * price.write

/** No provider cache writes or reads. */
const disabled = (requests: number, tokensPerRequest: number) => requests * tokensPerRequest * price.ordinary

/**
 * One explicit stable-prefix write, followed by successful reads. Volatile
 * suffix bytes are intentionally not cached in explicit-only mode.
 */
const explicitStable = (requests: number, stable: number, volatilePerRequest: number) =>
  weighted({ write: stable, ordinary: volatilePerRequest }) +
  Math.max(0, requests - 1) * weighted({ read: stable, ordinary: volatilePerRequest })

/**
 * Implicit mode when the provider's only eligible boundary contains a different
 * volatile suffix each request, so no previous complete boundary is reusable.
 */
const implicitVolatileBoundary = (requests: number, stable: number, volatilePerRequest: number) =>
  requests * weighted({ write: stable + volatilePerRequest })

/**
 * Implicit append-only conversation: first request writes its whole eligible
 * prefix; each later request reuses the complete previous prefix and writes only
 * the newly appended delta. Mirrors OpenAI's documented 12k -> 15k example.
 */
const implicitAppendOnly = (initial: number, deltas: ReadonlyArray<number>) => {
  let prefix = initial
  let cost = weighted({ write: initial })
  for (const delta of deltas) {
    cost += weighted({ read: prefix, write: delta })
    prefix += delta
  }
  return cost
}

/**
 * Explicit-only caching of a static prefix while the rest of an append-only
 * conversation remains ordinary input on every request.
 */
const explicitStaticOnlyForGrowingConversation = (
  stable: number,
  initialDynamic: number,
  deltas: ReadonlyArray<number>,
) => {
  let dynamic = initialDynamic
  let cost = weighted({ write: stable, ordinary: dynamic })
  for (const delta of deltas) {
    dynamic += delta
    cost += weighted({ read: stable, ordinary: dynamic })
  }
  return cost
}

const minimumHitProbability = (requests: number) => {
  if (requests <= 1) return Number.POSITIVE_INFINITY
  const numerator = requests * (price.write - price.ordinary)
  const denominator = (requests - 1) * (price.write - price.read)
  return numerator / denominator
}

const expectedExplicitPrefix = (requests: number, prefix: number, hitProbability: number) => {
  const later = Math.max(0, requests - 1)
  return weighted({ write: prefix }) +
    later * (hitProbability * weighted({ read: prefix }) + (1 - hitProbability) * weighted({ write: prefix }))
}

describe("GPT-5.6+ prompt-cache economics research model", () => {
  test("matches the documented one-write + one-read 1.35x example", () => {
    expect(weighted({ write: 1 }) + weighted({ read: 1 })).toBeCloseTo(1.35)
  })

  test("one-shot work is cheaper with no cache write than an explicit stable-prefix write", () => {
    const stable = 8_000
    const volatile = 2_000
    expect(disabled(1, stable + volatile)).toBeLessThan(explicitStable(1, stable, volatile))
  })

  test("one stable-prefix reuse clears the deterministic explicit-write premium", () => {
    const stable = 8_000
    const volatile = 2_000
    expect(explicitStable(2, stable, volatile)).toBeLessThan(disabled(2, stable + volatile))
  })

  test("explicit stable boundary beats repeatedly writing a boundary with a unique volatile suffix", () => {
    const stable = 8_000
    const volatile = 2_000
    expect(explicitStable(3, stable, volatile)).toBeLessThan(implicitVolatileBoundary(3, stable, volatile))
  })

  test("provider implicit caching dominates static-only explicit caching for naturally append-only history", () => {
    const stable = 8_000
    const initialDynamic = 2_000
    const deltas = [3_000, 2_000, 1_000]
    const implicit = implicitAppendOnly(stable + initialDynamic, deltas)
    const explicit = explicitStaticOnlyForGrowingConversation(stable, initialDynamic, deltas)
    expect(implicit).toBeLessThan(explicit)
  })

  test("expected-hit admission threshold falls with reuse horizon but never reaches zero", () => {
    expect(minimumHitProbability(2)).toBeCloseTo(0.4347826087)
    expect(minimumHitProbability(3)).toBeCloseTo(0.3260869565)
    expect(minimumHitProbability(10)).toBeCloseTo(0.2415458937)
    expect(minimumHitProbability(100_000)).toBeGreaterThan(0.21739)
    expect(minimumHitProbability(100_000)).toBeLessThan(0.2174)
  })

  test("expected explicit reuse crosses the uncached baseline exactly at the derived threshold", () => {
    const requests = 3
    const prefix = 10_000
    const threshold = minimumHitProbability(requests)
    const baseline = disabled(requests, prefix)
    expect(expectedExplicitPrefix(requests, prefix, threshold - 0.001)).toBeGreaterThan(baseline)
    expect(expectedExplicitPrefix(requests, prefix, threshold + 0.001)).toBeLessThan(baseline)
  })
})
