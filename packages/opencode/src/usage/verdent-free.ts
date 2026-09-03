import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Semaphore } from "effect"
import { Database, withBackfillDb } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"

export const VERDENT_FREE_5H_MS = 5 * 60 * 60 * 1000
export const VERDENT_FREE_WEEK_MS = 7 * 24 * 60 * 60 * 1000
export const VERDENT_FREE_HISTORY_DAYS = 90
export const VERDENT_FREE_HISTORY_MS = VERDENT_FREE_HISTORY_DAYS * 24 * 60 * 60 * 1000
const SNAPSHOT_CACHE_TTL_MS = 30_000

export type VerdentFreeRequestEvent = { at: number; modelID: string }
export type VerdentFreeLimitErrorEvent = { at: number; modelID: string; raw: string }

export type VerdentFreeLimitHit = {
  at: number
  modelID: string
  window: "5h" | "weekly" | "unknown"
  requestsIn5h: number
  requestsInWeek: number
}

export type VerdentFreeSnapshot = {
  since: number
  until: number
  current5hCount: number
  currentWeekCount: number
  requests: VerdentFreeRequestEvent[]
  limitHits: VerdentFreeLimitHit[]
}

type VerdentRequestRow = { at: number | null; model_id: string | null }
type VerdentLimitErrorRow = { at: number | null; model_id: string | null; response_body: string | null }

export function isVerdentFreeModelID(modelID: string | null | undefined) {
  if (!modelID) return false
  // Account-qualified and context-qualified picker ids append `@...` after
  // the upstream model id. Quota accounting must still use the shared free
  // model buckets rather than silently dropping those requests.
  return modelID.trim().toLowerCase().split("@", 1)[0]?.endsWith("-free") ?? false
}

function lowerBound(sorted: readonly number[], value: number) {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = low + ((high - low) >> 1)
    if (sorted[mid] < value) low = mid + 1
    else high = mid
  }
  return low
}

function classifyWindow(raw: string): "5h" | "weekly" | "unknown" {
  const lower = raw.toLowerCase()
  if (lower.includes("weekly") || lower.includes("week")) return "weekly"
  if (lower.includes("5-hour") || lower.includes("5 hour") || lower.includes("5h") || lower.includes("five hour"))
    return "5h"
  return "unknown"
}

export function buildVerdentFreeSnapshot(input: {
  now: number
  requests: readonly VerdentFreeRequestEvent[]
  limitErrors: readonly VerdentFreeLimitErrorEvent[]
  historyMs?: number
}): VerdentFreeSnapshot {
  const now = input.now
  const historyMs = Math.max(VERDENT_FREE_WEEK_MS, input.historyMs ?? VERDENT_FREE_HISTORY_MS)
  const since = now - historyMs

  const filtered = input.requests
    .filter((r) => Number.isFinite(r.at) && r.at >= since && r.at < now && isVerdentFreeModelID(r.modelID))
    .sort((a, b) => a.at - b.at)
  const times = filtered.map((r) => r.at).sort((a, b) => a - b)

  const current5hCount = lowerBound(times, now) - lowerBound(times, now - VERDENT_FREE_5H_MS)
  const currentWeekCount = lowerBound(times, now) - lowerBound(times, now - VERDENT_FREE_WEEK_MS)

  const seenBuckets = new Set<string>()
  const limitHits: VerdentFreeLimitHit[] = []
  const errors = [...input.limitErrors]
    .filter((e) => Number.isFinite(e.at) && e.at >= since && e.at < now && isVerdentFreeModelID(e.modelID))
    .sort((a, b) => a.at - b.at)

  for (const error of errors) {
    const window = classifyWindow(error.raw ?? "")
    const bucket =
      window === "5h"
        ? `5h:${Math.floor(error.at / VERDENT_FREE_5H_MS)}`
        : window === "weekly"
          ? `wk:${Math.floor(error.at / VERDENT_FREE_WEEK_MS)}`
          : `unk:${Math.floor(error.at / (10 * 60 * 1000))}`
    if (seenBuckets.has(bucket)) continue
    seenBuckets.add(bucket)
    const in5h = lowerBound(times, error.at) - lowerBound(times, error.at - VERDENT_FREE_5H_MS)
    const inWeek = lowerBound(times, error.at) - lowerBound(times, error.at - VERDENT_FREE_WEEK_MS)
    limitHits.push({ at: error.at, modelID: error.modelID, window, requestsIn5h: in5h, requestsInWeek: inWeek })
  }

  return { since, until: now, current5hCount, currentWeekCount, requests: filtered, limitHits }
}

export interface Interface {
  readonly snapshot: () => Effect.Effect<VerdentFreeSnapshot>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Usage/VerdentFree") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, filename } = yield* Database.Service
    const queryPermit = yield* Semaphore.make(1)
    let cache: { at: number; value: VerdentFreeSnapshot } | undefined

    yield* db.run(sql`CREATE INDEX IF NOT EXISTS idx_part_time_created ON part (time_created)`).pipe(Effect.orDie)
    yield* db.run(sql`CREATE INDEX IF NOT EXISTS idx_message_time_updated ON message (time_updated)`).pipe(Effect.orDie)

    const snapshot = Effect.fn("Usage.VerdentFree.snapshot")(function* () {
      const now = Date.now()
      if (cache && now - cache.at < SNAPSHOT_CACHE_TTL_MS) return cache.value
      const since = now - VERDENT_FREE_HISTORY_MS

      const value = yield* queryPermit.withPermits(1)(
        withBackfillDb(filename, (conn) =>
          Effect.gen(function* () {
            const [requests, limitErrors] = yield* Effect.all(
              [
                conn
                  .all<VerdentRequestRow>(
                    sql`
                    SELECT
                      p.time_created AS at,
                      json_extract(m.data, '$.modelID') AS model_id
                    FROM part p
                    JOIN message m ON m.id = p.message_id
                    WHERE p.time_created >= ${since}
                      AND p.time_created < ${now}
                      AND json_extract(p.data, '$.type') = 'step-finish'
                      AND json_extract(m.data, '$.role') = 'assistant'
                      AND json_extract(m.data, '$.providerID') = 'verdent'
                    ORDER BY p.time_created ASC
                  `,
                  )
                  .pipe(Effect.orDie),
                conn
                  .all<VerdentLimitErrorRow>(
                    sql`
                    SELECT
                      COALESCE(
                        json_extract(m.data, '$.time.completed'),
                        m.time_updated,
                        m.time_created
                      ) AS at,
                      json_extract(m.data, '$.modelID') AS model_id,
                      COALESCE(json_extract(m.data, '$.error.data.responseBody'), '') AS response_body
                    FROM message m
                    WHERE COALESCE(
                        json_extract(m.data, '$.time.completed'),
                        m.time_updated,
                        m.time_created
                      ) >= ${since}
                      AND json_extract(m.data, '$.role') = 'assistant'
                      AND json_extract(m.data, '$.providerID') = 'verdent'
                      AND json_extract(m.data, '$.error.name') = 'APIError'
                      AND (
                        instr(lower(COALESCE(json_extract(m.data, '$.error.data.responseBody'), '')), 'rate_limit') > 0
                        OR instr(lower(COALESCE(json_extract(m.data, '$.error.data.responseBody'), '')), 'rate limit') > 0
                        OR instr(lower(COALESCE(json_extract(m.data, '$.error.data.responseBody'), '')), 'rate-limit') > 0
                        OR instr(lower(COALESCE(json_extract(m.data, '$.error.data.responseBody'), '')), 'quota') > 0
                        OR instr(lower(COALESCE(json_extract(m.data, '$.error.data.responseBody'), '')), 'too many requests') > 0
                        OR (
                          instr(lower(COALESCE(json_extract(m.data, '$.error.data.responseBody'), '')), 'limit') > 0
                          AND (
                            instr(lower(COALESCE(json_extract(m.data, '$.error.data.responseBody'), '')), 'reached') > 0
                            OR instr(lower(COALESCE(json_extract(m.data, '$.error.data.responseBody'), '')), 'weekly') > 0
                            OR instr(lower(COALESCE(json_extract(m.data, '$.error.data.responseBody'), '')), '5h') > 0
                            OR instr(lower(COALESCE(json_extract(m.data, '$.error.data.responseBody'), '')), '5-hour') > 0
                            OR instr(lower(COALESCE(json_extract(m.data, '$.error.data.responseBody'), '')), '5 hour') > 0
                            OR instr(lower(COALESCE(json_extract(m.data, '$.error.data.responseBody'), '')), 'model limit') > 0
                          )
                        )
                      )
                    ORDER BY at ASC
                  `,
                  )
                  .pipe(Effect.orDie),
              ],
              { concurrency: 2 },
            )

            return buildVerdentFreeSnapshot({
              now,
              requests: requests.flatMap((row) =>
                typeof row.at === "number" && typeof row.model_id === "string"
                  ? [{ at: row.at, modelID: row.model_id }]
                  : [],
              ),
              limitErrors: limitErrors.flatMap((row) =>
                typeof row.at === "number" && typeof row.model_id === "string"
                  ? [{ at: row.at, modelID: row.model_id, raw: row.response_body ?? "" }]
                  : [],
              ),
            })
          }),
        ).pipe(Effect.orDie),
      )

      cache = { at: now, value }
      return value
    })

    return Service.of({ snapshot })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
