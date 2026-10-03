import * as GeneralUsage from "../src/capacity/general-usage"
import { observeYieldStatistic, type YieldStatisticState } from "@opencode-ai/core/usage/yield-statistics"
import type { UsageYield } from "@opencode-ai/core/usage/yield"

const sizes = [100, 500, 8_000] as const
const iterations = 20
const warmups = 3

function stateFor(seed: number): YieldStatisticState {
  let state: YieldStatisticState | undefined
  for (let index = 0; index < 8; index++) {
    state = observeYieldStatistic(state, {
      sessionID: `session-${seed}-${index}`,
      completedAt: seed * 100 + index,
      tokens: {
        input: 800 + ((seed + index) % 13) * 50,
        cacheRead: 40_000 + ((seed * 17 + index) % 100) * 200,
        cacheWrite: (index % 3) * 25,
        output: 200 + ((seed + index) % 11) * 20,
        reasoning: (index % 2) * 30,
      },
    })
  }
  return state!
}

function entries(count: number): UsageYield.Entry[] {
  return Array.from({ length: count }, (_, index) => ({
    key: {
      providerID: `provider-${index % 17}`,
      baseModelID: `model-${index}`,
    },
    state: stateFor(index + 1),
    updatedAt: (index + 1) * 100 + 7,
  }))
}

function percentile(sorted: readonly number[], q: number) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))
  return sorted[index]!
}

for (const size of sizes) {
  const input = entries(size)
  for (let index = 0; index < warmups; index++) GeneralUsage.build(input)

  const samples: number[] = []
  let snapshot!: GeneralUsage.Snapshot
  for (let index = 0; index < iterations; index++) {
    const started = performance.now()
    snapshot = GeneralUsage.build(input)
    samples.push(performance.now() - started)
  }
  samples.sort((left, right) => left - right)

  console.log(
    JSON.stringify({
      modelScopes: size,
      medianMs: percentile(samples, 0.5),
      p95Ms: percentile(samples, 0.95),
      minMs: samples[0],
      maxMs: samples.at(-1),
      wireBytes: Buffer.byteLength(JSON.stringify(snapshot)),
      directModels: snapshot.models.length,
      corpusSize: snapshot.corpus.length,
      source: snapshot.source,
    }),
  )
}
