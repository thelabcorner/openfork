/**
 * Compare hover inspector's old per-hover membership-index construction with
 * server-scoped shared snapshot reuse. This is pure JS work, NOT Electron FPS.
 * From packages/app: bun run benchmarks/session-preview-index.bench.ts
 */
import type { SessionGroupEntry } from "../src/context/session-groups"
import { buildSessionPreviewIndex } from "../src/context/session-group-preview-index"
import { sessionPreviewRelationships } from "../src/components/session-preview/session-preview-model"

const groups: SessionGroupEntry[] = Array.from({ length: 128 }, (_, index) => {
  const anchor = `ses-root-${index % 8}`
  const ids = [anchor, ...Array.from({ length: 20 }, (_, j) => `ses-${index}-${j}`)]
  return {
    id: `group-${index}`,
    name: `Group ${index}`,
    kind: index % 2 ? "plugin" : "subagent",
    position: index,
    anchorSessionID: anchor,
    sessionIds: ids,
    sessions: ids.map((id, j) => ({
      id, title: id, parentID: j ? anchor : undefined,
      origin: "auto_subagent", locked: false, position: j, timeAdded: 0,
    })),
    time: { created: 0, updated: 0 },
  }
})
const hovered = Array.from({ length: 32 }, (_, i) => `ses-root-${i % 8}`)
const iterations = 128
const trials = 7

function execute(shared: boolean) {
  const index = shared ? buildSessionPreviewIndex(groups) : undefined
  let projected = 0
  const begin = performance.now()
  for (let repeat = 0; repeat < iterations; repeat++) {
    const id = hovered[repeat % hovered.length]!
    const rel = sessionPreviewRelationships({
      sessionID: id,
      groups,
      index: index ?? buildSessionPreviewIndex(groups),
    })
    projected += rel.sections.length + rel.specialAgents.length
  }
  return { ms: performance.now() - begin, projected }
}
function median(values: number[]) {
  const valuesSorted = [...values].sort((a, b) => a - b)
  return valuesSorted[Math.floor(valuesSorted.length / 2)]!
}
const before: number[] = []
const after: number[] = []
for (let trial = -2; trial < trials; trial++) {
  for (const shared of trial % 2 ? [true, false] : [false, true]) {
    const result = execute(shared)
    if (trial < 0) continue
    ;(shared ? after : before).push(result.ms)
  }
}
const control = execute(false)
const optimized = execute(true)
if (control.projected !== optimized.projected) throw Error("relationship parity mismatch")
const a = median(before)
const b = median(after)
console.log(JSON.stringify({
  groups: groups.length,
  members: groups.reduce((count, group) => count + group.sessionIds.length, 0),
  hoversPerTrial: iterations,
  trials,
  previousMs: +a.toFixed(3),
  sharedMs: +b.toFixed(3),
  speedup: +(a / b).toFixed(2),
  projectedRowsAndSections: control.projected,
  previousSamples: before.map((x) => +x.toFixed(2)),
  sharedSamples: after.map((x) => +x.toFixed(2)),
}))