import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Cause, Effect, Option } from "effect"
import { InstanceHttpApi } from "../api"
import { Database } from "@opencode-ai/core/database/database"
import { MessageV2 } from "@/session/message-v2"
import { SessionContextState } from "@/session/context/state"
import { SessionLedger } from "@/session/context/ledger"
import { validate as validateContextMutation } from "@/session/context/admission"
import { withinContextPayloadBudget } from "@/session/context/admission-budget"
import { ContextInspection } from "@/session/context/inspection"
import { readPage as readContextLedgerPage } from "@/session/context/page"
import { readTotals as readContextLedgerTotals } from "@/session/context/totals"
import { ApiNotFoundError, notFound } from "../errors"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"

/**
 * Translate any non-declared domain failure to the group's declared error
 * channel ([HttpApiError.BadRequest, ApiNotFoundError]). Declared errors pass
 * through untouched so 404s stay 404s; everything else becomes a 400.
 */
const translate = <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, ApiNotFoundError | HttpApiError.BadRequest, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const failure = Cause.findErrorOption(cause)
      if (Option.isSome(failure)) {
        const error = failure.value
        if (error instanceof ApiNotFoundError || error instanceof HttpApiError.BadRequest) {
          return Effect.fail(error)
        }
      }
      return Effect.fail(new HttpApiError.BadRequest())
    }),
  )

/** Apply `translate` to the effect produced by an `Effect.fn` builder function. */
const translateHandler =
  <A, R>(f: (...args: any[]) => Effect.Effect<A, unknown, R>) =>
  (...args: any[]): Effect.Effect<A, ApiNotFoundError | HttpApiError.BadRequest, R> =>
    translate(f(...args))

export const sessionContextHandlers = HttpApiBuilder.group(InstanceHttpApi, "session-context", (handlers) =>
  Effect.gen(function* () {
    const database = yield* Database.Service

    // Producer-owned classifier only. A full Session read deserializes
    // unrelated large metadata, summaries, permissions and model config.
    const isSpecialAgent = Effect.fn("session-context.specialAgent")(function* (sessionID: string) {
      const row = yield* database.readDb
        .select({ metadata: SessionTable.metadata })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID as any))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(notFound(`Session not found: ${sessionID}`))
      return SessionMetadataOwnership.isSpecialAgent(row.metadata ?? undefined)
    })

    const applyOps = translateHandler(Effect.fn("session-context.applyOps")(function* ({ params, payload }: any) {
      const { sessionID } = params as { sessionID: string }
      const ops = (payload as { operations: any[] }).operations
      // Byte-size admission must precede any SQLite reads. The durable event
      // projector cannot afford arbitrarily large user-authored replacements.
      if (!withinContextPayloadBudget(ops)) return yield* Effect.fail(new HttpApiError.BadRequest())
      // Local request admission is a durable writer-transaction precondition.
      // The validation and event/projector append linearize at the same SQLite
      // transaction. A concurrent deletion, signature update, special-agent
      // reclassification or part-status change cannot slip between them.
      // No separate WAL read is authoritative for the mutation.
      if (ops.length === 0) {
        yield* isSpecialAgent(sessionID)
        return { batchID: "", timestamp: Date.now() }
      }

      const result = yield* SessionContextState.applyOps({
        sessionID: sessionID as any,
        operations: ops as any,
        admit: () => validateContextMutation({ sessionID, operations: ops }, database.db),
      })
      return result
    }),
  )

    const opsHistory = translateHandler(Effect.fn("session-context.opsHistory")(function* ({ params }: any) {
      const { sessionID } = params as { sessionID: string }
      yield* isSpecialAgent(sessionID)
      const rows = yield* SessionContextState.getOpsHistory(sessionID as any)
      return rows
    }),
  )

    const ledger = translateHandler(Effect.fn("session-context.ledger")(function* ({ params }: any) {
      const { sessionID } = params as { sessionID: string }
      if (yield* isSpecialAgent(sessionID)) {
        const messages = yield* MessageV2.currentMessages({ sessionID: sessionID as any }).pipe(
          Effect.provideService(Database.Service, database),
        )
        return yield* SessionLedger.buildCurrentReadOnly({ sessionID, messages })
      }

      const snapshot = yield* ContextInspection.read(sessionID).pipe(
        Effect.provideService(Database.Service, database),
      )
      return ContextInspection.ledger(sessionID, snapshot)
    }),
  )

    const ledgerPage = translateHandler(Effect.fn("session-context.ledgerPage")(function* ({ params, query }: any) {
      const { sessionID } = params as { sessionID: string }
      if (yield* isSpecialAgent(sessionID)) {
        // The V2/special-agent transcript is host-owned and read-only. Do not
        // silently expose the unrelated V1 physical-message history.
        return yield* Effect.fail(new HttpApiError.BadRequest())
      }
      return yield* readContextLedgerPage({ sessionID, limit: query.limit, cursor: query.cursor })
    }))

    const ledgerTotals = translateHandler(Effect.fn("session-context.ledgerTotals")(function* ({ params }: any) {
      const { sessionID } = params as { sessionID: string }
      if (yield* isSpecialAgent(sessionID))
        return yield* Effect.fail(new HttpApiError.BadRequest())
      return yield* readContextLedgerTotals(sessionID)
    }))

    const preview = translateHandler(Effect.fn("session-context.preview")(function* ({ params }: any) {
      const { sessionID } = params as { sessionID: string }
      if (yield* isSpecialAgent(sessionID)) {
        const messages = yield* MessageV2.currentMessages({ sessionID: sessionID as any }).pipe(
          Effect.provideService(Database.Service, database),
        )
        const ledgerData = yield* SessionLedger.buildCurrentReadOnly({ sessionID, messages })
        return {
          beforeTokens: ledgerData.totals.estimatedTokens,
          afterTokens: ledgerData.totals.estimatedTokens,
          removedTokens: 0,
          messageCount: ledgerData.totals.messageCount,
          effectiveCount: ledgerData.totals.messageCount,
          earliestMutationIndex: undefined,
        }
      }

      const snapshot = yield* ContextInspection.read(sessionID).pipe(
        Effect.provideService(Database.Service, database),
      )
      // The domain compiler owns pin/exclude/edit semantics. Never swallow a
      // compilation error and label the unmodified transcript as effective.
      return ContextInspection.preview(sessionID, snapshot)
    }),
  )

    const forkOrigin = translateHandler(Effect.fn("session-context.forkOrigin")(function* ({ params }: any) {
      const { sessionID } = params as { sessionID: string }
      const origin = yield* SessionContextState.getForkOrigin(sessionID as any)
      if (!origin) return yield* Effect.fail(new Error(`No fork origin for session ${sessionID}`))
      return origin
    }),
  )

    return handlers
      .handle("applyOps", applyOps)
      .handle("opsHistory", opsHistory)
      .handle("ledger", ledger)
      .handle("ledgerPage", ledgerPage)
      .handle("ledgerTotals", ledgerTotals)
      .handle("preview", preview)
      .handle("forkOrigin", forkOrigin)
    }),
  )
