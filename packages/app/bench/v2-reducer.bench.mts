// Bench: measure the production hot streaming-delta reduction path across long
// histories. `projectV2` consumes `reduction.incremental` and updates one nested
// Solid store slot; it does NOT read the lazy compatibility `messages` getter.
// Keep that invariant here or this benchmark measures deliberate fallback
// materialization rather than steady-state streaming cost.
//
// Run: bun "C:/Users/slooshied/WebstormProjects/opencode/packages/app/bench/v2-reducer.bench.mts"

import { createV2SessionReducer } from "../src/context/server-session-v2-reducer"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"

function makeSession(messageCount: number): SessionMessageInfo[] {
  const out: SessionMessageInfo[] = []
  for (let i = 0; i < messageCount; i++) {
    out.push({
      id: `msg_${i}`,
      type: "assistant",
      metadata: {},
      agent: "build",
      model: { providerID: "p", modelID: "m" },
      content: [{ type: "text", text: "x", ordinal: 0 }],
      time: { created: 1 },
    })
  }
  return out
}

function deltaEvent(messageID: string, delta: string, current: boolean) {
  return {
    id: `evt_${Math.random()}`,
    ...(current ? {} : { created: 1 }),
    type: current ? "session.next.text.delta" : "session.text.delta",
    data: current
      ? { sessionID: "ses", timestamp: 1, assistantMessageID: messageID, textID: "txt_live", delta }
      : { sessionID: "ses", assistantMessageID: messageID, ordinal: 0, delta },
  } as any
}

function controlEvent() {
  return {
    id: `evt_control_${Math.random()}`,
    type: "session.next.renamed",
    data: { sessionID: "ses", timestamp: 1, title: "same" },
  } as any
}

function applyIncremental(source: SessionMessageInfo[], reduction: ReturnType<ReturnType<typeof createV2SessionReducer>["reduce"]>) {
  if (!reduction?.incremental) return
  const incremental = reduction.incremental
  if (incremental.kind === "message") {
    source[incremental.index] = incremental.message
    return
  }
  const message = source[incremental.index]
  if (!message || message.type !== "assistant") throw new Error("benchmark target disappeared")
  // Benchmark-side in-place update models Solid's nested-slot setter without
  // introducing an O(history) array copy into the measurement itself.
  message.content[incremental.partIndex] = incremental.content
}

function bench(messageCount: number, deltas: number, current: boolean) {
  const reducer = createV2SessionReducer()
  const source = makeSession(messageCount)
  // target the LAST message (worst case: reducer scans full list to find it)
  const targetID = `msg_${messageCount - 1}`
  // warm up
  for (let i = 0; i < 5; i++) {
    const result = reducer.reduce(source, deltaEvent(targetID, "a", current))
    applyIncremental(source, result)
  }
  const t0 = Bun.nanoseconds()
  for (let i = 0; i < deltas; i++) {
    const result = reducer.reduce(source, deltaEvent(targetID, "a", current))
    applyIncremental(source, result)
  }
  const ms = (Bun.nanoseconds() - t0) / 1e6
  return { ms, perDeltaUs: (ms / deltas) * 1000 }
}

function benchControlInterleave(messageCount: number, pairs: number) {
  const reducer = createV2SessionReducer()
  const source = makeSession(messageCount)
  const targetID = `msg_${messageCount - 1}`
  const warm = reducer.reduce(source, deltaEvent(targetID, "a", false))
  applyIncremental(source, warm)

  const t0 = Bun.nanoseconds()
  for (let i = 0; i < pairs; i++) {
    const control = reducer.reduce(source, controlEvent())
    if (control?.kind !== "unchanged") throw new Error("control event changed message projection")
    const delta = reducer.reduce(source, deltaEvent(targetID, "a", false))
    applyIncremental(source, delta)
  }
  const ms = (Bun.nanoseconds() - t0) / 1e6
  return { ms, perPairUs: (ms / pairs) * 1000 }
}

for (const current of [false, true]) {
  console.log(`v2 ${current ? "session.next.text.delta" : "session.text.delta"} production-path reduce cost`)
  console.log(`${"messages".padEnd(10)} ${"deltas".padEnd(10)} ${"total ms".padStart(12)} ${"us/delta".padStart(12)}`)
  for (const n of [10, 50, 100, 200, 500, 1000, 2000]) {
    const r = bench(n, 2000, current)
    console.log(`${String(n).padEnd(10)} ${"2000".padEnd(10)} ${r.ms.toFixed(1).padStart(12)} ${r.perDeltaUs.toFixed(2).padStart(12)}`)
  }
}

console.log("\ncontrol-event + streaming-delta interleave (index must survive control traffic)")
console.log(`${"messages".padEnd(10)} ${"pairs".padEnd(10)} ${"total ms".padStart(12)} ${"us/pair".padStart(12)}`)
for (const n of [100, 1_000, 5_000, 10_000]) {
  const r = benchControlInterleave(n, 5_000)
  console.log(`${String(n).padEnd(10)} ${"5000".padEnd(10)} ${r.ms.toFixed(1).padStart(12)} ${r.perPairUs.toFixed(2).padStart(12)}`)
}

// Realistic stream shape: a session with ~150 messages streaming ~20K deltas/sec.
console.log("\nAt 150 messages, what 20K deltas/sec costs the reducer (excl. everything else):")
for (const current of [false, true]) {
  const real = bench(150, 20000, current)
  console.log(
    `  ${current ? "next" : "compat"}: ${real.perDeltaUs.toFixed(2)}us/delta -> ${((real.perDeltaUs * 20000) / 1000).toFixed(0)}ms/sec reducer CPU`,
  )
}
