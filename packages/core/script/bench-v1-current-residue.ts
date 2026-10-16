/**
 * Opt-in synthetic microbenchmark of the V1 → current compact residue.
 *
 * Usage: from packages/core: bun script/bench-v1-current-residue.ts
 * No database is read or written. Numbers are fixture-specific and never
 * authorize a production migration or a throughput Pareto claim.
 */
import { performance } from "node:perf_hooks"
import { SessionV1 } from "../src/v1/session"
import { SessionSchema } from "../src/session/schema"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { V1CurrentResidue } from "../src/session/v1-current-residue"

const sid = SessionSchema.ID.make("ses_residue_bench")
const mid = SessionV1.MessageID.make("msg_residue_bench")
const info = SessionV1.Assistant.make({
  id: mid, sessionID: sid, role: "assistant", time: { created: 1 },
  parentID: SessionV1.MessageID.make("msg_bench_parent"),
  modelID: ModelV2.ID.make("bench"),
  providerID: ProviderV2.ID.make("local"),
  agent: "build", mode: "build",
  path: { cwd: "/fixture", root: "/fixture" }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}) as unknown as SessionV1.Assistant

const quantile = (values: number[], fraction: number) => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!
}

for (const payloadBytes of [4 * 1024, 64 * 1024, 1024 * 1024]) {
  const source: SessionV1.WithParts = {
    info,
    parts: [
      SessionV1.ToolPart.make({
        id: SessionV1.PartID.make("prt_residue_bench"),
        sessionID: sid, messageID: mid, type: "tool",
        callID: "call_residue_bench", tool: "bash",
        state: {
          status: "completed", input: { cmd: "benchmark" },
          output: "X".repeat(payloadBytes),
          title: "test", metadata: {}, time: { start: 1, end: 2 },
        },
      }) as unknown as SessionV1.Part,
    ],
  }
  const warmup = 4
  const iterations = payloadBytes > 64 * 1024 ? 12 : 40
  const lowerMs: number[] = []
  const wireMs: number[] = []
  const originalBytes = Buffer.byteLength(JSON.stringify(source))
  let wireBytes = 0
  for (let i = 0; i < warmup + iterations; i++) {
    const start = performance.now()
    const residue = V1CurrentResidue.lower(source)
    const middle = performance.now()
    const wire = V1CurrentResidue.toWire(residue)
    const parsed = JSON.parse(JSON.stringify(wire)) as typeof wire
    const restored = V1CurrentResidue.restore(V1CurrentResidue.fromWire(parsed))
    if (restored.parts.length !== source.parts.length) throw new Error("Unexpected V1 roundtrip")
    const end = performance.now()
    wireBytes = Buffer.byteLength(JSON.stringify(wire))
    if (i < warmup) continue
    lowerMs.push(middle - start)
    wireMs.push(end - middle)
  }
  const p50 = quantile(lowerMs, .5)
  console.log(JSON.stringify({
    payloadBytes, iterations, originalBytes, wireBytes,
    wireToOriginalRatio: Number((wireBytes / originalBytes).toFixed(4)),
    lowerP50Ms: Number(p50.toFixed(3)),
    lowerP95Ms: Number(quantile(lowerMs, .95).toFixed(3)),
    encodeRestoreP50Ms: Number(quantile(wireMs, .5).toFixed(3)),
    lowerMiBPerSec: Number(((payloadBytes / 1048576) / (p50 / 1000)).toFixed(1)),
  }))
}
