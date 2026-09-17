/**
 * WorkBuddyEntitlementGovernor
 * =============================
 *
 * Sits BETWEEN one WorkBuddyAccount's `handleCompletions()` transport and
 * Tencent. It enforces the design principle "the account-local entitlement, not
 * the HTTP request, is the scheduling primitive" and it fixes the refresh
 * duplicate-generation bug (issue #1).
 *
 * Three independent controls (do NOT conflate them)
 * ------------------------------------------------
 *   1. CONCURRENCY BUDGET  - how many Tencent generations may be ACTIVELY
 *      streaming at once. Permissive by default (multi-session interactive use).
 *   2. LAUNCH-RATE BUDGET  - how frequently a NEW generation may START (token
 *      bucket). Already-running streams are unaffected; only *new starts* are
 *      paced. This is the primary control for Tencent's observed
 *      "usage exceeds frequency limit" 429s.
 *   3. WINDOW/QUOTA STATE  - authoritative limits learned from Tencent and
 *      enforced locally (see state machine below).
 *
 * Fair, session-aware scheduling
 * ------------------------------
 *   Admission uses weighted-fair queueing keyed by session. A long agent loop
 *   performing many sequential tool continuations (priority P0) cannot monopolize
 *   the entitlement and starve other interactive sessions: each session accrues
 *   virtual time as it is admitted, so the scheduler interleaves sessions.
 *
 * Entitlement state machine (overlaid on the two budgets)
 * -------------------------------------------------------
 *   READY               - nominal; generations may start.
 *   TRANSIENT_COOLDOWN  - short backoff after 5xx / unparseable 429; probe
 *                         allowed again once the window elapses. Reduces pressure.
 *   WINDOW_LIMITED      - Tencent returned a 429 carrying an AUTHORITATIVE reset
 *                         time ("usage will reset at 2026-08-31 01:15:00 UTC+8").
 *                         Persisted to disk and enforced LOCALLY until resetAt:
 *                         future OpenFork requests fail with the remaining reset
 *                         instead of probing Tencent again. (openchamber/
 *                         opencode-claude parity.)
 *
 *                         Forensically (2026-08-29 Hy3/Hy4 research), this is
 *                         scoped to (account, model), NOT the whole account:
 *                         the same account can have Hy4 hard-limited (Tencent
 *                         code 6004) while Hy3 keeps working on that same
 *                         account. So WINDOW_LIMITED is tracked per-model in
 *                         `models` (see workbuddy-model-entitlement.ts), not
 *                         as a scalar account-wide state — a model-specific
 *                         6004 must disable only that model, never the whole
 *                         account. Tencent's code 14003 ("too many requests")
 *                         is a SEPARATE transient/short-window condition that
 *                         never carries a durable reset and must never be
 *                         promoted to WINDOW_LIMITED.
 *   QUOTA_EXHAUSTED     - Tencent returned 402 (hard credit limit). Persisted;
 *                         enforced locally. Cleared only by explicit
 *                         re-enrollment/account-epoch change, never by ordinary
 *                         bearer-token rotation.
 *   AUTH_INVALID        - token dead (401/403 recovery failed). The next
 *                         generation may still attempt because the desktop or
 *                         vault may have been updated independently.
 *   UPSTREAM_DEGRADED   - Tencent is 5xx; informational, gated via cooldown.
 *
 * The gateway learns an entitlement fact ONCE and then enforces it locally.
 * Tencent does not have to tell every OpenFork session / title / subagent the
 * same limit independently.
 *
 * Other invariants
 * ----------------
 *  - Generation commit point: a Generation is COMMITTED on its first successful
 *    Attempt and is then NEVER re-issued. Kills the duplicate-generation bug.
 *  - Singleflight refresh is account-local (the caller keys it by account id).
 *  - Priority admission: tool-continuations (P0) are cheap to admit; titles (P4)
 *    are expensive - but fairness still interleaves sessions.
 *  - Bounded queueing: a surge beyond MAX_INFLIGHT is rejected (503), not buffered
 *    unbounded.
 *  - No synthetic health probes during cooldown/window/quota: we never fire a
 *    request merely to "check" health - that would itself burn the entitlement.
 *  - Conservative Retry-After: max(server Retry-After, exp backoff + jitter).
 *    Never below what the server asked for.
 *  - Never hedge: at most one in-flight Attempt per Generation.
 *  - Session affinity is enforced by the account router above this governor;
 *    this account-local governor never rotates credentials.
 *  - Do NOT hard-cap legitimate agent turns. A long tool-call loop is expected.
 *  - Adaptive, not max-throughput: on sustained pressure we REDUCE the launch
 *    rate and concurrency (backpressure); we never raise them above the
 *    configured baseline to chase throughput.
 *
 * Transport amplification metric
 * ------------------------------
 *   amplification = attempts / generations  (healthy ~1.00; a 401 recovery adds
 *   exactly one Attempt, counted as `authRecoveries`, never a redundant Generation)
 */

import { mkdirSync, renameSync, writeFileSync, readFileSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { dirname } from "path"
import {
  absorbLearnedLimit,
  buildModelEntitlementReport,
  canonicalModelId,
  consumptionFrom,
  emptyModelRuntime,
  isAccountForbidden,
  isBalanceExhausted,
  isValidationError,
  parseErrorCode,
  recordTimestamp,
  type ModelEntitlementReport,
  type ModelEntitlementRuntime,
} from "./workbuddy-model-entitlement"

export type AttemptOutcome = { status: number; ok: boolean }
export type GenerationPhase = "ADMITTED" | "COMMITTED" | "FAILED"

/**
 * WINDOW_LIMITED is intentionally NOT one of this account-wide state's live
 * values anymore (see the class doc below) — Tencent's frequency limit
 * (code 6004) is scoped to (account, model), tracked per-model in the
 * `models` map instead. The value is kept in the union only so an
 * old-schema persisted file from before this change parses without a type
 * error; the constructor treats it as unknown/READY on load.
 *
 * ACCOUNT_FORBIDDEN is the quarantine for Tencent's account-level
 * `auth_forbidden` verdict (codes 11140/11142, official client taxonomy).
 * Unlike AUTH_INVALID it cannot be cleared by refreshing — verified live
 * 2026-09-16: a fresh token pair still received 11140 — so it is time-boxed
 * (`forbiddenUntil`) and re-probed after the cooldown instead of being
 * retried on every generation.
 */
export type EntitlementState =
  | "READY"
  | "TRANSIENT_COOLDOWN"
  | "WINDOW_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "AUTH_INVALID"
  | "ACCOUNT_FORBIDDEN"
  | "UPSTREAM_DEGRADED"

export type AdmissionKind = "window" | "quota" | "cooldown" | "queue" | "cancel" | "duplicate" | "forbidden"

export class AdmissionError extends Error {
  constructor(
    public status: number,
    public retryAfter: number,
    message: string,
    public kind: AdmissionKind,
  ) {
    super(message)
    this.name = "AdmissionError"
  }
}

/**
 * Pure, network-free decision for one Generation's attempt schedule.
 * Regression target for issue #1: a successful first Attempt is committed and
 * never re-issued, regardless of credential expiry.
 */
export function planGeneration(params: {
  credExpired: boolean
  first: AttemptOutcome | null
  refreshedThisGeneration: boolean
}): { refreshBeforeAttempt: boolean; canRetry: boolean; done: boolean } {
  if (params.first === null) {
    return {
      refreshBeforeAttempt: params.credExpired && !params.refreshedThisGeneration,
      canRetry: true,
      done: false,
    }
  }
  if (params.first.ok) {
    return { refreshBeforeAttempt: false, canRetry: false, done: true }
  }
  if (params.first.status === 401 || params.first.status === 403) {
    if (params.refreshedThisGeneration) {
      return { refreshBeforeAttempt: false, canRetry: false, done: true }
    }
    return { refreshBeforeAttempt: true, canRetry: true, done: false }
  }
  return { refreshBeforeAttempt: false, canRetry: false, done: true }
}

/**
 * Outcome of one credential re-auth attempt as the governor sees it.
 *
 * `rejected` is the only AUTH_INVALID-qualifying failure: the refresh
 * endpoint answered 401/403, so the saved refresh token is dead. Network
 * errors, 5xx, timeouts, or a missing refresh token are transient and must
 * never exile an account. Mirrors the official client's own mapping
 * (`isAuthenticationInvalidError` → UnauthorizedError, everything else →
 * SignError).
 */
export type RefreshResult = { ok: true } | { ok: false; rejected: boolean }

export type RunGenerationOpts = {
  priority: number
  /** Stable per-generation label for observability. */
  genKey: string
  /** Exact upstream model id. Promotional hard limits are keyed by this model. */
  model?: string
  /** Session key for fair scheduling (e.g. OpenCode session id). */
  session?: string
  /** Reads credential expiry at call time (closure over live cred). */
  isExpired: () => boolean
  /**
   * Singleflight token refresh (closure over live cred). `rejected: true`
   * means the backend answered 401/403 on the refresh token — the only case
   * that may persist AUTH_INVALID. Transient failures must not.
   */
  refresh: () => Promise<RefreshResult>
  /** One upstream request. Re-reads the live cred for headers. */
  transport: () => Promise<Response>
  /** Optional cancellation from the OpenFork/client response lifecycle. */
  signal?: AbortSignal
  /** Stable OpenFork enrollment epoch; only explicit re-enrollment clears quota. */
  enrollmentEpoch?: string
  /** @deprecated retained for callers during migration; never clears quota. */
  currentToken?: string
}

export type GenerationLease = { release: () => void }
export type RunGenerationResult = { res: Response; committed: boolean; lease: GenerationLease }

// --- config (provisional baselines; tune from live evidence) -----------------
// The observed Tencent limit is a FREQUENCY limit, so the launch-rate budget is
// the primary control. Concurrency stays permissive for normal multi-session
// interactive use. All are overridable via env for live tuning.
const DEFAULT_MAX_CONCURRENT = Number(process.env.WORKBUDDY_MAX_CONCURRENT) || 4
const DEFAULT_LAUNCH_BURST = Number(process.env.WORKBUDDY_LAUNCH_BURST) || 4
const DEFAULT_LAUNCH_PER_SEC = Number(process.env.WORKBUDDY_LAUNCH_PER_SEC) || 4
const MAX_INFLIGHT = 24
const TRANSIENT_CAP_MS = 60_000
/**
 * How long a forbidden account is quarantined before OpenFork lets it try one
 * generation again. The restriction is Tencent-side (`auth_forbidden`) and
 * may be lifted at any time, so recovery is a timed probe rather than a
 * permanent exile — but it must never become a hammering loop. One hour keeps
 * our rejected-request footprint on a restricted account minimal.
 */
const DEFAULT_FORBIDDEN_COOLDOWN_MS = Number(process.env.WORKBUDDY_FORBIDDEN_COOLDOWN_MS) || 60 * 60_000
const PRESSURE_THRESHOLD = 3

// Weighted-fair queueing weights by priority: lower = admitted sooner.
// Tool continuations (P0) are cheap; titles (P4) are expensive - but a session
// still accrues virtual time, so no single session can monopolize.
const WEIGHT: Record<number, number> = { 0: 1, 2: 3, 4: 6 }

const DEFAULT_ENTITLEMENT_FILE = `${tmpdir()}/opencode-workbuddy-entitlement.json`
let ENTITLEMENT_FILE_OVERRIDE: string | undefined
/** Test-only: point the default singleton persistence at an isolated file. */
export function setEntitlementFile(p: string) {
  ENTITLEMENT_FILE_OVERRIDE = p
}

/** Test-only: clear the default singleton entitlement state. */
export function clearEntitlementForTest() {
  try {
    unlinkSync(ENTITLEMENT_FILE_OVERRIDE ?? DEFAULT_ENTITLEMENT_FILE)
  } catch {
    // not present - fine
  }
}

type PersistedModelEntitlement = {
  windowLimited: boolean
  resetAt: number | null
  accuracy: "estimate" | "server-confirmed"
  observed: number
  windowStartedAt: number | null
  learnedLimit: number | null
  history: number[]
  recentTimestamps?: number[]
  lastObservationAt?: number | null
  serverCode?: number | null
  /** Real per-window consumption, added in schema v2; absent in older files. */
  creditsObserved?: number
  tokensInput?: number
  tokensOutput?: number
  tokensCacheHit?: number
  tokensCacheMiss?: number
}

type Persisted = {
  schema?: number
  state: EntitlementState
  resetAt: number | null
  limitedEpoch: string | null
  at: number
  forbiddenUntil?: number | null
  models?: Record<string, PersistedModelEntitlement>
}

function loadPersisted(file: string): Persisted | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Persisted
  } catch {
    return undefined
  }
}

/**
 * Parse an authoritative reset time from a Tencent response. Prefers a real
 * `Retry-After` header, then structured JSON fields, then the natural-language
 * form we actually observed:
 *   "429 usage exceeds frequency limit ... your usage will reset at
 *    2026-08-31 01:15:00 UTC+8"
 * Returns a unix-ms timestamp, or undefined when no reset is known.
 */
export function parseResetAt(raw: string, retryAfter?: string | null): number | undefined {
  if (retryAfter) {
    const sec = Number(retryAfter)
    if (!Number.isNaN(sec)) return Date.now() + sec * 1000
    const t = Date.parse(retryAfter)
    if (!Number.isNaN(t)) return t
  }
  const json = raw.match(/"?(?:resetAt|reset_time|resetDate|reset_at)"?\s*:\s*("?[\d.:T\-+Z ]{8,}"?|\d+)/)
  if (json) {
    const v = json[1].replace(/^"|"$/g, "").trim()
    const t = Date.parse(v)
    if (!Number.isNaN(t)) return t
  }
  const m = raw.match(/reset\s+at\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})\s*(?:UTC|GMT)?\s*([+-]?\d{1,2}(?::?\d{2})?)?/i)
  if (m) {
    let iso = m[1].replace(" ", "T")
    const tz = m[2]
    if (tz) {
      const tm = tz.match(/([+-])(\d{1,2})(?::?(\d{2}))?/)
      if (tm) {
        const sign = tm[1]
        const hh = tm[2].padStart(2, "0")
        const mm = (tm[3] ?? "00").padStart(2, "0")
        iso += `${sign}${hh}:${mm}`
      }
    } else if (/UTC\+8/i.test(raw)) {
      iso += "+08:00"
    }
    const t = Date.parse(iso)
    if (!Number.isNaN(t)) return t
  }
  return undefined
}

async function safeBody(res: Response): Promise<string> {
  try {
    return await res.clone().text()
  } catch {
    return ""
  }
}

type Pending = {
  model: string
  priority: number
  session: string
  seq: number
  resolve: () => void
  reject: (e: any) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export type GovernorOptions = {
  /** Per-account persistence path. Omit only for the legacy/default singleton. */
  persistenceFile?: string
  maxConcurrent?: number
  launchBurst?: number
  launchPerSec?: number
  /** Test override for the auth_forbidden quarantine window. */
  forbiddenCooldownMs?: number
}

export class WorkBuddyEntitlementGovernor {
  private readonly entitlementFile: string
  // 1. concurrency budget
  private readonly defaultMaxConcurrent: number
  private maxConcurrent: number
  private active = 0

  // 2. launch-rate budget (token bucket)
  private readonly defaultLaunchPerSec: number
  private readonly launchCapacity: number
  private launchPerSec: number
  private launchTokens: number
  private launchLast = Date.now()
  private launchTimer: ReturnType<typeof setTimeout> | undefined

  // fair queue
  private pending: Pending[] = []
  private seq = 0
  private vt: Record<string, number> = {}

  // 3. entitlement state
  private state: EntitlementState = "READY"
  private resetAt: number | undefined
  private cooldownUntil = 0
  private limitedEpoch: string | undefined
  private readonly generationKeys = new Set<string>()
  private readonly models = new Map<string, ModelEntitlementRuntime>()
  /** Epoch ms until which the account is quarantined as auth_forbidden. */
  private forbiddenUntil = 0
  private readonly forbiddenCooldownMs: number

  /**
   * Pushed opportunistically by the quota adapter after a package-balance
   * poll succeeds (see `quota/providers/workbuddy.ts`'s `fetchAccountUsage`
   * caller). Tencent's backend runs its OWN Basic+Gift+Extra balance check
   * before every generation regardless of a model's published rate, so a
   * 0-credit account 402s even on a nominally free promotional model — this
   * cache lets the router steer automatic (non-pinned) selection away from
   * that account instead of discovering it the hard way. Not persisted: it
   * is a live snapshot refreshed on whatever cadence the Limits pane polls
   * at. `null` means "unknown" and must never be treated as exhausted —
   * better to try an account we haven't heard from than silently exclude it.
   */
  private packageCreditsRemaining: number | null = null

  // adaptive backpressure
  private pressure = 0

  // metrics
  private generations = 0
  private attempts = 0
  private committed = 0
  private failed = 0
  private authRecoveries = 0
  /** Last observed 401/403 transport failure (in-memory diagnostic). */
  private lastAuthFailure: { at: number; status: number; code?: number } | null = null

  constructor(options: GovernorOptions = {}) {
    this.entitlementFile = options.persistenceFile ?? ENTITLEMENT_FILE_OVERRIDE ?? DEFAULT_ENTITLEMENT_FILE
    this.defaultMaxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)
    this.maxConcurrent = this.defaultMaxConcurrent
    this.defaultLaunchPerSec = Math.max(0.5, options.launchPerSec ?? DEFAULT_LAUNCH_PER_SEC)
    this.launchPerSec = this.defaultLaunchPerSec
    this.launchCapacity = Math.max(1, options.launchBurst ?? DEFAULT_LAUNCH_BURST)
    this.launchTokens = this.launchCapacity
    this.forbiddenCooldownMs = Math.max(1_000, options.forbiddenCooldownMs ?? DEFAULT_FORBIDDEN_COOLDOWN_MS)

    // Learn-once: restore a persisted hard/window limit so a fresh OpenFork
    // session enforces it without re-probing Tencent.
    const p = loadPersisted(this.entitlementFile)
    if (!p) return
    if (p.state === "QUOTA_EXHAUSTED") {
      this.state = "QUOTA_EXHAUSTED"
      this.limitedEpoch = p.limitedEpoch ?? undefined
    } else if (p.state === "AUTH_INVALID") {
      // A dead vault token stays dead across restarts: without this, every
      // fresh process retries the revoked credential, burns a refresh, fails
      // with 401 again, and pins the session via affinity. Healing happens
      // only through success (clears to READY), explicit re-enrollment, or
      // desktop heal — never by restarting.
      this.state = "AUTH_INVALID"
    } else if (p.state === "ACCOUNT_FORBIDDEN" && p.forbiddenUntil && p.forbiddenUntil > Date.now()) {
      // A Tencent-side account restriction survives restarts for its
      // cooldown window; after that the account gets one fresh probe.
      this.state = "ACCOUNT_FORBIDDEN"
      this.forbiddenUntil = p.forbiddenUntil
    }
    for (const [model, saved] of Object.entries(p.models ?? {})) {
      const runtime = emptyModelRuntime()
      runtime.windowLimited = saved.windowLimited
      runtime.resetAt = saved.resetAt
      runtime.accuracy = saved.accuracy
      runtime.observed = Math.max(0, saved.observed)
      runtime.windowStartedAt = saved.windowStartedAt
      runtime.learnedLimit = saved.learnedLimit
      runtime.history = [...saved.history].slice(-5)
      runtime.recentTimestamps = [...(saved.recentTimestamps ?? [])].slice(-200)
      runtime.lastObservationAt = saved.lastObservationAt ?? runtime.recentTimestamps.at(-1) ?? null
      runtime.serverCode = saved.serverCode ?? (saved.windowLimited ? 6004 : null)
      // Older persisted files predate consumption tracking; default to zero
      // rather than dropping the window state we do have.
      runtime.creditsObserved = Math.max(0, saved.creditsObserved ?? 0)
      runtime.tokensInput = Math.max(0, saved.tokensInput ?? 0)
      runtime.tokensOutput = Math.max(0, saved.tokensOutput ?? 0)
      runtime.tokensCacheHit = Math.max(0, saved.tokensCacheHit ?? 0)
      runtime.tokensCacheMiss = Math.max(0, saved.tokensCacheMiss ?? 0)
      this.models.set(model, runtime)
    }
    this.expireModels(Date.now())
  }

  // --- persistence ------------------------------------------------------------
  private persist() {
    try {
      mkdirSync(dirname(this.entitlementFile), { recursive: true })
      const models = Object.fromEntries([...this.models.entries()].map(([model, runtime]) => [model, {
        windowLimited: runtime.windowLimited,
        resetAt: runtime.resetAt,
        accuracy: runtime.accuracy,
        observed: runtime.observed,
        windowStartedAt: runtime.windowStartedAt,
        learnedLimit: runtime.learnedLimit,
        history: runtime.history,
        recentTimestamps: runtime.recentTimestamps,
        lastObservationAt: runtime.lastObservationAt,
        serverCode: runtime.serverCode,
        creditsObserved: runtime.creditsObserved,
        tokensInput: runtime.tokensInput,
        tokensOutput: runtime.tokensOutput,
        tokensCacheHit: runtime.tokensCacheHit,
        tokensCacheMiss: runtime.tokensCacheMiss,
      }]))
      const temp = `${this.entitlementFile}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify({
        schema: 2,
        state: this.state,
        resetAt: this.resetAt ?? null,
        limitedEpoch: this.limitedEpoch ?? null,
        forbiddenUntil: this.forbiddenUntil || null,
        at: Date.now(),
        models,
      }))
      renameSync(temp, this.entitlementFile)
    } catch {
      // best-effort
    }
  }

  private clearHardLimit() {
    this.state = "READY"
    this.resetAt = undefined
    this.limitedEpoch = undefined
    this.persist()
  }

  private setState(state: EntitlementState, resetAt?: number) {
    this.state = state
    this.resetAt = resetAt
    this.persist()
  }

  private modelKey(model: string): string {
    return canonicalModelId(model) ?? model.toLowerCase()
  }

  private runtimeFor(model: string): ModelEntitlementRuntime {
    const key = this.modelKey(model)
    let runtime = this.models.get(key)
    if (!runtime) {
      runtime = emptyModelRuntime()
      this.models.set(key, runtime)
    }
    return runtime
  }

  private expireModel(model: string, now: number): boolean {
    const runtime = this.models.get(this.modelKey(model))
    if (!runtime) return false
    const inferredResetAt = this.modelKey(model) === "hy3" && runtime.windowStartedAt !== null
      ? runtime.windowStartedAt + 24 * 60 * 60 * 1000
      : null
    const resetAt = runtime.windowLimited ? runtime.resetAt : inferredResetAt
    if (resetAt === null || now < resetAt) return false
    runtime.windowLimited = false
    runtime.resetAt = null
    runtime.accuracy = "estimate"
    runtime.observed = 0
    runtime.windowStartedAt = null
    runtime.recentTimestamps = []
    runtime.lastObservationAt = null
    runtime.serverCode = null
    // Consumption is per-window: what was spent before the reset says nothing
    // about the new window's balance, so the running sums restart too.
    runtime.creditsObserved = 0
    runtime.tokensInput = 0
    runtime.tokensOutput = 0
    runtime.tokensCacheHit = 0
    runtime.tokensCacheMiss = 0
    return true
  }

  private expireModels(now: number) {
    let changed = false
    for (const model of this.models.keys()) changed = this.expireModel(model, now) || changed
    if (changed) this.persist()
  }

  canAdmitModel(model: string, now = Date.now()): boolean {
    if (this.expireModel(model, now)) this.persist()
    return !this.runtimeFor(model).windowLimited
  }

  /**
   * Fold one completed request's REAL consumption into the model's window.
   *
   * `usage` is whatever upstream streamed back. WorkBuddy reports the actual
   * credit cost per generation, which is strictly better evidence than the
   * catalog's published rate: it already reflects this user's prompt size,
   * reasoning volume, and cache behaviour. Summing it answers "how many
   * credits/points did I burn in this window" and, divided by the observed
   * request count, yields the true average cost per request the picker needs.
   *
   * Called once per logical generation, after a successful response — never
   * per SSE chunk, and never for a transport retry or a 14003 (which produced
   * no generation and consumed nothing measurable).
   */
  recordUsage(model: string, usage: unknown, at = Date.now()) {
    const consumption = consumptionFrom(usage)
    if (!consumption) return
    if (this.expireModel(model, at)) this.persist()
    const runtime = this.runtimeFor(model)
    runtime.creditsObserved += consumption.credit
    runtime.tokensInput += consumption.input
    runtime.tokensOutput += consumption.output
    runtime.tokensCacheHit += consumption.cacheHit
    runtime.tokensCacheMiss += consumption.cacheMiss
    this.persist()
  }

  modelReport(model: string, now = Date.now()): ModelEntitlementReport {
    if (this.expireModel(model, now)) this.persist()
    return buildModelEntitlementReport(this.modelKey(model), this.runtimeFor(model), now)
  }

  /**
   * Record a provider-specific quota error discovered inside a successful HTTP
   * stream. HTTP status observation cannot see these 200 + SSE error frames,
   * so adapters call this after translating the frame. The model bucket stays
   * account-local; a later explicit re-enrollment or inferred reset clears it.
   */
  recordInBandRateLimit(model: string, raw: string, now = Date.now()) {
    const lower = raw.toLowerCase()
    const resetAt = parseResetAt(raw) ?? (
      lower.includes("weekly")
        ? now + 7 * 24 * 60 * 60 * 1000
        : lower.includes("5-hour") || lower.includes("5 hour") || lower.includes("5h")
          ? now + 5 * 60 * 60 * 1000
          : now + 24 * 60 * 60 * 1000
    )
    const runtime = this.runtimeFor(model)
    runtime.windowLimited = true
    runtime.resetAt = resetAt > now ? resetAt : now + 60_000
    runtime.accuracy = "server-confirmed"
    runtime.serverCode = 429
    absorbLearnedLimit(runtime, runtime.observed)
    this.persist()
  }

  /**
   * Only canonical promotional models (hy3/hy4-preview) are always reported —
   * every other model this account has ever routed through also gets a
   * runtime entry (see `runtimeFor`), but surfacing all of them would bury
   * the two models this feature is actually about under a wall of "0
   * observed" rows for models with no promotional-quota story at all. A
   * non-canonical model only earns a row once it has real evidence attached
   * (usage or a hard 6004 hit).
   */
  modelReports(now = Date.now()): ModelEntitlementReport[] {
    this.expireModels(now)
    const keys = new Set<string>(["hy3", "hy4-preview", ...this.models.keys()])
    return [...keys]
      .map((model) => buildModelEntitlementReport(model, this.runtimeFor(model), now))
      .filter((r) => r.canonical !== null || r.usedObserved > 0 || r.exhaustedObserved)
  }

  // --- adaptive backpressure (reduce on pressure, never maximize throughput) ---
  private applyPressure() {
    this.pressure++
    if (this.pressure >= PRESSURE_THRESHOLD) {
      this.launchPerSec = Math.max(0.5, this.launchPerSec * 0.5)
      this.maxConcurrent = Math.max(1, this.maxConcurrent - 1)
      this.pressure = 0
    }
  }

  private relievePressure() {
    this.pressure = Math.max(0, this.pressure - 1)
    if (this.state === "READY") {
      this.launchPerSec = Math.min(this.defaultLaunchPerSec, this.launchPerSec + 0.25)
      this.maxConcurrent = Math.min(this.defaultMaxConcurrent, this.maxConcurrent + 1)
    }
  }

  // --- launch-rate token bucket -------------------------------------------------
  private refillLaunch() {
    const now = Date.now()
    const elapsed = (now - this.launchLast) / 1000
    this.launchTokens = Math.min(this.launchCapacity, this.launchTokens + elapsed * this.launchPerSec)
    this.launchLast = now
  }

  private scheduleLaunchPump() {
    if (this.launchTimer) return
    const delay = Math.max(20, 1000 / this.launchPerSec)
    this.launchTimer = setTimeout(() => {
      this.launchTimer = undefined
      this.pump()
    }, delay)
  }

  // --- fair queue selection (weighted fair queueing by session) ---------------
  private selectNext(): Pending | undefined {
    if (!this.pending.length) return undefined
    const now = Date.now()
    let best: Pending | undefined
    let bestTag = Infinity
    let bestSeq = Infinity
    for (const p of this.pending) {
      const base = Math.max(this.vt[p.session] ?? 0, now)
      const tag = base + (WEIGHT[p.priority] ?? 3)
      if (tag < bestTag - 1e-9 || (Math.abs(tag - bestTag) < 1e-9 && p.seq < bestSeq)) {
        best = p
        bestTag = tag
        bestSeq = p.seq
      }
    }
    if (best) {
      this.vt[best.session] = Math.max(this.vt[best.session] ?? 0, now) + (WEIGHT[best.priority] ?? 3)
      const index = this.pending.indexOf(best)
      if (index >= 0) this.pending.splice(index, 1)
    }
    return best
  }

  // --- admission ---------------------------------------------------------------
  private admit(priority: number, session: string, model: string, signal?: AbortSignal): Promise<void> {
    const now = Date.now()
    if (signal?.aborted) return Promise.reject(new AdmissionError(499, 0, "generation canceled before admission", "cancel"))

    // An auth_forbidden quarantine is account-level and trumps per-model
    // state: Tencent rejected the whole account, not this request.
    this.expireForbidden(now)
    if (this.state === "ACCOUNT_FORBIDDEN") {
      const ra = Math.max(1, Math.ceil((this.forbiddenUntil - now) / 1000))
      return Promise.reject(
        new AdmissionError(403, ra, `WorkBuddy has restricted this account (auth_forbidden); next probe in ${ra}s`, "forbidden"),
      )
    }

    // A learned promotional limit blocks only this account+model bucket.
    if (!this.canAdmitModel(model, now)) {
      const runtime = this.runtimeFor(model)
      const ra = runtime.resetAt ? Math.max(1, Math.ceil((runtime.resetAt - now) / 1000)) : 3600
      const until = runtime.resetAt ? ` until ${new Date(runtime.resetAt).toISOString()}` : ""
      return Promise.reject(new AdmissionError(429, ra, `${this.modelKey(model)} frequency window limit${until}`, "window"))
    }
    // A learned hard credit limit is enforced locally; re-auth (token change) clears it.
    if (this.state === "QUOTA_EXHAUSTED") {
      return Promise.reject(new AdmissionError(402, 0, "entitlement credits exhausted for this account", "quota"))
    }
    // Transient backoff elapses into READY.
    if (now < this.cooldownUntil) {
      if (this.state === "TRANSIENT_COOLDOWN" || this.state === "UPSTREAM_DEGRADED") this.state = "READY"
      const ra = Math.ceil((this.cooldownUntil - now) / 1000)
      return Promise.reject(new AdmissionError(429, ra, "transient upstream cooldown", "cooldown"))
    }
    if (this.state === "TRANSIENT_COOLDOWN" || this.state === "UPSTREAM_DEGRADED") this.state = "READY"

    if (this.active + this.pending.length >= MAX_INFLIGHT) {
      return Promise.reject(new AdmissionError(503, 1, "admission queue full", "queue"))
    }
    return new Promise<void>((resolve, reject) => {
      const pending: Pending = { model, priority, session, seq: this.seq++, resolve, reject, signal }
      const cancel = () => {
        const index = this.pending.indexOf(pending)
        if (index < 0) return
        this.pending.splice(index, 1)
        if (pending.onAbort) signal?.removeEventListener("abort", pending.onAbort)
        reject(new AdmissionError(499, 0, "generation canceled while queued", "cancel"))
      }
      pending.onAbort = cancel
      signal?.addEventListener("abort", cancel, { once: true })
      this.pending.push(pending)
      this.pump()
    })
  }

  private pump() {
    this.refillLaunch()
    while (this.active < this.maxConcurrent && this.pending.length) {
      if (this.launchTokens < 1) {
        this.scheduleLaunchPump()
        break
      }
      const next = this.selectNext()
      if (!next) break
      if (!this.canAdmitModel(next.model)) {
        const runtime = this.runtimeFor(next.model)
        const retryAfter = runtime.resetAt ? Math.max(1, Math.ceil((runtime.resetAt - Date.now()) / 1000)) : 3600
        next.reject(new AdmissionError(429, retryAfter, `${this.modelKey(next.model)} frequency window limit`, "window"))
        continue
      }
      if (next.signal?.aborted) {
        next.reject(new AdmissionError(499, 0, "generation canceled while queued", "cancel"))
        continue
      }
      if (next.onAbort) next.signal?.removeEventListener("abort", next.onAbort)
      this.launchTokens -= 1
      this.active++
      next.resolve()
    }
  }

  private release() {
    this.active = Math.max(0, this.active - 1)
    this.pump()
  }

  async runGeneration(opts: RunGenerationOpts): Promise<RunGenerationResult> {
    const session = opts.session ?? "default"
    const model = opts.model ?? "unknown"
    if (this.generationKeys.has(opts.genKey)) {
      throw new AdmissionError(409, 0, `duplicate logical generation: ${opts.genKey}`, "duplicate")
    }
    this.generationKeys.add(opts.genKey)
    let admitted = false
    let handedOff = false
    const releaseLease = () => {
      // Clear the logical-generation guard on every terminal path, including
      // admission rejection/cancellation before a slot was acquired.
      this.generationKeys.delete(opts.genKey)
      if (!admitted) return
      admitted = false
      this.release()
    }
    try {
      // Explicit re-enrollment/account epoch is the only automatic quota reset.
      // Bearer-token rotation alone is deliberately ignored.
      if (this.state === "QUOTA_EXHAUSTED" && opts.enrollmentEpoch && this.limitedEpoch && opts.enrollmentEpoch !== this.limitedEpoch) {
        this.clearHardLimit()
      }
      await this.admit(opts.priority, session, model, opts.signal)
      admitted = true
      if (opts.enrollmentEpoch) this.limitedEpoch = this.limitedEpoch ?? opts.enrollmentEpoch
      this.generations++
      const promotional = canonicalModelId(model)
      if (promotional) {
        const runtime = this.runtimeFor(promotional)
        const now = Date.now()
        runtime.observed++
        runtime.windowStartedAt = runtime.windowStartedAt ?? now
        recordTimestamp(runtime, now)
        this.persist()
      }
      let refreshedThisGeneration = false
      let first: AttemptOutcome | null = null
      let res: Response | null = null
      for (let i = 0; i < 2; i++) {
        if (opts.signal?.aborted) throw new AdmissionError(499, 0, "generation canceled", "cancel")
        const plan = planGeneration({ credExpired: opts.isExpired(), first, refreshedThisGeneration })
        if (plan.refreshBeforeAttempt) {
          const refreshed = await opts.refresh()
          refreshedThisGeneration = true
          if (opts.signal?.aborted) throw new AdmissionError(499, 0, "generation canceled", "cancel")
          if (!refreshed.ok && first && (first.status === 401 || first.status === 403)) {
            // The first attempt was rejected and refresh did not produce a
            // usable token; `res` is that first response. Only a refresh the
            // backend *rejected* (401/403 on X-Refresh-Token) is definitive
            // evidence of a dead credential — a transient refresh failure
            // (network/5xx/timeout/no refresh token) must not be persisted as
            // AUTH_INVALID. Auth_forbidden was already quarantined by
            // observe(), and validation rejections never poison.
            const secondRaw = res ? await safeBody(res) : ""
            const secondCode = parseErrorCode(secondRaw)
            this.lastAuthFailure = {
              at: Date.now(),
              status: res?.status ?? first.status,
              ...(secondCode !== undefined ? { code: secondCode } : {}),
            }
            if (refreshed.rejected && !isValidationError(secondRaw) && !isAccountForbidden(secondRaw)) this.setState("AUTH_INVALID")
            this.failed++
            return { res: res!, committed: false, lease: { release: releaseLease } }
          }
        }
        res = await opts.transport()
        this.attempts++
        const outcome = { status: res.status, ok: res.ok }
        await this.observe(model, outcome, res)
        if (outcome.ok) {
          this.committed++
          if (refreshedThisGeneration) this.authRecoveries++
          // A real generation is the only thing that can refute a chat-level
          // account restriction or a dead-token verdict.
          if (this.state === "AUTH_INVALID" || this.state === "ACCOUNT_FORBIDDEN") this.clearLearnedBlocks()
          this.relievePressure()
          // The lease remains active until the caller drains or cancels the body.
          if (res.body) {
            handedOff = true
            return { res, committed: true, lease: { release: releaseLease } }
          }
          releaseLease()
          return { res, committed: true, lease: { release: () => undefined } }
        }
        if (res.status === 401 || res.status === 403) {
          if (refreshedThisGeneration) {
            const raw = await safeBody(res)
            const code = parseErrorCode(raw)
            // observe() already quarantined an auth_forbidden account; a
            // thinking-echo validation rejection never poisons state.
            if (!isAccountForbidden(raw)) {
              this.lastAuthFailure = { at: Date.now(), status: res.status, ...(code !== undefined ? { code } : {}) }
              if (!isValidationError(raw)) this.setState("AUTH_INVALID")
            }
            this.failed++
            return { res: res!, committed: false, lease: { release: releaseLease } }
          }
          // Fail fast on rejections a refresh cannot fix: an auth_forbidden
          // account needs the Tencent restriction lifted (verified live: a
          // refreshed token pair still gets 11140), and a validation
          // rejection needs a different body. Retrying would only double it.
          const firstRaw = await safeBody(res)
          if (isAccountForbidden(firstRaw) || isValidationError(firstRaw)) {
            this.failed++
            return { res: res!, committed: false, lease: { release: releaseLease } }
          }
          first = outcome
          continue
        }
        this.failed++
        return { res: res!, committed: false, lease: { release: releaseLease } }
      }
      return { res: res!, committed: false, lease: { release: releaseLease } }
    } catch (error) {
      releaseLease()
      throw error
    } finally {
      // A successful body is owned by handleCompletions. Every other path must
      // release immediately; the flag makes this explicit and leak-resistant.
      if (!handedOff && admitted) releaseLease()
    }
  }

  private async observe(model: string, outcome: AttemptOutcome, res: Response) {
    const retryAfter = res.headers.get("retry-after")
    if (outcome.status === 429) {
      const raw = await safeBody(res)
      const code = parseErrorCode(raw)
      // Balance exhaustion (14018 et al.) arrives wrapped in HTTP 429 but is
      // `quota_balance_exhausted` in the official taxonomy — it must not fall
      // into the transient cooldown path and hammer the gateway.
      if (isBalanceExhausted(raw)) {
        this.limitedEpoch = this.limitedEpoch ?? "unknown-enrollment"
        this.setState("QUOTA_EXHAUSTED")
        return
      }
      const resetAt = parseResetAt(raw, retryAfter)
      const isHardFrequency = code === 6000 || code === 6004 || /usage exceeds frequency limit|frequency window limit/i.test(raw)
      if (isHardFrequency && code !== 14003 && resetAt) {
        // Authoritative hard state is STRICTLY account+model scoped (not account-global).
        // A 14003 ("too many requests") may carry Retry-After, but it is transient transport
        // pressure and must never deplete the 24h promotional window. Only 6000/6004 with an
        // explicit resetAt hits the per-model WINDOW_LIMITED.
        const runtime = this.runtimeFor(model)
        runtime.windowLimited = true
        runtime.resetAt = resetAt && resetAt > Date.now() ? resetAt : null
        runtime.accuracy = "server-confirmed"
        runtime.serverCode = code ?? 6000
        absorbLearnedLimit(runtime, runtime.observed)
        this.persist()
      } else if (isHardFrequency && code !== 14003) {
        // Fallback: server said frequency limit without parsable reset — treat as hard but infer 24h
        const runtime = this.runtimeFor(model)
        runtime.windowLimited = true
        runtime.resetAt = resetAt && resetAt > Date.now() ? resetAt : Date.now() + 24 * 60 * 60 * 1000
        runtime.accuracy = "server-confirmed"
        runtime.serverCode = code ?? 6000
        absorbLearnedLimit(runtime, runtime.observed)
        this.persist()
      } else {
        // Frequency pressure without a known reset: short backoff + adaptive easing.
        const backoff = Math.min(TRANSIENT_CAP_MS, 2000 * Math.pow(2, this.authRecoveries)) + Math.floor(Math.random() * 1000)
        this.cooldownUntil = Date.now() + backoff
        this.state = "TRANSIENT_COOLDOWN"
        this.applyPressure()
      }
    } else if (outcome.status === 402) {
      // Persist only the non-secret enrollment epoch, never a bearer token.
      this.limitedEpoch = this.limitedEpoch ?? "unknown-enrollment"
      this.setState("QUOTA_EXHAUSTED")
    } else if (outcome.status >= 500) {
      const backoff = Math.min(TRANSIENT_CAP_MS, 2000 * Math.pow(2, this.authRecoveries)) + Math.floor(Math.random() * 1000)
      this.cooldownUntil = Date.now() + backoff
      this.state = "UPSTREAM_DEGRADED"
      this.applyPressure()
    } else if (outcome.status === 401 || outcome.status === 403) {
      const raw = await safeBody(res)
      const code = parseErrorCode(raw)
      // auth_forbidden (11140/11142) is account-scoped per the official
      // taxonomy and cannot be cleared by refreshing — quarantine it.
      if (isAccountForbidden(raw)) {
        this.markAccountForbidden(code)
        return
      }
      // Otherwise record the diagnostic only. The AUTH_INVALID verdict is
      // deliberately deferred to runGeneration's terminal branches, which
      // know whether a refresh was attempted and whether the backend
      // *rejected* it: a 401 followed by a transient refresh failure must
      // leave the account READY, and thinking-echo validation rejections
      // never poison it at all.
      this.lastAuthFailure = { at: Date.now(), status: outcome.status, ...(code !== undefined ? { code } : {}) }
    }
  }

  /** Called by the quota adapter after a fresh package-balance read. */
  setPackageCredits(remaining: number) {
    this.packageCreditsRemaining = Number.isFinite(remaining) ? Math.max(0, remaining) : null
  }

  /**
   * Clear a learned AUTH_INVALID after the credential was explicitly
   * re-enrolled or healed from the desktop login. Ordinary bearer rotation
   * does not call this — only a deliberate user action does. Note the session
   * endpoint (`/v2/plugin/accounts`) still answers 200 for a *forbidden*
   * account, so proactive validation must use this method — not
   * `clearLearnedBlocks` — or it would lift the chat-level quarantine.
   */
  clearAuthInvalid() {
    if (this.state === "AUTH_INVALID") this.setState("READY")
    this.lastAuthFailure = null
  }

  /**
   * Quarantine this account after Tencent classified the chat service as
   * `auth_forbidden` (codes 11140/11142). Time-boxed: after the cooldown the
   * account gets one fresh probe, because the restriction may be lifted.
   */
  markAccountForbidden(code?: number) {
    this.forbiddenUntil = Date.now() + this.forbiddenCooldownMs
    if (code !== undefined) this.lastAuthFailure = { at: Date.now(), status: 403, code }
    this.setState("ACCOUNT_FORBIDDEN")
  }

  /** True while the account is inside the auth_forbidden quarantine window. */
  isAccountForbidden(now = Date.now()): boolean {
    this.expireForbidden(now)
    return this.state === "ACCOUNT_FORBIDDEN"
  }

  private expireForbidden(now: number): boolean {
    if (this.state !== "ACCOUNT_FORBIDDEN") return false
    if (now < this.forbiddenUntil) return false
    this.forbiddenUntil = 0
    this.setState("READY")
    return true
  }

  /**
   * Clear every learned account block after a deliberate re-authorization
   * (re-enroll, explicit desktop import, desktop heal) or after a generation
   * actually succeeds. A fresh credential deserves a fresh chance, and only a
   * real generation can refute a chat-level restriction.
   */
  clearLearnedBlocks() {
    this.forbiddenUntil = 0
    if (this.state === "AUTH_INVALID" || this.state === "ACCOUNT_FORBIDDEN") this.setState("READY")
    this.lastAuthFailure = null
  }

  /**
   * Record a verified true-auth failure and persist it. This is the single
   * producer for learned AUTH_INVALID outside the generation retry path
   * (used by proactive validation). Account-forbidden codes never reach this
   * method — they have their own quarantine (`markAccountForbidden`).
   */
  markAuthInvalid(status: number, code?: number) {
    this.lastAuthFailure = { at: Date.now(), status, ...(code !== undefined ? { code } : {}) }
    this.setState("AUTH_INVALID")
  }

  /** True unless we have POSITIVE evidence the account's package balance is at 0. */
  hasKnownCredits(): boolean {
    return this.packageCreditsRemaining === null || this.packageCreditsRemaining > 0
  }

  metrics() {
    this.expireForbidden(Date.now())
    const reports = this.modelReports()
    return {
      state: this.state,
      resetAt: this.resetAt ?? null,
      forbiddenUntil: this.forbiddenUntil || null,
      maxConcurrent: this.maxConcurrent,
      launchPerSec: Number(this.launchPerSec.toFixed(2)),
      active: this.active,
      queued: this.pending.length,
      pressure: this.pressure,
      generations: this.generations,
      attempts: this.attempts,
      committed: this.committed,
      failed: this.failed,
      authRecoveries: this.authRecoveries,
      amplification: this.generations ? Number((this.attempts / this.generations).toFixed(3)) : 1,
      cooldownUntil: this.cooldownUntil,
      hardLimited: this.state === "QUOTA_EXHAUSTED",
      authInvalid: this.state === "AUTH_INVALID",
      lastAuthFailure: this.lastAuthFailure,
      packageCreditsRemaining: this.packageCreditsRemaining,
      models: Object.fromEntries(reports.map((report) => [report.model, report])),
    }
  }
}

/** Legacy default instance for callers that do not supply an account registry. */
export const governor = new WorkBuddyEntitlementGovernor()
