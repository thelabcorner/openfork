import { asc, eq, inArray, lt, sql } from "drizzle-orm"
import { Duration, Effect } from "effect"
import { dirname, join } from "path"
import { Database, type DatabaseShape } from "../database/database"
import { isSqliteBusy } from "../database/sqlite-busy"
import { makeSqliteMaintenanceQuietGate, type SqliteMaintenanceQuietGate } from "../database/sqlite-maintenance"
import { Flock } from "../util/flock"
import { RUNTIME_LOCK_DIRNAME } from "../storage-identity"
import { projectHistoricalContext } from "../oxp-attribution/backfill"
import { OxpInvocationDetailTable, OxpInvocationTable } from "./sql"
import type { OxpActivitySchema } from "./schema"

export const MAX_RETAINED_INVOCATION_DETAILS = 16_384
export const INVOCATION_DETAIL_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
export const INVOCATION_DETAIL_PRUNE_BATCH = 256
export const INVOCATION_DETAIL_MAX_PRUNE_PER_PASS = 2_048

export interface PruneOptions {
  readonly now?: number
  readonly maxRows?: number
  readonly maxAgeMs?: number
  readonly batchSize?: number
  readonly maxRowsPerPass?: number
  readonly quietGate?: SqliteMaintenanceQuietGate
}

export interface PruneResult {
  readonly before: number
  readonly after: number
  readonly removed: number
  readonly hitPassLimit: boolean
}

function positiveInt(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback
  return Math.max(1, Math.floor(value))
}

const countDetails = (db: DatabaseShape) =>
  db
    .select({ count: sql<number>`count(*)` })
    .from(OxpInvocationDetailTable)
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => Number(row?.count ?? 0)),
    )

const oldestDetails = (db: DatabaseShape, limit: number, before?: number) => {
  const base = db
    .select({
      invocationID: OxpInvocationDetailTable.invocation_id,
      startedAt: OxpInvocationTable.time_started,
    })
    .from(OxpInvocationDetailTable)
    .innerJoin(OxpInvocationTable, eq(OxpInvocationTable.id, OxpInvocationDetailTable.invocation_id))

  const query = before === undefined ? base : base.where(lt(OxpInvocationTable.time_started, before))

  return query
    .orderBy(asc(OxpInvocationTable.time_started), asc(OxpInvocationTable.id))
    .limit(limit)
    .all()
    .pipe(Effect.orDie)
}

export const pruneInvocationDetails = Effect.fnUntraced(function* (db: DatabaseShape, options: PruneOptions = {}) {
  const now = options.now ?? Date.now()
  const maxRows = positiveInt(options.maxRows, MAX_RETAINED_INVOCATION_DETAILS)
  const maxAgeMs = positiveInt(options.maxAgeMs, INVOCATION_DETAIL_RETENTION_MS)
  const batchSize = positiveInt(options.batchSize, INVOCATION_DETAIL_PRUNE_BATCH)
  const maxRowsPerPass = positiveInt(options.maxRowsPerPass, INVOCATION_DETAIL_MAX_PRUNE_PER_PASS)
  const cutoff = now - maxAgeMs
  const before = yield* countDetails(db)
  let remainingBudget = maxRowsPerPass
  let removed = 0

  const remove = Effect.fnUntraced(function* (rows: readonly { invocationID: OxpActivitySchema.InvocationID }[]) {
    if (rows.length === 0) return 0
    if (options.quietGate) yield* options.quietGate.wait()
    const ids = rows.map((row) => row.invocationID)
    // Detail is disposable; recoverable context accounting evidence is not.
    // Persist exact scalar projections before deleting the JSON presentation
    // payload so retention can never destroy still-recoverable attribution.
    yield* projectHistoricalContext(db, {
      ids,
      limit: ids.length,
      quietGate: options.quietGate,
    })
    yield* db
      .delete(OxpInvocationDetailTable)
      .where(inArray(OxpInvocationDetailTable.invocation_id, ids))
      .run()
      .pipe(Effect.orDie)
    return ids.length
  })

  // Enforce the global cardinality ceiling first. This prevents a busy host from
  // retaining an arbitrarily large detail history even when all rows are young.
  let excess = Math.max(0, before - maxRows)
  while (excess > 0 && remainingBudget > 0) {
    const rows = yield* oldestDetails(db, Math.min(batchSize, excess, remainingBudget))
    if (rows.length === 0) break
    const deleted = yield* remove(rows)
    if (deleted === 0) break
    removed += deleted
    excess = Math.max(0, excess - deleted)
    remainingBudget -= deleted
  }

  // When cardinality is already healthy, age still bounds low-volume installs.
  while (remainingBudget > 0) {
    const rows = yield* oldestDetails(db, Math.min(batchSize, remainingBudget), cutoff)
    if (rows.length === 0) break
    const deleted = yield* remove(rows)
    if (deleted === 0) break
    removed += deleted
    remainingBudget -= deleted
  }

  const after = yield* countDetails(db)
  return {
    before,
    after,
    removed: Math.max(0, before - after),
    hitPassLimit: remainingBudget === 0 && after > maxRows,
  } satisfies PruneResult
})

const runRetentionPass = (filename: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Flock.effect(`oxp-detail-retention:${filename}`, {
        dir: join(dirname(filename), RUNTIME_LOCK_DIRNAME),
        staleMs: 60_000,
        timeoutMs: 100,
        baseDelayMs: 20,
        maxDelayMs: 50,
      })
      const result = yield* Database.withBackfillDb(
        filename,
        (db) => {
          const quietGate = makeSqliteMaintenanceQuietGate(db)
          return pruneInvocationDetails(db, { quietGate })
        },
        { busyTimeoutMs: 75 },
      )
      if (result.removed > 0) {
        yield* Effect.logInfo("OXP invocation-detail retention pass complete", {
          filename,
          ...result,
          maxRows: MAX_RETAINED_INVOCATION_DETAILS,
          maxAgeMs: INVOCATION_DETAIL_RETENTION_MS,
        })
      }
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      isSqliteBusy(cause)
        ? Effect.void
        : Effect.logWarning("OXP invocation-detail retention pass skipped", {
            filename,
            cause,
          }),
    ),
  )

/**
 * Low-priority global-detail maintenance. It deliberately runs infrequently,
 * uses a separate SQLite connection, waits for a cross-process quiet window and
 * deletes at most a bounded number of rows per pass. This is the opposite of an
 * insert-then-prune hot path: normal tool calls never run retention work.
 */
export function runInvocationDetailRetentionLoop(filename: string) {
  if (filename === ":memory:") return Effect.void
  return Effect.gen(function* () {
    yield* Effect.sleep(Duration.seconds(5))
    for (;;) {
      yield* runRetentionPass(filename)
      yield* Effect.sleep(Duration.minutes(30))
    }
  })
}
