import { sql, type SQL } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "@opencode-ai/core/database/database"
import type { ModelRates } from "./valuation"
import { estimateCost } from "./valuation"

/**
 * Minimal, grouped SQL projection for Usage.inspect timeline.
 *
 * Unlike the general-purpose compact accounting SELECT, a timeline does not
 * need COUNT(DISTINCT session_id), generation latency, TTFT, duration, or five
 * fully broken-down token columns. Keeping those expensive aggregations out of
 * the hot grouped timeline query saves CPU and reduces row decoding.
 *
 * Pricing identity remains provider+model: unpriced settlements carry their
 * five missing-token sums separately for exact catalog estimation.
 */
export type CompactTimelineRow = {
  start: number
  provider_id: string
  model_id: string
  messages: number
  recorded_cost: number
  tokens: number
  missing_records: number
  missing_input_tokens: number
  missing_cache_read_tokens: number
  missing_cache_write_tokens: number
  missing_output_tokens: number
  missing_reasoning_tokens: number
}

export function queryTimelineRows(
  conn: Pick<Database.DatabaseShape, "all">,
  range: { since: number; until: number; resolution: "hour" | "day" },
  joins: SQL,
  filter: SQL,
): Effect.Effect<CompactTimelineRow[]> {
  const divisor = range.resolution === "hour" ? 3_600_000 : 86_400_000
  const bucket = sql`CAST(r.completed_at / ${divisor} AS INTEGER) * ${divisor}`
  return conn.all<CompactTimelineRow>(sql`
    SELECT
      ${bucket} AS start,
      COALESCE(r.provider_id, 'unknown') AS provider_id,
      COALESCE(r.model_id, 'unknown') AS model_id,
      COUNT(*) AS messages,
      COALESCE(SUM(r.cost_usd), 0) AS recorded_cost,
      COALESCE(SUM(r.input_tokens + r.cache_read_tokens + r.cache_write_tokens + r.output_tokens + r.reasoning_tokens), 0) AS tokens,
      COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS missing_records,
      COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.input_tokens ELSE 0 END), 0) AS missing_input_tokens,
      COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.cache_read_tokens ELSE 0 END), 0) AS missing_cache_read_tokens,
      COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.cache_write_tokens ELSE 0 END), 0) AS missing_cache_write_tokens,
      COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.output_tokens ELSE 0 END), 0) AS missing_output_tokens,
      COALESCE(SUM(CASE WHEN r.cost_usd IS NULL THEN r.reasoning_tokens ELSE 0 END), 0) AS missing_reasoning_tokens
    FROM usage_record r
    ${joins}
    WHERE ${filter}
    GROUP BY ${bucket}, COALESCE(r.provider_id, 'unknown'), COALESCE(r.model_id, 'unknown')
    -- The caller folds groups by bucket and explicitly sorts the bounded
    -- result; ORDER BY here imposed an additional global SQLite sort.
  `).pipe(Effect.orDie)
}

export function valueTimelineRow(row: CompactTimelineRow, rates: ReadonlyMap<string, ModelRates>) {
  const rate = rates.get(`${row.provider_id}/${row.model_id}`)
  return {
    recordedCost: row.recorded_cost,
    estimatedCost: rate && row.missing_records > 0
      ? estimateCost({
          input: row.missing_input_tokens,
          cacheRead: row.missing_cache_read_tokens,
          cacheWrite: row.missing_cache_write_tokens,
          output: row.missing_output_tokens,
          reasoning: row.missing_reasoning_tokens,
        }, rate)
      : 0,
    tokens: row.tokens,
  }
}
