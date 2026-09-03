import { Effect } from "effect"
import type { Adapter } from "../registry"
import { NEXT_REFRESH_NOW } from "./http"
import { toUsageWindow } from "../format"
import type { ProviderResult } from "../schema"
import { verdentLimitSnapshot } from "@/plugin/verdent"
import {
  VERDENT_FREE_5H_MS,
  VERDENT_FREE_WEEK_MS,
  type Interface as VerdentFreeUsage,
  type VerdentFreeSnapshot,
} from "@/usage/verdent-free"

// 5h + weekly buckets are shared across all free models (deepseek +
// glm-5.3-flash, etc.). Exact upstream caps are not published; tracker
// learns the true caps from the first hits (see verdent-free.ts
// classifyWindow → "weekly"/"5h"). 400/5h and ~650/week observed.
export const VERDENT_FREE_5H_FALLBACK = 400
export const VERDENT_FREE_WEEK_FALLBACK = 650
export const VERDENT_FREE_HIT_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000

const NAME = "Verdent"
const ID = "verdent"

type WeightedValue = { value: number; weight: number }

export type VerdentFreeWindowEstimate = {
  used: number
  limit: number | null
  knownAtLeast: number
  source: "fallback" | "learned" | "lower-bound"
  confidence: number
  hitSamples: number
  lastHitAt: number | null
}

export type VerdentFreeEstimate = {
  fiveHour: VerdentFreeWindowEstimate
  weekly: VerdentFreeWindowEstimate
}

function clampPercent(v: number) {
  return Math.max(0, Math.min(100, v))
}

function weightedMedian(values: readonly WeightedValue[]) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a.value - b.value)
  const total = sorted.reduce((s, x) => s + x.weight, 0)
  if (!(total > 0)) return null
  let cur = 0
  for (const item of sorted) {
    cur += item.weight
    if (cur >= total / 2) return item.value
  }
  return sorted.at(-1)?.value ?? null
}

function hitWeight(now: number, at: number) {
  return 2 ** (-Math.max(0, now - at) / VERDENT_FREE_HIT_HALF_LIFE_MS)
}

function estimateWindow(input: {
  used: number
  hits: { at: number; requests: number }[]
  now: number
  fallback: number
}): VerdentFreeWindowEstimate {
  const used = Math.max(0, Math.round(input.used))
  const hits = input.hits.filter(
    (h) => Number.isFinite(h.at) && h.at <= input.now && Number.isFinite(h.requests) && h.requests > 0,
  )
  const latestHitAt = hits.reduce<number | null>(
    (latest, h) => (latest === null || h.at > latest ? h.at : latest),
    null,
  )

  const weighted: WeightedValue[] = [{ value: input.fallback, weight: 0.35 }]
  let weightTotal = 0
  for (const h of hits) {
    const w = hitWeight(input.now, h.at)
    weightTotal += w
    weighted.push({ value: Math.max(1, Math.round(h.requests)), weight: w })
  }
  const learned = hits.length > 0 ? weightedMedian(weighted) : null
  const knownAtLeast = used

  if (learned !== null) {
    const lim = Math.max(1, Math.round(learned))
    if (knownAtLeast > lim) {
      return {
        used,
        limit: null,
        knownAtLeast,
        source: "lower-bound",
        confidence: Math.min(0.7, 0.4 + weightTotal * 0.1),
        hitSamples: hits.length,
        lastHitAt: latestHitAt,
      }
    }
    return {
      used,
      limit: lim,
      knownAtLeast: Math.max(knownAtLeast, lim),
      source: "learned",
      confidence: Math.min(0.98, 0.55 + (1 - Math.exp(-weightTotal)) * 0.4),
      hitSamples: hits.length,
      lastHitAt: latestHitAt,
    }
  }

  if (knownAtLeast > input.fallback) {
    return { used, limit: null, knownAtLeast, source: "lower-bound", confidence: 0.35, hitSamples: 0, lastHitAt: null }
  }

  return {
    used,
    limit: input.fallback,
    knownAtLeast: Math.max(knownAtLeast, input.fallback),
    source: "fallback",
    confidence: 0.15,
    hitSamples: 0,
    lastHitAt: null,
  }
}

export function estimateVerdentFreeLimit(input: { snapshot: VerdentFreeSnapshot; now?: number }): VerdentFreeEstimate {
  const now = input.now ?? input.snapshot.until
  const hits5h = input.snapshot.limitHits
    .filter((h) => h.window === "5h" || h.window === "unknown")
    .map((h) => ({ at: h.at, requests: h.requestsIn5h }))
  const hitsWeek = input.snapshot.limitHits
    .filter((h) => h.window === "weekly" || h.window === "unknown")
    .map((h) => ({ at: h.at, requests: h.requestsInWeek }))

  return {
    fiveHour: estimateWindow({
      used: input.snapshot.current5hCount,
      hits: hits5h,
      now,
      fallback: VERDENT_FREE_5H_FALLBACK,
    }),
    weekly: estimateWindow({
      used: input.snapshot.currentWeekCount,
      hits: hitsWeek,
      now,
      fallback: VERDENT_FREE_WEEK_FALLBACK,
    }),
  }
}

export function verdentFreeProviderResult(estimate: VerdentFreeEstimate, fetchedAt: number): ProviderResult {
  const windows: Record<string, ReturnType<typeof toUsageWindow>> = {}

  for (const [key, est, windowMs] of [
    ["5h", estimate.fiveHour, VERDENT_FREE_5H_MS] as const,
    ["weekly", estimate.weekly, VERDENT_FREE_WEEK_MS] as const,
  ]) {
    const exact = est.limit !== null
    const usedPercent = exact ? clampPercent((est.used / est.limit!) * 100) : null
    const sourceLabel = est.source === "learned" ? "learned" : est.source === "fallback" ? "estimated" : "learning"
    const resetAt = key === "5h" ? fetchedAt + VERDENT_FREE_5H_MS : fetchedAt + VERDENT_FREE_WEEK_MS
    windows[`${key} ${sourceLabel}`] = toUsageWindow({
      usedPercent,
      windowSeconds: windowMs / 1000,
      resetAt,
      valueLabel: exact ? null : `${est.used} used, cap at least ${est.knownAtLeast}`,
    })
  }

  const worstRemaining =
    [estimate.fiveHour, estimate.weekly]
      .map((e) => (e.limit !== null ? 100 - (e.used / e.limit) * 100 : null))
      .filter((v): v is number => v !== null)
      .reduce((min, v) => Math.min(min, v), 100) ?? null

  const planLabel =
    estimate.fiveHour.limit !== null && estimate.weekly.limit !== null
      ? `${estimate.fiveHour.used}/${estimate.fiveHour.limit} (5h) · ${estimate.weekly.used}/${estimate.weekly.limit} (wk)`
      : `${estimate.fiveHour.used}·${estimate.weekly.used} req`

  return {
    providerId: ID,
    providerName: NAME,
    ok: true,
    configured: true,
    planLabel,
    fetchedAt,
    nextRefreshAt: NEXT_REFRESH_NOW,
    usage: { windows },
  }
}

export const verdent = (usage: VerdentFreeUsage): Adapter => ({
  id: ID,
  name: NAME,
  aliases: ["verdent-free"],
  configured: () => Effect.succeed(true),
  fetch: () =>
    Effect.map(usage.snapshot(), (snapshot) => {
      const fetchedAt = Date.now()
      const result = verdentFreeProviderResult(estimateVerdentFreeLimit({ snapshot, now: fetchedAt }), fetchedAt)
      const verdentAccounts = verdentLimitSnapshot(fetchedAt)
      if (verdentAccounts.length === 0) return result
      return {
        ...result,
        usage: {
          windows: result.usage?.windows ?? {},
          verdentAccounts,
        },
      }
    }),
})
