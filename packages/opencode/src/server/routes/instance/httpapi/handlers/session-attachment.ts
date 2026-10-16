import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionAttachment } from "@opencode-ai/core/session/attachment"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { SessionAttachmentApi } from "../groups/session-attachment"
import { ApiNotFoundError } from "../errors"
import type { SessionID } from "@/session/schema"

/**
 * Tier 1 handler. The durable attachment index is answered from SQLite session
 * metadata only; it does not cross `InstanceContextMiddleware`.
 */
export const sessionAttachmentHandlers = HttpApiBuilder.group(
  SessionAttachmentApi,
  "sessionAttachment",
  (handlers) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service

      const requireSession = Effect.fn("SessionAttachmentHttpApi.requireSession")(function* (sessionID: SessionID) {
        const found = yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!found)
          return yield* new ApiNotFoundError({
            name: "NotFoundError",
            data: { message: `Session not found: ${sessionID}` },
          })
      })

      return handlers
        .handle("index", (ctx) =>
          Effect.gen(function* () {
            const sessionID = ctx.params.sessionID
            yield* requireSession(sessionID)
            return yield* SessionAttachment.indexPage(db, {
              sessionID,
              ...(ctx.query.cursor ? { cursor: ctx.query.cursor } : {}),
              ...(ctx.query.limit ? { limit: ctx.query.limit } : {}),
            })
          }),
        )
        .handle("status", (ctx) =>
          Effect.gen(function* () {
            const sessionID = ctx.params.sessionID
            yield* requireSession(sessionID)
            const statuses = yield* SessionAttachment.recipientStatuses(db, sessionID)
            return { sessionID, statuses }
          }),
        )
    }),
)
