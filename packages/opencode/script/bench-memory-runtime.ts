/**
 * Reproducible host-side Memory read-path latency measurement.
 *
 * bun run script/bench-memory-runtime.ts <absolute approved project root> [iterations]
 * Does not mutate Session/Memory data or bootstrap V1 execution Instances.
 */
import { Effect } from "effect"
import { isAbsolute } from "node:path"
import { ExchangeMemory } from "../src/exchange/memory"

const rootPath = process.argv[2]
if (!rootPath || !isAbsolute(rootPath)) {
  console.error("Usage: bun run script/bench-memory-runtime.ts <absolute-root> [iterations]")
  process.exit(2)
}
const count = Math.max(10, Math.min(500, Number(process.argv[3] ?? 100) || 100))
const timestamp = () => performance.now()
const round = (n: number) => Math.round(n * 100) / 100
const context = { rootPath, sessionSearchAuthorized: true }
const cases = [
  { name: "map", input: { action: "map" as const } },
  { name: "saved-only", input: { action: "search" as const, query: "memory latency", sources: "memory" as const, limit: 5 } },
  { name: "combined", input: { action: "search" as const, query: "memory latency", sources: "both" as const, limit: 5 } },
]
async function run(input: ExchangeMemory.Input) {
  const at = timestamp()
  const result = await Effect.runPromise(ExchangeMemory.executeRuntime(input, context))
  return { duration: timestamp() - at, result }
}
function quantile(values: number[], p: number) {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0
}
function summary(name: string, times: number[]) {
  return {
    name, samples: times.length,
    minMs: round(Math.min(...times)),
    p50Ms: round(quantile(times, 0.50)),
    p95Ms: round(quantile(times, 0.95)),
    p99Ms: round(quantile(times, 0.99)),
    maxMs: round(Math.max(...times)),
  }
}
const first = await run(cases[0]!.input)
console.log(JSON.stringify({ name: "cold-map", ms: round(first.duration), topics: first.result.metadata.topics }))
for (const item of cases) {
  const times: number[] = []
  let coverage: boolean | undefined
  let indexCoverage: unknown
  let uniqueSessions: number | undefined
  for (let i = 0; i < count; i++) {
    const attempt = await run(item.input)
    times.push(attempt.duration)
    coverage = attempt.result.metadata.sessionCoverageComplete
    const evidence = attempt.result.structured.sessionEvidence as {
      indexCoverage?: unknown
      hits?: ReadonlyArray<{ sessionId: string }>
    } | undefined
    indexCoverage = evidence?.indexCoverage
    uniqueSessions = evidence?.hits ? new Set(evidence.hits.map((x) => x.sessionId)).size : undefined
  }
  console.log(JSON.stringify({
    ...summary(item.name, times),
    sessionCoverageComplete: coverage ?? null,
    ...(indexCoverage ? { indexCoverage } : {}),
    ...(uniqueSessions !== undefined ? { uniqueSessions } : {}),
  }))
}
const parallelTimes: number[] = []
for (let i = 0; i < Math.ceil(count / 10); i++) {
  const started = timestamp()
  await Promise.all(Array.from({ length: 10 }, () => run(cases[2]!.input)))
  parallelTimes.push(timestamp() - started)
}
console.log(JSON.stringify({ ...summary("combined-batches-of-10", parallelTimes), batchConcurrency: 10 }))
process.exit(0)
