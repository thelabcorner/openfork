export * as SessionContextState from "./state"

import { and, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionContextStateTable, SessionContextOpsTable, SessionForkOriginTable } from "@opencode-ai/core/session/sql"
import { SessionContext } from "@opencode-ai/schema/session-context"
import { SessionID } from "../schema"
import type { MessageID } from "../schema"
import { EventV2Bridge } from "@/event-v2-bridge"

type MessageStateRow = typeof SessionContextStateTable.$inferSelect

function fromRow(row: MessageStateRow) {
  return {
    sessionID: row.session_id,
    messageID: row.message_id,
    excluded: row.excluded,
    pinned: row.pinned,
    overrideData: row.override_data ?? undefined,
    overrideSearchText: row.override_search_text ?? undefined,
    modifiedSeq: row.modified_seq ?? undefined,
    modifiedAt: row.modified_at,
  }
}

// Simple token estimator: ~4 chars per token, clamped.
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

export function searchTextForOverride(data: Record<string, unknown>): string {
  // Extract searchable text from override_data (mirrors partSearchText/message search)
  const parts: string[] = []
  if (typeof data["text"] === "string") parts.push(data["text"] as string)
  if (typeof (data as any).parts === "object" && Array.isArray((data as any).parts)) {
    for (const p of (data as any).parts as any[]) {
      if (p.type === "text" && typeof p.text === "string") parts.push(p.text)
      if (p.type === "tool" && p.state?.output) parts.push(String(p.state.output))
      if (p.type === "reasoning" && typeof p.text === "string") parts.push(p.text)
    }
  }
  return parts.join("\n")
}

export const getState = Effect.fn("SessionContextState.getState")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(SessionContextStateTable)
    .where(eq(SessionContextStateTable.session_id, sessionID))
    .all()
    .pipe(Effect.orDie)
  return new Map(rows.map((r) => [r.message_id, fromRow(r)]))
})

export const getMessageState = Effect.fn("SessionContextState.getMessageState")(function* (
  sessionID: SessionID,
  messageID: MessageID,
) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select()
    .from(SessionContextStateTable)
    .where(and(eq(SessionContextStateTable.session_id, sessionID), eq(SessionContextStateTable.message_id, messageID)))
    .get()
    .pipe(Effect.orDie)
  return row ? fromRow(row) : undefined
})

export const isExcluded = Effect.fn("SessionContextState.isExcluded")(function* (
  sessionID: SessionID,
  messageID: string,
) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select()
    .from(SessionContextStateTable)
    .where(and(eq(SessionContextStateTable.session_id, sessionID), eq(SessionContextStateTable.message_id, messageID as MessageID)))
    .get()
    .pipe(Effect.orDie)
  return row?.excluded ?? false
})

export const applyOps = Effect.fn("SessionContextState.applyOps")(function* (input: {
  sessionID: SessionID
  operations: SessionContext.ContextOperation[]
}) {
  const events = yield* EventV2Bridge.Service
  const now = Date.now()
  const batchID = `ctx_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  // The durable projector is the single authoritative writer for the op log
  // and context overlay. EventV2 executes projectors inline in the same
  // transaction as the event append, so pre-writing these rows here only
  // doubles global SQLite writer work and makes the live path differ from
  // replay. Publish once and project once.
  yield* events.publish(SessionContext.ContextOpsApplied, {
    sessionID: input.sessionID,
    batchID,
    operations: input.operations as any,
    timestamp: now,
  })

  return { batchID, timestamp: now }
})

export const getOpsHistory = Effect.fn("SessionContextState.getOpsHistory")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(SessionContextOpsTable)
    .where(eq(SessionContextOpsTable.session_id, sessionID))
    .orderBy(SessionContextOpsTable.timestamp)
    .all()
    .pipe(Effect.orDie)
  return rows.map((r) => ({
    id: r.id,
    batchID: r.batch_id,
    operations: r.operations,
    timestamp: r.timestamp,
  }))
})

export const getForkOrigin = Effect.fn("SessionContextState.getForkOrigin")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select()
    .from(SessionForkOriginTable)
    .where(eq(SessionForkOriginTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return row
    ? {
        sessionID: row.session_id,
        parentSessionID: row.parent_session_id,
        sourceMessageID: row.source_message_id ?? undefined,
        sourceSeq: row.source_seq ?? undefined,
        edge: row.edge ?? undefined,
        kind: row.kind,
        workspaceMode: row.workspace_mode,
        createdAt: row.created_at,
      }
    : undefined
})

export const setForkOrigin = Effect.fn("SessionContextState.setForkOrigin")(function* (input: {
  sessionID: SessionID
  parentSessionID: SessionID
  sourceMessageID?: string
  edge?: "before" | "after"
  kind: SessionContext.ForkOriginKind
  workspaceMode: SessionContext.WorkspaceMode
}) {
  const events = yield* EventV2Bridge.Service
  const now = Date.now()
  yield* events.publish(SessionContext.ForkCreated, {
    sessionID: input.sessionID,
    parentSessionID: input.parentSessionID,
    sourceMessageID: input.sourceMessageID,
    edge: input.edge,
    kind: input.kind,
    workspaceMode: input.workspaceMode,
    createdAt: now,
  })
})
