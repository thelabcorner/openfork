/**
 * No-network microbenchmark of the LACE AI SDK post-transform observer.
 * This DOES NOT benchmark commercial inference, actual Session execution,
 * provider cache hits, final wire serialization, or billed model usage.
 */
import { performance } from "node:perf_hooks"
import { createLaceAISdkObserver } from "../src/session/llm/lace-ai-sdk-observer"

const sizes = [2048, 16_384, 131_072, 524_288]
const batches = 9
const iterations = 80

function median(xs: number[]) {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

for (const bytes of sizes) {
  const observer = createLaceAISdkObserver()
  const request = {
    owner: "benchmark",
    session: "benchmark",
    provider: "fixture",
    model: "fixture",
    route: "ai-sdk/fixture",
    tools: [{ name: "read", inputSchema: { type: "object" } }],
    prompt: [{ role: "user", content: [{ type: "text", text: "x".repeat(bytes) }] }],
  }
  for (let i = 0; i < 50; i++) observer.observe(request)
  const samples: number[] = []
  for (let batch = 0; batch < batches; batch++) {
    const before = performance.now()
    for (let i = 0; i < iterations; i++) observer.observe(request)
    samples.push(((performance.now() - before) * 1000) / iterations)
  }
  console.log(
    JSON.stringify({
      sizeBytes: bytes,
      medianMicroseconds: median(samples),
      minMicroseconds: Math.min(...samples),
      maxMicroseconds: Math.max(...samples),
      sampleBatches: batches,
      iterationsPerBatch: iterations,
      retainedRegions: observer.retained(),
    }),
  )
}
