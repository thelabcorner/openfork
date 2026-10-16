/**
 * Usage table sorting regression benchmark.
 *
 * Run from packages/app: bun scripts/bench-usage-sort.ts
 * Intentionally measures only ranking. Real page/SQLite performance must be
 * measured separately with an active renderer and real usage history.
 */
import { sortedUsagePrefix } from "../src/components/usage/usage-prefix-sort"

type Row = { id: number; score: number }
const samples = [
  { n: 50, k: 50, iterations: 5000 },
  { n: 500, k: 50, iterations: 2000 },
  { n: 10_000, k: 50, iterations: 500 },
  { n: 100_000, k: 50, iterations: 50 },
] as const

function data(n: number, shape: "random" | "ties" | "sorted"): Row[] {
  let state = 0x13a42b71
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  return Array.from({ length: n }, (_, id) => ({
    id,
    score: shape === "sorted" ? n - id : shape === "ties" ? Math.floor(random() * 7) : random(),
  }))
}

function median(values: number[]) {
  return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!
}

function measure(run: () => Row[], repetitions: number) {
  const times: number[] = []
  let checksum = 0
  for (let round = 0; round < 5; round++) {
    for (let warmup = 0; warmup < 10; warmup++) checksum += run()[0]?.id ?? 0
    const start = performance.now()
    for (let i = 0; i < repetitions; i++) checksum += run()[0]?.id ?? 0
    times.push((performance.now() - start) / repetitions)
  }
  if (!Number.isFinite(checksum)) throw new Error("Invalid benchmark checksum")
  return median(times)
}

console.log("N       K    Shape    Full sort (ms/op)  Prefix (ms/op)  Speedup")
for (const { n, k, iterations } of samples) {
  for (const shape of ["random", "ties", "sorted"] as const) {
    const rows = data(n, shape)
    const full = () => [...rows].sort((a, b) => b.score - a.score).slice(0, k)
    const prefix = () => sortedUsagePrefix(rows, k, (row) => row.score, "desc")
    const expected = full().map((row) => row.id)
    const actual = prefix().map((row) => row.id)
    if (expected.some((id, index) => id !== actual[index]) || expected.length !== actual.length) {
      throw new Error(`Ranking mismatch for ${n}/${shape}`)
    }
    const baseline = measure(full, iterations)
    const optimized = measure(prefix, iterations)
    const f = (value: number) => value.toFixed(4).padStart(12)
    console.log(
      `${String(n).padEnd(7)} ${String(k).padEnd(4)} ${shape.padEnd(8)} ${f(baseline).padStart(18)}  ${f(optimized).padStart(14)}  ${(baseline / optimized).toFixed(2)}x`,
    )
  }
}