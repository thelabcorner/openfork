import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import type { ProviderResult } from "@/quota/schema"

const HALF_LIFE = 8
const RHO = 0.5 ** (1 / HALF_LIFE)

export type BurnEstimate = {
  quotaProviderID: string
  windowKey: string
  providerID: string
  modelID?: string
  resourceKind: string
  unit: string
  burnPerRequest: number
  observations: number
  effectiveSamples: number
  updatedAt: number
}

export type ObservationInput = {
  quotaProviderID: string
  modelProviderIDs: readonly string[]
  result: ProviderResult
}

type Transaction = Parameters<Parameters<Database.DatabaseShape["transaction"]>[0]>[0]

type CursorRow = {
  observed_at: number
  position: number
  resource_limit: number | null
}

type BurnRow = {
  burn_key: string
  quota_provider_id: string
  window_key: string
  provider_id: string
  model_id: string | null
  resource_kind: string
  unit: string
  weight: number
  squared_weight: number
  sum: number
  observations: number
  updated_at: number
}

type UsageGroup = {
  provider_id: string
  base_model_id: string
  requests: number
}

function cursorKey(input: {
  quotaProviderID: string
  windowKey: string
  resourceKind: string
  unit: string
}) {
  return [input.quotaProviderID, input.windowKey, input.resourceKind, input.unit].join("\u0000")
}

function burnKey(input: {
  quotaProviderID: string
  windowKey: string
  providerID: string
  modelID?: string
  resourceKind: string
  unit: string
}) {
  return [
    input.quotaProviderID,
    input.windowKey,
    input.providerID,
    input.modelID ?? "*",
    input.resourceKind,
    input.unit,
  ].join("\u0000")
}

function resourcePosition(resource: NonNullable<NonNullable<ProviderResult["usage"]>["windows"][string]["resource"]>) {
  if (resource.used !== null && Number.isFinite(resource.used)) return resource.used
  if (resource.remaining !== null && Number.isFinite(resource.remaining)) return -resource.remaining
  return undefined
}

function sameLimit(a: number | null, b: number | null) {
  if (a === null || b === null) return a === b
  return Math.abs(a - b) <= Math.max(1e-12, Math.abs(a) * Number.EPSILON * 8)
}

export function effectiveSamples(row: Pick<BurnRow, "weight" | "squared_weight">) {
  if (!(row.weight > 0) || !(row.squared_weight > 0)) return 0
  return (row.weight * row.weight) / row.squared_weight
}

export function toEstimate(row: BurnRow): BurnEstimate | undefined {
  if (!(row.weight > 0) || !(row.sum > 0)) return undefined
  const burnPerRequest = row.sum / row.weight
  if (!(burnPerRequest > 0) || !Number.isFinite(burnPerRequest)) return undefined
  return {
    quotaProviderID: row.quota_provider_id,
    windowKey: row.window_key,
    providerID: row.provider_id,
    ...(row.model_id ? { modelID: row.model_id } : {}),
    resourceKind: row.resource_kind,
    unit: row.unit,
    burnPerRequest,
    observations: row.observations,
    effectiveSamples: effectiveSamples(row),
    updatedAt: row.updated_at,
  }
}

export function ensureTables(db: Database.DatabaseShape) {
  return Effect.gen(function* () {
    yield* db.run(
      "CREATE TABLE IF NOT EXISTS capacity_resource_cursor (" +
        "cursor_key TEXT PRIMARY KEY," +
        "quota_provider_id TEXT NOT NULL," +
        "window_key TEXT NOT NULL," +
        "resource_kind TEXT NOT NULL," +
        "unit TEXT NOT NULL," +
        "observed_at INTEGER NOT NULL," +
        "position REAL NOT NULL," +
        "resource_limit REAL," +
        "updated_at INTEGER NOT NULL" +
      ")",
    )
    yield* db.run(
      "CREATE TABLE IF NOT EXISTS capacity_resource_burn (" +
        "burn_key TEXT PRIMARY KEY," +
        "quota_provider_id TEXT NOT NULL," +
        "window_key TEXT NOT NULL," +
        "provider_id TEXT NOT NULL," +
        "model_id TEXT," +
        "resource_kind TEXT NOT NULL," +
        "unit TEXT NOT NULL," +
        "weight REAL NOT NULL," +
        "squared_weight REAL NOT NULL," +
        "sum REAL NOT NULL," +
        "observations INTEGER NOT NULL," +
        "updated_at INTEGER NOT NULL" +
      ")",
    )
    yield* db.run(
      "CREATE INDEX IF NOT EXISTS capacity_resource_burn_provider_idx " +
      "ON capacity_resource_burn (quota_provider_id, provider_id, model_id)",
    )
  }).pipe(Effect.orDie)
}


function updateBurn(
  tx: Transaction,
  input: {
    quotaProviderID: string
    windowKey: string
    providerID: string
    modelID?: string
    resourceKind: string
    unit: string
    value: number
    updatedAt: number
  },
) {
  return Effect.gen(function* () {
    if (!(input.value > 0) || !Number.isFinite(input.value)) return
    const key = burnKey(input)
    const previous = yield* tx
      .get<BurnRow>(sql`SELECT * FROM capacity_resource_burn WHERE burn_key = ${key}`)
      .pipe(Effect.orDie)

    const weight = RHO * (previous?.weight ?? 0) + 1
    const squaredWeight = RHO * RHO * (previous?.squared_weight ?? 0) + 1
    const sum = RHO * (previous?.sum ?? 0) + input.value
    const observations = (previous?.observations ?? 0) + 1

    yield* tx
      .run(sql`
        INSERT INTO capacity_resource_burn (
          burn_key, quota_provider_id, window_key, provider_id, model_id,
          resource_kind, unit, weight, squared_weight, sum, observations, updated_at
        ) VALUES (
          ${key}, ${input.quotaProviderID}, ${input.windowKey}, ${input.providerID},
          ${input.modelID ?? null}, ${input.resourceKind}, ${input.unit},
          ${weight}, ${squaredWeight}, ${sum}, ${observations}, ${input.updatedAt}
        )
        ON CONFLICT(burn_key) DO UPDATE SET
          weight = excluded.weight,
          squared_weight = excluded.squared_weight,
          sum = excluded.sum,
          observations = excluded.observations,
          updated_at = excluded.updated_at
      `)
      .pipe(Effect.orDie)
  })
}

function usageGroups(
  tx: Transaction,
  input: {
    providerIDs: readonly string[]
    after: number
    through: number
  },
) {
  if (input.providerIDs.length === 0 || input.through <= input.after) {
    return Effect.succeed([] as UsageGroup[])
  }
  const providers = sql.join(input.providerIDs.map((id) => sql`${id}`), sql`, `)
  return tx
    .all<UsageGroup>(sql`
      SELECT
        provider_id,
        COALESCE(base_model_id, model_id) AS base_model_id,
        COUNT(*) AS requests
      FROM usage_record
      WHERE completed_at > ${input.after}
        AND completed_at <= ${input.through}
        AND provider_id IN (${providers})
        AND (mode IS NULL OR mode <> 'compaction')
        AND (agent IS NULL OR (agent <> 'compaction' AND agent <> 'summary'))
      GROUP BY provider_id, COALESCE(base_model_id, model_id)
    `)
    .pipe(Effect.orDie)
}


export function observe(
  db: Database.DatabaseShape,
  inputs: readonly ObservationInput[],
) {
  return db
    .transaction(
      (tx) =>
        Effect.gen(function* () {
          for (const input of inputs) {
            if (!input.result.ok || !input.result.usage) continue
            const observedAt = input.result.fetchedAt
            if (!(observedAt > 0)) continue

            for (const [windowKey, window] of Object.entries(input.result.usage.windows)) {
              const resource = window.resource
              if (!resource || resource.kind === "requests") continue
              const position = resourcePosition(resource)
              if (position === undefined) continue

              const key = cursorKey({
                quotaProviderID: input.quotaProviderID,
                windowKey,
                resourceKind: resource.kind,
                unit: resource.unit,
              })
              const previous = yield* tx
                .get<CursorRow>(
                  sql`SELECT observed_at, position, resource_limit
                      FROM capacity_resource_cursor WHERE cursor_key = ${key}`,
                )
                .pipe(Effect.orDie)

              if (previous && observedAt > previous.observed_at) {
                const comparable = sameLimit(previous.resource_limit, resource.limit)
                const delta = position - previous.position

                if (comparable && delta > 0 && Number.isFinite(delta)) {
                  const groups = yield* usageGroups(tx, {
                    providerIDs: input.modelProviderIDs,
                    after: previous.observed_at,
                    through: observedAt,
                  })
                  const requestCount = groups.reduce(
                    (sum, group) => sum + Number(group.requests || 0),
                    0,
                  )

                  if (requestCount > 0) {
                    const globalBurn = delta / requestCount
                    for (const providerID of input.modelProviderIDs) {
                      yield* updateBurn(tx, {
                        quotaProviderID: input.quotaProviderID,
                        windowKey,
                        providerID,
                        resourceKind: resource.kind,
                        unit: resource.unit,
                        value: globalBurn,
                        updatedAt: observedAt,
                      })
                    }

                    if (groups.length === 1) {
                      const group = groups[0]!
                      yield* updateBurn(tx, {
                        quotaProviderID: input.quotaProviderID,
                        windowKey,
                        providerID: group.provider_id,
                        modelID: group.base_model_id,
                        resourceKind: resource.kind,
                        unit: resource.unit,
                        value: delta / Number(group.requests),
                        updatedAt: observedAt,
                      })
                    }
                  }
                }
              }

              if (!previous || observedAt > previous.observed_at) {
                yield* tx
                  .run(sql`
                    INSERT INTO capacity_resource_cursor (
                      cursor_key, quota_provider_id, window_key, resource_kind, unit,
                      observed_at, position, resource_limit, updated_at
                    ) VALUES (
                      ${key}, ${input.quotaProviderID}, ${windowKey}, ${resource.kind}, ${resource.unit},
                      ${observedAt}, ${position}, ${resource.limit}, ${Date.now()}
                    )
                    ON CONFLICT(cursor_key) DO UPDATE SET
                      observed_at = excluded.observed_at,
                      position = excluded.position,
                      resource_limit = excluded.resource_limit,
                      updated_at = excluded.updated_at
                    WHERE excluded.observed_at > capacity_resource_cursor.observed_at
                  `)
                  .pipe(Effect.orDie)
              }
            }
          }
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
}

export function list(db: Database.DatabaseShape) {
  return db
    .all<BurnRow>(sql`SELECT * FROM capacity_resource_burn`)
    .pipe(
      Effect.orDie,
      Effect.map((rows) =>
        rows.flatMap((row) => {
          const estimate = toEstimate(row)
          return estimate ? [estimate] : []
        }),
      ),
    )
}

export function observeAndList(
  db: Database.DatabaseShape,
  inputs: readonly ObservationInput[],
) {
  return Effect.gen(function* () {
    yield* observe(db, inputs)
    return yield* list(db)
  })
}
