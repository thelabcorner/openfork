/**
 * Explicit-compilation Context preview benchmark.
 * Compare the former map-based projection to the ordered, O(1)-auxiliary-space
 * merge. Synthetic pure data only; no SQLite or live Session process.
 *
 * bun script/benchmark-context-preview.ts 50000
 */
import { projectContextPreview } from "../src/session/context/preview"
import type { WithParts } from "@opencode-ai/schema/session-v1"
import type { SessionContext } from "@opencode-ai/schema/session-context"

const count = Math.max(100, Math.min(250000, Number(process.argv[2] ?? 50000) || 50000))
const messages = Array.from({ length: count }, (_, i) => ({
  info: { id: `msg_preview_perf_${i}`, role: "user", time: { created: i } },
  parts: [{ id: `prt_perf_${i}`, type: "text", text: "old content" }],
})) as unknown as WithParts[]
const estimatedPerMessage = 7
const entries = messages.map((msg, index) => ({
  messageID: msg.info.id,
  type: "user", role: msg.info.role, preview: "old content",
  tokenEstimate: estimatedPerMessage,
  excluded: index % 23 === 0,
  pinned: index % 73 === 0,
  edited: index % 13 === 0,
  hasSignedReasoning: false, partCount: 1, timeCreated: index,
})) as SessionContext.Ledger["entries"]
const excluded = messages.filter((_, index) => index % 23 === 0)
const effective = messages.filter((_, index) => index % 23 !== 0)
const ledger = {
  sessionID: "ses_preview_benchmark",
  entries,
  totals: {
    messageCount: count, excludedCount: excluded.length,
    pinnedCount: entries.filter((x) => x.pinned).length,
    editedCount: entries.filter((x) => x.edited).length,
    estimatedTokens: effective.length * estimatedPerMessage,
    estimatedTokensExcluded: excluded.length * estimatedPerMessage,
  },
} as SessionContext.Ledger
const compiled = { effective, excluded }
const old = () => {
  const indexed = new Map(ledger.entries.map((entry) => [entry.messageID, entry] as const))
  const originals = new Map(messages.map((msg) => [msg.info.id, msg] as const))
  const beforeTokens = ledger.totals.estimatedTokens + ledger.totals.estimatedTokensExcluded
  let afterTokens = 0
  for (const msg of compiled.effective) {
    const entry = indexed.get(msg.info.id)!
    afterTokens += originals.get(msg.info.id) === msg ? entry.tokenEstimate : 0
  }
  let removedTokens = 0
  for (const msg of compiled.excluded) removedTokens += indexed.get(msg.info.id)!.tokenEstimate
  let earliestMutationIndex: number | undefined
  for (let i = 0; i < messages.length; i++) {
    const e = indexed.get(messages[i]!.info.id)!
    if (e.excluded || e.pinned || e.edited) { earliestMutationIndex = i; break }
  }
  return { beforeTokens, afterTokens, removedTokens, messageCount: messages.length,
    effectiveCount: compiled.effective.length, earliestMutationIndex }
}
const newer = () => projectContextPreview({ messages, ledger, compiled })
const expected = old()
if (JSON.stringify(expected) !== JSON.stringify(newer())) throw Error("Preview mismatch")
const runs = { mapBased: [] as number[], orderedMerge: [] as number[] }
for (let i = 0; i < 11; i++) {
  for (const mode of i % 2 ? ["orderedMerge", "mapBased"] as const : ["mapBased", "orderedMerge"] as const) {
    const start = performance.now()
    if (mode === "mapBased") old()
    else newer()
    runs[mode].push(performance.now() - start)
  }
}
const median = (numbers: number[]) => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)]!
const before = median(runs.mapBased), after = median(runs.orderedMerge)
console.log(JSON.stringify({
  messages: count, beforeMedianMs: Number(before.toFixed(3)),
  orderedMedianMs: Number(after.toFixed(3)),
  speedup: Number((before / after).toFixed(2)),
  extraHistorySizedMaps: { previous: 2, current: 0 },
  samples: runs,
}, null, 2))
