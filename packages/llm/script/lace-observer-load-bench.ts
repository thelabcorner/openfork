/** No-network synthetic LACE observer load scaling.
 *
 * Does not simulate provider inference, SQLite, scheduling, tool execution,
 * workspace ownership, or actual concurrent sessions. It measures bounded
 * in-process observer bookkeeping for 1/3/6/25/50/100 distinct session IDs.
 */
import { createRequestWitnessObserver } from "../src/cache-request-witness"

const counts = [1, 3, 6, 25, 50, 100]
const ITERATIONS = 300
const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!
const percentile = (xs: number[], p: number) => xs.toSorted((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)]!
const results = []
for (const sessions of counts) {
  const observer = createRequestWitnessObserver(128)
  const body = {
    model: "gpt-5.6",
    tools: [{ name: "read", parameters: { type: "object", properties: {} } }],
    input: [{ role: "system", content: "Stable" }, { role: "user", content: "A".repeat(8192) }],
  }
  const inputs = Array.from({ length: sessions }, (_, index) => ({
    owner: "synthetic-owner", session: "session-" + index, provider: "openai", model: "gpt-5.6",
    runtime: "native", route: "direct/responses", protocol: "openai-responses" as const,
    body,
  }))
  const samples: number[] = []
  for (let i = 0; i < 10; i++) for (const input of inputs) observer.observe(input)
  const memBefore = process.memoryUsage().heapUsed
  const startAll = performance.now()
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const start = performance.now()
    for (const input of inputs) observer.observe(input)
    samples.push((performance.now() - start) * 1000 / sessions)
  }
  const elapsedMs = performance.now() - startAll
  results.push({
    sessions, observations: sessions * ITERATIONS, retainedEntries: observer.size(),
    medianUsPerObservation: +median(samples).toFixed(2),
    p95UsPerObservation: +percentile(samples, 0.95).toFixed(2),
    observationsPerSecond: Math.round(sessions * ITERATIONS * 1000 / elapsedMs),
    observedHeapDeltaKiB: Math.round((process.memoryUsage().heapUsed - memBefore) / 1024),
  })
}
console.log(JSON.stringify(results, null, 2))
