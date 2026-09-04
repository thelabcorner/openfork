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
  const { db } = yield* Database.Service
  const events = yield* EventV2Bridge.Service
  const now = Date.now()
  const batchID = `ctx_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  // Persist ops log
  yield* db
    .insert(SessionContextOpsTable)
    .values({
      id: `ctxops_${batchID}`,
      session_id: input.sessionID,
      batch_id: batchID,
      operations: input.operations as unknown[],
      timestamp: now,
    })
    .run()
    .pipe(Effect.orDie)

  // Apply each op to state table
  for (const op of input.operations) {
    switch (op.type) {
      case "message.exclude": {
        yield* db
          .insert(SessionContextStateTable)
          .values({
            session_id: input.sessionID,
            message_id: op.messageID,
            excluded: true,
            pinned: false,
            modified_at: now,
          })
          .onConflictDoUpdate({
            target: [SessionContextStateTable.session_id, SessionContextStateTable.message_id],
            set: { excluded: true, modified_at: now },
          })
          .run()
          .pipe(Effect.orDie)
        break
      }
      case "message.include": {
        yield* db
          .insert(SessionContextStateTable)
          .values({
            session_id: input.sessionID,
            message_id: op.messageID,
            excluded: false,
            pinned: false,
            modified_at: now,
          })
          .onConflictDoUpdate({
            target: [SessionContextStateTable.session_id, SessionContextStateTable.message_id],
            set: { excluded: false, modified_at: now },
          })
          .run()
          .pipe(Effect.orDie)
        break
      }
      case "message.pin": {
        yield* db
          .insert(SessionContextStateTable)
          .values({
            session_id: input.sessionID,
            message_id: op.messageID,
            excluded: false,
            pinned: true,
            modified_at: now,
          })
          .onConflictDoUpdate({
            target: [SessionContextStateTable.session_id, SessionContextStateTable.message_id],
            set: { pinned: true, modified_at: now },
          })
          .run()
          .pipe(Effect.orDie)
        break
      }
      case "message.unpin": {
        yield* db
          .insert(SessionContextStateTable)
          .values({
            session_id: input.sessionID,
            message_id: op.messageID,
            excluded: false,
            pinned: false,
            modified_at: now,
          })
          .onConflictDoUpdate({
            target: [SessionContextStateTable.session_id, SessionContextStateTable.message_id],
            set: { pinned: false, modified_at: now },
          })
          .run()
          .pipe(Effect.orDie)
        break
      }
      case "text.replace": {
        const override = { text: op.content, editedAt: now, ...(op.partID ? { partID: op.partID } : {}) }
        yield* db
          .insert(SessionContextStateTable)
          .values({
            session_id: input.sessionID,
            message_id: op.messageID,
            excluded: false,
            pinned: false,
            override_data: override as Record<string, unknown>,
            override_search_text: op.content,
            modified_at: now,
          })
          .onConflictDoUpdate({
            target: [SessionContextStateTable.session_id, SessionContextStateTable.message_id],
            set: { override_data: override as Record<string, unknown>, override_search_text: op.content, modified_at: now },
          })
          .run()
          .pipe(Effect.orDie)
        break
      }
      case "text.restore": {
        // Clear override — restore original
        const existing = yield* db
          .select()
          .from(SessionContextStateTable)
          .where(
            and(
              eq(SessionContextStateTable.session_id, input.sessionID),
              eq(SessionContextStateTable.message_id, op.messageID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (existing) {
          yield* db
            .update(SessionContextStateTable)
            .set({ override_data: null, override_search_text: null, modified_at: now })
            .where(
              and(
                eq(SessionContextStateTable.session_id, input.sessionID),
                eq(SessionContextStateTable.message_id, op.messageID),
              ),
            )
            .run()
            .pipe(Effect.orDie)
        }
        break
      }
      case "tool.collapse": {
        // Mark tool output as collapsed — compiler will replace with stub
        const override = { collapsed: true, partID: op.partID, collapsedAt: now }
        yield* db
          .insert(SessionContextStateTable)
          .values({
            session_id: input.sessionID,
            message_id: op.messageID,
            excluded: false,
            pinned: false,
            override_data: override as Record<string, unknown>,
            modified_at: now,
          })
          .onConflictDoUpdate({
            target: [SessionContextStateTable.session_id, SessionContextStateTable.message_id],
            set: {
              // Merge: preserve existing override_data if it's a text edit, otherwise replace
              override_data: override as Record<string, unknown>,
              modified_at: now,
            },
          })
          .run()
          .pipe(Effect.orDie)
        break
      }
      case "tool.restore": {
        const existing = yield* db
          .select()
          .from(SessionContextStateTable)
          .where(
            and(
              eq(SessionContextStateTable.session_id, input.sessionID),
              eq(SessionContextStateTable.message_id, op.messageID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (existing?.override_data && (existing.override_data as any).collapsed) {
          yield* db
            .update(SessionContextStateTable)
            .set({ override_data: null, modified_at: now })
            .where(
              and(
                eq(SessionContextStateTable.session_id, input.sessionID),
                eq(SessionContextStateTable.message_id, op.messageID),
              ),
            )
            .run()
            .pipe(Effect.orDie)
        }
        break
      }
    }
  }

  // Emit durable event for cross-client sync and audit trail
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
  const { db } = yield* Database.Service
  const events = yield* EventV2Bridge.Service
  const now = Date.now()
  yield* db
    .insert(SessionForkOriginTable)
    .values({
      // The core table brands with `SessionSchema.ID`; the local `SessionID`
      // is a sibling declaration, so cast at the boundary.
      session_id: input.sessionID as any,
      parent_session_id: input.parentSessionID as any,
      source_message_id: input.sourceMessageID as any,
      edge: input.edge,
      kind: input.kind,
      workspace_mode: input.workspaceMode,
      created_at: now,
    })
    .run()
    .pipe(Effect.orDie)
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
