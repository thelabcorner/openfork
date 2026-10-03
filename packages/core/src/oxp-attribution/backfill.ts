export * as OxpAttributionBackfill from "./backfill"

import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm"
import { Duration, Effect } from "effect"
import { dirname, join } from "node:path"
import { Database, type DatabaseShape } from "../database/database"
import { isSqliteBusy } from "../database/sqlite-busy"
import { makeSqliteMaintenanceQuietGate, type SqliteMaintenanceQuietGate } from "../database/sqlite-maintenance"
import { OxpInvocationDetailTable, OxpInvocationTable } from "../oxp-activity/sql"
import type { OxpActivitySchema } from "../oxp-activity/schema"
import { RUNTIME_LOCK_DIRNAME } from "../storage-identity"
import { Flock } from "../util/flock"
import { OxpAttributionCalibration } from "./calibration"
import { OxpAttributionRevision } from "./revision"

export const HISTORICAL_CONTEXT_BACKFILL_BATCH = 128
export const HISTORICAL_CONTEXT_MAX_ROWS_PER_PASS = 2_048

export interface BackfillOptions {
  readonly limit?: number
  readonly ids?: readonly OxpActivitySchema.InvocationID[]
  readonly quietGate?: SqliteMaintenanceQuietGate
}

export interface BackfillResult {
  readonly projected: number
  readonly more: boolean
}

const legacyRequestChars = sql<number | null>`
  length(json_extract(${OxpInvocationDetailTable.request}, '$.args'))
`
const legacyResultChars = sql<number | null>`
  CASE
    WHEN ${OxpInvocationDetailTable.outcome} IS NULL THEN NULL
    ELSE
      COALESCE(length(json_extract(${OxpInvocationDetailTable.outcome}, '$.output')), 0) +
      COALESCE(length(json_extract(${OxpInvocationDetailTable.outcome}, '$.error')), 0)
  END
`

/**
 * Project recoverable legacy JSON detail into durable scalar evidence.
 *
 * The stored detail is already a bounded privacy projection; this function only
 * computes character counts and never creates another payload copy.
 */
export const projectHistoricalContext = Effect.fnUntraced(function* (db: DatabaseShape, options: BackfillOptions = {}) {
  const limit = Math.max(
    1,
    Math.min(HISTORICAL_CONTEXT_BACKFILL_BATCH, Math.floor(options.limit ?? HISTORICAL_CONTEXT_BACKFILL_BATCH)),
  )
  if (options.ids && options.ids.length === 0) return { projected: 0, more: false } satisfies BackfillResult

  // The sealed calibration corpus predates the recorder's privacy-projected
  // detail format. Never reinterpret newer bounded detail as the old canonical
  // args/output/error population; live rows should already carry boundary
  // scalars, and any missing newer measurement must remain explicitly
  // estimated/unavailable.
  const legacyCorpus = lte(OxpInvocationTable.time_started, OxpAttributionCalibration.status.corpus.maxStartedAt)
  const recoverable = and(
    legacyCorpus,
    or(
      and(
        isNull(OxpInvocationTable.context_request_chars),
        sql`${OxpInvocationDetailTable.request} IS NOT NULL`,
        sql`json_type(${OxpInvocationDetailTable.request}, '$.args') IS NOT NULL`,
        sql`json_type(${OxpInvocationDetailTable.request}, '$.args') <> 'null'`,
      ),
      and(isNull(OxpInvocationTable.context_result_chars), sql`${OxpInvocationDetailTable.outcome} IS NOT NULL`),
    )!,
  )!

  if (options.quietGate) yield* options.quietGate.wait()
  const rows = yield* db
    .select({
      id: OxpInvocationTable.id,
      currentRequest: OxpInvocationTable.context_request_chars,
      currentResult: OxpInvocationTable.context_result_chars,
      requestChars: legacyRequestChars,
      resultChars: legacyResultChars,
    })
    .from(OxpInvocationTable)
    .innerJoin(OxpInvocationDetailTable, eq(OxpInvocationDetailTable.invocation_id, OxpInvocationTable.id))
    .where(options.ids ? and(recoverable, inArray(OxpInvocationTable.id, [...options.ids])) : recoverable)
    .orderBy(asc(OxpInvocationTable.id))
    .limit(options.ids ? Math.max(limit, options.ids.length) : limit + 1)
    .all()
    .pipe(Effect.orDie)

  const more = !options.ids && rows.length > limit
  const selected = more ? rows.slice(0, limit) : rows
  if (selected.length === 0) return { projected: 0, more: false } satisfies BackfillResult
  if (options.quietGate) yield* options.quietGate.wait()

  let written = 0
  yield* db
    .transaction(
      (tx) =>
        Effect.forEach(
          selected,
          (row) => {
            const request =
              row.currentRequest === null && row.requestChars !== null
                ? {
                    context_request_chars: Number(row.requestChars),
                    context_request_source: "historical_detail" as const,
                    context_request_schema: "oxp-primary-args-output-error/v1" as const,
                  }
                : {}
            const result =
              row.currentResult === null && row.resultChars !== null
                ? {
                    context_result_chars: Number(row.resultChars),
                    context_result_source: "historical_detail" as const,
                    context_result_schema: "oxp-primary-args-output-error/v1" as const,
                  }
                : {}
            if (Object.keys(request).length === 0 && Object.keys(result).length === 0) return Effect.void
            return tx
              .update(OxpInvocationTable)
              .set({ ...request, ...result })
              .where(eq(OxpInvocationTable.id, row.id))
              .run()
              .pipe(
                Effect.orDie,
                Effect.tap(() =>
                  Effect.sync(() => {
                    written += 1
                  }),
                ),
                Effect.asVoid,
              )
          },
          { discard: true },
        ),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
  if (written > 0) OxpAttributionRevision.advance()

  return {
    projected: written,
    more: more && written > 0,
  } satisfies BackfillResult
})

const runPass = (filename: string) =>
  Effect.gen(function* () {
    const lease = yield* Effect.promise((signal) =>
      Flock.tryAcquire(`oxp-context-backfill:${filename}`, {
        dir: join(dirname(filename), RUNTIME_LOCK_DIRNAME),
        staleMs: 60_000,
        signal,
      }),
    )
    if (!lease) return { projected: 0, more: false }
    return yield* Database.withBackfillDb(
      filename,
      (db) =>
        Effect.gen(function* () {
          const quietGate = makeSqliteMaintenanceQuietGate(db)
          let projected = 0
          let more = true
          while (more && projected < HISTORICAL_CONTEXT_MAX_ROWS_PER_PASS) {
            const result = yield* projectHistoricalContext(db, {
              limit: Math.min(HISTORICAL_CONTEXT_BACKFILL_BATCH, HISTORICAL_CONTEXT_MAX_ROWS_PER_PASS - projected),
              quietGate,
            })
            projected += result.projected
            more = result.more && result.projected > 0
          }
          return { projected, more }
        }),
      { busyTimeoutMs: 75 },
    ).pipe(Effect.ensuring(Effect.promise(() => lease.release()).pipe(Effect.ignore)))
  }).pipe(
    Effect.catchCause((cause) =>
      isSqliteBusy(cause)
        ? Effect.succeed({ projected: 0, more: false })
        : Effect.logWarning("OXP context backfill pass skipped", {
            filename,
            cause,
          }).pipe(Effect.as({ projected: 0, more: false })),
    ),
  )

export function runHistoricalContextBackfillLoop(filename: string) {
  if (filename === ":memory:") return Effect.void
  return Effect.gen(function* () {
    yield* Effect.sleep(Duration.seconds(1))
    for (;;) {
      const result = yield* runPass(filename)
      if (result.projected > 0) {
        yield* Effect.logInfo("OXP historical context backfill pass complete", {
          filename,
          ...result,
        })
      }
      yield* Effect.sleep(result.more ? Duration.seconds(3) : Duration.minutes(30))
    }
  })
}
