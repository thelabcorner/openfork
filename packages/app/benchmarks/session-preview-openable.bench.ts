/**
 * Group inspector's Open All button count: previously scanned every row on
 * every tab-store update; now consumes a relationship-scoped multiplicity
 * projection and scans only open session-tab IDs.
 * From packages/app: bun run benchmarks/session-preview-openable.bench.ts
 */
import type { SessionPreviewRelationships } from "../src/components/session-preview/session-preview-model"
import {
  forEachPreviewSession,
  previewRelationshipCount,
  previewSessionWeights,
  previewUnopenedCount,
} from "../src/components/session-preview/session-preview-rows"

const count = 16_384
const revisions = 500
const rel: SessionPreviewRelationships = {
  sections: [{
    kind: "subagent", name: "Workers",
    rows: Array.from({ length: count }, (_, i) => ({
      row: { id: `ses_${i}`, title: `worker_${i}`, locked: false, origin: "user" },
      depth: 0, last: true,
    })),
  }],
  specialAgents: [],
}
const weights = previewSessionWeights(rel)
const total = previewRelationshipCount(rel)
const states = Array.from({ length: revisions }, (_, i) =>
  new Set(Array.from({ length: 100 }, (_, j) => `ses_${(i * 37 + j * 13) % count}`)),
)
function oldRun() {
  let checksum = 0
  for (const opened of states) {
    let unopened = 0
    forEachPreviewSession(rel, (id) => { if (!opened.has(id)) unopened++ })
    checksum += unopened
  }
  return checksum
}
function newRun() {
  let checksum = 0
  for (const opened of states) checksum += previewUnopenedCount(weights, opened, total)
  return checksum
}
if (oldRun() !== newRun()) throw new Error("projection parity mismatch")
const before: number[] = []
const after: number[] = []
const median = (sample: number[]) => [...sample].sort((a, b) => a - b)[Math.floor(sample.length / 2)]!
for (let trial = -2; trial < 7; trial++) {
  for (const optimized of trial % 2 === 0 ? [false, true] : [true, false]) {
    const start = performance.now()
    if (optimized) newRun()
    else oldRun()
    const elapsed = performance.now() - start
    if (trial >= 0) (optimized ? after : before).push(elapsed)
  }
}
const baselineMs = median(before)
const projectedMs = median(after)
console.log(JSON.stringify({
  members: count, revisions, openTabs: states[0]?.size ?? 0, trials: 7,
  baselineMs: +baselineMs.toFixed(3), indexedMs: +projectedMs.toFixed(3),
  speedup: +(baselineMs / projectedMs).toFixed(2), before, after,
}))