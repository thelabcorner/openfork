export * as SessionLedger from "./ledger"

import { DateTime, Effect } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionMessage as CurrentSessionMessage } from "@opencode-ai/core/session/message"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
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
  if (msg.info.role === "user") {
    const kind = SessionTurnProvenance.semanticKind(msg)
    if (kind === "shell") return "shell"
    if (kind === "synthetic") return "synthetic"
    if (kind === "compaction") return "compaction"
    return "user"
  }
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
    // Historical invalid overlays may still exist in old databases. STATE is
    // authoritative domain projection, so those rows must not affect the
    // effective ledger or any totals derived from it.
    const s = SessionTurnProvenance.hasStateSemanticsTurn(msg) ? undefined : stateMap.get(msg.info.id)
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

function previewForCurrentMessage(msg: CurrentSessionMessage.Message): string {
  if (msg.type === "user" || msg.type === "synthetic") return msg.text.slice(0, 120) || `[${msg.type}]`
  if (msg.type !== "assistant") return `[${msg.type}]`
  for (const part of msg.content) {
    if ((part.type === "text" || part.type === "reasoning") && part.text.trim()) return part.text.slice(0, 120)
    if (part.type === "tool") return `[tool: ${part.name}]`
  }
  return "[assistant]"
}

function estimateCurrentMessageTokens(msg: CurrentSessionMessage.Message): number {
  let total = 4
  if (msg.type === "user" || msg.type === "synthetic") {
    total += estimateTokens(msg.text)
    total += (msg.files?.length ?? 0) * 200
    return total
  }
  if (msg.type !== "assistant") return total
  for (const part of msg.content) {
    if (part.type === "text" || part.type === "reasoning") total += estimateTokens(part.text)
    if (part.type === "tool") {
      total += estimateTokens(JSON.stringify(part.state.input ?? {}))
      if (part.state.status === "completed") {
        for (const item of part.state.content) if (item.type === "text") total += estimateTokens(item.text)
      } else if (part.state.status === "error") {
        total += estimateTokens(part.state.error.message)
      }
    }
  }
  return total
}

/**
 * Read-only ledger for authoritative current/V2 transcripts.
 *
 * Special-agent sessions are host-owned and can be assistant-only. Lowering
 * them through V1 conversation pairing drops such assistants because V1
 * requires a user parent. This projection intentionally stays in current
 * semantics and never consults mutable context overlays.
 */
export const buildCurrentReadOnly = Effect.fn("SessionLedger.buildCurrentReadOnly")(function* (input: {
  sessionID: string
  messages: readonly CurrentSessionMessage.Message[]
}) {
  const entries: SessionContext.LedgerEntry[] = input.messages.flatMap((msg) => {
    if (msg.type !== "user" && msg.type !== "synthetic" && msg.type !== "assistant") return []
    const hasSignedReasoning =
      msg.type === "assistant" &&
      msg.content.some(
        (part) => part.type === "reasoning" && (part.providerMetadata as any)?.anthropic?.signature != null,
      )
    const type: SessionContext.LedgerEntryType =
      msg.type === "assistant"
        ? msg.content.some((part) => part.type === "tool")
          ? "tool"
          : "assistant"
        : msg.type === "synthetic"
          ? "synthetic"
          : "user"
    return [{
      messageID: msg.id as any,
      type,
      role: msg.type === "assistant" ? "assistant" : "user",
      preview: previewForCurrentMessage(msg),
      tokenEstimate: estimateCurrentMessageTokens(msg),
      excluded: false,
      pinned: false,
      edited: false,
      hasSignedReasoning,
      partCount:
        msg.type === "assistant"
          ? msg.content.length
          : (msg.text.trim() ? 1 : 0) + (msg.files?.length ?? 0),
      timeCreated: DateTime.toEpochMillis(msg.time.created),
    }]
  })

  const estimatedTokens = entries.reduce((sum, entry) => sum + entry.tokenEstimate, 0)
  return {
    sessionID: input.sessionID as any,
    entries,
    totals: {
      messageCount: entries.length,
      excludedCount: 0,
      pinnedCount: 0,
      editedCount: 0,
      estimatedTokens,
      estimatedTokensExcluded: 0,
    },
  } satisfies SessionContext.Ledger
})
