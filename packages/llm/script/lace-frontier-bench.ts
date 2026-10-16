import { commonPrefixBytes, planCacheAdmission } from "../src/cache-frontier"
import { planCacheAdmissionDP } from "../src/cache-frontier-dp"

function benchmark(name: string, iterations: number, fn: () => number) {
  let sink = 0
  for (let i = 0; i < Math.min(100, iterations); i++) sink += fn()
  const times: number[] = []
  for (let k = 0; k < 11; k++) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) sink += fn()
    times.push((performance.now() - start) * 1e6 / iterations)
  }
  times.sort((a, b) => a - b)
  return { name, iterations, nsPerCallMedian: Math.round(times[5]!), nsPerCallP90: Math.round(times[9]!), sink }
}

const chunks = Array.from({ length: 128 }, (_, i) => new Uint8Array(1024).fill(i % 251))
const changed = chunks.slice()
changed[changed.length - 1] = chunks[chunks.length - 1]!.slice()
changed[changed.length - 1]![1023] ^= 1
const flatA = new Uint8Array(chunks.length * 1024)
const flatB = new Uint8Array(chunks.length * 1024)
chunks.forEach((piece, i) => flatA.set(piece, i * 1024))
changed.forEach((piece, i) => flatB.set(piece, i * 1024))

function naiveExact() {
  let count = 0
  while (count < flatA.length && count < flatB.length && flatA[count] === flatB[count]) count++
  return count
}

const data = [
  benchmark("fragmented-prefix-128KiB-reused-segments", 5000, () => commonPrefixBytes(chunks, changed).bytes),
  benchmark("flat-prefix-128KiB-full-scan", 1000, naiveExact),
]
for (const n of [3, 12, 24]) {
  const plan = {
    initialTokens: 24000,
    candidateBoundaries: Array.from({ length: n }, (_, i) => Math.floor((i + 1) * 24000 / n)),
    maxBreakpoints: 4,
    minimumCacheableTokens: 1024,
    rates: { ordinary: 1, write: 1.25, read: 0.1 },
    future: Array.from({ length: 8 }, (_, i) => ({
      probability: 1 - i * 0.08,
      totalTokens: 26000,
      sharedPrefixTokens: i % 2 ? 12000 : 24000,
      residencyProbability: 0.85,
    })),
  }
  const explored = planCacheAdmission(plan)
  data.push(benchmark("admission-" + n + "-boundaries-" + explored.evaluatedPlans + "-plans",
    n === 24 ? 80 : n === 12 ? 800 : 5000,
    () => planCacheAdmission(plan).projectedSavings))
  const dp = planCacheAdmissionDP(plan)
  if (Math.abs(dp.projectedCost - explored.projectedCost) > 0.0001) throw new Error("differential planner mismatch")
  data.push(benchmark("admission-dp-" + n + "-boundaries-" + dp.evaluatedTransitions + "-transitions",
    n === 24 ? 3000 : 5000,
    () => planCacheAdmissionDP(plan).projectedSavings))
}
console.log(JSON.stringify(data, null, 2))
