import * as GeneralUsage from "../src/capacity/general-usage"
import { observeYieldStatistic, snapshotYieldStatistic, type YieldStatisticState } from "@opencode-ai/core/usage/yield-statistics"
import type { UsageYield } from "@opencode-ai/core/usage/yield"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"

const sizes = [100, 500, 8_000] as const
const iterations = 20
const warmups = 3
// Point this to a temporary reference implementation for local A/B comparison.
// Production does not depend on any reference module.
const reference: typeof GeneralUsage | undefined = process.env.GENERAL_USAGE_REFERENCE
  ? await import(pathToFileURL(resolve(process.env.GENERAL_USAGE_REFERENCE)).href)
  : undefined
const implementations = reference
  ? ([{ name: "reference", build: reference.build }, { name: "optimized", build: GeneralUsage.build }] as const)
  : ([{ name: "optimized", build: GeneralUsage.build }] as const)

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
  const raw = entries(size)
  // Core UsageYield.list() returns snapshotYieldStatistic(row.state), so this
  // represents the real Capacity.general input; raw states remain a useful
  // independent benchmark of the pure builder API.
  for (const [stateKind, input] of [
    ["raw", raw],
    ["finalized", raw.map((entry) => ({ ...entry, state: snapshotYieldStatistic(entry.state) }))],
  ] as const) {
    const records = implementations.map((implementation) => ({
      implementation,
      samples: [] as number[],
      snapshot: undefined as GeneralUsage.Snapshot | undefined,
    }))
    for (let index = 0; index < warmups; index++) {
      for (const record of records) record.implementation.build(input)
    }
    for (let index = 0; index < iterations; index++) {
      // Alternate ordering so one implementation cannot always benefit from
      // the other one's warm caches or suffer first-in-iteration GC pressure.
      const order = index % 2 === 0 ? records : [...records].reverse()
      for (const record of order) {
        const started = performance.now()
        record.snapshot = record.implementation.build(input)
        record.samples.push(performance.now() - started)
      }
    }
    if (records.length === 2 && JSON.stringify(records[0]!.snapshot) !== JSON.stringify(records[1]!.snapshot))
      throw new Error(`general-usage output mismatch for ${size} scopes (${stateKind})`)

    for (const record of records) {
      record.samples.sort((left, right) => left - right)
      const snapshot = record.snapshot!
      console.log(
        JSON.stringify({
          implementation: record.implementation.name,
          stateKind,
          modelScopes: size,
          medianMs: percentile(record.samples, 0.5),
          p95Ms: percentile(record.samples, 0.95),
          minMs: record.samples[0],
          maxMs: record.samples.at(-1),
          wireBytes: Buffer.byteLength(JSON.stringify(snapshot)),
          directModels: snapshot.models.length,
          corpusSize: snapshot.corpus.length,
          source: snapshot.source,
        }),
      )
    }
  }
}
