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
  /**
   * REAL WorkBuddy-reported consumption accumulated over the current window.
   *
   * The proxy receives per-request `credit` and token fields in the streamed
   * usage object from upstream (see WORKBUDDY_USAGE_API_RESEARCH.md — the
   * forensic `rawUsage` shape). Summing them gives the user a true spend
   * figure rather than `observed × publishedRate`, which is what allows the
   * picker to invert credits-left into a precise request estimate and to
   * backtrack "how many did I burn in the last 24h".
   *
   * Reset to zero by `expireModel` when the frequency window rolls over.
   */
  creditsObserved: number
  tokensInput: number
  tokensOutput: number
  tokensCacheHit: number
  tokensCacheMiss: number
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
    creditsObserved: 0,
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheHit: 0,
    tokensCacheMiss: 0,
  }
}

const HISTORY_CAP = 5
const TIMESTAMP_CAP = 200
const BURN_WINDOW_MS = 60 * 60 * 1000

/**
 * Observations required before the locally averaged credit cost is trusted over
 * the catalog's published rate. Mirrors the OpenCode Go picker's personal-cost
 * threshold: one or two samples are noise, a handful is a signal.
 */
export const MIN_SAMPLES_FOR_PERSONAL_RATE = 3

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
  /** Milliseconds until the next reset boundary. null when no window is known. */
  secondsUntilReset: number | null
  lastObservationAt: number | null
  burnPerHour: number | null
  estimatedExhaustionAt: number | null
  willLikelyExhaustBeforeReset: boolean | null
  /**
    * Sum of `credit` WorkBuddy reported via upstream `usage` for this model in
    * the current window — the real spend, not a sticker × observed estimate.
    */
  creditsObserved: number
  tokensInput: number
  tokensOutput: number
  tokensCacheHit: number
  tokensCacheMiss: number
  /** True once we've accumulated enough real spend to invert for an estimate. */
  creditsPersonalized: boolean
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

  const secondsUntilReset = resetAt !== null && resetAt > now ? Math.round((resetAt - now) / 1000) : null
  // Enough real spend to invert credits-left into a request estimate. Below
  // this the average is dominated by whichever single prompt happened to run.
  const creditsPersonalized = runtime.observed >= MIN_SAMPLES_FOR_PERSONAL_RATE && runtime.creditsObserved > 0

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
    secondsUntilReset,
    lastObservationAt: runtime.lastObservationAt,
    burnPerHour,
    estimatedExhaustionAt,
    willLikelyExhaustBeforeReset,
    creditsObserved: runtime.creditsObserved,
    tokensInput: runtime.tokensInput,
    tokensOutput: runtime.tokensOutput,
    tokensCacheHit: runtime.tokensCacheHit,
    tokensCacheMiss: runtime.tokensCacheMiss,
    creditsPersonalized,
    coverage: "opencode-only",
  }
}

/**
 * Tencent's "request illegal" code. Official client taxonomy: auth_forbidden.
 *
 * Verified against the bundled official client
 * (`cli/dist/codebuddy.js` `classifyErrorDetail`): 11140 and 11142 map to
 * `{category:"auth", subcategory:"auth_forbidden"}`, and
 * `isAuthRequiredLikeError` treats 403 + these codes as an auth-class
 * failure. Live bisection 2026-09-16 proved the rejection is account-scoped,
 * not request-shaped: an affected account failed every model (including a
 * minimal system+user request with no tools or params) while other accounts
 * succeeded with byte-identical requests, and a fresh token pair from
 * `/v2/plugin/auth/token/refresh` still received 11140.
 */
export const WORKBUDDY_REQUEST_ILLEGAL_CODE = 11140

/** All codes the official taxonomy classifies as `auth_forbidden`. */
export const WORKBUDDY_FORBIDDEN_CODES: readonly number[] = [11140, 11142]

/**
 * Tencent's thinking-mode round-trip code: "the reasoning content from the
 * previous turn must be passed back in thinking mode". Mirrors DeepSeek's
 * thinking-mode echo requirement (QwenLM/qwen-code#3579, Tencent ask/2211416:
 * the field is specifically lost around tool-call turns). Arrives as HTTP 400.
 */
export const WORKBUDDY_THINKING_ROUNDTRIP_CODE = 11155

function numericCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

/**
 * Extracts Tencent's structured `code` field (e.g. 6004, 14003, 11140) from a
 * raw JSON error body.
 *
 * Prefers the innermost Tencent code: some failures arrive wrapped (JSON-RPC
 * `{"code":-32603,...,"data":{...,"code":11140,"statusCode":403}}`, observed
 * live in workbuddy2api#2), where the outer code is transport framing and the
 * inner `data.code` is the authoritative Tencent verdict. A first-match regex
 * would return the wrapper (-32603) and lose the real code.
 */
export function parseErrorCode(raw: string): number | undefined {
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      const deep = (node: unknown): number | undefined => {
        if (!node || typeof node !== "object") return undefined
        const record = node as Record<string, unknown>
        // Tencent nests payloads under `data` (JSON-RPC wrapper); some
        // endpoints wrap errors as `{error:{data:{code,…}}}`.
        for (const key of ["data", "error", "cause"]) {
          const nested = record[key]
          if (nested && typeof nested === "object") {
            const inner = deep(nested)
            if (inner !== undefined) return inner
          }
        }
        return numericCode(record.code) ?? numericCode(record.error_code ?? record.errorCode)
      }
      const code = deep(parsed)
      if (code !== undefined) return code
    } catch {
      // Not JSON — fall through to the regex scan below.
    }
    const matches = [...raw.matchAll(/"code"\s*:\s*"?(-?\d+)"?/g)]
    const last = matches.length ? matches[matches.length - 1]?.[1] : undefined
    if (last !== undefined) return Number(last)
  }
  return undefined
}

/** Extracts Tencent's human message (`msg` / `message` / wrapped `details`). */
export function parseErrorMessage(raw: string, fallback: string): string {
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      const deep = (node: unknown): string | undefined => {
        if (!node || typeof node !== "object") return undefined
        const record = node as Record<string, unknown>
        for (const key of ["data", "error", "cause"]) {
          const nested = record[key]
          if (nested && typeof nested === "object") {
            const inner = deep(nested)
            if (inner) return inner
          }
        }
        // Tencent attaches a localized, user-facing explanation to some
        // errors (e.g. 11140 carries "The content did not pass the safety
        // review. Please adjust and retry."); it is strictly more useful
        // than the raw code text, so prefer it.
        const display = record.displayMsg
        if (display && typeof display === "object") {
          const text = (display as Record<string, unknown>).en ?? (display as Record<string, unknown>).zh
          if (typeof text === "string" && text.trim()) return text.slice(0, 300)
        }
        for (const key of ["msg", "message", "details", "detail"]) {
          const value = record[key]
          if (typeof value === "string" && value.trim()) return value.slice(0, 300)
        }
        return undefined
      }
      const message = deep(parsed)
      if (message) return message
    } catch {
      // Not JSON — fall through to the regex scan below.
    }
    const msg = raw.match(/"msg"\s*:\s*"([^"]{0,200})"/)?.[1]
    if (msg) return msg
    const message = raw.match(/"message"\s*:\s*"([^"]{0,200})"/)?.[1]
    if (message) return message
  }
  return fallback
}

/**
 * True when Tencent rejected the request because the account is forbidden
 * (official taxonomy `auth_forbidden`). Account-scoped, not request-shaped:
 * see the WORKBUDDY_REQUEST_ILLEGAL_CODE doc for the live evidence.
 */
export function isAccountForbidden(raw: string): boolean {
  const code = parseErrorCode(raw)
  if (code !== undefined && WORKBUDDY_FORBIDDEN_CODES.includes(code)) return true
  return /request illegal/i.test(raw)
}

/**
 * True when Tencent rejected the request because the account balance is
 * exhausted. The official taxonomy maps 14001, 14002, 14012–14014 and 14018
 * to `quota_balance_exhausted`; the gateway wraps them in HTTP 429, so they
 * must be recognised by code rather than by status (14018 observed live on
 * 2026-09-16 inside an `{error:{data:{code}}}` envelope).
 */
export function isBalanceExhausted(raw: string): boolean {
  const code = parseErrorCode(raw)
  if (code === 14001 || code === 14002 || code === 14018) return true
  if (code !== undefined && code >= 14012 && code <= 14014) return true
  return /credits? (are )?exhausted|insufficient credit|积分不足/i.test(raw)
}

/**
 * True for request-shape/backend validation rejections that must NEVER be
 * treated as auth failures and must never trigger a token refresh: 11155
 * (thinking-mode reasoning echo). A refresh cannot fix an illegal body —
 * retrying one just doubles the failure. Account-forbidden codes are NOT
 * validation errors; they are handled separately via `isAccountForbidden`.
 */
export function isValidationError(raw: string): boolean {
  const code = parseErrorCode(raw)
  if (code === WORKBUDDY_THINKING_ROUNDTRIP_CODE) return true
  return /reasoning_content/i.test(raw) && /thinking mode|passed back/i.test(raw)
}

/**
 * The consumption WorkBuddy reported for ONE request.
 *
 * Tencent bills in credits and reports the real figure per generation, which is
 * the honest replacement for "published rate × requests": it already accounts
 * for prompt size, reasoning volume, and cache behaviour.
 */
export type ObservedConsumption = {
  credit: number
  input: number
  output: number
  cacheHit: number
  cacheMiss: number
}

/**
 * Pull real per-request consumption out of a streamed usage object.
 *
 * The upstream shape is not one fixed contract, so every field is read through
 * several observed spellings:
 *  - credits may sit at `credit`, `credits`, `used_credit`, or nested under
 *    `rawUsage` (the forensic project-JSONL shape documented in
 *    WORKBUDDY_USAGE_API_RESEARCH.md).
 *  - tokens are OpenAI-shaped, with the cache split under either
 *    `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` or the nested
 *    `prompt_tokens_details.cached_tokens` form.
 *
 * Returns undefined when nothing numeric is present, so callers skip the
 * sample rather than recording a phantom zero. This matters most for the free
 * Hy models: the forensics show `rawUsage.credit = 0` for them, and a recorded
 * 0 must be preserved as a REAL zero (free), not treated as missing data.
 */
export function consumptionFrom(usage: unknown): ObservedConsumption | undefined {
  if (!usage || typeof usage !== "object") return undefined
  const raw = usage as Record<string, unknown>
  const nested = (raw.rawUsage ?? raw.raw_usage) as Record<string, unknown> | undefined
  const num = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      for (const source of [raw, nested]) {
        const value = source?.[key]
        if (typeof value === "number" && Number.isFinite(value)) return value
        if (typeof value === "string" && value.trim()) {
          const parsed = Number(value)
          if (Number.isFinite(parsed)) return parsed
        }
      }
    }
    return undefined
  }

  const credit = num("credit", "credits", "used_credit", "usedCredit", "consume_credit")
  const input = num("prompt_tokens", "promptTokens", "input_tokens")
  const output = num("completion_tokens", "completionTokens", "output_tokens")
  const details = (raw.prompt_tokens_details ?? nested?.prompt_tokens_details) as Record<string, unknown> | undefined
  const cacheHit = num("prompt_cache_hit_tokens", "promptCacheHitTokens", "cache_read_input_tokens") ??
    (typeof details?.cached_tokens === "number" ? details.cached_tokens : undefined)
  const cacheMiss = num("prompt_cache_miss_tokens", "promptCacheMissTokens")

  if (credit === undefined && input === undefined && output === undefined) return undefined
  return {
    credit: credit ?? 0,
    input: input ?? 0,
    output: output ?? 0,
    cacheHit: cacheHit ?? 0,
    cacheMiss: cacheMiss ?? (input !== undefined && cacheHit !== undefined ? Math.max(0, input - cacheHit) : 0),
  }
}
