/**
 * WorkBuddy promotional model-frequency estimator.
 *
 * Ported architecture (not assumptions) from the OpenCode Zen Free tracker:
 * an observed-usage estimator with explicit accuracy tiers (observed /
 * estimate / server-confirmed), confidence, burn rate, and projected
 * exhaustion. Zen's quota is one IP-scoped calendar-day reservoir shared by
 * every model; WorkBuddy's promotional Hy3/Hy4 quota is a completely
 * different shape, forensically reverse-engineered 2026-08-29
 * (see WORKBUDDY_HY3_HY4_RATE_LIMIT_RESEARCH.md):
 *
 *   hard promotional quota bucket = Tencent account × model × server window
 *
 * Evidence: the same account can have Hy4 hard-limited (Tencent code 6004)
 * while Hy3 and other models on that SAME account keep working, and a
 * DIFFERENT account's Hy4 keeps working while the first account's Hy4 stays
 * limited. So the entitlement key is (account, model), never the account
 * alone — see WorkBuddyEntitlementGovernor, which now tracks this map
 * per-model instead of one scalar state field.
 *
 * These are reverse-engineered estimates from ~4,500 forensic generation
 * records, not published Tencent limits, and MUST stay revisable: a local
 * hard-limit (6004) observation is fed back into `history` so the estimate
 * self-corrects toward what this specific account is actually seeing,
 * without ever overriding an authoritative server-confirmed 6004 in the
 * moment it happens.
 */

export type WorkBuddyCanonicalModel = "hy3" | "hy4-preview"

export type WorkBuddyResearchPrior = {
  limitEstimate: number
  /** The server calls this a "frequency limit" — unit is an admission count, not tokens. */
  unit: string
  confidence: "low" | "medium" | "high"
  windowPolicy: "inferred-rolling-24h" | "server-defined"
}

/**
 * Centralized, versioned research priors (doc section 41). Do not scatter
 * magic numbers through router/UI code — revise them here as controlled
 * experiments (doc sections 37-40) produce better evidence.
 */
export const WORKBUDDY_LIMIT_RESEARCH: Record<WorkBuddyCanonicalModel, WorkBuddyResearchPrior> = {
  hy3: {
    limitEstimate: 384,
    unit: "generations",
    confidence: "high",
    windowPolicy: "inferred-rolling-24h",
  },
  "hy4-preview": {
    limitEstimate: 512,
    unit: "attempts",
    confidence: "medium",
    windowPolicy: "server-defined",
  },
}

const HY3_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Maps a literal requested model id onto the research-prior family it
 * belongs to. The CN catalog's `hy3-preview-agent` is grouped under `hy3`
 * heuristically (same model family, no forensic evidence yet that its
 * counter is shared or separate from the Global `hy3` id) — split this if
 * live evidence ever shows otherwise.
 */
export function canonicalModelId(model: string): WorkBuddyCanonicalModel | null {
  const id = model.toLowerCase()
  if (id === "hy3" || id.startsWith("hy3-")) return "hy3"
  if (id === "hy4-preview" || id.startsWith("hy4-preview")) return "hy4-preview"
  return null
}

export type ModelEntitlementStatus = "healthy" | "draining" | "low" | "critical" | "terminal" | "depleted" | "unknown"

/** Status ladder over REMAINING percent, reused from the Zen tone philosophy (doc section 43). */
export function statusForRemaining(remainingPercent: number | null): ModelEntitlementStatus {
  if (remainingPercent === null || !Number.isFinite(remainingPercent)) return "unknown"
  if (remainingPercent <= 0) return "depleted"
  if (remainingPercent <= 5) return "terminal"
  if (remainingPercent <= 15) return "critical"
  if (remainingPercent <= 30) return "low"
  if (remainingPercent <= 60) return "draining"
  return "healthy"
}

/**
 * Mutable per-(account,model) runtime the governor owns and persists.
 * `recentTimestamps` is intentionally NOT persisted (burn rate is a live
 * signal, not a durable fact) — everything else survives restart.
 */
export type ModelEntitlementRuntime = {
  windowLimited: boolean
  resetAt: number | null
  accuracy: "estimate" | "server-confirmed"
  observed: number
  windowStartedAt: number | null
  /** Rolling median-ish of locally observed hard-limit hit counts; refines the research prior. */
  learnedLimit: number | null
  history: number[]
  recentTimestamps: number[]
  lastObservationAt: number | null
  serverCode: number | null
}

export function emptyModelRuntime(): ModelEntitlementRuntime {
  return {
    windowLimited: false,
    resetAt: null,
    accuracy: "estimate",
    observed: 0,
    windowStartedAt: null,
    learnedLimit: null,
    history: [],
    recentTimestamps: [],
    lastObservationAt: null,
    serverCode: null,
  }
}

const HISTORY_CAP = 5
const TIMESTAMP_CAP = 200
const BURN_WINDOW_MS = 60 * 60 * 1000

/** Feeds one confirmed hard-limit hit count into the learned-limit history (doc section 34, "reconcile"). */
export function absorbLearnedLimit(runtime: ModelEntitlementRuntime, observedAtHit: number) {
  if (observedAtHit <= 0) return
  runtime.history.push(observedAtHit)
  if (runtime.history.length > HISTORY_CAP) runtime.history.shift()
  const sum = runtime.history.reduce((a, b) => a + b, 0)
  runtime.learnedLimit = Math.round(sum / runtime.history.length)
}

export function recordTimestamp(runtime: ModelEntitlementRuntime, at: number) {
  runtime.recentTimestamps.push(at)
  if (runtime.recentTimestamps.length > TIMESTAMP_CAP) runtime.recentTimestamps.shift()
  runtime.lastObservationAt = at
}

export type ModelEntitlementReport = {
  model: string
  canonical: WorkBuddyCanonicalModel | null
  unit: string
  usedObserved: number
  limitEstimate: number | null
  remainingEstimate: number | null
  remainingPercent: number | null
  status: ModelEntitlementStatus
  confidence: "low" | "medium" | "high"
  accuracy: "observed" | "estimate" | "server-confirmed"
  exhaustedObserved: boolean
  serverCode: number | null
  resetAt: number | null
  resetSource: "server-6004" | "inferred" | "unknown"
  windowType: "server-defined" | "inferred-rolling-24h" | "unknown"
  windowStartedAt: number | null
  lastObservationAt: number | null
  burnPerHour: number | null
  estimatedExhaustionAt: number | null
  willLikelyExhaustBeforeReset: boolean | null
  /** OpenCode only sees generations it routed itself — see doc section 33. */
  coverage: "opencode-only"
}

/** Pure projection from runtime state to a display report. Never mutates. */
export function buildModelEntitlementReport(model: string, runtime: ModelEntitlementRuntime, now: number): ModelEntitlementReport {
  const canonical = canonicalModelId(model)
  const prior = canonical ? WORKBUDDY_LIMIT_RESEARCH[canonical] : undefined
  const windowLimited = runtime.windowLimited
  const limitEstimate = runtime.learnedLimit ?? prior?.limitEstimate ?? null
  const usedObserved = runtime.observed
  const remainingEstimate = windowLimited ? 0 : limitEstimate !== null ? Math.max(0, limitEstimate - usedObserved) : null
  const remainingPercent = limitEstimate !== null && limitEstimate > 0 ? Math.max(0, Math.min(100, (remainingEstimate! / limitEstimate) * 100)) : null
  const accuracy: ModelEntitlementReport["accuracy"] = windowLimited ? "server-confirmed" : limitEstimate !== null ? "estimate" : "observed"
  const confidence = runtime.learnedLimit !== null ? "high" : prior?.confidence ?? "low"
  const status: ModelEntitlementStatus = windowLimited ? "depleted" : statusForRemaining(remainingPercent)
  const unit = prior?.unit ?? "requests"

  const recentHour = runtime.recentTimestamps.filter((t) => now - t <= BURN_WINDOW_MS)
  const recentSpan = recentHour.length >= 2 ? recentHour[recentHour.length - 1]! - recentHour[0]! : 0
  const burnPerHour = recentHour.length >= 2 && recentSpan > 0
    ? ((recentHour.length - 1) / recentSpan) * 3_600_000
    : null

  const inferredResetAt = !windowLimited && canonical === "hy3" && runtime.windowStartedAt !== null ? runtime.windowStartedAt + HY3_WINDOW_MS : null
  const resetAt = windowLimited ? runtime.resetAt : inferredResetAt

  const estimatedExhaustionAt = windowLimited
    ? now
    : burnPerHour && remainingEstimate !== null && remainingEstimate > 0
      ? now + (remainingEstimate / burnPerHour) * 3_600_000
      : null
  const willLikelyExhaustBeforeReset =
    estimatedExhaustionAt !== null && resetAt !== null ? estimatedExhaustionAt < resetAt : null

  return {
    model,
    canonical,
    unit,
    usedObserved,
    limitEstimate,
    remainingEstimate,
    remainingPercent,
    status,
    confidence,
    accuracy,
    exhaustedObserved: windowLimited,
    serverCode: runtime.serverCode,
    resetAt,
    resetSource: windowLimited && runtime.resetAt !== null ? "server-6004" : inferredResetAt !== null ? "inferred" : "unknown",
    windowType: prior?.windowPolicy === "server-defined"
      ? "server-defined"
      : prior?.windowPolicy === "inferred-rolling-24h"
        ? "inferred-rolling-24h"
        : "unknown",
    windowStartedAt: runtime.windowStartedAt,
    lastObservationAt: runtime.lastObservationAt,
    burnPerHour,
    estimatedExhaustionAt,
    willLikelyExhaustBeforeReset,
    coverage: "opencode-only",
  }
}

/** Extracts Tencent's structured `code` field (e.g. 6004, 14003) from a raw JSON error body. */
export function parseErrorCode(raw: string): number | undefined {
  const m = raw.match(/"code"\s*:\s*"?(\d+)"?/)
  return m ? Number(m[1]) : undefined
}
