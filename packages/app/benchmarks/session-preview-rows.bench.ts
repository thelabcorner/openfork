/** Pure presenter allocation benchmark, NOT full popover/renderer FPS.
 * From packages/app: bun run benchmarks/session-preview-rows.bench.ts
 */
import type { SessionPreviewRelationships } from "../src/components/session-preview/session-preview-model"
import { previewVisibleRows } from "../src/components/session-preview/session-preview-rows"

const count = 16_384
const limit = 80
const iterations = 500
const trials = 7
const rel: SessionPreviewRelationships = {
  sections: [{
    kind: "subagent",
    name: "Workers",
    rows: Array.from({ length: count }, (_, i) => ({
      row: { id: `worker-${i}`, title: `Worker ${i}`, locked: false, origin: "user" },
      depth: i % 4,
      last: true,
    })),
  }],
  specialAgents: [],
}
const prior = () => rel.sections.flatMap((section, sectionIndex) =>
  section.rows.map((row, i) => ({
    first: i === 0, sectionKey: `section-${sectionIndex}`, sectionName: section.name,
    sectionKind: section.kind, sectionCount: section.rows.length, row,
  })),
).slice(0, limit)

const oldSamples: number[] = []
const newSamples: number[] = []
function run(optimized: boolean) {
  let checksum = 0
  const start = performance.now()
  for (let i = 0; i < iterations; i++) {
    const result = optimized ? previewVisibleRows(rel, limit, "Special Agents") : prior()
    checksum += result.length
  }
  if (checksum !== iterations * limit) throw Error("incorrect projection length")
  return performance.now() - start
}
for (let trial = -2; trial < trials; trial++) {
  for (const optimized of trial % 2 ? [true, false] : [false, true]) {
    const elapsed = run(optimized)
    if (trial >= 0) (optimized ? newSamples : oldSamples).push(elapsed)
  }
}
const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!
const oldMs = median(oldSamples)
const newMs = median(newSamples)
console.log(JSON.stringify({
  members: count, visible: limit, iterations, trials,
  previousMs: +oldMs.toFixed(3), boundedMs: +newMs.toFixed(3),
  speedup: +(oldMs / newMs).toFixed(2),
  previousSamples: oldSamples.map((n) => +n.toFixed(2)),
  boundedSamples: newSamples.map((n) => +n.toFixed(2)),
}))