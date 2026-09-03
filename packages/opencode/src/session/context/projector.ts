import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionContext } from "@opencode-ai/schema/session-context"
import { SessionContextStateTable, SessionContextOpsTable, SessionForkOriginTable } from "@opencode-ai/core/session/sql"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"

/**
 * Fork-owned projector: hydrates overlay tables from durable events for replay correctness.
 * Direct writes via SessionContextState.applyOps already insert rows and publish events;
 * this projector ensures that replaying the event log alone reconstructs the same state.
 *
 * Idempotent: onConflictDoNothing / onConflictDoUpdate so re-projection is safe.
 */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service

    yield* events.project(SessionContext.ContextOpsApplied, (event) =>
      Effect.gen(function* () {
        const { sessionID, batchID, operations, timestamp } = event.data as any
        // Ops log — idempotent
        yield* db
          .insert(SessionContextOpsTable)
          .values({
            id: `ctxops_${batchID}`,
            session_id: sessionID,
            batch_id: batchID,
            operations: operations as unknown[],
            timestamp,
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)

        // State overlay — replay each op idempotently
        for (const op of operations as any[]) {
          switch (op.type) {
            case "message.exclude":
              yield* db
                .insert(SessionContextStateTable)
                .values({ session_id: sessionID, message_id: op.messageID, excluded: true, pinned: false, modified_at: timestamp })
                .onConflictDoUpdate({
                  target: [SessionContextStateTable.session_id, SessionContextStateTable.message_id],
                  set: { excluded: true, modified_at: timestamp },
                })
                .run()
                .pipe(Effect.orDie)
              break
            case "message.include":
              yield* db
                .insert(SessionContextStateTable)
                .values({ session_id: sessionID, message_id: op.messageID, excluded: false, pinned: false, modified_at: timestamp })
                .onConflictDoUpdate({
                  target: [SessionContextStateTable.session_id, SessionContextStateTable.message_id],
                  set: { excluded: false, modified_at: timestamp },
                })
                .run()
                .pipe(Effect.orDie)
              break
            case "message.pin":
              yield* db
                .insert(SessionContextStateTable)
                .values({ session_id: sessionID, message_id: op.messageID, excluded: false, pinned: true, modified_at: timestamp })
                .onConflictDoUpdate({
                  target: [SessionContextStateTable.session_id, SessionContextStateTable.message_id],
                  set: { pinned: true, modified_at: timestamp },
                })
                .run()
                .pipe(Effect.orDie)
              break
            case "message.unpin":
              yield* db
                .insert(SessionContextStateTable)
                .values({ session_id: sessionID, message_id: op.messageID, excluded: false, pinned: false, modified_at: timestamp })
                .onConflictDoUpdate({
                  target: [SessionContextStateTable.session_id, SessionContextStateTable.message_id],
                  set: { pinned: false, modified_at: timestamp },
                })
                .run()
                .pipe(Effect.orDie)
              break
            case "text.replace":
              yield* db
                .insert(SessionContextStateTable)
                .values({
                  session_id: sessionID,
                  message_id: op.messageID,
                  excluded: false,
                  pinned: false,
                  override_data: { text: op.content, editedAt: timestamp, ...(op.partID ? { partID: op.partID } : {}) } as any,
                  override_search_text: op.content,
                  modified_at: timestamp,
                })
                .onConflictDoUpdate({
                  target: [SessionContextStateTable.session_id, SessionContextStateTable.message_id],
                  set: {
                    override_data: { text: op.content, editedAt: timestamp, ...(op.partID ? { partID: op.partID } : {}) } as any,
                    override_search_text: op.content,
                    modified_at: timestamp,
                  },
                })
                .run()
                .pipe(Effect.orDie)
              break
            case "text.restore": {
              const { eq, and } = yield* Effect.promise(() => import("drizzle-orm"))
              yield* (db as any)
                .update(SessionContextStateTable)
                .set({ override_data: null, override_search_text: null, modified_at: timestamp })
                .where(and(eq(SessionContextStateTable.session_id, sessionID), eq(SessionContextStateTable.message_id, op.messageID)))
                .run()
                .pipe(Effect.catch(() => Effect.void))
              break
            }
            default:
              break
          }
        }
      }),
    )

    yield* events.project(SessionContext.ForkCreated, (event) =>
      Effect.gen(function* () {
        const { sessionID, parentSessionID, sourceMessageID, edge, kind, workspaceMode, createdAt } = event.data as any
        yield* db
          .insert(SessionForkOriginTable)
          .values({
            session_id: sessionID,
            parent_session_id: parentSessionID,
            source_message_id: sourceMessageID,
            edge,
            kind,
            workspace_mode: workspaceMode,
            created_at: createdAt,
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      }),
    )
  }),
)

export const node = makeGlobalNode({ name: "session-context-projector", layer, deps: [EventV2.node, Database.node] })
