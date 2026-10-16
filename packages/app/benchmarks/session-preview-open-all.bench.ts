/** Isolated append-planning comparison; no persistence/Electron UI work.
 * From packages/app: bun run benchmarks/session-preview-open-all.bench.ts
 */
import type { ServerConnection } from "../src/context/server"
import type { Tab } from "../src/context/tabs"
import { missingSessionTabs } from "../src/context/tab-session-batch"

const server = "local" as ServerConnection.Key
const count = 2_000
const existing: Tab[] = Array.from({ length: 500 }, (_, i) => ({
  type: "session", server, sessionId: `ses_${i}`,
}))
const incoming = Array.from({ length: count }, (_, i) => `ses_${i}`)
const runs = 9
const baseline: number[] = []
const optimized: number[] = []

function before() {
  const store = [...existing]
  for (const sessionId of incoming) {
    if (store.some((tab) => tab.type === "session" && tab.server === server && tab.sessionId === sessionId)) continue
    store.push({ type: "session", server, sessionId })
  }
  return store
}
function after() {
  return [...existing, ...missingSessionTabs(existing, server, incoming)]
}
if (JSON.stringify(before()) !== JSON.stringify(after())) throw Error("bulk parity mismatch")
const median = (items: number[]) => [...items].sort((a, b) => a - b)[Math.floor(items.length / 2)]!
for (let trial = -2; trial < runs; trial++) {
  for (const batch of trial % 2 ? [true, false] : [false, true]) {
    const start = performance.now()
    const result = batch ? after() : before()
    const elapsed = performance.now() - start
    if (result.length !== count) throw Error("unexpected result length")
    if (trial >= 0) (batch ? optimized : baseline).push(elapsed)
  }
}
const previousMs = median(baseline)
const batchedMs = median(optimized)
console.log(JSON.stringify({
  existing: existing.length, requested: incoming.length, trials: runs,
  previousMs: +previousMs.toFixed(3), batchedMs: +batchedMs.toFixed(3),
  speedup: +(previousMs / batchedMs).toFixed(2),
  baseline, optimized,
}))