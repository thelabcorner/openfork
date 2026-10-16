/**
 * Offline LACE V1 oversized plain-text turn search benchmark.
 * The serializer is a controlled stand-in for the full V1 projection; results
 * measure algorithmic suffix-search work, NOT provider/production throughput.
 *
 * Run: bun script/lace-retention-bench.ts (from packages/opencode)
 */
import { performance } from "node:perf_hooks"
import { Effect } from "effect"
import { firstFittingSuffix } from "../src/session/lace-checkpoint-retention"

const median = (samples: number[]) => samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]!
const fmt = (x: number) => x.toFixed(2)
for (const n of [128, 512, 1024]) {
  const messages = Array.from({ length: n }, (_, i) => ({
    role: "assistant",
    content: [{ type: "text", text: "line " + i + " " + "x".repeat(384) }],
  }))
  const budget = 1100
  const starts = messages.map((_, i) => i)
  const oldTimes: number[] = []
  const newTimes: number[] = []
  let oldCalls = 0
  let newCalls = 0
  const tokens = (start: number) => Math.round(JSON.stringify(messages.slice(start)).length / 4)
  const baseline = () => {
    for (let start = 0; start < n; start++) {
      oldCalls++
      if (tokens(start) <= budget) return start
    }
    return undefined
  }
  const optimized = () => Effect.runSync(firstFittingSuffix({
    starts,
    budget,
    estimate: (start) => Effect.sync(() => {
      newCalls++
      return tokens(start)
    }),
  }))
  for (let run = 0; run < 5; run++) {
    const a = performance.now()
    const oldResult = baseline()
    const b = performance.now()
    const newResult = optimized()
    const c = performance.now()
    if (oldResult !== newResult) throw new Error("LACE suffix mismatch")
    if (run > 0) {
      oldTimes.push(b - a)
      newTimes.push(c - b)
    }
  }
  console.log(JSON.stringify({
    n,
    oldMedianMs: fmt(median(oldTimes)),
    newMedianMs: fmt(median(newTimes)),
    oldEstimatesPerRun: oldCalls / 5,
    newEstimatesPerRun: newCalls / 5,
    speedup: fmt(median(oldTimes) / median(newTimes)),
  }))
}
