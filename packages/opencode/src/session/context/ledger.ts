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

function typeForMessage(msg: WithParts, hasCompaction: boolean, hasTool: boolean): SessionContext.LedgerEntryType {
  if (hasCompaction) return "compaction"
  if (hasTool) return "tool"
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

/** Shared approximate token unit for the ledger and effective-context preview. */
export function estimateMessageTokens(msg: WithParts): number {
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
  // Ledger inspection must not queue behind provider/session writers. Read
  // committed context overlays through the WAL reader (aliases db for :memory:).
  const { readDb } = yield* Database.Service
  const stateRows = yield* readDb
    .select({
      message_id: SessionContextStateTable.message_id,
      excluded: SessionContextStateTable.excluded,
      pinned: SessionContextStateTable.pinned,
      override_data: SessionContextStateTable.override_data,
    })
    .from(SessionContextStateTable)
    .where(eq(SessionContextStateTable.session_id, input.sessionID as any))
    .all()
    .pipe(Effect.orDie)
  return buildWithRows(input, stateRows)
})

export type LedgerOverlayRow = Pick<
  typeof SessionContextStateTable.$inferSelect,
  "message_id" | "excluded" | "pinned" | "override_data"
>

/** Scalar part facts emitted by the canonical V1 event projector (version 1). */
export type LedgerPartFact = {
  tokens: number
  signed: boolean
}

/** Pure ledger projection; callers can share one transaction with history. */
export function buildWithRows(
  input: { sessionID: string; messages: WithParts[] },
  stateRows: readonly LedgerOverlayRow[],
  partFacts?: ReadonlyMap<string, LedgerPartFact>,
): SessionContext.Ledger {
  const stateMap = new Map(stateRows.map((r) => [r.message_id, r]))

  const entries: SessionContext.LedgerEntry[] = input.messages.map((msg) => {
    // One linear walk yields all part-derived facts: preview, signed-reasoning
    // guard, semantic type, token estimate and edit-target eligibility. The
    // earlier implementation repeatedly rescanned every part for each fact.
    let tokenEstimate = 4
    let firstText: string | undefined
    let firstTool: string | undefined
    let hasCompaction = false
    let hasReasoning = false
    let hasSignedReasoning = false
    const raw = stateMap.get(msg.info.id)
    const override = raw?.override_data as Record<string, unknown> | null | undefined
    const targetPartID = typeof override?.partID === "string" ? override.partID : undefined
    let hasEditTarget = false
    let hasCollapseTarget = false
    for (const p of msg.parts) {
      const fact = partFacts?.get(p.id)
      if (p.type === "text") {
        if (firstText === undefined) firstText = p.text
        tokenEstimate += fact ? fact.tokens : estimateTokens(p.text)
        if (!targetPartID || targetPartID === p.id) hasEditTarget = true
      } else if (p.type === "reasoning") {
        hasReasoning = true
        hasSignedReasoning ||= fact ? fact.signed : (p as any).metadata?.anthropic?.signature != null
        tokenEstimate += fact ? fact.tokens : estimateTokens(p.text)
        if (!targetPartID || targetPartID === p.id) hasEditTarget = true
      } else if (p.type === "tool") {
        if (firstTool === undefined) firstTool = p.tool
        if (p.state.status === "completed") {
          tokenEstimate += fact ? fact.tokens : estimateTokens(p.state.output)
          if (targetPartID === p.id) hasCollapseTarget = true
        } else if (p.state.status === "error") tokenEstimate += fact ? fact.tokens : estimateTokens(p.state.error)
      } else if (p.type === "compaction") hasCompaction = true
      else if (p.type === "file") tokenEstimate += fact ? fact.tokens : 200
    }
    // Authoritative host STATE projections and signed reasoning ignore
    // historical invalid overlays. Pinned always overrides excluded; never
    // present an effectively included message as removed or count it in the
    // excluded-token total.
    const s = raw && !SessionTurnProvenance.hasStateSemanticsTurn(msg) ? raw : undefined
    const excluded = !!s?.excluded && !s?.pinned && !hasSignedReasoning
    const edited = !excluded && !!s?.override_data && (
      (override?.text != null && !hasSignedReasoning && hasEditTarget) ||
      (override?.collapsed === true && hasCollapseTarget)
    )
    const preview = firstText
      ? firstText.slice(0, 120)
      : firstTool !== undefined
        ? `[tool: ${firstTool}]`
        : hasCompaction ? "[compaction]" : hasReasoning ? "[reasoning]" : `[${msg.info.role}]`
    return {
      messageID: msg.info.id as any,
      type: typeForMessage(msg, hasCompaction, firstTool !== undefined),
      role: msg.info.role,
      preview,
      tokenEstimate,
      excluded,
      pinned: s?.pinned ?? false,
      edited,
      hasSignedReasoning,
      partCount: msg.parts.length,
      timeCreated: msg.info.time.created,
    }
  })

  // One linear traversal with no temporary filter arrays. A large actionable
  // ledger is already O(messages); avoid repeatedly allocating copies of
  // every included/excluded row solely to derive five scalar totals.
  let excludedCount = 0
  let pinnedCount = 0
  let editedCount = 0
  let estimatedTokens = 0
  let estimatedTokensExcluded = 0
  for (const entry of entries) {
    if (entry.excluded) {
      excludedCount++
      estimatedTokensExcluded += entry.tokenEstimate
    } else {
      estimatedTokens += entry.tokenEstimate
    }
    if (entry.pinned) pinnedCount++
    if (entry.edited) editedCount++
  }

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
}

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
