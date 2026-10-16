/** Archive filtering and member projection fused into one loop.
 * Pure cold-hover data/model work only, NOT Electron frame-time or paint.
 * From packages/app: bun run benchmarks/session-preview-group-tree.bench.ts
 */
import type { SessionGroupEntry } from "../src/context/session-groups"
import {
  sessionPreviewGroupOnly,
  sessionPreviewRow,
  sessionPreviewTree,
} from "../src/components/session-preview/session-preview-model"

const size = 16_384
const iterations = 20
const trials = 7
const group: SessionGroupEntry = {
  id: "large",
  name: "All workers",
  kind: "subagent",
  sessionIds: [],
  position: 0,
  sessions: Array.from({ length: size }, (_, i) => ({
    id: `ses_${i}`, title: `Worker ${i}`,
    parentID: i > 0 ? `ses_${Math.floor((i - 1) / 3)}` : undefined,
    locked: false, origin: "auto_subagent", position: i, timeAdded: 0,
    time: { created: 0, ...(i % 11 === 0 ? { archived: 5 } : {}) },
  })),
  time: { created: 0, updated: 0 },
}
group.sessionIds = group.sessions.map((member) => member.id)

function previous() {
  return sessionPreviewTree(
    group.sessions.filter((member) => member.time?.archived == null).map((member) => sessionPreviewRow(member)),
  )
}
function optimized() {
  return sessionPreviewGroupOnly(group).rows
}
const a = previous()
const b = optimized()
if (JSON.stringify(a) !== JSON.stringify(b)) throw Error("group-tree parity mismatch")
const oldSamples: number[] = []
const newSamples: number[] = []
for (let trial = -2; trial < trials; trial++) {
  for (const fast of trial % 2 ? [true, false] : [false, true]) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) (fast ? optimized : previous)()
    const elapsed = performance.now() - start
    if (trial >= 0) (fast ? newSamples : oldSamples).push(elapsed)
  }
}
const median = (samples: number[]) => [...samples].sort((x, y) => x - y)[Math.floor(samples.length / 2)]!
const beforeMs = median(oldSamples)
const afterMs = median(newSamples)
console.log(JSON.stringify({
  members: size, visible: b.length, iterations, trials,
  baselineMs: +beforeMs.toFixed(3),
  optimizedMs: +afterMs.toFixed(3),
  speedup: +(beforeMs / afterMs).toFixed(2),
  before: oldSamples, after: newSamples,
}))