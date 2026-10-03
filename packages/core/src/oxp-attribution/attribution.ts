export * as OxpAttribution from "./attribution"

import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { OxpInvocationTable } from "../oxp-activity/sql"
import type { OxpActivitySchema } from "../oxp-activity/schema"
import { OxpAttributionCalibration as Calibration } from "./calibration"
import { OxpAttributionModel as Model, type Source } from "./model"
import { OxpAttributionWatermark } from "./watermark"
import { OxpAttributionStatusPolicy } from "./status-policy"

export interface SnapshotInput {
  readonly since?: number
  readonly until?: number
  readonly activityID?: OxpActivitySchema.ActivityID
}

export interface Coverage {
  readonly request: Readonly<Record<Source | "unavailable", number>>
  readonly result: Readonly<Record<Source | "unavailable" | "not_applicable", number>>
  readonly invalidPersistedMeasurements: number
  readonly complete: boolean
}

export interface Snapshot {
  readonly generatedAt: number
  readonly scope: {
    readonly since?: number
    readonly until?: number
    readonly activityID?: OxpActivitySchema.ActivityID
  }
  readonly totals: Model.Snapshot
  readonly sensitivity: {
    readonly low: { readonly rho: 0.75; readonly tokens: number }
    readonly calibrated: { readonly rho: number; readonly tokens: number }
    readonly high: { readonly rho: 0.99; readonly tokens: number }
  }
  readonly coverage: Coverage
  readonly model: {
    readonly kind: "geometric-context-residency"
    readonly rho: number
    readonly gapThresholdMs: number
    readonly requestCharsPerToken: number
    readonly resultCharsPerToken: number
    readonly components: {
      readonly callTranscript: true
      readonly returnedContent: true
      readonly repeatedContextExposure: true
      readonly availabilitySchema: false
    }
    readonly calibration: typeof Calibration.status
  }
  readonly causalAttribution: {
    readonly available: false
    readonly reason: "trace-chain-unavailable"
  }
}

type StoredRow = {
  readonly id: string
  readonly activityID: string
  readonly tool: string
  readonly status: string
  readonly startedAt: number
  readonly completedAt: number | null
  readonly requestChars: number | null
  readonly requestSource: "observed_boundary" | "historical_detail" | null
  readonly requestSchema: "oxp-boundary-primary-text/v1" | "oxp-primary-args-output-error/v1" | null
  readonly resultChars: number | null
  readonly resultSource: "observed_boundary" | "historical_detail" | null
  readonly resultSchema: "oxp-boundary-primary-text/v1" | "oxp-primary-args-output-error/v1" | null
}

const emptyRequestCoverage = (): Record<Source | "unavailable", number> => ({
  observed_boundary: 0,
  historical_detail: 0,
  calibrated_surrogate: 0,
  calibrated_donor: 0,
  unavailable: 0,
})

const emptyResultCoverage = (): Record<Source | "unavailable" | "not_applicable", number> => ({
  observed_boundary: 0,
  historical_detail: 0,
  calibrated_surrogate: 0,
  calibrated_donor: 0,
  unavailable: 0,
  not_applicable: 0,
})

function exact(
  chars: number | null,
  source: StoredRow["requestSource"],
  schema: StoredRow["requestSchema"],
): Model.Mass | undefined {
  if (chars === null || source === null || schema === null || !Number.isFinite(chars) || chars < 0) return
  if (source === "observed_boundary" && schema !== "oxp-boundary-primary-text/v1") return
  if (source === "historical_detail" && schema !== "oxp-primary-args-output-error/v1") return
  return { chars, source }
}

function resolve(rows: readonly StoredRow[]) {
  const requestCoverage = emptyRequestCoverage()
  const resultCoverage = emptyResultCoverage()
  let invalidPersistedMeasurements = 0

  const resolved = rows.map((row): Model.Row => {
    let request = exact(row.requestChars, row.requestSource, row.requestSchema)
    if (!request && (row.requestChars !== null || row.requestSource !== null || row.requestSchema !== null)) {
      invalidPersistedMeasurements += 1
    }
    if (!request) {
      const chars = Calibration.requestDonorChars(row.tool, row.status)
      request = chars === undefined ? undefined : { chars, source: "calibrated_donor" }
    }
    requestCoverage[request?.source ?? "unavailable"] += 1

    let result = exact(row.resultChars, row.resultSource, row.resultSchema)
    if (!result && (row.resultChars !== null || row.resultSource !== null || row.resultSchema !== null)) {
      invalidPersistedMeasurements += 1
    }
    if (result) {
      resultCoverage[result.source] += 1
    } else {
      const expectation = OxpAttributionStatusPolicy.responseExpectation(row.status)
      if (expectation === false) {
        resultCoverage.not_applicable += 1
      } else if (expectation === true) {
        const chars = Calibration.resultDonorChars(row.tool, row.status)
        result = chars === undefined ? undefined : { chars, source: "calibrated_donor" }
        resultCoverage[result?.source ?? "unavailable"] += 1
      } else {
        resultCoverage.unavailable += 1
      }
    }

    return {
      id: row.id,
      activityID: row.activityID,
      tool: row.tool,
      status: row.status,
      startedAt: row.startedAt,
      ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
      ...(request ? { request } : {}),
      ...(result ? { result } : {}),
    }
  })

  return {
    rows: resolved,
    coverage: {
      request: requestCoverage,
      result: resultCoverage,
      invalidPersistedMeasurements,
      complete:
        requestCoverage.unavailable === 0 && resultCoverage.unavailable === 0 && invalidPersistedMeasurements === 0,
    } satisfies Coverage,
  }
}

function options(rho: number): Model.ProjectOptions {
  return {
    rho,
    gapThresholdMs: Calibration.gapThresholdMs,
    requestCharsPerToken: Calibration.requestCharsPerToken,
    resultCharsPerToken: Calibration.resultCharsPerToken,
  }
}

export interface Interface {
  readonly snapshot: (input?: SnapshotInput) => Effect.Effect<Snapshot>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/core/OxpAttribution") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const MAX_ACTIVITY_CACHES = 8

    const readRows = (activityID?: OxpActivitySchema.ActivityID) =>
      Effect.gen(function* () {
        const scan = yield* database.scanDb()
        const query = scan
          .select({
            id: OxpInvocationTable.id,
            activityID: OxpInvocationTable.activity_id,
            tool: OxpInvocationTable.tool,
            status: OxpInvocationTable.status,
            startedAt: OxpInvocationTable.time_started,
            completedAt: OxpInvocationTable.time_completed,
            requestChars: OxpInvocationTable.context_request_chars,
            requestSource: OxpInvocationTable.context_request_source,
            requestSchema: OxpInvocationTable.context_request_schema,
            resultChars: OxpInvocationTable.context_result_chars,
            resultSource: OxpInvocationTable.context_result_source,
            resultSchema: OxpInvocationTable.context_result_schema,
          })
          .from(OxpInvocationTable)
        return yield* (activityID === undefined ? query : query.where(eq(OxpInvocationTable.activity_id, activityID)))
          .orderBy(
            asc(OxpInvocationTable.activity_id),
            asc(OxpInvocationTable.time_started),
            asc(OxpInvocationTable.id),
          )
          .all()
          .pipe(Effect.orDie)
      })

    const cachedGlobal = OxpAttributionWatermark.cached(readRows(), OxpAttributionWatermark.make(database.db))
    const activityCaches = new Map<string, ReturnType<typeof OxpAttributionWatermark.cached<StoredRow[]>>>()

    const activityCache = (activityID: OxpActivitySchema.ActivityID) => {
      const hit = activityCaches.get(activityID)
      if (hit) {
        activityCaches.delete(activityID)
        activityCaches.set(activityID, hit)
        return hit
      }
      const next = OxpAttributionWatermark.cached(readRows(activityID), OxpAttributionWatermark.make(database.db))
      activityCaches.set(activityID, next)
      while (activityCaches.size > MAX_ACTIVITY_CACHES) {
        const oldest = activityCaches.keys().next().value
        if (oldest === undefined) break
        activityCaches.delete(oldest)
      }
      return next
    }

    const snapshot = Effect.fn("OxpAttribution.snapshot")(function* (input: SnapshotInput = {}) {
      const memo = input.activityID === undefined ? yield* cachedGlobal() : yield* activityCache(input.activityID)()
      const selected = memo.value.filter(
        (row) =>
          (input.since === undefined || row.startedAt >= input.since) &&
          (input.until === undefined || row.startedAt <= input.until),
      )
      const materialized = resolve(selected)
      const totals = Model.project(materialized.rows, options(Calibration.rho))
      const lowTokens = Model.projectTokenTotal(
        materialized.rows,
        options(0.75),
      )
      const highTokens = Model.projectTokenTotal(
        materialized.rows,
        options(0.99),
      )
      return {
        generatedAt: Date.now(),
        scope: {
          ...(input.since === undefined ? {} : { since: input.since }),
          ...(input.until === undefined ? {} : { until: input.until }),
          ...(input.activityID === undefined ? {} : { activityID: input.activityID }),
        },
        totals,
        sensitivity: {
          low: { rho: 0.75 as const, tokens: lowTokens },
          calibrated: { rho: Calibration.rho, tokens: totals.tokens },
          high: { rho: 0.99 as const, tokens: highTokens },
        },
        coverage: materialized.coverage,
        model: {
          kind: "geometric-context-residency" as const,
          rho: Calibration.rho,
          gapThresholdMs: Calibration.gapThresholdMs,
          requestCharsPerToken: Calibration.requestCharsPerToken,
          resultCharsPerToken: Calibration.resultCharsPerToken,
          components: {
            callTranscript: true as const,
            returnedContent: true as const,
            repeatedContextExposure: true as const,
            availabilitySchema: false as const,
          },
          calibration: Calibration.status,
        },
        causalAttribution: {
          available: false as const,
          reason: "trace-chain-unavailable" as const,
        },
      } satisfies Snapshot
    })

    return Service.of({ snapshot })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node],
})
