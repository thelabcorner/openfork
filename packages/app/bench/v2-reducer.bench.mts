// Bench: does the v2 session reducer do O(messages) work per delta?
// Mirrors the real consumer path: server-sync.tsx calls session.applyV2(event.current)
// -> v2.reduce(source, event) -> updateAssistant -> update() = source.map(...) over the
// WHOLE session message list, for EVERY text/reasoning/tool delta.
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

const reducer = createV2SessionReducer()

function deltaEvent(messageID: string, delta: string) {
  return {
    id: `evt_${Math.random()}`,
    created: 1,
    type: "session.text.delta",
    data: { sessionID: "ses", assistantMessageID: messageID, ordinal: 0, delta },
  } as any
}

function bench(messageCount: number, deltas: number) {
  let source = makeSession(messageCount)
  // target the LAST message (worst case: reducer scans full list to find it)
  const targetID = `msg_${messageCount - 1}`
  // warm up
  for (let i = 0; i < 5; i++) reducer.reduce(source, deltaEvent(targetID, "a"))
  const t0 = Bun.nanoseconds()
  for (let i = 0; i < deltas; i++) {
    const r = reducer.reduce(source, deltaEvent(targetID, "a"))
    if (r) source = r.messages as SessionMessageInfo[]
  }
  const ms = (Bun.nanoseconds() - t0) / 1e6
  return { ms, perDeltaUs: (ms / deltas) * 1000 }
}

console.log("v2 session.text.delta reduce cost (full session re-scan per delta)")
console.log(`${"messages".padEnd(10)} ${"deltas".padEnd(10)} ${"total ms".padStart(12)} ${"us/delta".padStart(12)}`)
for (const n of [10, 50, 100, 200, 500, 1000, 2000]) {
  const r = bench(n, 2000)
  console.log(`${String(n).padEnd(10)} ${"2000".padEnd(10)} ${r.ms.toFixed(1).padStart(12)} ${r.perDeltaUs.toFixed(2).padStart(12)}`)
}

// Realistic stream shape: a session with ~150 messages streaming ~20K deltas/sec.
console.log("\nAt 150 messages, what 20K deltas/sec costs the reducer (excl. everything else):")
const real = bench(150, 20000)
console.log(`  per-delta ${real.perDeltaUs.toFixed(2)}us -> ${((real.perDeltaUs * 20000) / 1000).toFixed(0)}ms/sec of pure reducer CPU`)
