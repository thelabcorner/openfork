import { Effect } from "effect"
import type { Adapter } from "../registry"
import { NEXT_REFRESH_NOW } from "./http"
import { toUsageWindow } from "../format"
import type { ProviderResult, ZenKeyLimits } from "../schema"
import { zenLimitSnapshot } from "@/plugin/zen"
import {
  ZEN_FREE_DAY_MS,
  type Interface as ZenFreeUsage,
  type ZenFreeSnapshot,
  zenUtcDayEnd,
} from "@/usage/zen-free"

export const ZEN_FREE_FALLBACK_LIMIT = 200
export const ZEN_FREE_LOWER_BOUND_HORIZON_MS = 14 * ZEN_FREE_DAY_MS
export const ZEN_FREE_HIT_HALF_LIFE_MS = 14 * ZEN_FREE_DAY_MS

const NAME = "OpenCode Zen"
const ID = "opencode-zen"

type WeightedValue = { value: number; weight: number }

export type ZenFreeLimitSource = "fallback" | "learned" | "lower-bound"
export type ZenFreeLimitEstimate = {
  used: number
  limit: number | null
  knownAtLeast: number
  source: ZenFreeLimitSource
  confidence: number
  hitSamples: number
  lastLimitHitAt: number | null
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value))
}

const ZEN_KEY_STATE: Record<string, ZenKeyLimits["state"]> = {
  READY: "ready",
  COOLING_DOWN: "cooling",
  QUOTA_EXHAUSTED: "exhausted",
}

/**
 * One limits-panel row per configured Zen key. The free-tier estimate is
 * computed per account from the shared usage snapshot (the free limiter is
 * IP-scoped, so the pool window is common; per-key differentiation comes from
 * the governor state and the failover queue). Rows carry the governor's own
 * resetAt — the exact timestamp the router orders by — so the displayed
 * countdown and the next failover pick always agree.
 */
export function zenKeyLimitsRows(snapshot: ZenFreeSnapshot, now = Date.now()): ZenKeyLimits[] {
  return zenLimitSnapshot(now).map((entry) => {
    const estimate = estimateZenFreeLimit({ snapshot, now })
    const usedObserved = entry.everUsed ? estimate.used : null
    const resetAfterSeconds =
      entry.resetAt === null ? null : Math.max(0, Math.round((entry.resetAt - now) / 1000))
    return {
      keyId: entry.accountId,
      label: entry.label,
      state: ZEN_KEY_STATE[entry.state] ?? "unknown",
      exhausted: entry.state === "QUOTA_EXHAUSTED",
      everUsed: entry.everUsed,
      resetAt: entry.resetAt,
      resetAfterSeconds,
      usedObserved,
      limitEstimate: estimate.limit,
      remainingPercent:
        usedObserved === null || estimate.limit === null
          ? null
          : clampPercent(100 - (usedObserved / estimate.limit) * 100),
      estimateSource: usedObserved === null ? null : estimate.source,
      queuePosition: entry.queuePosition,
    }
  })
}

function weightedMedian(values: readonly WeightedValue[]) {
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
  return 2 ** (-Math.max(0, now - at) / ZEN_FREE_HIT_HALF_LIFE_MS)
}

export function estimateZenFreeLimit(input: {
  snapshot: ZenFreeSnapshot
  now?: number
  fallbackLimit?: number
}): ZenFreeLimitEstimate {
  const now = input.now ?? input.snapshot.until
  const used = Math.max(0, Math.round(input.snapshot.currentRequests))
  const fallback = Math.max(1, Math.round(input.fallbackLimit ?? ZEN_FREE_FALLBACK_LIMIT))
  const hits = input.snapshot.limitHits.filter(
    (hit) => Number.isFinite(hit.at) && hit.at <= now && Number.isFinite(hit.requests) && hit.requests > 0,
  )
  const latestHitAt = hits.reduce<number | null>(
    (latest, hit) => (latest === null || hit.at > latest ? hit.at : latest),
    null,
  )

  const weightedHits: WeightedValue[] = [{ value: fallback, weight: 0.35 }]
  let hitWeightTotal = 0
  for (const hit of hits) {
    const weight = hitWeight(now, hit.at)
    hitWeightTotal += weight
    weightedHits.push({ value: Math.max(1, Math.round(hit.requests)), weight })
  }
  const learned = hits.length > 0 ? weightedMedian(weightedHits) : null

  let knownAtLeast = used
  for (const day of input.snapshot.days) {
    if (day.start >= input.snapshot.currentDayStart) continue
    const at = day.start + ZEN_FREE_DAY_MS - 1
    if (now - at > ZEN_FREE_LOWER_BOUND_HORIZON_MS) continue
    if (latestHitAt !== null && at < latestHitAt) continue
    knownAtLeast = Math.max(knownAtLeast, Math.max(0, Math.round(day.requests)))
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

export function zenFreeProviderResult(estimate: ZenFreeLimitEstimate, fetchedAt: number): ProviderResult {
  const exact = estimate.limit !== null
  const usedPercent = exact ? clampPercent((estimate.used / estimate.limit!) * 100) : null
  const sourceLabel = estimate.source === "learned" ? "learned" : estimate.source === "fallback" ? "estimated" : "learning"
  const planLabel = exact
    ? estimate.source === "fallback"
      ? `${estimate.used}/~${estimate.limit} req`
      : `${estimate.used}/${estimate.limit} req`
    : `${estimate.used}/at least ${estimate.knownAtLeast} req`

  return {
    providerId: ID,
    providerName: NAME,
    ok: true,
    configured: true,
    planLabel,
    fetchedAt,
    // Zen reads a local usage snapshot, not a remote account endpoint: there
    // is no upstream to protect, so a refresh always does real work.
    nextRefreshAt: NEXT_REFRESH_NOW,
    usage: {
      windows: {
        [`daily ${sourceLabel}`]: toUsageWindow({
          usedPercent,
          windowSeconds: ZEN_FREE_DAY_MS / 1000,
          resetAt: zenUtcDayEnd(fetchedAt),
          valueLabel: exact ? null : `${estimate.used} used, cap at least ${estimate.knownAtLeast}`,
        }),
      },
    },
  }
}

export const opencodeZen = (usage: ZenFreeUsage): Adapter => ({
  id: ID,
  name: NAME,
  aliases: ["zen", "opencode-free", "opencode-zen-free"],
  configured: () => Effect.succeed(true),
  // `usage.snapshot()`'s error channel is `never` — it cannot fail — so there
  // is nothing to catch here. (A prior version wrapped this in
  // `Effect.catchAll`, which doesn't exist on this Effect version, with a
  // fallback snapshot built from an unimported `zenUtcDayStart`; every call
  // threw before ever reaching the map below, which is why every Zen request
  // was failing.)
  fetch: () =>
    Effect.map(usage.snapshot(), (snapshot) => {
      const fetchedAt = Date.now()
      const estimate = estimateZenFreeLimit({ snapshot, now: fetchedAt })
      const result = zenFreeProviderResult(estimate, fetchedAt)
      const zenKeys = zenKeyLimitsRows(snapshot, fetchedAt)
      if (zenKeys.length === 0) return result
      return {
        ...result,
        usage: {
          windows: result.usage?.windows ?? {},
          zenAccounts: zenKeys,
        },
      }
    }),
})
