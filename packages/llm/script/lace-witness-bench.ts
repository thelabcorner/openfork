/** Reproducible, no-network LACE native-body witness cost microbenchmark. */
import { createRequestWitnessObserver, witnessCompiledRequest } from "../src/cache-request-witness"

const median = (numbers: number[]) => numbers.toSorted((a, b) => a - b)[Math.floor(numbers.length / 2)]!
const measure = (name: string, size: number) => {
  const body = {
    model: "gpt-5.6",
    tools: [{ name: "read", parameters: { type: "object", properties: {} } }],
    input: [
      { role: "system", content: "Immutable operator policy." },
      { role: "user", content: "x".repeat(size) },
    ],
    max_output_tokens: 1024,
  }
  const input = {
    owner: "benchmark-owner", session: "bench-session", provider: "openai",
    model: "gpt-5.6", runtime: "native", route: "direct/responses",
    protocol: "openai-responses" as const, body,
  }
  const observer = createRequestWitnessObserver(2)
  for (let i = 0; i < 16; i++) witnessCompiledRequest(input)
  const samples: number[] = []
  for (let round = 0; round < 9; round++) {
    const start = performance.now()
    for (let i = 0; i < 80; i++) observer.observe(input)
    samples.push((performance.now() - start) * 1000 / 80)
  }
  return {
    operation: name,
    bodyBytes: Buffer.byteLength(JSON.stringify(body), "utf8"),
    medianMicroseconds: +median(samples).toFixed(2),
    minMicroseconds: +Math.min(...samples).toFixed(2),
    maxMicroseconds: +Math.max(...samples).toFixed(2),
  }
}
console.log(JSON.stringify([
  measure("16KiB native prompt", 16 * 1024),
  measure("128KiB native prompt", 128 * 1024),
  measure("512KiB native prompt", 512 * 1024),
], null, 2))
