export * as UsageYield from "./yield"

import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { splitAccountModelID } from "@opencode-ai/schema/model-account-identity"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { UsageRevision } from "./revision"
import { UsageRecordTable, UsageYieldMetaTable, UsageYieldStatTable } from "./sql"
import {
  isUserFacingYieldObservation,
  observeYieldStatistic,
  snapshotYieldStatistic,
  statisticalKeyID,
  statisticalKeys,
  type YieldObservation,
  type YieldStatisticalKey,
  type YieldStatisticState,
} from "./yield-statistics"

type DatabaseClient = EffectDrizzleSqlite.EffectSQLiteDatabase
export type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]

export const STATE_VERSION = 3

export interface ObserveInput extends YieldObservation, YieldStatisticalKey {
  readonly agent?: string
  readonly mode?: string
}

export interface Entry {
  readonly key: YieldStatisticalKey
  readonly state: YieldStatisticState
  readonly updatedAt: number
}

export interface RebuildResult {
  readonly sourceRows: number
  readonly states: number
}

export interface Interface {
  /**
   * Incrementally update the materialized state for one settled generation.
   * Supplying the caller's transaction keeps the ledger row and projection
   * crash-consistent.
   */
  readonly observe: (input: ObserveInput, tx?: Transaction) => Effect.Effect<void>
  /** Read one finalized snapshot without scanning usage history. */
  readonly get: (key: YieldStatisticalKey) => Effect.Effect<YieldStatisticState | undefined>
  /** Read the bounded materialized state set. */
  readonly list: () => Effect.Effect<readonly Entry[]>
  /** Explicit full rebuild from the durable usage ledger. */
  readonly rebuild: () => Effect.Effect<RebuildResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/core/UsageYield") {}

function storedKey(row: {
  provider_id: string
  base_model_id: string
  account_id: string | null
}): YieldStatisticalKey {
  return {
    providerID: row.provider_id,
    baseModelID: row.base_model_id,
    ...(row.account_id ? { accountID: row.account_id } : {}),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service

    const writeObservation = Effect.fnUntraced(function* (
      client: DatabaseClient | Transaction,
      key: YieldStatisticalKey,
      observation: YieldObservation,
    ) {
      const id = statisticalKeyID(key)
      const current = yield* client
        .select({ state: UsageYieldStatTable.state })
        .from(UsageYieldStatTable)
        .where(eq(UsageYieldStatTable.stat_key, id))
        .get()
        .pipe(Effect.orDie)
      const state = observeYieldStatistic(current?.state, observation)
      yield* client
        .insert(UsageYieldStatTable)
        .values({
          stat_key: id,
          provider_id: key.providerID,
          base_model_id: key.baseModelID,
          account_id: key.accountID ?? null,
          state,
          updated_at: state.lastCompletedAt ?? observation.completedAt,
        })
        .onConflictDoUpdate({
          target: UsageYieldStatTable.stat_key,
          set: {
            provider_id: key.providerID,
            base_model_id: key.baseModelID,
            account_id: key.accountID ?? null,
            state,
            updated_at: state.lastCompletedAt ?? observation.completedAt,
          },
        })
        .run()
        .pipe(Effect.orDie)
    })

    const observeIn = Effect.fnUntraced(function* (client: DatabaseClient | Transaction, input: ObserveInput) {
      if (!isUserFacingYieldObservation(input)) return
      const observation: YieldObservation = {
        sessionID: input.sessionID,
        completedAt: input.completedAt,
        tokens: input.tokens,
      }
      yield* Effect.forEach(
        statisticalKeys({
          providerID: input.providerID,
          baseModelID: input.baseModelID,
          accountID: input.accountID,
        }),
        (key) => writeObservation(client, key, observation),
        { discard: true },
      )
    })

    const rebuildIn = Effect.fnUntraced(function* (tx: Transaction) {
      const rows = yield* tx
        .select({
          sessionID: UsageRecordTable.session_id,
          providerID: UsageRecordTable.provider_id,
          modelID: UsageRecordTable.model_id,
          baseModelID: UsageRecordTable.base_model_id,
          accountID: UsageRecordTable.account_id,
          agent: UsageRecordTable.agent,
          mode: UsageRecordTable.mode,
          completedAt: UsageRecordTable.completed_at,
          input: UsageRecordTable.input_tokens,
          cacheRead: UsageRecordTable.cache_read_tokens,
          cacheWrite: UsageRecordTable.cache_write_tokens,
          output: UsageRecordTable.output_tokens,
          reasoning: UsageRecordTable.reasoning_tokens,
        })
        .from(UsageRecordTable)
        .orderBy(asc(UsageRecordTable.completed_at), asc(UsageRecordTable.message_id))
        .all()
        .pipe(Effect.orDie)

      const states = new Map<
        string,
        { key: YieldStatisticalKey; state: YieldStatisticState }
      >()
      let sourceRows = 0

      for (const row of rows) {
        if (!isUserFacingYieldObservation(row)) continue
        sourceRows += 1
        const identity = row.baseModelID
          ? { baseModelID: row.baseModelID, accountID: row.accountID ?? undefined }
          : splitAccountModelID(row.modelID)
        const observation: YieldObservation = {
          sessionID: row.sessionID,
          completedAt: row.completedAt,
          tokens: {
            input: row.input,
            cacheRead: row.cacheRead,
            cacheWrite: row.cacheWrite,
            output: row.output,
            reasoning: row.reasoning,
          },
        }
        for (const key of statisticalKeys({
          providerID: row.providerID,
          baseModelID: identity.baseModelID,
          accountID: identity.accountID,
        })) {
          const id = statisticalKeyID(key)
          const current = states.get(id)
          states.set(id, {
            key,
            state: observeYieldStatistic(current?.state, observation),
          })
        }
      }

      yield* tx.delete(UsageYieldStatTable).run().pipe(Effect.orDie)
      if (states.size > 0) {
        yield* tx
          .insert(UsageYieldStatTable)
          .values(
            [...states.entries()].map(([id, value]) => ({
              stat_key: id,
              provider_id: value.key.providerID,
              base_model_id: value.key.baseModelID,
              account_id: value.key.accountID ?? null,
              state: value.state,
              updated_at: value.state.lastCompletedAt ?? 0,
            })),
          )
          .run()
          .pipe(Effect.orDie)
      }

      const rebuiltAt = Date.now()
      yield* tx
        .insert(UsageYieldMetaTable)
        .values({
          id: "global",
          version: STATE_VERSION,
          rebuilt_at: rebuiltAt,
          source_rows: sourceRows,
        })
        .onConflictDoUpdate({
          target: UsageYieldMetaTable.id,
          set: {
            version: STATE_VERSION,
            rebuilt_at: rebuiltAt,
            source_rows: sourceRows,
          },
        })
        .run()
        .pipe(Effect.orDie)

      // A full rewrite replaces every materialized state, so in-process readers
      // memoizing this projection must observe it even when no settlement was
      // recorded. Observing through the caller's transaction keeps the advance
      // tied to the commit that carries the new states.
      UsageRevision.advance()
      return { sourceRows, states: states.size } satisfies RebuildResult
    })

    const rebuild = Effect.fn("UsageYield.rebuild")(function* () {
      return yield* db
        .transaction((tx) => rebuildIn(tx), { behavior: "immediate" })
        .pipe(Effect.orDie)
    })

    // The materialized projection is disposable/versioned. Rebuild it exactly
    // once when the algorithm version changes or a database predates the table.
    yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const meta = yield* tx
              .select({ version: UsageYieldMetaTable.version })
              .from(UsageYieldMetaTable)
              .where(eq(UsageYieldMetaTable.id, "global"))
              .get()
              .pipe(Effect.orDie)
            if (meta?.version === STATE_VERSION) return
            yield* rebuildIn(tx)
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)

    const observe = Effect.fn("UsageYield.observe")(function* (input: ObserveInput, tx?: Transaction) {
      if (tx) {
        yield* observeIn(tx, input)
        return
      }
      yield* db
        .transaction((inner) => observeIn(inner, input), { behavior: "immediate" })
        .pipe(Effect.orDie)
      // A standalone observation commits the projection outside the settlement
      // ledger, so it is the only writer of the change and must advance the
      // watermark itself. The transactional path is owned by UsageRecord.record,
      // which advances only when its ledger row was actually inserted.
      UsageRevision.advance()
    })

    const get = Effect.fn("UsageYield.get")(function* (key: YieldStatisticalKey) {
      const row = yield* readDb
        .select({ state: UsageYieldStatTable.state })
        .from(UsageYieldStatTable)
        .where(eq(UsageYieldStatTable.stat_key, statisticalKeyID(key)))
        .get()
        .pipe(Effect.orDie)
      return row ? snapshotYieldStatistic(row.state) : undefined
    })

    const list = Effect.fn("UsageYield.list")(function* () {
      const rows = yield* readDb
        .select({
          provider_id: UsageYieldStatTable.provider_id,
          base_model_id: UsageYieldStatTable.base_model_id,
          account_id: UsageYieldStatTable.account_id,
          state: UsageYieldStatTable.state,
          updated_at: UsageYieldStatTable.updated_at,
        })
        .from(UsageYieldStatTable)
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        key: storedKey(row),
        state: snapshotYieldStatistic(row.state),
        updatedAt: row.updated_at,
      }))
    })

    return Service.of({ observe, get, list, rebuild })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
