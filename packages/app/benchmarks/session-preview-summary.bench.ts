/** Sparse authoritative status maps vs per-row reactive scan.
 * Isolated JS projection only, NOT Electron frame/latency profiling.
 * From packages/app: bun run benchmarks/session-preview-summary.bench.ts
 */
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { previewSparseSummary } from "../src/components/session-preview/session-preview-summary"

const groups = 16_384
const iterations = 1_000
const weights = new Map(Array.from({ length: groups }, (_, i) => [`ses_${i}`, 1] as const))
const status = { type: "busy" } as SessionStatus
const statuses = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`ses_${i * 31}`, status]))
const permissions = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`ses_${i * 21}`, [{}]]))
const questions = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`ses_${i * 23}`, [{}]]))
const paused = { "ses_0": true }

function before() {
  let running = 0
  let waiting = 0
  for (const [id, weight] of weights) {
    if (permissions[id]?.length || questions[id]?.length) {
      waiting += weight
    } else if (!paused[id as keyof typeof paused] && statuses[id]?.type === "busy") {
      running += weight
    }
  }
  return { running, waiting }
}
const input = { weights, statuses, paused, permissions, questions }
function after() {
  return previewSparseSummary(input)
}
if (JSON.stringify(before()) !== JSON.stringify(after())) throw Error("status summary mismatch")

const previous: number[] = []
const sparse: number[] = []
for (let trial = -2; trial < 7; trial++) {
  for (const optimized of trial % 2 ? [true, false] : [false, true]) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) optimized ? after() : before()
    const elapsed = performance.now() - start
    if (trial >= 0) (optimized ? sparse : previous).push(elapsed)
  }
}
const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!
const old = median(previous)
const now = median(sparse)
console.log(JSON.stringify({
  groups, statuses: Object.keys(statuses).length, iterations,
  baselineMs: +old.toFixed(3), sparseMs: +now.toFixed(3),
  speedup: +(old / now).toFixed(2), previous, sparse,
}))