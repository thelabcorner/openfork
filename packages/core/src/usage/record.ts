export * as UsageRecord from "./record"

import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "../session/schema"
import { MaintenanceUsageTable, UsageRecordTable } from "./sql"

export interface RecordInput {
  readonly messageID: string
  readonly sessionID: string
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
  readonly agent?: string
  readonly mode?: string
  readonly createdAt?: number
  readonly requestSentAt?: number
  readonly firstTokenAt?: number
  readonly streamedAt?: number
  readonly completedAt: number
  readonly cost?: number
  readonly tokens: {
    readonly input: number
    readonly cacheRead: number
    readonly cacheWrite: number
    readonly output: number
    readonly reasoning: number
  }
}

export interface MaintenanceRecordInput {
  readonly agent: string
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
  readonly sessionID?: string
  readonly projectID?: string
  readonly requests?: number
  readonly cost?: number
  readonly costEstimated?: boolean
  readonly tokens: {
    readonly input: number
    readonly cacheRead: number
    readonly cacheWrite: number
    readonly output: number
    readonly reasoning: number
  }
  readonly totalTokens: number
  readonly startedAt: number
  readonly completedAt: number
}

export interface Interface {
  /**
   * Idempotently materialize one settled generation for historical analytics.
   * This is intentionally scalar-only and never reads message/part history.
   */
  readonly record: (input: RecordInput) => Effect.Effect<void>
  /** Persist one physical host-owned support-agent request. */
  readonly recordMaintenance: (input: MaintenanceRecordInput) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/core/UsageRecord") {}

// Monotonic in-process history revision. Historical readers use this as an
// O(1) cache watermark instead of issuing a MAX(rowid)/mtime query on every
// analytics request. Only a successfully committed scalar settlement advances
// the revision; observability storage failures remain fail-open to execution.
let historyRevision = 0
export const revision = () => historyRevision

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const record = Effect.fnUntraced(function* (input: RecordInput) {
      const sessionID = SessionSchema.ID.make(input.sessionID)
      const row: typeof UsageRecordTable.$inferInsert = {
        message_id: input.messageID,
        session_id: sessionID,
        provider_id: input.providerID,
        model_id: input.modelID,
        variant: input.variant,
        agent: input.agent,
        mode: input.mode,
        created_at: input.createdAt,
        request_sent_at: input.requestSentAt,
        first_token_at: input.firstTokenAt,
        streamed_at: input.streamedAt,
        completed_at: input.completedAt,
        cost_usd: input.cost,
        input_tokens: input.tokens.input,
        cache_read_tokens: input.tokens.cacheRead,
        cache_write_tokens: input.tokens.cacheWrite,
        output_tokens: input.tokens.output,
        reasoning_tokens: input.tokens.reasoning,
      }
      yield* db
        .insert(UsageRecordTable)
        .values(row)
        .onConflictDoUpdate({
          target: UsageRecordTable.message_id,
          set: {
            session_id: sessionID,
            provider_id: input.providerID,
            model_id: input.modelID,
            variant: input.variant,
            agent: input.agent,
            mode: input.mode,
            created_at: input.createdAt,
            request_sent_at: input.requestSentAt,
            first_token_at: input.firstTokenAt,
            streamed_at: input.streamedAt,
            completed_at: input.completedAt,
            cost_usd: input.cost,
            input_tokens: input.tokens.input,
            cache_read_tokens: input.tokens.cacheRead,
            cache_write_tokens: input.tokens.cacheWrite,
            output_tokens: input.tokens.output,
            reasoning_tokens: input.tokens.reasoning,
          },
        })
        .run()
        .pipe(Effect.orDie)
      historyRevision += 1
    })

    const recordMaintenance = Effect.fnUntraced(function* (input: MaintenanceRecordInput) {
      yield* db
        .insert(MaintenanceUsageTable)
        .values({
          agent: input.agent,
          provider_id: input.providerID,
          model_id: input.modelID,
          variant: input.variant,
          session_id: input.sessionID,
          project_id: input.projectID,
          requests: Math.max(1, Math.floor(input.requests ?? 1)),
          cost_usd: input.cost,
          cost_estimated: input.costEstimated ?? false,
          input_tokens: Math.max(0, Math.floor(input.tokens.input)),
          cache_read_tokens: Math.max(0, Math.floor(input.tokens.cacheRead)),
          cache_write_tokens: Math.max(0, Math.floor(input.tokens.cacheWrite)),
          output_tokens: Math.max(0, Math.floor(input.tokens.output)),
          reasoning_tokens: Math.max(0, Math.floor(input.tokens.reasoning)),
          total_tokens: Math.max(0, Math.floor(input.totalTokens)),
          time_started: input.startedAt,
          time_completed: input.completedAt,
        })
        .run()
        .pipe(Effect.orDie)
      historyRevision += 1
    })

    // Usage accounting is observability, not execution authority. A storage
    // fault must never fail or retry a provider turn.
    return Service.of({
      record: (input) => record(input).pipe(Effect.catchCause(() => Effect.void)),
      recordMaintenance: (input) => recordMaintenance(input).pipe(Effect.catchCause(() => Effect.void)),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
