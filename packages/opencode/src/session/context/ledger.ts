export * as SessionLedger from "./ledger"

import { Effect } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { WithParts } from "@opencode-ai/schema/session-v1"
import { SessionContext } from "@opencode-ai/schema/session-context"
import { Database } from "@opencode-ai/core/database/database"
import { SessionContextStateTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { estimateTokens } from "./state"

function previewForMessage(msg: WithParts): string {
  const firstText = msg.parts.find((p) => p.type === "text") as SessionV1.TextPart | undefined
  if (firstText?.text) return firstText.text.slice(0, 120)
  const tool = msg.parts.find((p) => p.type === "tool") as SessionV1.ToolPart | undefined
  if (tool) return `[tool: ${tool.tool}]`
  if (msg.parts.some((p) => p.type === "compaction")) return "[compaction]"
  if (msg.parts.some((p) => p.type === "reasoning")) return "[reasoning]"
  return `[${msg.info.role}]`
}

function typeForMessage(msg: WithParts): SessionContext.LedgerEntryType {
  if (msg.parts.some((p) => p.type === "compaction")) return "compaction"
  if (msg.parts.some((p) => p.type === "tool")) return "tool"
  if (msg.info.role === "user") return "user"
  if (msg.info.role === "assistant") return "assistant"
  return "system"
}

function estimateMessageTokens(msg: WithParts): number {
  let total = 0
  for (const p of msg.parts) {
    if (p.type === "text") total += estimateTokens((p as SessionV1.TextPart).text)
    if (p.type === "reasoning") total += estimateTokens((p as SessionV1.ReasoningPart).text)
    if (p.type === "tool") {
      const tp = p as SessionV1.ToolPart
      if (tp.state.status === "completed") total += estimateTokens(tp.state.output)
      else if (tp.state.status === "error") total += estimateTokens(tp.state.error)
    }
    if (p.type === "file") total += 200 // rough
  }
  // Add overhead for role framing
  return total + 4
}

export const build = Effect.fn("SessionLedger.build")(function* (input: {
  sessionID: string
  messages: WithParts[]
}) {
  const { db } = yield* Database.Service
  const stateRows = yield* db
    .select()
    .from(SessionContextStateTable)
    .where(eq(SessionContextStateTable.session_id, input.sessionID as any))
    .all()
    .pipe(Effect.orDie)

  const stateMap = new Map(stateRows.map((r) => [r.message_id, r]))

  const entries: SessionContext.LedgerEntry[] = input.messages.map((msg) => {
    const s = stateMap.get(msg.info.id)
    const hasSignedReasoning = msg.parts.some(
      (p) => p.type === "reasoning" && (p as any).metadata?.anthropic?.signature != null,
    )
    return {
      messageID: msg.info.id as any,
      type: typeForMessage(msg),
      role: msg.info.role,
      preview: previewForMessage(msg),
      tokenEstimate: estimateMessageTokens(msg),
      excluded: s?.excluded ?? false,
      pinned: s?.pinned ?? false,
      edited: !!s?.override_data,
      hasSignedReasoning,
      partCount: msg.parts.length,
      timeCreated: msg.info.time.created,
    }
  })

  const excludedCount = entries.filter((e) => e.excluded).length
  const pinnedCount = entries.filter((e) => e.pinned).length
  const editedCount = entries.filter((e) => e.edited).length
  const estimatedTokens = entries.filter((e) => !e.excluded).reduce((sum, e) => sum + e.tokenEstimate, 0)
  const estimatedTokensExcluded = entries.filter((e) => e.excluded).reduce((sum, e) => sum + e.tokenEstimate, 0)

  const ledger: SessionContext.Ledger = {
    sessionID: input.sessionID as any,
    entries,
    totals: {
      messageCount: entries.length,
      excludedCount,
      pinnedCount,
      editedCount,
      estimatedTokens,
      estimatedTokensExcluded,
    },
  }

  return ledger
})
