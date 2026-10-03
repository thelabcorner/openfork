import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Cause, Effect, Option } from "effect"
import { InstanceHttpApi } from "../api"
import { Database } from "@opencode-ai/core/database/database"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionContextState } from "@/session/context/state"
import { SessionLedger } from "@/session/context/ledger"
import { EffectiveContextCompiler } from "@/session/context/compiler"
import { ApiNotFoundError } from "../errors"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"

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
    const session = yield* Session.Service
    const database = yield* Database.Service

    const applyOps = translateHandler(Effect.fn("session-context.applyOps")(function* ({ params, payload }: any) {
      const { sessionID } = params as { sessionID: string }
      // Validate session exists
      const current = yield* session.get(sessionID as any)
      // Special-agent transcripts are host-owned inspection surfaces. Context
      // overlays are interactive-session mutations and do not alter the
      // privileged/current transcript that an auditor or revisor actually saw.
      if (SessionMetadataOwnership.isSpecialAgent(current.metadata)) {
        return yield* Effect.fail(new HttpApiError.BadRequest())
      }
      // Validate ops at admission. The compiler repeats these guards for old
      // persisted rows, but invalid operations must not enter the durable event
      // log/projector in the first place.
      const ops = (payload as { operations: any[] }).operations
      if (ops.length === 0) return { batchID: "", timestamp: Date.now() }

      // Pre-validate against one already-loaded transcript snapshot.
      const all = yield* MessageV2.stream(sessionID as any).pipe(
        Effect.provideService(Database.Service, database),
        Effect.catch(() => Effect.succeed([] as never)),
      )
      const byId = new Map(all.map((m: any) => [m.info.id, m]))

      for (const op of ops) {
        const msg = byId.get(op.messageID)
        if (!msg) continue
        const check = EffectiveContextCompiler.canApplyContextOperation(msg as any, op.type)
        if (!check.allowed) {
          return yield* Effect.fail(
            new Error(`Operation ${op.type} blocked for message ${op.messageID}: ${check.reason}`),
          )
        }
      }

      const result = yield* SessionContextState.applyOps({
        sessionID: sessionID as any,
        operations: ops as any,
      })
      return result
    }),
  )

    const opsHistory = translateHandler(Effect.fn("session-context.opsHistory")(function* ({ params }: any) {
      const { sessionID } = params as { sessionID: string }
      yield* session.get(sessionID as any)
      const rows = yield* SessionContextState.getOpsHistory(sessionID as any)
      return rows
    }),
  )

    const ledger = translateHandler(Effect.fn("session-context.ledger")(function* ({ params }: any) {
      const { sessionID } = params as { sessionID: string }
      const current = yield* session.get(sessionID as any)
      if (SessionMetadataOwnership.isSpecialAgent(current.metadata)) {
        const messages = yield* MessageV2.currentMessages({ sessionID: sessionID as any }).pipe(
          Effect.provideService(Database.Service, database),
        )
        return yield* SessionLedger.buildCurrentReadOnly({ sessionID, messages })
      }

      const all = yield* MessageV2.stream(sessionID as any).pipe(
        Effect.provideService(Database.Service, database),
        Effect.catch(() => Effect.succeed([] as never)),
      )
      const filtered = MessageV2.filterCompacted(all as any)
      return yield* SessionLedger.build({ sessionID, messages: filtered as any })
    }),
  )

    const preview = translateHandler(Effect.fn("session-context.preview")(function* ({ params }: any) {
      const { sessionID } = params as { sessionID: string }
      const current = yield* session.get(sessionID as any)
      if (SessionMetadataOwnership.isSpecialAgent(current.metadata)) {
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

      const all = yield* MessageV2.stream(sessionID as any).pipe(
        Effect.provideService(Database.Service, database),
        Effect.catch(() => Effect.succeed([] as never)),
      )
      const filtered = MessageV2.filterCompacted(all as any)
      const ledgerData = yield* SessionLedger.build({ sessionID, messages: filtered as any })
      const compiled = yield* EffectiveContextCompiler.compileForSession({
        messages: filtered as any,
        sessionID,
      }).pipe(Effect.catch(() => Effect.succeed({ effective: filtered, excluded: [], pinned: [], warnings: [] } as any)))

      const beforeTokens = ledgerData.totals.estimatedTokens + ledgerData.totals.estimatedTokensExcluded
      // Estimate after by summing effective
      let afterTokens = 0
      for (const m of (compiled as any).effective as any[]) {
        const entry = ledgerData.entries.find((e: any) => e.messageID === m.info.id)
        if (entry && !entry.excluded) afterTokens += entry.tokenEstimate
        else {
          // Fallback estimate
          for (const p of (m as any).parts) {
            if (p.type === "text") afterTokens += Math.ceil((p.text as string).length / 4)
          }
        }
      }
      // Find earliest *effective* mutation from the already materialized ledger.
      // This avoids a second SQLite read and ignores legacy overlay rows that the
      // compiler deliberately treats as semantically inert (for example STATE).
      const mutated = new Set(
        ledgerData.entries
          .filter((entry) => entry.excluded || entry.pinned || entry.edited)
          .map((entry) => entry.messageID),
      )
      let earliestMutationIndex: number | undefined
      for (let i = 0; i < filtered.length; i++) {
        if (mutated.has(filtered[i]!.info.id as any)) {
          earliestMutationIndex = i
          break
        }
      }

      return {
        beforeTokens,
        afterTokens: afterTokens || ledgerData.totals.estimatedTokens,
        removedTokens: ledgerData.totals.estimatedTokensExcluded,
        messageCount: filtered.length,
        effectiveCount: (compiled as any).effective.length,
        earliestMutationIndex,
      }
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
      .handle("preview", preview)
      .handle("forkOrigin", forkOrigin)
  }),
)
