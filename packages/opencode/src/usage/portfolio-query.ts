import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import type { ModelBucket, ProviderBucket, VariantBucket } from "./usage"
import { cacheSavings, estimateCost, type ModelRates } from "./valuation"
import { usageScopedProjectFilter } from "./summary-row-query"

/**
 * SQL-first portfolio aggregation. A *candidate*, independent of rich
 * Usage.summary, until differential parity and throughput gates have passed.
 * Session cardinalities are computed separately by provider: summing
 * per-variant DISTINCTs would double-count sessions crossing variants.
 */
export type PortfolioGroup = {
  provider_id: string
  model_id: string
  variant: string | null
  messages: number
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
  generation_ms: number
  generation_records: number
}
type ProviderSession = { provider_id: string; sessions: number }

const ordinary = sql`
  COALESCE(r.mode, '') <> 'maintenance'
  AND COALESCE(r.mode, '') <> 'compaction'
  AND COALESCE(r.agent, '') <> 'compaction'
  AND COALESCE(r.agent, '') <> 'summary'
`

function selection(request: { since: number; until: number; projectID?: string | null }, indexedProject: boolean) {
  const projectID = request.projectID ?? null
  const joins = projectID === null || indexedProject
    ? sql``
    : sql`
      LEFT JOIN session s ON s.id = r.session_id
      LEFT JOIN usage_session us ON us.session_id = r.session_id
    `
  const filter = projectID === null
    ? sql`1`
    : indexedProject && projectID !== "__historical__"
      ? usageScopedProjectFilter(projectID)
      : sql`COALESCE(s.project_id, us.project_id, '__historical__') = ${projectID}`
  const where = sql`
    r.completed_at >= ${request.since}
    AND r.completed_at < ${request.until}
    AND ${ordinary}
    AND ${filter}
  `
  return { joins, where }
}

export function portfolioSql(request: { since: number; until: number; projectID?: string | null }, indexedProject: boolean) {
  const { joins, where } = selection(request, indexedProject)
  const generation = sql`CASE
    WHEN r.first_token_at IS NOT NULL AND r.streamed_at IS NOT NULL AND r.streamed_at >= r.first_token_at
      THEN r.streamed_at - r.first_token_at
    WHEN r.created_at IS NOT NULL AND r.completed_at >= r.created_at
      THEN r.completed_at - r.created_at
    ELSE NULL END`
  const duration = sql`CASE WHEN r.created_at IS NOT NULL AND r.completed_at >= r.created_at
    THEN r.completed_at - r.created_at ELSE NULL END`
  const groups = sql`
    SELECT
      COALESCE(r.provider_id, 'unknown') AS provider_id,
      COALESCE(r.model_id, 'unknown') AS model_id,
      r.variant AS variant,
      COUNT(*) AS messages,
      COALESCE(SUM(r.cost_usd), 0) AS recorded_cost,
      COUNT(r.cost_usd) AS recorded_records,
      COUNT(*) - COUNT(r.cost_usd) AS missing_records,
      COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(r.cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(r.cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
      COALESCE(SUM(r.reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(r.input_tokens) FILTER (WHERE r.cost_usd IS NULL), 0) AS missing_input_tokens,
      COALESCE(SUM(r.cache_read_tokens) FILTER (WHERE r.cost_usd IS NULL), 0) AS missing_cache_read_tokens,
      COALESCE(SUM(r.cache_write_tokens) FILTER (WHERE r.cost_usd IS NULL), 0) AS missing_cache_write_tokens,
      COALESCE(SUM(r.output_tokens) FILTER (WHERE r.cost_usd IS NULL), 0) AS missing_output_tokens,
      COALESCE(SUM(r.reasoning_tokens) FILTER (WHERE r.cost_usd IS NULL), 0) AS missing_reasoning_tokens,
      COALESCE(SUM(${duration}), 0) AS duration_ms,
      COUNT(${duration}) AS duration_records,
      COALESCE(SUM(${generation}), 0) AS generation_ms,
      COUNT(${generation}) AS generation_records
    FROM usage_record r
    ${joins}
    WHERE ${where}
    GROUP BY COALESCE(r.provider_id, 'unknown'), COALESCE(r.model_id, 'unknown'), r.variant
  `
  const providerSessions = sql`
    SELECT COALESCE(r.provider_id, 'unknown') AS provider_id, COUNT(DISTINCT r.session_id) AS sessions
    FROM usage_record r ${joins}
    WHERE ${where}
    GROUP BY COALESCE(r.provider_id, 'unknown')
  `
  return { groups, providerSessions }
}

export function queryPortfolio(
  db: Pick<Database.DatabaseShape, "all">,
  request: { since: number; until: number; projectID?: string | null },
  indexedProject: boolean,
) {
  return Effect.gen(function* () {
    const queries = portfolioSql(request, indexedProject)
    // Both reads must occur in one WAL snapshot (caller owns transaction).
    const groups = yield* db.all<PortfolioGroup>(queries.groups).pipe(Effect.orDie)
    const providerSessions = yield* db.all<ProviderSession>(queries.providerSessions).pipe(Effect.orDie)
    return { groups, providerSessions }
  })
}

const zero = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 })
const div = (a: number, b: number) => b > 0 ? a / b : 0
type Mutable<T> = { -readonly [K in keyof T]: T[K] }
type MutableProvider = Omit<Mutable<ProviderBucket>, "tokens"> & { tokens: Mutable<ProviderBucket["tokens"]> }

/** Pure small-group projection; raw usage_record rows never reach JS. */
export function valuePortfolio(
  groups: readonly PortfolioGroup[],
  providerSessions: readonly ProviderSession[],
  rates: ReadonlyMap<string, ModelRates>,
): { providers: ProviderBucket[]; models: ModelBucket[]; variants: VariantBucket[] } {
  const providers = new Map<string, MutableProvider>()
  const models: Mutable<ModelBucket>[] = []
  const variants = new Map<string | null, Mutable<VariantBucket>>()
  let totalMessages = 0

  for (const row of groups) {
    const rate = rates.get(`${row.provider_id}/${row.model_id}`)
    const tokens = {
      input: row.input_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens,
      output: row.output_tokens,
      reasoning: row.reasoning_tokens,
    }
    const estimatedCost = rate ? estimateCost({
      input: row.missing_input_tokens, cacheRead: row.missing_cache_read_tokens,
      cacheWrite: row.missing_cache_write_tokens, output: row.missing_output_tokens,
      reasoning: row.missing_reasoning_tokens,
    }, rate) : 0
    const savings = cacheSavings(tokens, rate)
    const unpricedRecords = rate ? 0 : row.missing_records
    const model: ModelBucket = {
      providerID: row.provider_id, modelID: row.model_id, variant: row.variant,
      messages: row.messages, cost: row.recorded_cost, estimatedCost,
      unpricedRecords, tokens, share: 0, cacheSavings: savings,
      durationMs: row.duration_ms, durationRecords: row.duration_records,
      generationMs: row.generation_ms, generationRecords: row.generation_records,
    }
    models.push(model)
    totalMessages += row.messages

    const provider = providers.get(row.provider_id) ?? {
      providerID: row.provider_id, messages: 0, sessions: 0, cost: 0,
      estimatedCost: 0, unpricedRecords: 0, tokens: zero(), share: 0,
      durationMs: 0, durationRecords: 0, generationMs: 0, generationRecords: 0,
    }
    provider.messages += row.messages
    provider.cost += row.recorded_cost
    provider.estimatedCost += estimatedCost
    provider.unpricedRecords += unpricedRecords
    provider.tokens.input += tokens.input
    provider.tokens.cacheRead += tokens.cacheRead
    provider.tokens.cacheWrite += tokens.cacheWrite
    provider.tokens.output += tokens.output
    provider.tokens.reasoning += tokens.reasoning
    provider.durationMs += row.duration_ms
    provider.durationRecords += row.duration_records
    provider.generationMs += row.generation_ms
    provider.generationRecords += row.generation_records
    providers.set(row.provider_id, provider)

    const variant = variants.get(row.variant) ?? { variant: row.variant, messages: 0, cost: 0, share: 0 }
    variant.messages += row.messages
    variant.cost += row.recorded_cost + estimatedCost
    variants.set(row.variant, variant)
  }
  const sessions = new Map(providerSessions.map(row => [row.provider_id, row.sessions]))
  for (const provider of providers.values()) {
    provider.sessions = sessions.get(provider.providerID) ?? 0
    provider.share = div(provider.messages, totalMessages)
  }
  for (const model of models) model.share = div(model.messages, totalMessages)
  for (const variant of variants.values()) variant.share = div(variant.messages, totalMessages)
  return {
    providers: [...providers.values()].sort((a,b) => b.cost + b.estimatedCost - a.cost - a.estimatedCost),
    models: models.sort((a,b) => b.cost + b.estimatedCost - a.cost - a.estimatedCost),
    variants: [...variants.values()].sort((a,b)=>b.messages-a.messages),
  }
}
