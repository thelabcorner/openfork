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
  emptyModelRuntime,
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
 */
export type EntitlementState =
  | "READY"
  | "TRANSIENT_COOLDOWN"
  | "WINDOW_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "AUTH_INVALID"
  | "UPSTREAM_DEGRADED"

export type AdmissionKind = "window" | "quota" | "cooldown" | "queue" | "cancel" | "duplicate"

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
  /** Singleflight token refresh (closure over live cred). */
  refresh: () => Promise<boolean>
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
}

type Persisted = {
  schema?: number
  state: EntitlementState
  resetAt: number | null
  limitedEpoch: string | null
  at: number
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

  // adaptive backpressure
  private pressure = 0

  // metrics
  private generations = 0
  private attempts = 0
  private committed = 0
  private failed = 0
  private authRecoveries = 0

  constructor(options: GovernorOptions = {}) {
    this.entitlementFile = options.persistenceFile ?? ENTITLEMENT_FILE_OVERRIDE ?? DEFAULT_ENTITLEMENT_FILE
    this.defaultMaxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)
    this.maxConcurrent = this.defaultMaxConcurrent
    this.defaultLaunchPerSec = Math.max(0.5, options.launchPerSec ?? DEFAULT_LAUNCH_PER_SEC)
    this.launchPerSec = this.defaultLaunchPerSec
    this.launchCapacity = Math.max(1, options.launchBurst ?? DEFAULT_LAUNCH_BURST)
    this.launchTokens = this.launchCapacity

    // Learn-once: restore a persisted hard/window limit so a fresh OpenFork
    // session enforces it without re-probing Tencent.
    const p = loadPersisted(this.entitlementFile)
    if (!p) return
    if (p.state === "QUOTA_EXHAUSTED") {
      this.state = "QUOTA_EXHAUSTED"
      this.limitedEpoch = p.limitedEpoch ?? undefined
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
      }]))
      const temp = `${this.entitlementFile}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify({
        schema: 2,
        state: this.state,
        resetAt: this.resetAt ?? null,
        limitedEpoch: this.limitedEpoch ?? null,
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

  modelReport(model: string, now = Date.now()): ModelEntitlementReport {
    if (this.expireModel(model, now)) this.persist()
    return buildModelEntitlementReport(this.modelKey(model), this.runtimeFor(model), now)
  }

  modelReports(now = Date.now()): ModelEntitlementReport[] {
    this.expireModels(now)
    const keys = new Set<string>(["hy3", "hy4-preview", ...this.models.keys()])
    return [...keys].map((model) => buildModelEntitlementReport(model, this.runtimeFor(model), now))
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
          const ok = await opts.refresh()
          refreshedThisGeneration = true
          if (opts.signal?.aborted) throw new AdmissionError(499, 0, "generation canceled", "cancel")
          if (!ok && first && (first.status === 401 || first.status === 403)) {
            this.state = "AUTH_INVALID"
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
          if (this.state === "AUTH_INVALID") this.state = "READY"
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
            this.state = "AUTH_INVALID"
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
      const resetAt = parseResetAt(raw, retryAfter)
      if (code === 6004 || (code !== 14003 && resetAt && /usage exceeds frequency limit/i.test(raw))) {
        // Authoritative hard state is account+model scoped. A 14003 may carry
        // Retry-After, but it is transport pressure and must never deplete the
        // promotional window.
        const runtime = this.runtimeFor(model)
        runtime.windowLimited = true
        runtime.resetAt = resetAt && resetAt > Date.now() ? resetAt : null
        runtime.accuracy = "server-confirmed"
        runtime.serverCode = 6004
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
      this.state = "AUTH_INVALID"
    }
  }

  metrics() {
    const reports = this.modelReports()
    return {
      state: this.state,
      resetAt: this.resetAt ?? null,
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
      models: Object.fromEntries(reports.map((report) => [report.model, report])),
    }
  }
}

/** Legacy default instance for callers that do not supply an account registry. */
export const governor = new WorkBuddyEntitlementGovernor()
