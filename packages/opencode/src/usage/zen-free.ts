import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Semaphore } from "effect"
import { Database, withBackfillDb } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"

export const ZEN_FREE_DAY_MS = 86_400_000
export const ZEN_FREE_HISTORY_DAYS = 90
export const ZEN_FREE_HISTORY_MS = ZEN_FREE_HISTORY_DAYS * ZEN_FREE_DAY_MS

const SNAPSHOT_CACHE_TTL_MS = 30_000

export type ZenFreeRequestEvent = {
  at: number
  modelID: string
}

export type ZenFreeLimitErrorEvent = {
  at: number
  modelID: string
}

export type ZenFreeDay = {
  start: number
  requests: number
}

export type ZenFreeLimitHit = {
  at: number
  requests: number
  modelID: string
}

export type ZenFreeSnapshot = {
  since: number
  until: number
  currentDayStart: number
  currentRequests: number
  days: ZenFreeDay[]
  limitHits: ZenFreeLimitHit[]
}

type ZenRequestRow = {
  at: number | null
  model_id: string | null
}

type ZenLimitErrorRow = {
  at: number | null
  model_id: string | null
}

export function zenUtcDayStart(timestamp: number) {
  return Math.floor(timestamp / ZEN_FREE_DAY_MS) * ZEN_FREE_DAY_MS
}

export function zenUtcDayEnd(timestamp: number) {
  return zenUtcDayStart(timestamp) + ZEN_FREE_DAY_MS
}

/**
 * Zen's catalog changes frequently. Current promotional free models use the
 * `-free` suffix, with `big-pickle` as the long-lived exception. Keeping the
 * discriminator structural means newly-added `*-free` models are learned
 * without a client release while paid Zen traffic is not folded into the
 * anonymous free quota.
 */
export function isZenFreeModelID(modelID: string | null | undefined) {
  if (!modelID) return false
  const normalized = modelID.trim().toLowerCase()
  return normalized === "big-pickle" || normalized.endsWith("-free")
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

/**
 * Convert persisted request/error events into the compact evidence needed by
 * the quota learner. A successful `step-finish` is the counted request unit;
 * assistant messages are deliberately not used because one assistant turn can
 * contain multiple provider generation steps around tool calls.
 *
 * Multiple post-exhaustion errors on the same UTC day are one quota episode.
 * The first persisted FreeUsageLimitError is the useful calibration point.
 */
export function buildZenFreeSnapshot(input: {
  now: number
  requests: readonly ZenFreeRequestEvent[]
  limitErrors: readonly ZenFreeLimitErrorEvent[]
  historyMs?: number
}): ZenFreeSnapshot {
  const now = input.now
  const historyMs = Math.max(ZEN_FREE_DAY_MS, input.historyMs ?? ZEN_FREE_HISTORY_MS)
  const since = zenUtcDayStart(now - historyMs)
  const currentDayStart = zenUtcDayStart(now)
  const requestTimesByDay = new Map<number, number[]>()

  for (const request of input.requests) {
    if (!Number.isFinite(request.at) || request.at < since || request.at >= now) continue
    if (!isZenFreeModelID(request.modelID)) continue
    const day = zenUtcDayStart(request.at)
    const list = requestTimesByDay.get(day)
    if (list) list.push(request.at)
    else requestTimesByDay.set(day, [request.at])
  }

  for (const list of requestTimesByDay.values()) list.sort((a, b) => a - b)

  const days = [...requestTimesByDay.entries()]
    .map(([start, requests]) => ({ start, requests: requests.length }))
    .sort((a, b) => a.start - b.start)

  const seenHitDays = new Set<number>()
  const limitHits: ZenFreeLimitHit[] = []
  const errors = [...input.limitErrors].sort((a, b) => a.at - b.at)
  for (const error of errors) {
    if (!Number.isFinite(error.at) || error.at < since || error.at >= now) continue
    if (!isZenFreeModelID(error.modelID)) continue
    const day = zenUtcDayStart(error.at)
    if (seenHitDays.has(day)) continue
    seenHitDays.add(day)
    const requests = requestTimesByDay.get(day) ?? []
    limitHits.push({
      at: error.at,
      requests: lowerBound(requests, error.at),
      modelID: error.modelID,
    })
  }

  return {
    since,
    until: now,
    currentDayStart,
    currentRequests: requestTimesByDay.get(currentDayStart)?.length ?? 0,
    days,
    limitHits,
  }
}

export interface Interface {
  readonly snapshot: () => Effect.Effect<ZenFreeSnapshot>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Usage/ZenFree") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, filename } = yield* Database.Service
    const queryPermit = yield* Semaphore.make(1)
    let cache: { at: number; value: ZenFreeSnapshot } | undefined

    // These narrow time indexes keep the 90-day historical scan cheap even on
    // large long-lived OpenCode databases. JSON predicates remain post-filtered.
    yield* db.run(sql`CREATE INDEX IF NOT EXISTS idx_part_time_created ON part (time_created)`).pipe(Effect.orDie)
    yield* db.run(sql`CREATE INDEX IF NOT EXISTS idx_message_time_updated ON message (time_updated)`).pipe(Effect.orDie)

    const snapshot = Effect.fn("Usage.ZenFree.snapshot")(function* () {
      const now = Date.now()
      if (cache && now - cache.at < SNAPSHOT_CACHE_TTL_MS) return cache.value
      const since = zenUtcDayStart(now - ZEN_FREE_HISTORY_MS)

      const value = yield* queryPermit.withPermits(1)(
        withBackfillDb(filename, (conn) =>
          Effect.gen(function* () {
            const [requests, limitErrors] = yield* Effect.all(
              [
                conn
                  .all<ZenRequestRow>(sql`
                    SELECT
                      p.time_created AS at,
                      json_extract(m.data, '$.modelID') AS model_id
                    FROM part p
                    JOIN message m ON m.id = p.message_id
                    WHERE p.time_created >= ${since}
                      AND p.time_created < ${now}
                      AND json_extract(p.data, '$.type') = 'step-finish'
                      AND json_extract(m.data, '$.role') = 'assistant'
                      AND json_extract(m.data, '$.providerID') = 'opencode'
                    ORDER BY p.time_created ASC
                  `)
                  .pipe(Effect.orDie),
                conn
                  .all<ZenLimitErrorRow>(sql`
                    SELECT
                      COALESCE(
                        json_extract(m.data, '$.time.completed'),
                        m.time_updated,
                        m.time_created
                      ) AS at,
                      json_extract(m.data, '$.modelID') AS model_id
                    FROM message m
                    WHERE COALESCE(
                        json_extract(m.data, '$.time.completed'),
                        m.time_updated,
                        m.time_created
                      ) >= ${since}
                      AND json_extract(m.data, '$.role') = 'assistant'
                      AND json_extract(m.data, '$.providerID') = 'opencode'
                      AND json_extract(m.data, '$.error.name') = 'APIError'
                      AND instr(
                        COALESCE(json_extract(m.data, '$.error.data.responseBody'), ''),
                        'FreeUsageLimitError'
                      ) > 0
                    ORDER BY at ASC
                  `)
                  .pipe(Effect.orDie),
              ],
              { concurrency: 2 },
            )

            return buildZenFreeSnapshot({
              now,
              requests: requests.flatMap((row) =>
                typeof row.at === "number" && typeof row.model_id === "string"
                  ? [{ at: row.at, modelID: row.model_id }]
                  : [],
              ),
              limitErrors: limitErrors.flatMap((row) =>
                typeof row.at === "number" && typeof row.model_id === "string"
                  ? [{ at: row.at, modelID: row.model_id }]
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
