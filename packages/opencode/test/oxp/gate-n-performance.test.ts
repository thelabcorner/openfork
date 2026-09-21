import { describe, expect, test } from "bun:test"
import { OxpParentToolEpoch } from "@/oxp/parent-tool-epoch"

const percentile = (values: readonly number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length * fraction)] ?? 0

describe("OXP Gate N continuity performance", () => {
  test("keeps per-call epoch observation sub-millisecond on a warm path", () => {
    let now = 0
    const tracker = OxpParentToolEpoch.makeTracker({ now: () => now })
    const parent = {
      scheme: "openai/session",
      value: "parent-warm",
      scope: "conversation",
    } as const
    const samples: number[] = []
    tracker.observe(parent)
    for (let index = 0; index < 10_000; index++) {
      now += 1
      const start = performance.now()
      tracker.observe(parent)
      samples.push(performance.now() - start)
    }
    const report = {
      medianMs: percentile(samples, 0.5),
      p95Ms: percentile(samples, 0.95),
      trackedParents: tracker.stats().trackedParents,
    }
    console.log("OXP_GATE_N_EPOCH_PERF", JSON.stringify(report))
    expect(report.medianMs).toBeLessThan(0.1)
    expect(report.p95Ms).toBeLessThan(0.5)
    expect(report.trackedParents).toBe(1)
  })
})
