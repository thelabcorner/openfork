/**
 * Compare former multi-pass V1 ledger entry derivation with current fused scan.
 * In-process synthetic data only; never touches the user's SQLite runtime.
 * bun script/benchmark-context-ledger.ts 10000
 */
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import type { WithParts } from "@opencode-ai/schema/session-v1"
import { buildWithRows, estimateMessageTokens } from "../src/session/context/ledger"

const count = Math.max(100, Math.min(100_000, Number(process.argv[2] ?? 10000) || 10000))
const messages: WithParts[] = Array.from({ length: count }, (_, i) => ({
  info: { id: `msg_bench_${i}`, role: i % 3 === 0 ? "user" : "assistant", time: { created: i } },
  parts: [
    { id: `prt_${i}_0`, type: "text", text: "A".repeat(40 + i % 128) },
    { id: `prt_${i}_1`, type: "reasoning", text: "r".repeat(24 + i % 43) },
    { id: `prt_${i}_2`, type: "tool", tool: "read", state: { status: "completed", output: "o".repeat(280 + i % 300) } },
    { id: `prt_${i}_3`, type: "file" },
    { id: `prt_${i}_4`, type: "text", text: "finish" },
  ],
}) as unknown as WithParts)
const sessionID = "ses_context_ledger_perf"
const legacy = () => {
  const entries = messages.map((msg) => {
    const firstText = msg.parts.find((p) => p.type === "text")
    const tool = msg.parts.find((p) => p.type === "tool")
    const compaction = msg.parts.some((p) => p.type === "compaction")
    const reasoning = msg.parts.some((p) => p.type === "reasoning")
    const preview = firstText && firstText.type === "text" && firstText.text
      ? firstText.text.slice(0, 120)
      : tool && tool.type === "tool" ? `[tool: ${tool.tool}]`
      : compaction ? "[compaction]" : reasoning ? "[reasoning]" : `[${msg.info.role}]`
    const type = compaction ? "compaction" : tool ? "tool" : msg.info.role === "assistant" ? "assistant"
      : SessionTurnProvenance.semanticKind(msg)
    const signed = msg.parts.some((p) => p.type === "reasoning" && (p as any).metadata?.anthropic?.signature != null)
    return { messageID: msg.info.id, type, preview, signed, tokenEstimate: estimateMessageTokens(msg) }
  })
  return entries
}
const current = () => buildWithRows({ sessionID, messages }, [])
const oldEntries = legacy()
const newEntries = current().entries
if (oldEntries.length !== newEntries.length) throw Error("Length mismatch")
for (let i = 0; i < oldEntries.length; i++) {
  const a = oldEntries[i]!, b = newEntries[i]!
  if (a.messageID !== b.messageID || a.type !== b.type || a.preview !== b.preview ||
      a.signed !== b.hasSignedReasoning || a.tokenEstimate !== b.tokenEstimate) {
    throw new Error(`Ledger projection drift at ${i}`)
  }
}

const values = { legacy: [] as number[], fused: [] as number[] }
for (let iteration = 0; iteration < 9; iteration++) {
  for (const mode of iteration % 2 ? ["fused", "legacy"] as const : ["legacy", "fused"] as const) {
    const start = performance.now()
    const result = mode === "legacy" ? legacy() : current().entries
    if (result.length !== count) throw Error("Missing entries")
    values[mode].push(performance.now() - start)
  }
}
const median = (arr: number[]) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)]!
const before = median(values.legacy)
const after = median(values.fused)
console.log(JSON.stringify({
  messages: count,
  partsPerMessage: 5,
  oldMedianMs: Number(before.toFixed(3)),
  fusedMedianMs: Number(after.toFixed(3)),
  speedup: Number((before / after).toFixed(2)),
  samples: values,
}, null, 2))
