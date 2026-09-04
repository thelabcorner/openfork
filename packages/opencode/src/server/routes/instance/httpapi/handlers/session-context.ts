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
      yield* session.get(sessionID as any)
      // Validate ops — gate signed-reasoning edits/excludes
      const ops = (payload as { operations: any[] }).operations
      if (ops.length === 0) return { batchID: "", timestamp: Date.now() }

      // Pre-validate: load messages once to check signed reasoning
      const all = yield* MessageV2.stream(sessionID as any).pipe(
        Effect.provideService(Database.Service, database),
        Effect.catch(() => Effect.succeed([] as never)),
      )
      const byId = new Map(all.map((m: any) => [m.info.id, m]))

      for (const op of ops) {
        const msg = byId.get(op.messageID)
        if (!msg) continue
        const hasSigned = (msg as any).parts?.some(
          (p: any) => p.type === "reasoning" && p.metadata?.anthropic?.signature != null,
        )
        if (hasSigned && (op.type === "message.exclude" || op.type === "text.replace")) {
          return yield* Effect.fail(
            new Error(`Operation ${op.type} blocked: message ${op.messageID} contains signed reasoning`),
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
      yield* session.get(sessionID as any)
      const all = yield* MessageV2.stream(sessionID as any).pipe(
        Effect.provideService(Database.Service, database),
        Effect.catch(() => Effect.succeed([] as never)),
      )
      const filtered = MessageV2.filterCompacted(all as any)
      const result = yield* SessionLedger.build({ sessionID, messages: filtered as any })
      return result
    }),
  )

    const preview = translateHandler(Effect.fn("session-context.preview")(function* ({ params }: any) {
      const { sessionID } = params as { sessionID: string }
      yield* session.get(sessionID as any)
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
      // Find earliest mutation index
      const stateMap = yield* SessionContextState.getState(sessionID as any).pipe(
        Effect.catch(() => Effect.succeed(new Map())),
      )
      let earliestMutationIndex: number | undefined
      for (let i = 0; i < filtered.length; i++) {
        if ((stateMap as Map<string, any>).has(filtered[i]!.info.id)) {
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
