import { sql, type SQL } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import type { WorkloadRequest, WorkloadSnapshot } from "./workload"

type Reader = Pick<Database.DatabaseShape, "all" | "get">
type Distribution = WorkloadSnapshot["generation"]["requestToFirstToken"]
type MetricRow = { metric: string; samples: number; sum_ms: number; p50_ms: number | null; p95_ms: number | null }
const MAX_EXACT_QUANTILE_ROWS = 10_000
/** Fixed per-project tool-composition bound; keeps every project board bounded. */
const MAX_PROJECT_TOOLS = 5
type GenerationAggregateRow = {
  request_samples: number; request_sum: number
  client_samples: number; client_sum: number
  generation_samples: number; generation_sum: number
}
type ToolRow = {
  tool: string
  calls: number
  success: number
  error: number
  abort: number
  denied: number
  timeout: number
  unknown: number
  samples: number
  sum_ms: number
  p50_ms: number | null
  p95_ms: number | null
}
type ProjectRow = ToolRow & { project: string }
type ProjectToolRow = ToolRow & { project: string }
type ProjectNameRow = { project: string; project_name: string | null }
type ProjectDurationRow = {
  project: string
  tool: string
  project_p50_ms: number | null
  project_p95_ms: number | null
  tool_p50_ms: number | null
  tool_p95_ms: number | null
}
type GenerationTotalsRow = {
  settlements: number
  generation_ms: number
  generation_records: number
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  reasoning_tokens: number
  token_records: number
}
type GenerationProjectRow = GenerationTotalsRow & {
  project: string
  project_name: string | null
  provider_id: string
  model_id: string
}

const zeroDistribution = (): Distribution => ({ samples: 0, sumMs: 0, p50Ms: null, p95Ms: null })
const distribution = (row?: MetricRow): Distribution => row
  ? { samples: row.samples, sumMs: row.sum_ms, p50Ms: row.p50_ms, p95Ms: row.p95_ms }
  : zeroDistribution()

const project = (alias: SQL, projectID?: string) => projectID === undefined ? sql`` : sql`
  AND (EXISTS (SELECT 1 FROM session s WHERE s.id = ${alias} AND s.project_id = ${projectID})
    OR (NOT EXISTS (SELECT 1 FROM session s WHERE s.id = ${alias})
      AND EXISTS (SELECT 1 FROM usage_session us WHERE us.session_id = ${alias} AND us.project_id = ${projectID})))
`

export const generationFilter = (request: WorkloadRequest) => sql`
  r.completed_at >= ${request.since} AND r.completed_at < ${request.until}
  ${request.providerID === undefined ? sql`` : sql`AND r.provider_id = ${request.providerID}`}
  ${request.modelID === undefined ? sql`` : sql`AND r.model_id = ${request.modelID}`}
  AND COALESCE(r.mode, '') NOT IN ('maintenance', 'compaction')
  AND COALESCE(r.agent, '') NOT IN ('compaction', 'summary')
  ${project(sql`r.session_id`, request.projectID)}
`

export const toolFilter = (request: WorkloadRequest) => sql`
  t.completed_at >= ${request.since} AND t.completed_at < ${request.until}
  ${request.providerID === undefined ? sql`` : sql`AND t.provider_id = ${request.providerID}`}
  ${request.modelID === undefined ? sql`` : sql`AND t.model_id = ${request.modelID}`}
  ${request.projectID === undefined ? sql`` : sql`AND t.project_id = ${request.projectID}`}
`

const generationSamples = (request: WorkloadRequest) => sql`
  SELECT 'request' AS metric, first_token_at - request_sent_at AS duration_ms FROM usage_record r
    WHERE ${generationFilter(request)} AND request_sent_at IS NOT NULL AND first_token_at >= request_sent_at
  UNION ALL
  SELECT 'client', first_token_at - created_at FROM usage_record r
    WHERE ${generationFilter(request)} AND created_at IS NOT NULL AND first_token_at >= created_at
  UNION ALL
  SELECT 'generation', streamed_at - first_token_at FROM usage_record r
    WHERE ${generationFilter(request)} AND first_token_at IS NOT NULL AND streamed_at >= first_token_at
`

/** Three measured, non-interchangeable clocks; nearest-rank quantiles over valid samples only. */
export const generationMetricsQuery = (request: WorkloadRequest) => sql`
  WITH samples AS (${generationSamples(request)}), ranked AS (
    SELECT metric, duration_ms, ROW_NUMBER() OVER (PARTITION BY metric ORDER BY duration_ms) AS rank,
      COUNT(*) OVER (PARTITION BY metric) AS samples FROM samples
  )
  SELECT metric, MAX(samples) AS samples, SUM(duration_ms) AS sum_ms,
    MAX(CASE WHEN rank = CAST((samples + 1) / 2 AS INTEGER) THEN duration_ms END) AS p50_ms,
    MAX(CASE WHEN rank = CAST((95 * samples + 99) / 100 AS INTEGER) THEN duration_ms END) AS p95_ms
  FROM ranked GROUP BY metric
`

/**
 * Large cohorts use exact COUNT/SUM in a single indexed scalar scan, but do
 * not allocate/sort millions of latency observations for interactive viewing.
 * A null percentile explicitly signals unavailable exact quantiles.
 */
export const generationMetricsAggregateQuery = (request: WorkloadRequest) => sql`
  SELECT
    COALESCE(SUM(CASE WHEN r.request_sent_at IS NOT NULL AND r.first_token_at >= r.request_sent_at THEN 1 ELSE 0 END), 0) AS request_samples,
    COALESCE(SUM(CASE WHEN r.request_sent_at IS NOT NULL AND r.first_token_at >= r.request_sent_at
      THEN r.first_token_at - r.request_sent_at ELSE 0 END), 0) AS request_sum,
    COALESCE(SUM(CASE WHEN r.created_at IS NOT NULL AND r.first_token_at >= r.created_at THEN 1 ELSE 0 END), 0) AS client_samples,
    COALESCE(SUM(CASE WHEN r.created_at IS NOT NULL AND r.first_token_at >= r.created_at
      THEN r.first_token_at - r.created_at ELSE 0 END), 0) AS client_sum,
    COALESCE(SUM(CASE WHEN r.first_token_at IS NOT NULL AND r.streamed_at >= r.first_token_at THEN 1 ELSE 0 END), 0) AS generation_samples,
    COALESCE(SUM(CASE WHEN r.first_token_at IS NOT NULL AND r.streamed_at >= r.first_token_at
      THEN r.streamed_at - r.first_token_at ELSE 0 END), 0) AS generation_sum
  FROM usage_record r WHERE ${generationFilter(request)}
`

const toolCounts = sql`
  COUNT(*) AS calls,
  COALESCE(SUM(CASE WHEN t.status = 'success' THEN 1 ELSE 0 END), 0) AS success,
  COALESCE(SUM(CASE WHEN t.status = 'error' THEN 1 ELSE 0 END), 0) AS error,
  COALESCE(SUM(CASE WHEN t.status = 'abort' THEN 1 ELSE 0 END), 0) AS abort,
  COALESCE(SUM(CASE WHEN t.status = 'denied' THEN 1 ELSE 0 END), 0) AS denied,
  COALESCE(SUM(CASE WHEN t.status = 'timeout' THEN 1 ELSE 0 END), 0) AS timeout,
  COALESCE(SUM(CASE WHEN t.status NOT IN ('success','error','abort','denied','timeout') OR t.status IS NULL THEN 1 ELSE 0 END), 0) AS unknown,
  COALESCE(SUM(CASE WHEN t.started_at IS NOT NULL AND t.completed_at >= t.started_at THEN 1 ELSE 0 END), 0) AS samples,
  COALESCE(SUM(CASE WHEN t.started_at IS NOT NULL AND t.completed_at >= t.started_at
    THEN t.completed_at - t.started_at ELSE 0 END), 0) AS sum_ms
`

export const toolTotalsQuery = (request: WorkloadRequest) => sql`
  SELECT ${toolCounts}, MAX(t.completed_at) AS completed_at FROM native_tool_settlement t WHERE ${toolFilter(request)}
`
export const toolRowsQuery = (request: WorkloadRequest, limit: number) => sql`
  SELECT t.tool, ${toolCounts} FROM native_tool_settlement t WHERE ${toolFilter(request)}
  GROUP BY t.tool ORDER BY calls DESC, t.tool COLLATE BINARY ASC LIMIT ${limit}
`
/** Distinct failure leaderboard; high-failure low-volume tools cannot vanish from top volume. */
export const toolFailingRowsQuery = (request: WorkloadRequest, limit: number) => sql`
  SELECT t.tool, ${toolCounts} FROM native_tool_settlement t WHERE ${toolFilter(request)}
  GROUP BY t.tool HAVING error > 0 ORDER BY error DESC, calls DESC, t.tool COLLATE BINARY ASC LIMIT ${limit}
`
/** Independent cumulative-time leaderboard; catches infrequent expensive tools. */
export const toolSlowRowsQuery = (request: WorkloadRequest, limit: number) => sql`
  SELECT t.tool, ${toolCounts} FROM native_tool_settlement t WHERE ${toolFilter(request)}
  GROUP BY t.tool ORDER BY sum_ms DESC, calls DESC, t.tool COLLATE BINARY ASC LIMIT ${limit}
`
/**
 * Bounded top-projects leaderboard. Attribution is the settlement row's own
 * producer-stamped project_id (never a session/project join), so a project
 * later reassigned or deleted still lands under its settlement-time project.
 * A missing project_id surfaces as the honest `unknown` sentinel. Ranked by
 * call volume with a deterministic binary tiebreak; bounded by LIMIT.
 */
export const projectRowsQuery = (request: WorkloadRequest, limit: number) => sql`
  SELECT COALESCE(t.project_id, 'unknown') AS project, ${toolCounts}
  FROM native_tool_settlement t WHERE ${toolFilter(request)}
  GROUP BY COALESCE(t.project_id, 'unknown') ORDER BY calls DESC, project COLLATE BINARY ASC LIMIT ${limit}
`
/** Distinct project cardinality, independent of the top-N truncation. */
export const projectCountQuery = (request: WorkloadRequest) => sql`
  SELECT COUNT(*) AS count FROM (
    SELECT COALESCE(t.project_id, 'unknown') AS project FROM native_tool_settlement t WHERE ${toolFilter(request)}
    GROUP BY COALESCE(t.project_id, 'unknown')
  )
`

const projectIDList = (projects: readonly string[]) =>
  sql.join(projects.map((project) => sql`${project}`), sql`, `)

/**
 * Independent tool-failure leaderboard over projects. Ranked by error count so
 * a low-volume project with failures cannot vanish behind the volume top-N.
 */
export const projectFailingRowsQuery = (request: WorkloadRequest, limit: number) => sql`
  SELECT COALESCE(t.project_id, 'unknown') AS project, ${toolCounts}
  FROM native_tool_settlement t WHERE ${toolFilter(request)}
  GROUP BY COALESCE(t.project_id, 'unknown') HAVING error > 0
  ORDER BY error DESC, calls DESC, project COLLATE BINARY ASC LIMIT ${limit}
`
/** Independent cumulative tool-time leaderboard over projects. */
export const projectSlowRowsQuery = (request: WorkloadRequest, limit: number) => sql`
  SELECT COALESCE(t.project_id, 'unknown') AS project, ${toolCounts}
  FROM native_tool_settlement t WHERE ${toolFilter(request)}
  GROUP BY COALESCE(t.project_id, 'unknown')
  ORDER BY sum_ms DESC, calls DESC, project COLLATE BINARY ASC LIMIT ${limit}
`
/**
 * Bounded (project, tool) composition for the projects that appear on a board.
 * The result is `projects x MAX_PROJECT_TOOLS` regardless of project width; the
 * deterministic ordering keeps repeated requests stable.
 */
export const projectToolRowsQuery = (request: WorkloadRequest, projects: readonly string[]) => sql`
  WITH scoped AS (
    SELECT COALESCE(t.project_id, 'unknown') AS project, t.tool AS tool, ${toolCounts}
    FROM native_tool_settlement t
    WHERE ${toolFilter(request)} AND COALESCE(t.project_id, 'unknown') IN (${projectIDList(projects)})
    GROUP BY COALESCE(t.project_id, 'unknown'), t.tool
  ), ranked AS (
    SELECT scoped.*, ROW_NUMBER() OVER (
      PARTITION BY project ORDER BY calls DESC, sum_ms DESC, tool COLLATE BINARY ASC
    ) AS rank
    FROM scoped
  )
  SELECT project, tool, calls, success, error, abort, denied, timeout, unknown, samples, sum_ms
  FROM ranked WHERE rank <= ${MAX_PROJECT_TOOLS}
  ORDER BY project COLLATE BINARY ASC, calls DESC, sum_ms DESC, tool COLLATE BINARY ASC
`
/**
 * Exact nearest-rank tool-duration percentiles for the selected projects and for
 * each (project, tool) pair. Both window partitions share one indexed cohort
 * scan; callers gate this to bounded cohorts (see MAX_EXACT_QUANTILE_ROWS).
 */
export const projectDurationQuery = (request: WorkloadRequest, projects: readonly string[]) => sql`
  WITH scoped AS (
    SELECT COALESCE(t.project_id, 'unknown') AS project, t.tool AS tool,
      t.completed_at - t.started_at AS duration_ms
    FROM native_tool_settlement t
    WHERE ${toolFilter(request)} AND t.started_at IS NOT NULL AND t.completed_at >= t.started_at
      AND COALESCE(t.project_id, 'unknown') IN (${projectIDList(projects)})
  ), ranked AS (
    SELECT project, tool, duration_ms,
      ROW_NUMBER() OVER (PARTITION BY project ORDER BY duration_ms) AS project_rank,
      COUNT(*) OVER (PARTITION BY project) AS project_samples,
      ROW_NUMBER() OVER (PARTITION BY project, tool ORDER BY duration_ms) AS tool_rank,
      COUNT(*) OVER (PARTITION BY project, tool) AS tool_samples
    FROM scoped
  )
  SELECT project, tool,
    MAX(CASE WHEN project_rank = CAST((project_samples + 1) / 2 AS INTEGER) THEN duration_ms END) AS project_p50_ms,
    MAX(CASE WHEN project_rank = CAST((95 * project_samples + 99) / 100 AS INTEGER) THEN duration_ms END) AS project_p95_ms,
    MAX(CASE WHEN tool_rank = CAST((tool_samples + 1) / 2 AS INTEGER) THEN duration_ms END) AS tool_p50_ms,
    MAX(CASE WHEN tool_rank = CAST((95 * tool_samples + 99) / 100 AS INTEGER) THEN duration_ms END) AS tool_p95_ms
  FROM ranked
  GROUP BY project, tool
`
/**
 * Cheap display names for selected projects: the live `project` name wins and
 * the durable usage_session tombstone name is the fallback. No path resolution
 * and no workspace state; a project with neither stays explicitly unnamed.
 */
export const projectNamesQuery = (projects: readonly string[]) => sql`
  SELECT project, project_name FROM (
    SELECT proj.id AS project, proj.name AS project_name, 0 AS priority
    FROM project proj WHERE proj.id IN (${projectIDList(projects)})
    UNION ALL
    SELECT us.project_id AS project, MAX(us.project_name) AS project_name, 1 AS priority
    FROM usage_session us
    WHERE us.project_id IN (${projectIDList(projects)}) AND us.project_name IS NOT NULL
    GROUP BY us.project_id
  )
  ORDER BY project COLLATE BINARY ASC, priority ASC
`

/**
 * Model-generation project attribution mirrors Inspection: the live Session's
 * project wins over its durable usage_session tombstone, and a record with
 * neither is unattributed. Attribution joins are PK lookups only — never a
 * per-project N+1 or a history/Instance load.
 */
const generationAttributionJoins = sql`
  LEFT JOIN session proj_s ON proj_s.id = r.session_id
  LEFT JOIN usage_session proj_us ON proj_us.session_id = r.session_id
  LEFT JOIN project proj_p ON proj_p.id = COALESCE(proj_s.project_id, proj_us.project_id)
`
const generationProjectKey = sql`COALESCE(proj_s.project_id, proj_us.project_id)`
const generationProjectName = sql`COALESCE(proj_p.name, proj_us.project_name)`
const generationDurationMs = sql`CASE
  WHEN r.first_token_at IS NOT NULL AND r.streamed_at IS NOT NULL AND r.streamed_at >= r.first_token_at
    THEN r.streamed_at - r.first_token_at
  ELSE 0 END`
const generationMeasurable = sql`
  (r.first_token_at IS NOT NULL AND r.streamed_at IS NOT NULL AND r.streamed_at >= r.first_token_at)
`
const generationTokenTotal = sql`
  r.input_tokens + r.cache_read_tokens + r.cache_write_tokens + r.output_tokens + r.reasoning_tokens
`
const generationTokensSelect = sql`
  COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
  COALESCE(SUM(r.cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(r.cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(r.reasoning_tokens), 0) AS reasoning_tokens
`
const generationTotalsSelect = sql`
  COUNT(*) AS settlements,
  COALESCE(SUM(${generationDurationMs}), 0) AS generation_ms,
  COALESCE(SUM(CASE WHEN ${generationMeasurable} THEN 1 ELSE 0 END), 0) AS generation_records,
  ${generationTokensSelect},
  COALESCE(SUM(CASE WHEN ${generationTokenTotal} > 0 THEN 1 ELSE 0 END), 0) AS token_records
`

/** Full-cohort generation-project totals, independent of top-N truncation. */
export const generationProjectTotalsQuery = (request: WorkloadRequest) => sql`
  SELECT ${generationTotalsSelect}
  FROM usage_record r WHERE ${generationFilter(request)}
`
/** Orphan records with no resolvable session/project attribution. */
export const generationProjectUnattributedQuery = (request: WorkloadRequest) => sql`
  SELECT ${generationTotalsSelect}
  FROM usage_record r
  ${generationAttributionJoins}
  WHERE ${generationFilter(request)} AND ${generationProjectKey} IS NULL
`
/**
 * Bounded (project, provider, model) generation cohorts ranked by settled
 * model calls with a deterministic binary tiebreak. A deleted Session keeps
 * its usage_session tombstone attribution; a live reassigned project wins.
 */
export const generationProjectRowsQuery = (request: WorkloadRequest, limit: number) => sql`
  SELECT
    ${generationProjectKey} AS project,
    ${generationProjectName} AS project_name,
    COALESCE(r.provider_id, 'unknown') AS provider_id,
    COALESCE(r.model_id, 'unknown') AS model_id,
    ${generationTotalsSelect}
  FROM usage_record r
  ${generationAttributionJoins}
  WHERE ${generationFilter(request)} AND ${generationProjectKey} IS NOT NULL
  GROUP BY ${generationProjectKey}, ${generationProjectName}, COALESCE(r.provider_id, 'unknown'), COALESCE(r.model_id, 'unknown')
  ORDER BY settlements DESC, project COLLATE BINARY ASC, provider_id COLLATE BINARY ASC, model_id COLLATE BINARY ASC
  LIMIT ${limit}
`
/** Distinct attributed project cardinality, independent of top-N truncation. */
export const generationProjectCountQuery = (request: WorkloadRequest) => sql`
  SELECT COUNT(*) AS count FROM (
    SELECT ${generationProjectKey} AS project
    FROM usage_record r
    ${generationAttributionJoins}
    WHERE ${generationFilter(request)} AND ${generationProjectKey} IS NOT NULL
    GROUP BY ${generationProjectKey}
  )
`
export const toolTotalDurationQuery = (request: WorkloadRequest) => sql`
  WITH ranked AS (
    SELECT t.completed_at - t.started_at AS duration_ms,
      ROW_NUMBER() OVER (ORDER BY t.completed_at - t.started_at) AS rank,
      COUNT(*) OVER () AS samples
    FROM native_tool_settlement t WHERE ${toolFilter(request)} AND t.started_at IS NOT NULL
      AND t.completed_at >= t.started_at
  ) SELECT
    MAX(CASE WHEN rank = CAST((samples + 1) / 2 AS INTEGER) THEN duration_ms END) AS p50_ms,
    MAX(CASE WHEN rank = CAST((95 * samples + 99) / 100 AS INTEGER) THEN duration_ms END) AS p95_ms
  FROM ranked
`
export const toolDurationQuery = (request: WorkloadRequest, tools: readonly string[]) => sql`
  WITH ranked AS (
    SELECT t.tool, t.completed_at - t.started_at AS duration_ms,
      ROW_NUMBER() OVER (PARTITION BY t.tool ORDER BY t.completed_at - t.started_at) AS rank,
      COUNT(*) OVER (PARTITION BY t.tool) AS samples
    FROM native_tool_settlement t WHERE ${toolFilter(request)} AND t.started_at IS NOT NULL
      AND t.completed_at >= t.started_at AND t.tool IN (${sql.join(tools.map((tool) => sql`${tool}`), sql`, `)})
  ) SELECT tool,
    MAX(CASE WHEN rank = CAST((samples + 1) / 2 AS INTEGER) THEN duration_ms END) AS p50_ms,
    MAX(CASE WHEN rank = CAST((95 * samples + 99) / 100 AS INTEGER) THEN duration_ms END) AS p95_ms
  FROM ranked GROUP BY tool
`

const zeroGenerationTokens = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 })
const generationTotals = (row?: GenerationTotalsRow) => row
  ? {
      settlements: row.settlements,
      generationMs: row.generation_ms,
      generationRecords: row.generation_records,
      tokens: {
        input: row.input_tokens,
        cacheRead: row.cache_read_tokens,
        cacheWrite: row.cache_write_tokens,
        output: row.output_tokens,
        reasoning: row.reasoning_tokens,
      },
      tokenRecords: row.token_records,
    }
  : { settlements: 0, generationMs: 0, generationRecords: 0, tokens: zeroGenerationTokens(), tokenRecords: 0 }

export function runWorkload(reader: Reader, request: WorkloadRequest): Effect.Effect<WorkloadSnapshot> {
  return Effect.gen(function* () {
    const generation = yield* reader.get<{ settlements: number; completed_at: number | null }>(sql`
      SELECT COUNT(*) AS settlements, MAX(r.completed_at) AS completed_at
      FROM usage_record r WHERE ${generationFilter(request)}
    `).pipe(Effect.orDie)
    const largeGeneration = (generation?.settlements ?? 0) > MAX_EXACT_QUANTILE_ROWS
    const measured = largeGeneration
      ? yield* Effect.gen(function* () {
          const aggregate = yield* reader.get<GenerationAggregateRow>(generationMetricsAggregateQuery(request)).pipe(Effect.orDie)
          const row = (metric: string, samples: number, sum_ms: number): MetricRow =>
            ({ metric, samples, sum_ms, p50_ms: null, p95_ms: null })
          return aggregate ? [
            row("request", aggregate.request_samples, aggregate.request_sum),
            row("client", aggregate.client_samples, aggregate.client_sum),
            row("generation", aggregate.generation_samples, aggregate.generation_sum),
          ] : []
        })
      : yield* reader.all<MetricRow>(generationMetricsQuery(request)).pipe(Effect.orDie)
    const metrics = new Map(measured.map((row) => [row.metric, row] as const))
    const limit = request.limit ?? 20
    const generationProjectTotals = yield* reader.get<GenerationTotalsRow>(generationProjectTotalsQuery(request)).pipe(Effect.orDie)
    const generationUnattributed = yield* reader.get<GenerationTotalsRow>(generationProjectUnattributedQuery(request)).pipe(Effect.orDie)
    const generationProjectRows = yield* reader.all<GenerationProjectRow>(generationProjectRowsQuery(request, limit)).pipe(Effect.orDie)
    const generationProjectCount = yield* reader.get<{ count: number }>(generationProjectCountQuery(request)).pipe(Effect.orDie)
    const generationProjects = {
      provenance: "producer-settlement" as const,
      coverage: "recorded-only; historical calls may be missing" as const,
      totals: generationTotals(generationProjectTotals),
      unattributed: generationTotals(generationUnattributed),
      rows: generationProjectRows.map((row) => ({
        project: row.project,
        projectName: row.project_name,
        providerID: row.provider_id,
        modelID: row.model_id,
        ...generationTotals(row),
      })),
      totalProjects: generationProjectCount?.count ?? 0,
      omittedProjects: Math.max(0, (generationProjectCount?.count ?? 0) - new Set(generationProjectRows.map((row) => row.project)).size),
    }
    const present = yield* reader.get<{ present: number }>(sql`
      SELECT COUNT(*) AS present FROM sqlite_master WHERE type = 'table' AND name = 'native_tool_settlement'
    `).pipe(Effect.orDie)
    const empty = { calls: 0, success: 0, error: 0, abort: 0, denied: 0, timeout: 0, unknown: 0, duration: zeroDistribution() }
    const base = {
      since: request.since,
      until: request.until,
      providerID: request.providerID ?? null,
      modelID: request.modelID ?? null,
      projectID: request.projectID ?? null,
      generation: {
        settlements: generation?.settlements ?? 0,
        quantiles: largeGeneration ? "suppressed-large-cohort" as const : "exact" as const,
        requestToFirstToken: distribution(metrics.get("request")),
        clientToFirstToken: distribution(metrics.get("client")),
        streamedGeneration: distribution(metrics.get("generation")),
        providerInternalTTFT: null,
      },
    }
    if (!present?.present) return {
      ...base,
      watermark: { generationCompletedAt: generation?.completed_at ?? null, toolCompletedAt: null },
      tools: { provenance: "unavailable" as const, coverage: "unavailable" as const, firstRecordedAt: null,
        quantiles: "unavailable" as const,
        totals: empty, rows: [], topFailingRows: [], topSlowRows: [], totalTools: 0, omittedTools: 0 },
      projects: { provenance: "unavailable" as const, coverage: "unavailable" as const,
        quantiles: "unavailable" as const,
        totals: empty, rows: [], topFailingRows: [], topSlowRows: [], totalProjects: 0, omittedProjects: 0 },
      generationProjects,
    }

    const totals = yield* reader.get<ToolRow & { completed_at: number | null }>(toolTotalsQuery(request)).pipe(Effect.orDie)
    const exactToolQuantiles = (totals?.samples ?? 0) <= MAX_EXACT_QUANTILE_ROWS
    const totalDuration = totals?.samples && exactToolQuantiles
      ? yield* reader.get<{ p50_ms: number | null; p95_ms: number | null }>(toolTotalDurationQuery(request)).pipe(Effect.orDie)
      : undefined
    const rows = yield* reader.all<ToolRow>(toolRowsQuery(request, limit)).pipe(Effect.orDie)
    const failing = yield* reader.all<ToolRow>(toolFailingRowsQuery(request, limit)).pipe(Effect.orDie)
    const slow = yield* reader.all<ToolRow>(toolSlowRowsQuery(request, limit)).pipe(Effect.orDie)
    const toolCount = yield* reader.get<{ count: number }>(sql`
      SELECT COUNT(*) AS count FROM (SELECT t.tool FROM native_tool_settlement t WHERE ${toolFilter(request)} GROUP BY t.tool)
    `).pipe(Effect.orDie)
    const projectRows = yield* reader.all<ProjectRow>(projectRowsQuery(request, limit)).pipe(Effect.orDie)
    const failingProjects = yield* reader.all<ProjectRow>(projectFailingRowsQuery(request, limit)).pipe(Effect.orDie)
    const slowProjects = yield* reader.all<ProjectRow>(projectSlowRowsQuery(request, limit)).pipe(Effect.orDie)
    const projectCount = yield* reader.get<{ count: number }>(projectCountQuery(request)).pipe(Effect.orDie)
    const selectedProjects = [...new Set([...projectRows, ...failingProjects, ...slowProjects].map((row) => row.project))]
    const nameRows = selectedProjects.length
      ? yield* reader.all<ProjectNameRow>(projectNamesQuery(selectedProjects)).pipe(Effect.orDie)
      : []
    const projectNames = new Map<string, string>()
    for (const row of nameRows) {
      // Rows arrive live-name first; keep the first concrete name per project.
      if (row.project_name !== null && !projectNames.has(row.project)) projectNames.set(row.project, row.project_name)
    }
    const projectToolRows = selectedProjects.length
      ? yield* reader.all<ProjectToolRow>(projectToolRowsQuery(request, selectedProjects)).pipe(Effect.orDie)
      : []
    const projectComposition = new Map<string, ProjectToolRow[]>()
    for (const row of projectToolRows) {
      const tools = projectComposition.get(row.project) ?? []
      tools.push(row)
      projectComposition.set(row.project, tools)
    }
    const projectDurationRows = exactToolQuantiles && selectedProjects.length
      ? yield* reader.all<ProjectDurationRow>(projectDurationQuery(request, selectedProjects)).pipe(Effect.orDie)
      : []
    const projectPercentiles = new Map<string, { p50_ms: number | null; p95_ms: number | null }>()
    const projectToolPercentiles = new Map<string, { p50_ms: number | null; p95_ms: number | null }>()
    for (const row of projectDurationRows) {
      // The per-project percentile is carried by whichever (project, tool) row
      // owns the ranked sample; merge so a null pair row cannot erase it.
      const merged = projectPercentiles.get(row.project)
      projectPercentiles.set(row.project, {
        p50_ms: merged?.p50_ms ?? row.project_p50_ms,
        p95_ms: merged?.p95_ms ?? row.project_p95_ms,
      })
      projectToolPercentiles.set(`${row.project}\u0000${row.tool}`, { p50_ms: row.tool_p50_ms, p95_ms: row.tool_p95_ms })
    }
    const first = yield* reader.get<{ first: number | null }>(sql`
      SELECT MIN(completed_at) AS first FROM native_tool_settlement
    `).pipe(Effect.orDie)
    const quantileTools = exactToolQuantiles
      ? [...new Set([...rows, ...failing, ...slow].filter((row) => row.samples <= MAX_EXACT_QUANTILE_ROWS).map((row) => row.tool))]
      : []
    const durations = quantileTools.length
      ? yield* reader.all<{ tool: string; p50_ms: number | null; p95_ms: number | null }>(
          toolDurationQuery(request, quantileTools),
        ).pipe(Effect.orDie)
      : []
    const percentiles = new Map(durations.map((row) => [row.tool, row] as const))
    const counts = (row: ToolRow, ranked?: { p50_ms: number | null; p95_ms: number | null }) => ({
      calls: row.calls, success: row.success, error: row.error, abort: row.abort, denied: row.denied,
      timeout: row.timeout, unknown: row.unknown,
      duration: { samples: row.samples, sumMs: row.sum_ms,
        p50Ms: ranked?.p50_ms ?? null, p95Ms: ranked?.p95_ms ?? null },
    })
    const projectBoardRow = (row: ProjectRow) => ({
      project: row.project,
      projectName: projectNames.get(row.project) ?? null,
      ...counts(row, projectPercentiles.get(row.project)),
      topTools: (projectComposition.get(row.project) ?? []).map((tool) => ({
        tool: tool.tool,
        ...counts(tool, projectToolPercentiles.get(`${row.project}\u0000${tool.tool}`)),
      })),
    })
    return {
      ...base,
      watermark: { generationCompletedAt: generation?.completed_at ?? null, toolCompletedAt: totals?.completed_at ?? null },
      tools: {
        provenance: "producer-settlement" as const,
        coverage: "recorded-only; historical calls may be missing" as const,
        quantiles: exactToolQuantiles ? "exact" as const : "suppressed-large-cohort" as const,
        firstRecordedAt: first?.first ?? null,
        totals: totals ? counts(totals, totalDuration) : empty,
        rows: rows.map((row) => ({ tool: row.tool, ...counts(row, percentiles.get(row.tool)) })),
        topFailingRows: failing.map((row) => ({ tool: row.tool, ...counts(row, percentiles.get(row.tool)) })),
        topSlowRows: slow.map((row) => ({ tool: row.tool, ...counts(row, percentiles.get(row.tool)) })),
        totalTools: toolCount?.count ?? 0,
        omittedTools: Math.max(0, (toolCount?.count ?? 0) - rows.length),
      },
      projects: {
        provenance: "producer-settlement" as const,
        coverage: "recorded-only; historical calls may be missing" as const,
        quantiles: exactToolQuantiles ? "exact" as const : "suppressed-large-cohort" as const,
        totals: totals ? counts(totals, totalDuration) : empty,
        rows: projectRows.map(projectBoardRow),
        topFailingRows: failingProjects.map(projectBoardRow),
        topSlowRows: slowProjects.map(projectBoardRow),
        totalProjects: projectCount?.count ?? 0,
        omittedProjects: Math.max(0, (projectCount?.count ?? 0) - projectRows.length),
      },
      generationProjects,
    }
  })
}

export * as UsageWorkloadQuery from "./workload-query"
