/**
 * bun --conditions=solid scripts/bench-session-preview-cache.ts
 * Deterministic microbenchmark for derived preview topology only; this does
 * not claim end-to-end renderer paint/interaction improvements.
 */
import type { SessionGroupEntry } from "@/context/session-groups"
import { buildSessionPreviewIndex, sessionPreviewRelationships } from "@/components/session-preview/session-preview-model"
import { createSessionPreviewProjectionCache } from "@/components/session-preview/session-preview-cache"

const count = 64
const rows = 16
const groups: SessionGroupEntry[] = Array.from({ length: count }, (_, index) => {
  const sessions = Array.from({ length: rows }, (_, row) => ({
    id: `worker_${index}_${row}`,
    title: `Worker ${index}:${row}`,
    parentID: row ? `worker_${index}_${row - 1}` : "root",
    origin: "subagent" as const,
    position: row,
    timeAdded: 0,
    locked: false,
  }))
  return {
    id: `group_${index}`,
    name: `group_${index}`,
    kind: "subagent",
    position: index,
    anchorSessionID: "root",
    sessionIds: ["root", ...sessions.map((s) => s.id)],
    sessions,
    time: { created: 0, updated: 0 },
  }
})
const index = buildSessionPreviewIndex(groups)
const cache = createSessionPreviewProjectionCache()
const inputs = Array.from({ length: 16 }, (_, i) => ({
  sessionID: i === 0 ? "root" : `worker_${i}_0`,
  groups,
  index,
}))
for (const input of inputs) {
  sessionPreviewRelationships(input)
  cache.session(input)
}
const measure = (name: string, action: (index: number) => void, iterations: number) => {
  const started = performance.now()
  for (let i = 0; i < iterations; i++) action(i)
  const elapsed = performance.now() - started
  console.log(`${name}: ${elapsed.toFixed(3)} ms / ${iterations} lookups | ${(iterations / elapsed * 1000).toFixed(0)} lookups/s`)
  return elapsed
}
const iterations = 1000
const cold = measure("raw topology projection", (i) => {
  sessionPreviewRelationships(inputs[i % inputs.length]!)
}, iterations)
const warm = measure("cached topology reuse", (i) => {
  cache.session(inputs[i % inputs.length]!)
}, iterations)
console.log(`warm-cache speedup: ${(cold / warm).toFixed(1)}x (synthetic 64-group fixture; index construction excluded)`)
