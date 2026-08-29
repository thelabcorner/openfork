import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"
import type { ProviderResult } from "@/utils/limits-format"

export const ZEN_FREE_FALLBACK_LIMIT = 200
export const ZEN_FREE_WINDOW_MS = 24 * 60 * 60 * 1000
export const ZEN_FREE_HISTORY_MS = 90 * ZEN_FREE_WINDOW_MS
export const ZEN_FREE_LOWER_BOUND_HORIZON_MS = 14 * ZEN_FREE_WINDOW_MS
export const ZEN_FREE_HIT_HALF_LIFE_MS = 14 * ZEN_FREE_WINDOW_MS
export const ZEN_FREE_HIT_DEDUPE_MS = 2 * 60 * 60 * 1000

export type ZenLimitObservation = {
  at: number
  requests: number
  kind: "lower-bound" | "limit-hit"
}

export type ZenLimitSource = "fallback" | "learned" | "lower-bound"

export type ZenFreeUsageEstimate = {
  used: number
  limit: number | null
  knownAtLeast: number
  source: ZenLimitSource
  confidence: number
  hitSamples: number
  lastLimitHitAt: number | null
}

type WeightedValue = { value: number; weight: number }

type UsageModelRow = UsageSummaryResponse["models"][number]

/**
 * OpenCode Zen's anonymous/free traffic is recorded under the `opencode`
 * provider with zero recorded/estimated cost. Paid Console traffic can share
 * the provider id, so provider id alone is not a safe discriminator.
 */
export function isZenFreeUsageRow(row: UsageModelRow) {
  return row.providerID === "opencode" && row.cost + row.estimatedCost <= 0
}

export function countZenFreeRequests(summary: UsageSummaryResponse | null | undefined) {
  if (!summary) return 0
  let total = 0
  for (const row of summary.models) {
    if (!isZenFreeUsageRow(row)) continue
    total += Math.max(0, row.messages)
  }
  return total
}

/**
 * Retry status can be emitted repeatedly while a session remains blocked.
 * Collapse nearby events so one exhaustion episode does not dominate the
 * learned limit simply because the retry loop was noisy.
 */
export function appendZenLimitHit(entries: readonly number[], at: number) {
  if (!Number.isFinite(at) || at <= 0) return [...entries]
  const recent = entries
    .filter((value) => Number.isFinite(value) && value > 0 && Math.abs(at - value) >= ZEN_FREE_HIT_DEDUPE_MS)
    .sort((a, b) => b - a)
  return [at, ...recent].slice(0, 100)
}

function weightedMedian(values: WeightedValue[]) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a.value - b.value)
  const total = sorted.reduce((sum, item) => sum + item.weight, 0)
  if (!(total > 0)) return null
  let cursor = 0
  for (const item of sorted) {
    cursor += item.weight
    if (cursor >= total / 2) return item.value
  }
  return sorted.at(-1)?.value ?? null
}

function hitWeight(now: number, at: number) {
  const age = Math.max(0, now - at)
  return 2 ** (-age / ZEN_FREE_HIT_HALF_LIFE_MS)
}

/**
 * Learn a time-varying free-tier cap without pretending censored successful
 * usage is an exact quota observation.
 *
 * - A successful 24h window only proves `limit >= requests`.
 * - A structured `free_tier_limit` rejection is a tight cap observation.
 * - Hit observations use exponential recency weighting (14d half-life).
 * - The documented/observed 200 req/day behavior remains a weak prior and
 *   bootstrap fallback, not a hard ceiling.
 * - Recent successful windows can invalidate a stale learned cap by turning
 *   the result back into an explicit lower bound.
 */
export function estimateZenFreeLimit(input: {
  now: number
  used: number
  observations: readonly ZenLimitObservation[]
  fallbackLimit?: number
}): ZenFreeUsageEstimate {
  const now = input.now
  const used = Math.max(0, Math.round(input.used))
  const fallback = Math.max(1, Math.round(input.fallbackLimit ?? ZEN_FREE_FALLBACK_LIMIT))
  const observations = input.observations.filter(
    (item) =>
      Number.isFinite(item.at) &&
      Number.isFinite(item.requests) &&
      item.at <= now &&
      now - item.at <= ZEN_FREE_HISTORY_MS &&
      item.requests >= 0,
  )

  const hits = observations.filter((item) => item.kind === "limit-hit" && item.requests > 0)
  const latestHitAt = hits.reduce<number | null>((latest, item) => (latest === null || item.at > latest ? item.at : latest), null)

  // The baseline is deliberately weak. One fresh, real limit hit outweighs it.
  const weightedHits: WeightedValue[] = [{ value: fallback, weight: 0.35 }]
  let hitWeightTotal = 0
  for (const hit of hits) {
    const weight = hitWeight(now, hit.at)
    hitWeightTotal += weight
    weightedHits.push({ value: Math.max(1, Math.round(hit.requests)), weight })
  }
  const learned = hits.length > 0 ? weightedMedian(weightedHits) : null

  // Successful history is censored. Keep it as a hard lower bound only while
  // it is recent enough to plausibly describe the current quota regime. Once
  // we have a limit hit, pre-hit success windows belong to the old regime and
  // must not prevent a legitimate downward quota change from being learned.
  let knownAtLeast = used
  for (const observation of observations) {
    if (observation.kind !== "lower-bound") continue
    if (now - observation.at > ZEN_FREE_LOWER_BOUND_HORIZON_MS) continue
    if (latestHitAt !== null && observation.at < latestHitAt) continue
    knownAtLeast = Math.max(knownAtLeast, Math.round(observation.requests))
  }

  if (learned !== null) {
    const learnedLimit = Math.max(1, Math.round(learned))
    if (knownAtLeast > learnedLimit) {
      return {
        used,
        limit: null,
        knownAtLeast,
        source: "lower-bound",
        confidence: Math.min(0.7, 0.4 + hitWeightTotal * 0.1),
        hitSamples: hits.length,
        lastLimitHitAt: latestHitAt,
      }
    }
    return {
      used,
      limit: learnedLimit,
      knownAtLeast: Math.max(knownAtLeast, learnedLimit),
      source: "learned",
      confidence: Math.min(0.98, 0.55 + (1 - Math.exp(-hitWeightTotal)) * 0.4),
      hitSamples: hits.length,
      lastLimitHitAt: latestHitAt,
    }
  }

  if (knownAtLeast > fallback) {
    return {
      used,
      limit: null,
      knownAtLeast,
      source: "lower-bound",
      confidence: 0.35,
      hitSamples: 0,
      lastLimitHitAt: null,
    }
  }

  return {
    used,
    limit: fallback,
    knownAtLeast: Math.max(knownAtLeast, fallback),
    source: "fallback",
    confidence: 0.15,
    hitSamples: 0,
    lastLimitHitAt: null,
  }
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value))
}

/** Project the learned Zen state into the Limits pane's normal provider model. */
export function zenEstimateToProviderResult(estimate: ZenFreeUsageEstimate, fetchedAt: number): ProviderResult {
  const exact = estimate.limit !== null
  const usedPercent = exact ? clampPercent((estimate.used / estimate.limit!) * 100) : null
  const remainingPercent = usedPercent === null ? null : clampPercent(100 - usedPercent)
  const sourceLabel = estimate.source === "learned" ? "learned" : estimate.source === "fallback" ? "fallback" : "learning"
  const valueLabel = exact ? null : `${estimate.used} used · cap ≥${estimate.knownAtLeast}`
  const planLabel = exact ? `${estimate.used}/${estimate.limit} req` : `${estimate.used}/≥${estimate.knownAtLeast} req`

  return {
    providerId: "opencode",
    providerName: "OpenCode Zen",
    ok: true,
    configured: true,
    planLabel,
    fetchedAt,
    usage: {
      windows: {
        [`24h · ${sourceLabel}`]: {
          usedPercent,
          remainingPercent,
          windowSeconds: ZEN_FREE_WINDOW_MS / 1000,
          // Rolling-window quotas do not have one wall-clock reset. This is
          // the latest time all usage observed at fetch time is guaranteed to
          // have rolled out if no additional requests are made.
          resetAt: estimate.used > 0 ? fetchedAt + ZEN_FREE_WINDOW_MS : null,
          resetAfterSeconds: null,
          valueLabel,
        },
      },
    },
  }
}
