import { eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionLimitRecovery as Recovery } from "@opencode-ai/core/session/limit-recovery"
import { SessionLimitRecovery as Contract } from "@opencode-ai/schema/session-limit-recovery"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionLimitRecoveryApi } from "../groups/session-limit-recovery"
import { ApiNotFoundError, ConflictError } from "../errors"
import { SessionID } from "@/session/schema"
import { SessionPrompt } from "@/session/prompt"

export const sessionLimitRecoveryHandlers = HttpApiBuilder.group(
  SessionLimitRecoveryApi,
  "sessionLimitRecovery",
  (handlers) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2Bridge.Service
      const prompt = yield* SessionPrompt.Service

      const requireSession = Effect.fn("SessionLimitRecoveryHttpApi.requireSession")(function* (sessionID: SessionID) {
        const found = yield* db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
        if (!found) return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: `Session not found: ${sessionID}` } })
      })

      const current = Effect.fn("SessionLimitRecoveryHttpApi.current")(function* (sessionID: SessionID) {
        yield* requireSession(sessionID)
        return (yield* Recovery.get(db, sessionID)) ?? null
      })

      const publishUpdated = (recovery: Contract.Info) => events.publish(Contract.Updated, { recovery })
      const stale = (sessionID: SessionID) => new ConflictError({ message: "Session recovery generation is stale", resource: sessionID })

      const mutate = Effect.fn("SessionLimitRecoveryHttpApi.mutate")(function* (
        sessionID: SessionID,
        generation: number,
        operation: "autoResume" | "resume" | "snooze" | "wake",
        enabled?: boolean,
      ) {
        yield* requireSession(sessionID)
        const before = yield* Recovery.get(db, sessionID)
        if (!before) return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: `Session recovery not found: ${sessionID}` } })
        if (before.generation !== generation) return yield* stale(sessionID)
        if (operation === "snooze" && before.resetAt === undefined) {
          return yield* new HttpApiError.BadRequest({})
        }

        const after =
          operation === "autoResume"
            ? yield* Recovery.setAutoResume(db, { sessionID, generation, enabled: enabled! })
            : operation === "resume"
              ? yield* Recovery.requestManualResume(db, { sessionID, generation })
              : yield* Recovery.setSnooze(db, {
                  sessionID,
                  generation,
                  until:
                    operation === "snooze" && before.resetAt !== undefined
                      ? DateTime.toEpochMillis(before.resetAt)
                      : undefined,
                })
        if (!after) return yield* stale(sessionID)
        yield* publishUpdated(after)
        return after
      })

      const cancel = Effect.fn("SessionLimitRecoveryHttpApi.cancel")(function* (sessionID: SessionID, generation: number) {
        yield* requireSession(sessionID)
        const before = yield* Recovery.get(db, sessionID)
        if (!before) return yield* new ApiNotFoundError({ name: "NotFoundError", data: { message: `Session recovery not found: ${sessionID}` } })
        if (before.generation !== generation) return yield* stale(sessionID)
        yield* prompt.retireLimitRecoveryContinuations(sessionID)
        const cleared = yield* Recovery.cancel(db, { sessionID, generation })
        if (!cleared) return yield* stale(sessionID)
        yield* events.publish(Contract.Cleared, { sessionID, generation })
        return HttpApiSchema.NoContent.make()
      })

      return handlers
        .handle("get", (ctx) => current(ctx.params.sessionID))
        .handle("autoResume", (ctx) => mutate(ctx.params.sessionID, ctx.payload.generation, "autoResume", ctx.payload.enabled))
        .handle("resume", (ctx) => mutate(ctx.params.sessionID, ctx.payload.generation, "resume"))
        .handle("snooze", (ctx) => mutate(ctx.params.sessionID, ctx.payload.generation, "snooze"))
        .handle("wake", (ctx) => mutate(ctx.params.sessionID, ctx.payload.generation, "wake"))
        .handle("cancel", (ctx) => cancel(ctx.params.sessionID, ctx.payload.generation))
    }),
)
