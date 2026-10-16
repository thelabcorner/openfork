import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import type {
  InspectionBreakdownResult,
  InspectionBreakdownRow,
  InspectionDimension,
  InspectionMaintenanceResult,
  InspectionMaintenanceRow,
  InspectionTimelinePoint,
  InspectionTimelineResult,
  InspectionTokens,
  InspectionTotalsResult,
  UsageInspectionRequest,
  UsageInspectionResult,
} from "./inspection"
import { cacheSavings, estimateCost, type ModelRates, type ValuationTokens } from "./valuation"
import { queryTimelineRows, valueTimelineRow } from "./inspection-timeline"
import { usageScopedProjectFilter } from "./summary-row-query"

type CompactRow = {
  provider_id: string
  model_id: string
  dimension_key: string | null
  dimension_label: string | null
  messages: number
  sessions: number
  recorded_cost: number
  recorded_records: number
  missing_records: number
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  reasoning_tokens: number
  missing_input_tokens: number
  missing_cache_read_tokens: number
  missing_cache_write_tokens: number
  missing_output_tokens: number
  missing_reasoning_tokens: number
  duration_ms: number
  duration_records: number
  ttft_ms: number
  ttft_records: number
  generation_ms: number
}

type SessionCountRow = {
  dimension_key: string
  sessions: number
}

type MaintenanceRow = {
  agent: string
  provider_id: string
  model_id: string
  requests: number
  sessions: number
  recorded_cost: number
  supplied_estimated_cost: number
  supplied_estimated_records: number
  missing_records: number
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  reasoning_tokens: number
  missing_input_tokens: number
  missing_cache_read_tokens: number
  missing_cache_write_tokens: number
  missing_output_tokens: number
  missing_reasoning_tokens: number
  total_tokens: number
  duration_ms: number
  duration_records: number
}

type Valued = {
  recordedCost: number
  estimatedCost: number
  pricedRecords: number
  unpricedRecords: number
  estimatedRecords: number
  cacheSavings: number
  rateKnownRecords: number
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const zeroTokens = (): InspectionTokens => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
})

const addTokens = (target: InspectionTokens, row: {
  input_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  output_tokens: number
  reasoning_tokens: number
}) => {
  const mutable = target as { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }
  mutable.input += row.input_tokens
  mutable.cacheRead += row.cache_read_tokens
  mutable.cacheWrite += row.cache_write_tokens
  mutable.output += row.output_tokens
  mutable.reasoning += row.reasoning_tokens
}

const tokenTotal = (tokens: InspectionTokens) =>
  tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output + tokens.reasoning

const safeDiv = (numerator: number, denominator: number) => (denominator > 0 ? numerator / denominator : 0)

const modelRate = (rates: ReadonlyMap<string, ModelRates>, row: { provider_id: string; model_id: string }) =>
  rates.get(`${row.provider_id}/${row.model_id}`)

const missingTokens = (row: CompactRow | MaintenanceRow): ValuationTokens => ({
  input: row.missing_input_tokens,
  cacheRead: row.missing_cache_read_tokens,
  cacheWrite: row.missing_cache_write_tokens,
  output: row.missing_output_tokens,
  reasoning: row.missing_reasoning_tokens,
})

const allTokens = (row: CompactRow | MaintenanceRow): ValuationTokens => ({
  input: row.input_tokens,
  cacheRead: row.cache_read_tokens,
  cacheWrite: row.cache_write_tokens,
  output: row.output_tokens,
  reasoning: row.reasoning_tokens,
})

function valueCompact(row: CompactRow, rates: ReadonlyMap<string, ModelRates>): Valued {
  const rate = modelRate(rates, row)
  const estimate = rate && row.missing_records > 0 ? estimateCost(missingTokens(row), rate) : 0
  return {
    recordedCost: row.recorded_cost,
    estimatedCost: estimate,
    pricedRecords: row.recorded_records + (rate ? row.missing_records : 0),
    unpricedRecords: rate ? 0 : row.missing_records,
    estimatedRecords: rate ? row.missing_records : 0,
    cacheSavings: cacheSavings(allTokens(row), rate),
    rateKnownRecords: rate ? row.messages : 0,
  }
}

function valueMaintenance(row: MaintenanceRow, rates: ReadonlyMap<string, ModelRates>): Valued {
  const rate = modelRate(rates, row)
  const derived = rate && row.missing_records > 0 ? estimateCost(missingTokens(row), rate) : 0
  const costed = Math.max(0, row.requests - row.missing_records)
  return {
    recordedCost: row.recorded_cost,
    estimatedCost: row.supplied_estimated_cost + derived,
    pricedRecords: costed + (rate ? row.missing_records : 0),
    unpricedRecords: rate ? 0 : row.missing_records,
    // Match Usage.aggregate(): catalog-derived estimates are priced but only
    // explicitly estimated durable maintenance rows increment estimatedRecords.
    estimatedRecords: row.supplied_estimated_records,
    cacheSavings: 0,
    rateKnownRecords: rate ? row.requests : 0,
  }
}

function projectFilter(projectID: string | null | undefined, indexedProject: boolean) {
  // Keep the common global path genuinely join-free. The previous `NULL IS
  // NULL OR ...` predicate was logically free but still forced every compact
  // query to carry the Session/usage_session joins needed only for project
  // attribution. On large ledgers that erased much of the benefit of grouped
  // SQL compared with the rich Usage summary.
  if (projectID === undefined || projectID === null) return sql`1`
  // Orphan records without a Session or tombstone deliberately keep the
  // historical fallback. All real project IDs use indexed Session membership.
  if (indexedProject && projectID !== "__historical__") return usageScopedProjectFilter(projectID)
  return sql`COALESCE(s.project_id, us.project_id, '__historical__') = ${projectID}`
}

// Use the (project_id, time_completed) index for scoped maintenance queries.
function maintenanceProjectFilter(projectID: string | null | undefined) {
  if (projectID === undefined || projectID === null) return sql`1`
  return sql`m.project_id = ${projectID}`
}

function ordinaryFilter(request: { since: number; until: number; projectID?: string | null }, indexedProject: boolean) {
  return sql`
    r.completed_at >= ${request.since}
    AND r.completed_at < ${request.until}
    AND ${projectFilter(request.projectID, indexedProject)}
    AND COALESCE(r.mode, '') <> 'maintenance'
    AND COALESCE(r.mode, '') <> 'compaction'
    AND COALESCE(r.agent, '') <> 'compaction'
    AND COALESCE(r.agent, '') <> 'summary'
  `
}

const attributionJoins = sql`
  LEFT JOIN session s ON s.id = r.session_id
  LEFT JOIN usage_session us ON us.session_id = r.session_id
`

const projectNameJoin = sql`LEFT JOIN project p ON p.id = COALESCE(s.project_id, us.project_id)`

function usageJoins(request: { projectID?: string | null }, projectBreakdown = false, indexedProject = false) {
  if (!projectBreakdown && (indexedProject || request.projectID === undefined || request.projectID === null)) return sql``
  return projectBreakdown ? sql`${attributionJoins} ${projectNameJoin}` : attributionJoins
}

function compactSelect(dimensionKey: ReturnType<typeof sql>, dimensionLabel: ReturnType<typeof sql>) {
  return sql`
    COALESCE(r.provider_id, 'unknown') AS provider_id,
    COALESCE(r.model_id, 'unknown') AS model_id,
    ${dimensionKey} AS dimension_key,
    ${dimensionLabel} AS dimension_label,
    COUNT(*) AS messages,
    COUNT(DISTINCT r.session_id) AS sessions,
    COALESCE(SUM(CASE WHEN r.cost_usd IS NOT NULL THEN r.cost_usd ELSE 0 END), 0) AS recorded_cost,
    COALESCE(SUM(CASE WHEN r.cost_usd IS NOT NULL THEN 1 ELSE 0 END), 0) AS recorded_records,
    COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS missing_records,
    COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
    COALESCE(SUM(r.cache_read_tokens), 0) AS cache_read_tokens,
    COALESCE(SUM(r.cache_write_tokens), 0) AS cache_write_tokens,
    COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(r.reasoning_tokens), 0) AS reasoning_tokens,
    COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.input_tokens ELSE 0 END), 0) AS missing_input_tokens,
    COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.cache_read_tokens ELSE 0 END), 0) AS missing_cache_read_tokens,
    COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.cache_write_tokens ELSE 0 END), 0) AS missing_cache_write_tokens,
    COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.output_tokens ELSE 0 END), 0) AS missing_output_tokens,
    COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.reasoning_tokens ELSE 0 END), 0) AS missing_reasoning_tokens,
    COALESCE(SUM(CASE WHEN r.created_at IS NOT NULL AND r.completed_at >= r.created_at
      THEN r.completed_at - r.created_at ELSE 0 END), 0) AS duration_ms,
    COALESCE(SUM(CASE WHEN r.created_at IS NOT NULL AND r.completed_at >= r.created_at THEN 1 ELSE 0 END), 0) AS duration_records,
    COALESCE(SUM(CASE WHEN r.request_sent_at IS NOT NULL AND r.first_token_at IS NOT NULL AND r.first_token_at >= r.request_sent_at
      THEN r.first_token_at - r.request_sent_at ELSE 0 END), 0) AS ttft_ms,
    COALESCE(SUM(CASE WHEN r.request_sent_at IS NOT NULL AND r.first_token_at IS NOT NULL AND r.first_token_at >= r.request_sent_at
      THEN 1 ELSE 0 END), 0) AS ttft_records,
    COALESCE(SUM(CASE
      WHEN r.first_token_at IS NOT NULL AND r.streamed_at IS NOT NULL AND r.streamed_at >= r.first_token_at
        THEN r.streamed_at - r.first_token_at
      WHEN r.created_at IS NOT NULL AND r.completed_at >= r.created_at
        THEN r.completed_at - r.created_at
      ELSE 0 END), 0) AS generation_ms
  `
}

function downsample(items: readonly InspectionTimelinePoint[], max: number) {
  if (items.length <= max) return [...items]
  const result: InspectionTimelinePoint[] = []
  for (let group = 0; group < max; group++) {
    const start = Math.floor((group * items.length) / max)
    const end = Math.floor(((group + 1) * items.length) / max)
    if (start >= end) continue
    const first = items[start]!
    let messages = 0
    let cost = 0
    let estimatedCost = 0
    let tokens = 0
    for (let index = start; index < end; index++) {
      const item = items[index]!
      messages += item.messages
      cost += item.cost
      estimatedCost += item.estimatedCost
      tokens += item.tokens
    }
    result.push({ start: first.start, messages, cost, estimatedCost, tokens })
  }
  return result
}

function sortBreakdown(rows: InspectionBreakdownRow[], sort: "cost" | "tokens" | "messages") {
  const score = (row: InspectionBreakdownRow) =>
    sort === "cost" ? row.cost + row.estimatedCost : sort === "tokens" ? row.tokens : row.messages
  return rows.sort((left, right) => score(right) - score(left) || right.messages - left.messages || left.key.localeCompare(right.key))
}

function totalsFromRows(
  request: Extract<UsageInspectionRequest, { action: "totals" }>,
  rows: readonly CompactRow[],
  sessions: number,
  rates: ReadonlyMap<string, ModelRates>,
): InspectionTotalsResult {
  const tokens = zeroTokens()
  let messages = 0
  let cost = 0
  let estimatedCost = 0
  let pricedRecords = 0
  let unpricedRecords = 0
  let estimatedRecords = 0
  let durationMs = 0
  let durationRecords = 0
  let ttftMs = 0
  let ttftRecords = 0
  let generationMs = 0
  let savings = 0
  let savingsCoverageRecords = 0
  const models = new Map<string, { providerID: string; modelID: string; messages: number; cost: number }>()

  for (const row of rows) {
    const valued = valueCompact(row, rates)
    messages += row.messages
    cost += valued.recordedCost
    estimatedCost += valued.estimatedCost
    pricedRecords += valued.pricedRecords
    unpricedRecords += valued.unpricedRecords
    estimatedRecords += valued.estimatedRecords
    durationMs += row.duration_ms
    durationRecords += row.duration_records
    ttftMs += row.ttft_ms
    ttftRecords += row.ttft_records
    generationMs += row.generation_ms
    savings += valued.cacheSavings
    savingsCoverageRecords += valued.rateKnownRecords
    addTokens(tokens, row)
    const key = `${row.provider_id}/${row.model_id}`
    const model = models.get(key) ?? { providerID: row.provider_id, modelID: row.model_id, messages: 0, cost: 0 }
    model.messages += row.messages
    model.cost += valued.recordedCost + valued.estimatedCost
    models.set(key, model)
  }

  const processed = tokens.output + tokens.reasoning
  const mode =
    messages === 0 || unpricedRecords === messages
      ? "unpriced" as const
      : estimatedRecords === 0
        ? "recorded" as const
        : pricedRecords === estimatedRecords
          ? "estimated" as const
          : "mixed" as const
  let most: { providerID: string; modelID: string; messages: number; cost: number } | undefined
  for (const model of models.values()) {
    if (!most || model.messages > most.messages || (model.messages === most.messages && model.cost > most.cost)) most = model
  }

  return {
    action: "totals",
    since: request.since,
    until: request.until,
    ...(request.projectID !== undefined ? { projectID: request.projectID } : {}),
    totals: {
      sessions,
      messages,
      cost,
      estimatedCost,
      pricedRecords,
      unpricedRecords,
      tokens,
      durationMs,
      durationRecords,
      ttftMs,
      ttftRecords,
    },
    rates: {
      tokensPerSecond: safeDiv(processed, generationMs) * 1000,
      avgTokensPerTurn: safeDiv(tokenTotal(tokens), messages),
      avgCostPerTurn: safeDiv(cost + estimatedCost, messages),
      cacheHitRate: safeDiv(tokens.cacheRead, tokens.input + tokens.cacheRead),
      cacheSavings: savings,
      cacheSavingsCoverage: safeDiv(savingsCoverageRecords, messages),
    },
    pricing: {
      coverage: safeDiv(pricedRecords, pricedRecords + unpricedRecords),
      mode,
    },
    mostUsedModel: most
      ? {
          providerID: most.providerID,
          modelID: most.modelID,
          messages: most.messages,
          cost: most.cost,
          share: safeDiv(most.messages, messages),
        }
      : null,
  }
}

export function runInspection(
  conn: Pick<Database.DatabaseShape, "all" | "get">,
  rates: ReadonlyMap<string, ModelRates>,
  request: UsageInspectionRequest,
  indexedProject: boolean,
): Effect.Effect<UsageInspectionResult> {
  return Effect.gen(function* () {
    if (request.action === "totals") {
      const rows = yield* conn.all<CompactRow>(sql`
        SELECT ${compactSelect(sql`NULL`, sql`NULL`)}
        FROM usage_record r
        ${usageJoins(request, false, indexedProject)}
        WHERE ${ordinaryFilter(request, indexedProject)}
        GROUP BY COALESCE(r.provider_id, 'unknown'), COALESCE(r.model_id, 'unknown')
      `).pipe(Effect.orDie)
      const sessionRow = yield* conn.get<{ sessions: number }>(sql`
        SELECT COUNT(DISTINCT r.session_id) AS sessions
        FROM usage_record r
        ${usageJoins(request, false, indexedProject)}
        WHERE ${ordinaryFilter(request, indexedProject)}
      `).pipe(Effect.orDie)
      return totalsFromRows(request, rows, sessionRow?.sessions ?? 0, rates)
    }

    if (request.action === "breakdown") {
      const key =
        request.dimension === "provider"
          ? sql`COALESCE(r.provider_id, 'unknown')`
          : request.dimension === "model"
            ? sql`COALESCE(r.provider_id, 'unknown') || '/' || COALESCE(r.model_id, 'unknown')`
            : request.dimension === "variant"
              ? sql`COALESCE(r.variant, '(default)')`
              : sql`COALESCE(s.project_id, us.project_id, '__historical__')`
      const label =
        request.dimension === "project"
          ? sql`COALESCE(p.name, us.project_name, COALESCE(s.project_id, us.project_id, 'Historical usage'))`
          : key
      const rows = yield* conn.all<CompactRow>(sql`
        SELECT ${compactSelect(key, label)}
        FROM usage_record r
        ${usageJoins(request, request.dimension === "project", indexedProject)}
        WHERE ${ordinaryFilter(request, indexedProject)}
        GROUP BY ${key}, ${label}, COALESCE(r.provider_id, 'unknown'), COALESCE(r.model_id, 'unknown')
      `).pipe(Effect.orDie)
      const sessionRows = yield* conn.all<SessionCountRow>(sql`
        SELECT ${key} AS dimension_key, COUNT(DISTINCT r.session_id) AS sessions
        FROM usage_record r
        ${usageJoins(request, request.dimension === "project", indexedProject)}
        WHERE ${ordinaryFilter(request, indexedProject)}
        GROUP BY ${key}
      `).pipe(Effect.orDie)
      const sessions = new Map(sessionRows.map((row) => [row.dimension_key, row.sessions] as const))
      const folded = new Map<string, Mutable<InspectionBreakdownRow>>()
      for (const row of rows) {
        const dimensionKey = row.dimension_key ?? "(unknown)"
        const valued = valueCompact(row, rates)
        const current = folded.get(dimensionKey) ?? {
          key: dimensionKey,
          label: row.dimension_label ?? dimensionKey,
          ...(request.dimension === "provider" ? { providerID: dimensionKey } : {}),
          ...(request.dimension === "model" ? { providerID: row.provider_id, modelID: row.model_id } : {}),
          ...(request.dimension === "variant" ? { variant: dimensionKey === "(default)" ? null : dimensionKey } : {}),
          ...(request.dimension === "project" ? { projectID: dimensionKey } : {}),
          messages: 0,
          sessions: sessions.get(dimensionKey) ?? 0,
          cost: 0,
          estimatedCost: 0,
          unpricedRecords: 0,
          tokens: 0,
          cacheSavings: 0,
        }
        current.messages += row.messages
        current.cost += valued.recordedCost
        current.estimatedCost += valued.estimatedCost
        current.unpricedRecords += valued.unpricedRecords
        current.tokens +=
          row.input_tokens + row.cache_read_tokens + row.cache_write_tokens + row.output_tokens + row.reasoning_tokens
        current.cacheSavings += valued.cacheSavings
        folded.set(dimensionKey, current)
      }
      const ordered = sortBreakdown([...folded.values()], request.sort)
      return {
        action: "breakdown",
        since: request.since,
        until: request.until,
        ...(request.projectID !== undefined ? { projectID: request.projectID } : {}),
        dimension: request.dimension,
        rows: ordered.slice(0, request.limit),
        totalRows: ordered.length,
        truncated: ordered.length > request.limit,
      } satisfies InspectionBreakdownResult
    }

    if (request.action === "timeline") {
      const rows = yield* queryTimelineRows(conn, request, usageJoins(request, false, indexedProject), ordinaryFilter(request, indexedProject))
      const points = new Map<number, Mutable<InspectionTimelinePoint>>()
      for (const row of rows) {
        const start = row.start
        const valued = valueTimelineRow(row, rates)
        const current = points.get(start) ?? { start, messages: 0, cost: 0, estimatedCost: 0, tokens: 0 }
        current.messages += row.messages
        current.cost += valued.recordedCost
        current.estimatedCost += valued.estimatedCost
        current.tokens += valued.tokens
        points.set(start, current)
      }
      const source = [...points.values()].sort((a, b) => a.start - b.start)
      const bounded = downsample(source, request.maxPoints)
      return {
        action: "timeline",
        since: request.since,
        until: request.until,
        ...(request.projectID !== undefined ? { projectID: request.projectID } : {}),
        resolution: request.resolution,
        metric: request.metric,
        points: bounded,
        sourcePoints: source.length,
        truncated: bounded.length < source.length,
      } satisfies InspectionTimelineResult
    }

    const usageMaintenance = yield* conn.all<MaintenanceRow>(sql`
      SELECT
        CASE
          WHEN COALESCE(r.mode, '') = 'compaction' OR COALESCE(r.agent, '') = 'compaction' THEN 'compaction'
          WHEN COALESCE(r.agent, '') = 'summary' THEN 'summary'
          ELSE 'maintenance'
        END AS agent,
        COALESCE(r.provider_id, 'unknown') AS provider_id,
        COALESCE(r.model_id, 'unknown') AS model_id,
        COUNT(*) AS requests,
        COUNT(DISTINCT r.session_id) AS sessions,
        COALESCE(SUM(CASE WHEN r.cost_usd IS NOT NULL THEN r.cost_usd ELSE 0 END), 0) AS recorded_cost,
        0 AS supplied_estimated_cost,
        0 AS supplied_estimated_records,
        COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS missing_records,
        COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(r.cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(r.cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(r.reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.input_tokens ELSE 0 END), 0) AS missing_input_tokens,
        COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.cache_read_tokens ELSE 0 END), 0) AS missing_cache_read_tokens,
        COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.cache_write_tokens ELSE 0 END), 0) AS missing_cache_write_tokens,
        COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.output_tokens ELSE 0 END), 0) AS missing_output_tokens,
        COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.reasoning_tokens ELSE 0 END), 0) AS missing_reasoning_tokens,
        COALESCE(SUM(r.input_tokens + r.cache_read_tokens + r.cache_write_tokens + r.output_tokens + r.reasoning_tokens), 0) AS total_tokens,
        COALESCE(SUM(CASE WHEN r.created_at IS NOT NULL AND r.completed_at >= r.created_at
          THEN r.completed_at - r.created_at ELSE 0 END), 0) AS duration_ms,
        COALESCE(SUM(CASE WHEN r.created_at IS NOT NULL AND r.completed_at >= r.created_at THEN 1 ELSE 0 END), 0) AS duration_records
      FROM usage_record r
      ${usageJoins(request, false, indexedProject)}
      WHERE r.completed_at >= ${request.since}
        AND r.completed_at < ${request.until}
        AND ${projectFilter(request.projectID, indexedProject)}
        AND COALESCE(r.mode, '') <> 'maintenance'
        AND (
          COALESCE(r.mode, '') = 'compaction'
          OR COALESCE(r.agent, '') = 'compaction'
          OR COALESCE(r.agent, '') = 'summary'
        )
      GROUP BY 1, 2, 3
    `).pipe(Effect.orDie)

    const durableMaintenance = yield* conn.all<MaintenanceRow>(sql`
      SELECT
        m.agent AS agent,
        m.provider_id AS provider_id,
        m.model_id AS model_id,
        COALESCE(SUM(m.requests), 0) AS requests,
        COUNT(DISTINCT m.session_id) AS sessions,
        COALESCE(SUM(CASE WHEN m.cost_usd IS NOT NULL AND m.cost_estimated = 0 THEN m.cost_usd ELSE 0 END), 0) AS recorded_cost,
        COALESCE(SUM(CASE WHEN m.cost_usd IS NOT NULL AND m.cost_estimated = 1 THEN m.cost_usd ELSE 0 END), 0) AS supplied_estimated_cost,
        COALESCE(SUM(CASE WHEN m.cost_usd IS NOT NULL AND m.cost_estimated = 1 THEN m.requests ELSE 0 END), 0) AS supplied_estimated_records,
        COALESCE(SUM(CASE WHEN m.cost_usd IS NULL THEN m.requests ELSE 0 END), 0) AS missing_records,
        COALESCE(SUM(m.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(m.cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(m.cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(m.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(m.reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(CASE WHEN m.cost_usd IS NULL THEN m.input_tokens ELSE 0 END), 0) AS missing_input_tokens,
        COALESCE(SUM(CASE WHEN m.cost_usd IS NULL THEN m.cache_read_tokens ELSE 0 END), 0) AS missing_cache_read_tokens,
        COALESCE(SUM(CASE WHEN m.cost_usd IS NULL THEN m.cache_write_tokens ELSE 0 END), 0) AS missing_cache_write_tokens,
        COALESCE(SUM(CASE WHEN m.cost_usd IS NULL THEN m.output_tokens ELSE 0 END), 0) AS missing_output_tokens,
        COALESCE(SUM(CASE WHEN m.cost_usd IS NULL THEN m.reasoning_tokens ELSE 0 END), 0) AS missing_reasoning_tokens,
        COALESCE(SUM(m.total_tokens), 0) AS total_tokens,
        COALESCE(SUM(CASE WHEN m.time_completed >= m.time_started THEN m.time_completed - m.time_started ELSE 0 END), 0) AS duration_ms,
        COALESCE(SUM(CASE WHEN m.time_completed >= m.time_started THEN 1 ELSE 0 END), 0) AS duration_records
      FROM maintenance_usage m
      WHERE m.time_completed >= ${request.since}
        AND m.time_completed < ${request.until}
        AND ${maintenanceProjectFilter(request.projectID)}
      GROUP BY m.agent, m.provider_id, m.model_id
    `).pipe(Effect.orDie)

    const totals = {
      requests: 0,
      sessions: 0,
      cost: 0,
      estimatedCost: 0,
      pricedRecords: 0,
      estimatedRecords: 0,
      unpricedRecords: 0,
      tokens: zeroTokens(),
      totalTokens: 0,
      durationMs: 0,
      durationRecords: 0,
    }
    const folded = new Map<string, Mutable<InspectionMaintenanceRow>>()
    for (const row of [...usageMaintenance, ...durableMaintenance]) {
      const valued = valueMaintenance(row, rates)
      totals.requests += row.requests
      totals.cost += valued.recordedCost
      totals.estimatedCost += valued.estimatedCost
      totals.pricedRecords += valued.pricedRecords
      totals.estimatedRecords += valued.estimatedRecords
      totals.unpricedRecords += valued.unpricedRecords
      addTokens(totals.tokens, row)
      totals.totalTokens += row.total_tokens
      totals.durationMs += row.duration_ms
      totals.durationRecords += row.duration_records
      // SQL has already counted distinct sessions inside each compact group.
      // Exact global maintenance session cardinality is supplied below.
      const key = request.dimension === "agent" ? row.agent : `${row.provider_id}/${row.model_id}`
      const current = folded.get(key) ?? {
        key,
        label: key,
        ...(request.dimension === "agent" ? { agent: row.agent } : { providerID: row.provider_id, modelID: row.model_id }),
        requests: 0,
        sessions: 0,
        cost: 0,
        estimatedCost: 0,
        tokens: 0,
      }
      current.requests += row.requests
      current.cost += valued.recordedCost
      current.estimatedCost += valued.estimatedCost
      current.tokens += row.total_tokens
      folded.set(key, current)
    }

    const maintenanceDimensionSessions = yield* conn.all<SessionCountRow>(sql`
      SELECT dimension_key, COUNT(DISTINCT session_id) AS sessions FROM (
        SELECT
          r.session_id AS session_id,
          CASE
            WHEN ${request.dimension} = 'agent' THEN
              CASE
                WHEN COALESCE(r.mode, '') = 'compaction' OR COALESCE(r.agent, '') = 'compaction' THEN 'compaction'
                WHEN COALESCE(r.agent, '') = 'summary' THEN 'summary'
                ELSE 'maintenance'
              END
            ELSE COALESCE(r.provider_id, 'unknown') || '/' || COALESCE(r.model_id, 'unknown')
          END AS dimension_key
        FROM usage_record r
        ${usageJoins(request, false, indexedProject)}
        WHERE r.completed_at >= ${request.since}
          AND r.completed_at < ${request.until}
          AND ${projectFilter(request.projectID, indexedProject)}
          AND COALESCE(r.mode, '') <> 'maintenance'
          AND (
            COALESCE(r.mode, '') = 'compaction'
            OR COALESCE(r.agent, '') = 'compaction'
            OR COALESCE(r.agent, '') = 'summary'
          )
        UNION ALL
        SELECT
          m.session_id AS session_id,
          CASE
            WHEN ${request.dimension} = 'agent' THEN m.agent
            ELSE m.provider_id || '/' || m.model_id
          END AS dimension_key
        FROM maintenance_usage m
        WHERE m.time_completed >= ${request.since}
          AND m.time_completed < ${request.until}
          AND ${maintenanceProjectFilter(request.projectID)}
          AND m.session_id IS NOT NULL
      )
      GROUP BY dimension_key
    `).pipe(Effect.orDie)
    const maintenanceSessionsByKey = new Map(
      maintenanceDimensionSessions.map((row) => [row.dimension_key, row.sessions] as const),
    )
    for (const row of folded.values()) row.sessions = maintenanceSessionsByKey.get(row.key) ?? 0

    const maintenanceSession = yield* conn.get<{ sessions: number }>(sql`
      SELECT COUNT(DISTINCT session_id) AS sessions FROM (
        SELECT r.session_id AS session_id
        FROM usage_record r
        ${usageJoins(request, false, indexedProject)}
        WHERE r.completed_at >= ${request.since}
          AND r.completed_at < ${request.until}
          AND ${projectFilter(request.projectID, indexedProject)}
          AND COALESCE(r.mode, '') <> 'maintenance'
          AND (
            COALESCE(r.mode, '') = 'compaction'
            OR COALESCE(r.agent, '') = 'compaction'
            OR COALESCE(r.agent, '') = 'summary'
          )
        UNION
        SELECT m.session_id AS session_id
        FROM maintenance_usage m
        WHERE m.time_completed >= ${request.since}
          AND m.time_completed < ${request.until}
          AND ${maintenanceProjectFilter(request.projectID)}
          AND m.session_id IS NOT NULL
      )
    `).pipe(Effect.orDie)
    totals.sessions = maintenanceSession?.sessions ?? 0

    const ordered = [...folded.values()].sort(
      (a, b) => b.cost + b.estimatedCost - (a.cost + a.estimatedCost) || b.tokens - a.tokens || a.key.localeCompare(b.key),
    )
    return {
      action: "maintenance",
      since: request.since,
      until: request.until,
      ...(request.projectID !== undefined ? { projectID: request.projectID } : {}),
      dimension: request.dimension,
      totals,
      rows: ordered.slice(0, request.limit),
      totalRows: ordered.length,
      truncated: ordered.length > request.limit,
    } satisfies InspectionMaintenanceResult
  })
}
