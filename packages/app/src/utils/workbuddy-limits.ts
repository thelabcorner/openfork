/**
 * WorkBuddy promotional model limit research priors.
 * Mirrors Zen FUT architecture but keyed by Tencent account × model × window.
 * Values are estimates, not official constants — surface as ~384 / ~512.
 * Source: WORKBUDDY_HY3_HY4_RATE_LIMIT_RESEARCH.md 2026-08-29
 */
export const WORKBUDDY_LIMIT_RESEARCH = {
  version: 1,
  observedAt: "2026-08-29",
  models: {
    hy3: {
      estimatedLimit: 384,
      unit: "generation" as const,
      windowMs: 86_400_000,
      windowPolicy: "inferred-rolling" as const,
      confidence: "high" as const,
      evidence: {
        completedBeforeFirst6004: 383,
        inFlightCompletedAfterFirst6004: 1,
        firstActivationAt: "2026-08-29T17:52:55.387Z",
        resetAt: "2026-08-30T17:52:56.000Z",
      },
    },
    "hy4-preview": {
      estimatedLimit: 512,
      unit: "attempt-candidate" as const,
      windowPolicy: "server-defined" as const,
      confidence: "medium" as const,
      evidence: {
        inferredWindowStart: "2026-08-29T17:15:00.000Z",
        firstHard6004At: "2026-08-29T17:40:45.903Z",
        successfulCompletionsInWindow: 502,
        transient14003InWindow: 11,
      },
    },
  },
} as const

export type WorkBuddyResearchModelId = keyof typeof WORKBUDDY_LIMIT_RESEARCH.models

export type WorkBuddyModelLimitReport = {
  accountId: string
  model: string
  unit: "generation" | "attempt-candidate" | "unknown"
  usedObserved: number
  limitEstimate: number | null
  remainingEstimate: number | null
  remainingPercent: number | null
  status: "healthy" | "draining" | "low" | "critical" | "terminal" | "depleted" | "unknown"
  confidence: "low" | "medium" | "high" | "very-high"
  exhaustedObserved: boolean
  serverCode?: number
  window: {
    type: "server-defined" | "inferred-rolling-24h" | "unknown"
    startedAt: string | null
    resetsAt: string | null
    secondsUntilReset: number | null
    resetSource: "server-6004" | "inferred" | "unknown"
  }
  rate: {
    observedUnitsPerMinute: number
    observedUnitsPerHour: number
    source: "recent" | "window-average" | "insufficient-data"
  }
  projection: {
    estimatedExhaustionAt: string | null
    willLikelyExhaustBeforeReset: boolean | null
  }
  tokens: { prompt: number; completion: number; total: number; cacheHit: number; cacheMiss: number }
  coverage: "complete-openfork" | "partial" | "unknown"
  accuracy: "observed" | "estimate" | "server-confirmed"
}

const STATUS_THRESHOLDS = [
  { max: 0, status: "depleted" as const },
  { max: 5, status: "terminal" as const },
  { max: 15, status: "critical" as const },
  { max: 30, status: "low" as const },
  { max: 60, status: "draining" as const },
  { max: 100, status: "healthy" as const },
]

export function statusForRemaining(remainingPercent: number | null): WorkBuddyModelLimitReport["status"] {
  if (remainingPercent === null || !Number.isFinite(remainingPercent)) return "unknown"
  if (remainingPercent <= 0) return "depleted"
  for (const t of STATUS_THRESHOLDS) if (remainingPercent <= t.max) return t.status
  return "healthy"
}

/** Parse Tencent 6004 reset string: "2026-08-31 01:15:00 UTC+8" -> epoch ms */
export function parseTencent6004Reset(text: string): number | null {
  // Tencent returns "usage will reset at 2026-08-31 01:15:00 UTC+8" in error message
  const m = text.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s*UTC\+8/i)
  if (!m) return null
  const iso = `${m[1]}T${m[2]}+08:00`
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

export function isHard6004(error: { code?: number; message?: string } | null): boolean {
  if (!error) return false
  if (error.code === 6000 || error.code === 6004) return true
  return /6000|6004|frequency limit|usage will reset at|frequency window limit/i.test(error.message ?? "")
}
export function isTransient14003(error: { code?: number; message?: string } | null): boolean {
  if (!error) return false
  if (error.code === 14003) return true
  return /14003|too many requests/i.test(error.message ?? "") && !isHard6004(error)
}

/** Aggregate 5h + 24h across models/accounts, weighted like globalBuckets in limits-panel */
export function aggregateWorkBuddyWindow(reports: WorkBuddyModelLimitReport[], window: "5h" | "24h"): { remaining: number | null; minResetAt: number | null; maxResetAt: number | null } {
  // 5h = short burn-rate bucket (use observedUnitsPerHour), 24h = hard quota bucket
  const vals = reports.map((r) => r.remainingPercent).filter((v): v is number => v !== null && Number.isFinite(v))
  const resets = reports.map((r) => (r.window.resetsAt ? Date.parse(r.window.resetsAt) : null)).filter((v): v is number => v !== null && Number.isFinite(v))
  if (!vals.length) return { remaining: null, minResetAt: null, maxResetAt: null }
  return {
    remaining: vals.reduce((a, b) => a + b, 0) / vals.length,
    minResetAt: resets.length ? Math.min(...resets) : null,
    maxResetAt: resets.length ? Math.max(...resets) : null,
  }
}
