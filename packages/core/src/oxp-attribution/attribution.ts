export * as OxpAttribution from "./attribution"

import { and, asc, eq, gte, inArray, lte } from "drizzle-orm"
import { Context, Effect, Layer, Semaphore } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { OxpInvocationTable } from "../oxp-activity/sql"
import type { OxpActivitySchema } from "../oxp-activity/schema"
import { OxpAttributionCalibration as Calibration } from "./calibration"
import { OxpAttributionModel as Model, type Source } from "./model"
import { OxpAttributionWatermark } from "./watermark"
import { OxpAttributionRevision } from "./revision"
import { Rollup } from "./rollup"
import { OxpAttributionStatusPolicy } from "./status-policy"
import { OxpWorkload } from "./workload"

export interface SnapshotInput {
  readonly since?: number
  readonly until?: number
  readonly activityID?: OxpActivitySchema.ActivityID
  /** Opt in to a 90-day-max, scalar-only workload projection. Requires since and until. */
  readonly includeWorkload?: boolean
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
  readonly coverage: Coverage
  readonly workload?: OxpWorkload.Profile
  readonly model: {
    readonly kind: "empirical-tool-usage"
    readonly requestCharsPerToken: number
    readonly resultCharsPerToken: number
    readonly turnGapThresholdMs: number
    readonly components: {
      readonly observedToolPayload: true
      readonly estimatedOxpTokens: true
      readonly empiricallyEstimatedUpstream: true
      readonly geometricResidency: false
      readonly availabilitySchema: false
    }
    readonly calibration: typeof Calibration.status
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
    if (!request && (row.requestChars !== null || row.requestSource !== null || row.requestSchema !== null))
      invalidPersistedMeasurements += 1
    if (!request) {
      const chars = Calibration.requestDonorChars(row.tool, row.status)
      request = chars === undefined ? undefined : { chars, source: "calibrated_donor" }
    }
    requestCoverage[request?.source ?? "unavailable"] += 1

    let result = exact(row.resultChars, row.resultSource, row.resultSchema)
    if (!result && (row.resultChars !== null || row.resultSource !== null || row.resultSchema !== null))
      invalidPersistedMeasurements += 1
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

const PROJECT_OPTIONS: Model.ProjectOptions = {
  turnGapThresholdMs: Calibration.turnGapThresholdMs,
  requestCharsPerToken: Calibration.requestCharsPerToken,
  resultCharsPerToken: Calibration.resultCharsPerToken,
  upstream: Calibration.upstream,
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

    const readRows = (
      activityID?: OxpActivitySchema.ActivityID,
      since?: number,
      until?: number,
      activityIDs?: readonly OxpActivitySchema.ActivityID[],
    ) =>
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
        // Push bounded scopes into the indexed SQL read. The sidebar uses a
        // sliding 24-hour window; in-memory filtering used to hydrate the
        // entire lifetime invocation history just to display that interval.
        const predicates = [
          ...(activityID === undefined ? [] : [eq(OxpInvocationTable.activity_id, activityID)]),
          ...(activityIDs === undefined ? [] : [inArray(OxpInvocationTable.activity_id, [...activityIDs])]),
          ...(since === undefined ? [] : [gte(OxpInvocationTable.time_started, since)]),
          ...(until === undefined ? [] : [lte(OxpInvocationTable.time_started, until)]),
        ]
        return yield* (predicates.length ? query.where(and(...predicates)) : query)
          .orderBy(
            asc(OxpInvocationTable.activity_id),
            asc(OxpInvocationTable.time_started),
            asc(OxpInvocationTable.id),
          )
          .all()
          .pipe(Effect.orDie)
      })

    const activityCaches = new Map<string, ReturnType<typeof OxpAttributionWatermark.cached<StoredRow[]>>>()

    const contribution = (rows: readonly StoredRow[]) => {
      const materialized = resolve(rows)
      return { totals: Model.project(materialized.rows, PROJECT_OPTIONS), coverage: materialized.coverage }
    }
    const windowCaches = new Map<
      string,
      ReturnType<typeof OxpAttributionWatermark.cached<ReturnType<typeof contribution>>>
    >()
    const workloadCaches = new Map<string, ReturnType<typeof OxpAttributionWatermark.cached<OxpWorkload.Profile>>>()

    // Bootstrap once from the ordered history, then reload only activities
    // named by producer commits. The rollup keeps compact contributions rather
    // than retaining raw invocation rows in process memory.
    type GlobalState = { watermark: OxpAttributionWatermark.Value; rollup: Rollup }
    let globalState: GlobalState | undefined
    const watermark = OxpAttributionWatermark.make(database.db)
    // Distinct watermark generations can overlap during rapid OXP writes.
    // Serialize only the small projection state mutation, not the writer or
    // other SQLite/HTTP activity, so stale rounds cannot corrupt the rollup.
    const incrementalAdmission = yield* Semaphore.make(1)
    const incrementalGlobal = OxpAttributionWatermark.cached(
      incrementalAdmission.withPermits(1)(Effect.gen(function* () {
        const current = yield* watermark
        const previous = globalState
        const changed = previous ? OxpAttributionRevision.changedSince(previous.watermark.localRevision) : undefined
        const incremental =
          previous !== undefined &&
          changed !== undefined &&
          Number.isFinite(previous.watermark.externalDataVersion) &&
          previous.watermark.externalDataVersion === current.externalDataVersion

        let rollup: Rollup
        if (incremental) {
          rollup = previous!.rollup
          // Fetch all replacements before mutating the aggregate so a read
          // failure cannot leave a partially updated local state.
          const replacements: Array<[string, ReturnType<typeof contribution> | undefined]> = []
          const ids = [...changed!]
          // A bounded IN query amortizes SQLite scan-lane overhead when
          // backfills or retention touch many parent activities at once.
          // Single invocation updates retain the cheaper equality lookup.
          const BATCH_SIZE = 256
          for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
            const batch = ids.slice(offset, offset + BATCH_SIZE) as OxpActivitySchema.ActivityID[]
            const rows = yield* (batch.length === 1
              ? readRows(batch[0])
              : readRows(undefined, undefined, undefined, batch))
            const byActivity = new Map<string, ReturnType<typeof contribution>>()
            for (let start = 0; start < rows.length; ) {
              let end = start + 1
              while (end < rows.length && rows[end]!.activityID === rows[start]!.activityID) end++
              byActivity.set(rows[start]!.activityID, contribution(rows.slice(start, end)))
              start = end
            }
            // Include deleted/empty activities so their previous totals are removed.
            for (const activityID of batch) replacements.push([activityID, byActivity.get(activityID)])
          }
          for (const [activityID, value] of replacements) rollup.update(activityID, value)
        } else {
          // Unobserved/foreign SQLite changes, journal eviction, and service
          // startup must rebuild; no speculative incremental correctness.
          rollup = new Rollup()
          const rows = yield* readRows()
          for (let start = 0; start < rows.length; ) {
            let end = start + 1
            while (end < rows.length && rows[end]!.activityID === rows[start]!.activityID) end++
            rollup.update(rows[start]!.activityID, contribution(rows.slice(start, end)))
            start = end
          }
        }
        if (!globalState || current.localRevision >= globalState.watermark.localRevision) {
          globalState = { watermark: current, rollup }
        }
        return rollup.snapshot(PROJECT_OPTIONS)
      })),
      watermark,
    )

    // Watermark memo objects are stable until a local OXP write or another
    // connection changes the database. Cache the *projection*, not just the SQL
    // rows: repeated UI polls used to filter, allocate and regress the complete
    // invocation history on every request, even when nothing had changed.
    // Weak keys let invalidated generations be collected without another LRU.
    const projected = new WeakMap<
      OxpAttributionWatermark.Memo<StoredRow[]>,
      Array<{ since?: number; until?: number; totals: Model.Snapshot; coverage: Coverage }>
    >()
    const MAX_SCOPE_PROJECTIONS = 8

    const projection = (memo: OxpAttributionWatermark.Memo<StoredRow[]>, input: SnapshotInput) => {
      let entries = projected.get(memo)
      if (!entries) {
        entries = []
        projected.set(memo, entries)
      }
      const index = entries.findIndex((entry) => entry.since === input.since && entry.until === input.until)
      if (index >= 0) {
        const hit = entries[index]!
        if (index !== 0) {
          entries.splice(index, 1)
          entries.unshift(hit)
        }
        return hit
      }
      const materialized = resolve(memo.value)
      const entry = {
        since: input.since,
        until: input.until,
        totals: Model.project(materialized.rows, PROJECT_OPTIONS),
        coverage: materialized.coverage,
      }
      entries.unshift(entry)
      if (entries.length > MAX_SCOPE_PROJECTIONS) entries.pop()
      return entry
    }

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

    const windowCache = (input: SnapshotInput) => {
      const key = JSON.stringify([input.activityID ?? null, input.since ?? null, input.until ?? null])
      const hit = windowCaches.get(key)
      if (hit) {
        windowCaches.delete(key)
        windowCaches.set(key, hit)
        return hit
      }
      const next = OxpAttributionWatermark.cached(
        Effect.gen(function* () {
          // Keep only compact projections in the LRU, never multiple 24-hour
          // arrays of persisted invocation rows.
          return contribution(yield* readRows(input.activityID, input.since, input.until))
        }),
        watermark,
      )
      windowCaches.set(key, next)
      while (windowCaches.size > MAX_SCOPE_PROJECTIONS) {
        const oldest = windowCaches.keys().next().value
        if (oldest === undefined) break
        windowCaches.delete(oldest)
      }
      return next
    }

    const snapshot = Effect.fn("OxpAttribution.snapshot")(function* (input: SnapshotInput = {}) {
      if (input.includeWorkload) {
        if (input.since === undefined || input.until === undefined)
          throw new Error("OXP workload requires both since and until")
        OxpWorkload.validate({ since: input.since, until: input.until, activityID: input.activityID })
      }
      const { totals, coverage } =
        input.activityID === undefined && input.since === undefined && input.until === undefined
          ? (yield* incrementalGlobal()).value
          : input.since !== undefined || input.until !== undefined
            ? (yield* windowCache(input)()).value
            : projection(yield* activityCache(input.activityID!)(), input)
      let workload: OxpWorkload.Profile | undefined
      if (input.includeWorkload) {
        const range = { since: input.since!, until: input.until!, ...(input.activityID ? { activityID: input.activityID } : {}) }
        const key = JSON.stringify([range.activityID ?? null, range.since, range.until])
        let cached = workloadCaches.get(key)
        if (cached) workloadCaches.delete(key)
        else cached = OxpAttributionWatermark.cached(OxpWorkload.read(database, range), watermark)
        workloadCaches.set(key, cached)
        while (workloadCaches.size > MAX_SCOPE_PROJECTIONS) workloadCaches.delete(workloadCaches.keys().next().value!)
        workload = (yield* cached()).value
      }
      return {
        generatedAt: Date.now(),
        scope: {
          ...(input.since === undefined ? {} : { since: input.since }),
          ...(input.until === undefined ? {} : { until: input.until }),
          ...(input.activityID === undefined ? {} : { activityID: input.activityID }),
        },
        totals,
        coverage,
        ...(workload ? { workload } : {}),
        model: {
          kind: "empirical-tool-usage" as const,
          requestCharsPerToken: Calibration.requestCharsPerToken,
          resultCharsPerToken: Calibration.resultCharsPerToken,
          turnGapThresholdMs: Calibration.turnGapThresholdMs,
          components: {
            observedToolPayload: true as const,
            estimatedOxpTokens: true as const,
            empiricallyEstimatedUpstream: true as const,
            geometricResidency: false as const,
            availabilitySchema: false as const,
          },
          calibration: Calibration.status,
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
