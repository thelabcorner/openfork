export * as OxpWorkload from "./workload"

import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database, DatabaseShape } from "../database/database"
import { OxpInvocationTable as Invocation } from "../oxp-activity/sql"
import type { OxpActivitySchema } from "../oxp-activity/schema"

export const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1_000
const MAX_POINTS = 120
const MAX_TOOLS = 12
const MAX_QUANTILE_ROWS = 5_000

export interface Input {
  readonly since: number
  readonly until: number
  readonly activityID?: OxpActivitySchema.ActivityID
}

export interface Metrics {
  readonly calls: number
  readonly successes: number
  readonly failures: number
  readonly denied: number
  readonly cancelled: number
  readonly interrupted: number
  readonly running: number
  readonly unknown: number
  /** Denominator excludes denied, cancelled, interrupted, running and unknown. */
  readonly failureRate: number | null
  readonly measuredDurations: number
  readonly missingDurations: number
  /** Sum of overlapping tool wall times, not user-visible blocked time. */
  readonly toolWallMs: number
  /** Exact nearest-rank quantiles; null below the sample threshold or above the query cap. */
  readonly p50Ms: number | null
  readonly p95Ms: number | null
}

export interface Profile {
  readonly scope: Input
  readonly bucketWidthMs: number
  readonly totals: Metrics
  readonly tools: readonly (Metrics & { readonly tool: string })[]
  /** Failure ranking is independent of top call volume. */
  readonly topFailures: readonly (Metrics & { readonly tool: string })[]
  /** Independent time-contribution leaderboard. */
  readonly topTime: readonly (Metrics & { readonly tool: string })[]
  readonly otherTools: number
  readonly otherCalls: number
  readonly buckets: readonly ({ readonly start: number } & Pick<Metrics, "calls" | "successes" | "failures">)[]
  readonly coverage: {
    /** Historical telemetry onset is not known; do not imply lifetime coverage. */
    readonly historicalCompleteness: "unknown"
    readonly quantileSampleLimit: number
    readonly p50MinimumSamples: 5
    readonly p95MinimumSamples: 20
  }
}

export function validate(input: Input) {
  if (!Number.isSafeInteger(input.since) || !Number.isSafeInteger(input.until) ||
      input.since < 0 || input.until < input.since || input.until - input.since > MAX_RANGE_MS)
    throw new Error("OXP workload requires an ordered time range of at most 90 days")
}

const success = sql`status IN ('success', 'committed')`
const failure = sql`status IN ('failed', 'conflict')`
const denied = sql`status = 'denied'`
const cancelled = sql`status IN ('cancelled_before_commit', 'cancelled_after_commit')`
const interrupted = sql`status = 'interrupted'`
const running = sql`status = 'running'`
const known = sql`${success} OR ${failure} OR ${denied} OR ${cancelled} OR ${interrupted} OR ${running}`
const duration = sql<number>`${Invocation.time_completed} - ${Invocation.time_started}`
const measurable = sql`${Invocation.status} <> 'running' AND ${Invocation.time_completed} IS NOT NULL AND ${duration} >= 0`
const count = (condition: ReturnType<typeof sql>) => sql<number>`SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END)`
const metrics = {
  calls: sql<number>`COUNT(*)`,
  successes: count(success),
  failures: count(failure),
  denied: count(denied),
  cancelled: count(cancelled),
  interrupted: count(interrupted),
  running: count(running),
  unknown: count(sql`NOT (${known})`),
  measuredDurations: count(measurable),
  toolWallMs: sql<number>`COALESCE(SUM(CASE WHEN ${measurable} THEN ${duration} ELSE 0 END), 0)`,
}

type Aggregate = { [K in keyof typeof metrics]: number }

function project(row: Partial<Aggregate>, samples: readonly number[]): Metrics {
  const calls = row.calls ?? 0
  const successes = row.successes ?? 0
  const failures = row.failures ?? 0
  const measuredDurations = row.measuredDurations ?? 0
  const quantile = (minimum: number, fraction: number) =>
    measuredDurations >= minimum && measuredDurations <= MAX_QUANTILE_ROWS && samples.length === measuredDurations
      ? samples[Math.ceil(measuredDurations * fraction) - 1] ?? null
      : null
  return {
    calls, successes, failures,
    denied: row.denied ?? 0,
    cancelled: row.cancelled ?? 0,
    interrupted: row.interrupted ?? 0,
    running: row.running ?? 0,
    unknown: row.unknown ?? 0,
    failureRate: successes + failures ? failures / (successes + failures) : null,
    measuredDurations,
    missingDurations: calls - measuredDurations,
    toolWallMs: row.toolWallMs ?? 0,
    p50Ms: quantile(5, 0.5),
    p95Ms: quantile(20, 0.95),
  }
}

/** Scalar indexed range projection. No invocation detail join or transcript decoding. */
export const read = (database: Database.Interface, input: Input): Effect.Effect<Profile> =>
  Effect.gen(function* () {
    validate(input)
    const width = Math.max(1, Math.ceil((input.until - input.since + 1) / MAX_POINTS))
    const size = Math.ceil((input.until - input.since + 1) / width)
    const predicate = and(
      gte(Invocation.time_started, input.since),
      lte(Invocation.time_started, input.until),
      ...(input.activityID ? [eq(Invocation.activity_id, input.activityID)] : []),
    )
    const bucket = sql<number>`CAST((${Invocation.time_started} - ${input.since}) / ${width} AS INTEGER)`
    const query = (db: DatabaseShape) => db.transaction((tx) =>
      Effect.gen(function* () {
        const total = yield* tx.select({ ...metrics, distinctTools: sql<number>`COUNT(DISTINCT ${Invocation.tool})` })
          .from(Invocation).where(predicate).get().pipe(Effect.orDie)
        const top = yield* tx.select({ tool: Invocation.tool, ...metrics })
          .from(Invocation).where(predicate).groupBy(Invocation.tool)
          .orderBy(desc(metrics.calls), asc(Invocation.tool)).limit(MAX_TOOLS).all().pipe(Effect.orDie)
        const failing = yield* tx.select({ tool: Invocation.tool, ...metrics })
          .from(Invocation).where(predicate).groupBy(Invocation.tool)
          .having(sql`${metrics.failures} > 0`)
          .orderBy(desc(metrics.failures), desc(metrics.calls), asc(Invocation.tool))
          .limit(MAX_TOOLS).all().pipe(Effect.orDie)
        const slow = yield* tx.select({ tool: Invocation.tool, ...metrics })
          .from(Invocation).where(predicate).groupBy(Invocation.tool)
          .orderBy(desc(metrics.toolWallMs), desc(metrics.calls), asc(Invocation.tool))
          .limit(MAX_TOOLS).all().pipe(Effect.orDie)
        const grouped = yield* tx.select({ bucket, calls: metrics.calls, successes: metrics.successes, failures: metrics.failures })
          .from(Invocation).where(predicate).groupBy(bucket).orderBy(asc(bucket)).all().pipe(Effect.orDie)

        // Exact quantiles only for bounded cohorts. Large cohorts retain exact counts,
        // wall time and coverage; null prevents a biased capped percentile.
        const topNames = top.filter((row) => row.measuredDurations >= 5 && row.measuredDurations <= MAX_QUANTILE_ROWS)
          .map((row) => row.tool)
        const samples = topNames.length ? yield* tx.select({ tool: Invocation.tool, duration })
          .from(Invocation).where(and(predicate, inArray(Invocation.tool, topNames), measurable))
          .orderBy(asc(Invocation.tool), asc(duration), asc(Invocation.id))
          .limit(MAX_TOOLS * MAX_QUANTILE_ROWS).all().pipe(Effect.orDie) : []
        const byTool = new Map<string, number[]>()
        for (const row of samples) {
          const values = byTool.get(row.tool) ?? []
          values.push(row.duration)
          byTool.set(row.tool, values)
        }
        const totalSamples = total && total.measuredDurations >= 5 && total.measuredDurations <= MAX_QUANTILE_ROWS
          ? yield* tx.select({ duration }).from(Invocation).where(and(predicate, measurable))
            .orderBy(asc(duration), asc(Invocation.id)).limit(MAX_QUANTILE_ROWS).all().pipe(Effect.orDie)
          : []
        const rows = new Map(grouped.map((row) => [row.bucket, row]))
        return {
          scope: input,
          bucketWidthMs: width,
          totals: project(total ?? {}, totalSamples.map((row) => row.duration)),
          tools: top.map((row) => ({ tool: row.tool, ...project(row, byTool.get(row.tool) ?? []) })),
          topFailures: failing.map((row) => ({ tool: row.tool, ...project(row, byTool.get(row.tool) ?? []) })),
          topTime: slow.map((row) => ({ tool: row.tool, ...project(row, byTool.get(row.tool) ?? []) })),
          otherTools: (total?.distinctTools ?? 0) - top.length,
          otherCalls: (total?.calls ?? 0) - top.reduce((sum, row) => sum + row.calls, 0),
          buckets: Array.from({ length: size }, (_, index) => ({
            start: input.since + index * width,
            calls: rows.get(index)?.calls ?? 0,
            successes: rows.get(index)?.successes ?? 0,
            failures: rows.get(index)?.failures ?? 0,
          })),
          coverage: {
            historicalCompleteness: "unknown" as const,
            quantileSampleLimit: MAX_QUANTILE_ROWS,
            p50MinimumSamples: 5 as const,
            p95MinimumSamples: 20 as const,
          },
        } satisfies Profile
      }),
    ).pipe(Effect.orDie)
    return yield* (database.withScanDb ? database.withScanDb(query) : query(yield* database.scanDb()))
  })
