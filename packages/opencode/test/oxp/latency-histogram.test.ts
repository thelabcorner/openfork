import { describe, expect, test } from "bun:test"
import { createLatencyHistogram } from "../../src/oxp/latency-histogram"

describe("OXP bounded latency telemetry", () => {
  test("projects empty histograms without fictitious quantiles", () => {
    expect(createLatencyHistogram().snapshot()).toEqual({ count: 0 })
  })
  test("ignores non-finite samples and preserves conservative upper bucket bounds", () => {
    const histogram = createLatencyHistogram()
    histogram.observe(-1)
    histogram.observe(Number.NaN)
    histogram.observe(Infinity)
    for (let i = 1; i <= 1_000; i++) histogram.observe(i / 10)
    const result = histogram.snapshot()
    expect(result.count).toBe(1_000)
    expect(result.maxMs).toBe(100)
    expect(result.meanMs).toBeCloseTo(50.05, 2)
    expect(result.p50UpperMs).toBeGreaterThanOrEqual(50)
    expect(result.p95UpperMs).toBeGreaterThanOrEqual(95)
    expect(result.p99UpperMs).toBeGreaterThanOrEqual(99)
    expect(result.p50UpperMs).toBeLessThan(60)
    expect(result.p95UpperMs).toBeLessThan(120)
  })
  test("works with sub-millisecond and long-running operations without retaining samples", () => {
    const histogram = createLatencyHistogram()
    for (let i = 0; i < 100_000; i++) histogram.observe(i % 2 ? 0.001 : 300_100)
    const result = histogram.snapshot()
    expect(result.count).toBe(100_000)
    expect(result.p50UpperMs).toBeLessThan(0.02)
    expect(result.p95UpperMs).toBeGreaterThanOrEqual(300_100)
  })
})
