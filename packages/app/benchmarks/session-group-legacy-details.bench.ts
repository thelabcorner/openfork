/**
 * Plain JS allocation cost of merging 1,000 legacy group responses as
 * separate store snapshots vs bounded progressive batches of 32.
 * DOES NOT measure SDK network latency or Solid DOM rendering.
 * From packages/app: bun run benchmarks/session-group-legacy-details.bench.ts
 */
import type { SessionGroupDetail, SessionGroupInfo } from "@opencode-ai/sdk/v2/client"
import { mergeSessionGroupDetails } from "../src/context/session-group-entries"

const members = 1_000
const payload: SessionGroupDetail[] = Array.from({ length: members }, (_, i) => ({
  group: { id: `group_${i}`, name: `Group ${i}`, kind: "user", time: { created: 0, updated: i } } as SessionGroupInfo,
  sessions: [],
}))
const trials = 7
const repeats = 20
function old() {
  let data: Record<string, SessionGroupDetail> = {}
  for (const item of payload) data = { ...data, [item.group.id]: item }
  return data
}
function batched() {
  let data: Record<string, SessionGroupDetail> = {}
  for (let index = 0; index < payload.length; index += 32)
    data = mergeSessionGroupDetails(data, payload.slice(index, index + 32))
  return data
}
function oneShot() { return mergeSessionGroupDetails({}, payload) }
if (
  JSON.stringify(old()) !== JSON.stringify(batched()) ||
  JSON.stringify(old()) !== JSON.stringify(oneShot())
) throw Error("batch projection parity mismatch")
const previous: number[] = []
const optimized: number[] = []
const theoretical: number[] = []
for (let trial = -2; trial < trials; trial++) {
  const order = trial % 2 ? [1, 2, 0] : [0, 2, 1]
  for (const mode of order) {
    const start = performance.now()
    for (let i = 0; i < repeats; i++) (mode === 1 ? batched : mode === 2 ? oneShot : old)()
    const duration = performance.now() - start
    if (trial >= 0) (mode === 1 ? optimized : mode === 2 ? theoretical : previous).push(duration)
  }
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
const before = median(previous)
const after = median(optimized)
console.log(JSON.stringify({
  groups: members, repeats, trials, previousMs: +before.toFixed(3),
  boundedBatchedMs: +after.toFixed(3), boundedSpeedup: +(before / after).toFixed(2),
  oneShotMs: +median(theoretical).toFixed(3),
  previous, optimized, theoretical,
}))