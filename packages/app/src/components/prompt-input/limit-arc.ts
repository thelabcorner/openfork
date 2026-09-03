import type { LimitProvider } from "@/hooks/use-limits"
import type { ForkWindowUsage } from "@/utils/fork-client"
import {
  forkWindowToUsageWindow,
  workbuddyModelDisplayName,
  workbuddyModelToUsageWindow,
  type ProviderResult,
  type UsageWindow,
  type WorkBuddyAccountLimits,
  type WorkBuddyModelLimit,
} from "@/utils/limits-format"
import { splitMultiAccountModelID, type AccountModelParts } from "@/utils/model-account-identity"

/**
 * The prompt composer's limit arc: which numbers belong on a 20px ring for the
 * model that is actually selected.
 *
 * This used to be an OpenCode-Go-only tripartite ring (5h / week / month) that
 * kept drawing Go's fork usage no matter which provider the composer was
 * pointed at — a Claude session showed a Go arc, and a WorkBuddy session showed
 * a Go arc. Everything here is a pure projection of what the Limits pane
 * already fetched (`useLimits`) plus the Go fork-usage stream, resolved through
 * the SELECTED model's provider, so the ring and the pane can never disagree.
 *
 * The arity is data-driven, not decorative: a provider with three real cadences
 * draws three sectors, a credit-pack provider draws two, an IP-based free quota
 * draws one. Missing data draws an explicitly *unknown* ring — never a full
 * one, because "we don't know" and "you have everything left" are different
 * answers and only one of them is safe to act on.
 */

/** Ceiling on sectors. Past three, a 20px ring stops being readable. */
export const MAX_ARC_SEGMENTS = 3

export type ArcSegmentKind = "window" | "model" | "balance"

export interface ArcSegment {
  id: string
  /**
   * Raw quota window key, for `displayWindowLabel()`. Null when the segment is
   * named after something that has no window vocabulary (a model, an account).
   */
  windowKey: string | null
  /** Literal, already-human label used when `windowKey` is null. */
  literal: string | null
  remaining: number | null
  resetAt: number | null
  resetAfterSeconds: number | null
  valueLabel: string | null
  kind: ArcSegmentKind
  /** The window that currently caps the provider — the one worth reading first. */
  binding: boolean
}

export type ArcStatus = "loading" | "ready" | "empty" | "unsupported" | "error"

export interface ArcModel {
  status: ArcStatus
  /** Quota-adapter id (`claude`, `workbuddy`, …), not the model provider id. */
  quotaProviderID: string | null
  /** Model provider id, for the provider glyph — always the user's mental model. */
  brandProviderID: string | null
  providerName: string | null
  planLabel: string | null
  error: string | null
  /** True when the numbers are last-good data served through a failed poll. */
  stale: boolean
  segments: ArcSegment[]
  /** Lowest remaining across gating segments — what the button's tone reads. */
  worst: number | null
  /**
   * What the arc is scoped to beyond the provider: an API-key label, a
   * WorkBuddy account, or nothing.
   */
  scope: string | null
  /** Provider exposes multiple swappable API keys from the composer. */
  switchable: boolean
}

/**
 * Model-provider id -> quota-adapter id.
 *
 * Mirrors the server's per-adapter `ALIASES` with one deliberate divergence:
 * the server folds a bare `opencode` into `opencode-go`, but in this app
 * `opencode` is Zen (an API key from opencode.ai/zen) and `opencode-go` is the
 * multi-key Go proxy — they are separate rows in the Limits pane and separate
 * entries in the provider picker, so folding them here would point the arc at
 * the wrong balance.
 */
const QUOTA_PROVIDER_ALIASES: Record<string, string> = {
  anthropic: "claude",
  claude: "claude",
  "claude-api": "claude",
  "claude-code": "claude",
  "claude-pro": "claude",
  "claude-max": "claude",
  openai: "codex",
  chatgpt: "codex",
  codex: "codex",
  "opencode-go": "opencode-go",
  opencode: "opencode-zen",
  "opencode-zen": "opencode-zen",
  "opencode-free": "opencode-zen",
  zen: "opencode-zen",
  openrouter: "openrouter",
  workbuddy: "workbuddy",
  codebuddy: "workbuddy",
  verdent: "verdent",
  "verdent-free": "verdent",
  kimi: "kimi-for-coding",
  "kimi-for-coding": "kimi-for-coding",
  moonshot: "kimi-for-coding",
  moonshotai: "kimi-for-coding",
  xai: "xai",
  grok: "xai",
  deepseek: "deepseek",
  nvidia: "nvidia",
  genspark: "genspark",
  "genspark-llm-proxy": "genspark",
  "genspark-gemini-proxy": "genspark",
}

export function normalizeProviderID(id: string): string {
  return id.trim().toLowerCase().replace(/[\s_]+/g, "-")
}

/**
 * Resolve which quota adapter reports on a model provider.
 *
 * `known` is the set of adapters the server actually returned, so an exact id
 * match wins over the alias table — a future adapter named after its provider
 * works with no table edit. Go and Zen are still returned when absent from
 * `known`: Go is synthesized entirely client-side from the fork usage stream,
 * and Zen is injected by `useLimits` itself.
 */
export function resolveQuotaProviderID(modelProviderID: string | undefined, known: ReadonlySet<string>): string | null {
  if (!modelProviderID) return null
  const normalized = normalizeProviderID(modelProviderID)
  if (known.has(normalized)) return normalized
  return QUOTA_PROVIDER_ALIASES[normalized] ?? null
}

function canon(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * Whether a `weekly:<model>` style window belongs to the selected model.
 *
 * Providers publish their own model spelling (`claude-opus-4-1`) while the
 * picker holds the catalog id and display name, so this compares canonicalized
 * forms in both directions. The 4-character floor stops a two-letter fragment
 * from matching every model in the account.
 */
export function windowMatchesModel(scopedName: string, modelID?: string, modelName?: string): boolean {
  const target = canon(scopedName)
  if (target.length === 0) return false
  for (const candidate of [modelID, modelName]) {
    if (!candidate) continue
    const value = canon(candidate)
    if (value.length === 0) continue
    // An exact match is always trustworthy, however short — WorkBuddy really
    // does ship models called "Hy3". The length floor guards only the fuzzy
    // containment paths, where a two-character fragment would match the entire
    // catalog.
    if (value === target) return true
    if (value.length < 4 || target.length < 4) continue
    if (value.includes(target) || target.includes(value)) return true
  }
  return false
}

export function remainingOfWindow(w: Pick<UsageWindow, "remainingPercent" | "usedPercent">): number | null {
  const r = w.remainingPercent
  if (r !== null && r !== undefined && Number.isFinite(r)) return Math.max(0, Math.min(100, r))
  const u = w.usedPercent
  if (u !== null && u !== undefined && Number.isFinite(u)) return Math.max(0, Math.min(100, 100 - u))
  return null
}

const MODEL_SCOPE_PREFIX = "weekly:"

function windowSegment(key: string, w: UsageWindow, kind: ArcSegmentKind = "window"): ArcSegment {
  return {
    id: key,
    windowKey: key,
    literal: null,
    remaining: remainingOfWindow(w),
    resetAt: w.resetAt,
    resetAfterSeconds: w.resetAfterSeconds,
    valueLabel: w.valueLabel,
    kind,
    binding: false,
  }
}

/**
 * Generic provider projection: model-scoped windows first (they answer "can I
 * send THIS model", which is the question the composer is asking), then the
 * real cadences shortest-first, then balances. Other models' scoped windows are
 * dropped outright — showing a stranger's weekly cap on this ring is worse than
 * showing nothing.
 */
export function segmentsFromWindows(
  windowsSorted: ReadonlyArray<readonly [string, UsageWindow]>,
  options: { modelID?: string; modelName?: string; bindingKey?: string | null } = {},
): ArcSegment[] {
  const scoped: ArcSegment[] = []
  const rest: ArcSegment[] = []
  for (const [key, w] of windowsSorted) {
    if (key.startsWith(MODEL_SCOPE_PREFIX)) {
      const name = key.slice(MODEL_SCOPE_PREFIX.length)
      if (!windowMatchesModel(name, options.modelID, options.modelName)) continue
      scoped.push({ ...windowSegment(key, w, "model"), literal: name })
      continue
    }
    rest.push(windowSegment(key, w, w.windowSeconds === null && remainingOfWindow(w) === null ? "balance" : "window"))
  }
  return capSegments([...scoped, ...rest], options.bindingKey ?? null)
}

/**
 * Trim to `MAX_ARC_SEGMENTS` without ever dropping the window that gates the
 * provider: a ring that omits the reason you are about to be blocked is a lie
 * of omission, so the binding window displaces the least-urgent visible one.
 */
export function capSegments(segments: ArcSegment[], bindingKey: string | null): ArcSegment[] {
  if (segments.length <= MAX_ARC_SEGMENTS) return segments
  const kept = segments.slice(0, MAX_ARC_SEGMENTS)
  if (bindingKey && !kept.some((s) => s.id === bindingKey)) {
    const binding = segments.find((s) => s.id === bindingKey)
    if (binding) kept[kept.length - 1] = binding
  }
  return kept
}

/** OpenCode Go: one USD budget per cadence, always in this order. */
const FORK_ORDER: ForkWindowUsage["label"][] = ["5h", "week", "month"]

export function segmentsFromFork(windows: ReadonlyArray<ForkWindowUsage>): ArcSegment[] {
  const segments: ArcSegment[] = []
  for (const label of FORK_ORDER) {
    const window = windows.find((item) => item.label === label)
    if (!window) continue
    const mapped = forkWindowToUsageWindow(window)
    segments.push({
      id: label,
      windowKey: label,
      literal: null,
      remaining: remainingOfWindow(mapped),
      resetAt: mapped.resetAt,
      resetAfterSeconds: null,
      valueLabel:
        window.limitUSD > 0 ? "$" + window.spentUSD.toFixed(2) + " / $" + window.limitUSD.toFixed(2) : null,
      kind: "window",
      binding: false,
    })
  }
  return segments
}

/**
 * WorkBuddy/Verdent: credits are per-request, per-account, and the promotional
 * models carry their own rolling window. The composer's question is "can I send
 * this model on this account", which needs all three of: the model's own
 * window, the account's total package balance (Tencent balance-checks before
 * every generation regardless of a model's published rate), and the Basic pool
 * that actually funds paid models.
 */
export function segmentsFromCreditProvider(
  result: ProviderResult,
  options: { modelID?: string; modelName?: string } = {},
): { segments: ArcSegment[]; scope: string | null } {
  const usage = result.usage
  if (!usage) return { segments: [], scope: null }
  const accounts: WorkBuddyAccountLimits[] = usage.workbuddyAccounts ?? usage.verdentAccounts ?? []
  const labels = usage.accountLabels ?? {}
  const split: AccountModelParts = splitMultiAccountModelID(options.modelID ?? "")
  const bare = split.baseModelID ? split.baseModelID.replace(/#ctx-\d+$/, "") : undefined
  const accountLabel = split.accountID ? labels[split.accountID] : undefined

  const pool = accountLabel ? accounts.filter((a) => a.label === accountLabel) : accounts
  let match: WorkBuddyModelLimit | undefined
  if (bare) {
    // Unqualified ids are routed to whichever account still has headroom, so
    // the ring must report the account the request would actually land on —
    // the first one in the list is an arbitrary answer that goes red while the
    // model is still perfectly usable somewhere else.
    for (const account of pool) {
      for (const candidate of account.models) {
        if (!windowMatchesModel(candidate.canonical ?? candidate.model, bare)) continue
        if (!match) {
          match = candidate
          continue
        }
        const best = match.remainingPercent ?? -1
        const next = candidate.remainingPercent ?? -1
        if (next > best) match = candidate
      }
      if (match && accountLabel) break
    }
  }

  const segments: ArcSegment[] = []
  if (match) {
    const mapped = workbuddyModelToUsageWindow(match)
    segments.push({
      id: "model:" + match.model,
      windowKey: null,
      literal: workbuddyModelDisplayName(match.model),
      remaining: remainingOfWindow(mapped),
      resetAt: mapped.resetAt,
      resetAfterSeconds: mapped.resetAfterSeconds,
      valueLabel: mapped.valueLabel,
      kind: "model",
      binding: false,
    })
  }
  const combinedKey = accountLabel ? "account:" + accountLabel + ":Combined" : "aggregate:combined"
  const basicKey = accountLabel ? "account:" + accountLabel + ":Basic" : "aggregate:basic"
  for (const key of [combinedKey, basicKey]) {
    const window = usage.windows[key]
    if (!window) continue
    segments.push(windowSegment(key, window, "balance"))
  }
  return { segments: segments.slice(0, MAX_ARC_SEGMENTS), scope: accountLabel ?? null }
}

/**
 * `worst` drives the button's tone, so it deliberately ignores segments whose
 * remaining is unknown: one unreadable balance must not paint a healthy ring
 * grey, and it must not paint a drained one green either.
 */
export function worstOf(segments: ReadonlyArray<ArcSegment>): number | null {
  let worst: number | null = null
  for (const segment of segments) {
    if (segment.remaining === null) continue
    if (worst === null || segment.remaining < worst) worst = segment.remaining
  }
  return worst
}

/**
 * Flag the one sector worth reading first. The provider's own tier gate wins
 * when the binding window is on screen; otherwise the lowest visible sector
 * stands in, which is the same answer for every provider whose windows are all
 * gating (Go, WorkBuddy).
 */
export function markBinding(segments: ArcSegment[], bindingKey: string | null): ArcSegment[] {
  let index = bindingKey ? segments.findIndex((s) => s.id === bindingKey) : -1
  if (index < 0) {
    let worst: number | null = null
    segments.forEach((segment, i) => {
      if (segment.remaining === null) return
      if (worst === null || segment.remaining < worst) {
        worst = segment.remaining
        index = i
      }
    })
  }
  return segments.map((segment, i) => (i === index ? { ...segment, binding: true } : segment))
}

export interface ArcInput {
  modelProviderID?: string
  modelID?: string
  modelName?: string
  /** `useLimits().providers()` — undefined while the first poll is in flight. */
  providers: readonly LimitProvider[] | undefined
  fork?: {
    windows: ReadonlyArray<ForkWindowUsage>
    credentialLabel?: string
    credentialCount: number
  }
  /** `useLimits().openRouterFree()` — the daily free-tier report, when polled. */
  openRouterFree?: { remainingPercent: number; resetsAt: string } | undefined
}

/**
 * OpenRouter's `:free` models are capped by a daily request allowance that has
 * nothing to do with the account's credit balance, and it is the only limit
 * that can stop a free model from running. Show it — but only for a `:free`
 * model, because on a paid one it is noise about a quota the request will
 * never touch.
 */
export function openRouterFreeSegment(
  modelID: string | undefined,
  report: { remainingPercent: number; resetsAt: string } | undefined,
): ArcSegment | null {
  if (!report || !modelID?.toLowerCase().includes(":free")) return null
  const resetAt = new Date(report.resetsAt).getTime()
  return {
    id: "openrouter:free",
    windowKey: null,
    literal: "Free daily",
    remaining: Number.isFinite(report.remainingPercent)
      ? Math.max(0, Math.min(100, report.remainingPercent))
      : null,
    resetAt: Number.isFinite(resetAt) ? resetAt : null,
    resetAfterSeconds: null,
    valueLabel: null,
    kind: "model",
    binding: false,
  }
}

const EMPTY: ArcModel = {
  status: "empty",
  quotaProviderID: null,
  brandProviderID: null,
  providerName: null,
  planLabel: null,
  error: null,
  stale: false,
  segments: [],
  worst: null,
  scope: null,
  switchable: false,
}

export function buildArcModel(input: ArcInput): ArcModel {
  const brand = input.modelProviderID ? normalizeProviderID(input.modelProviderID) : null
  const known = new Set((input.providers ?? []).map((p) => p.result.providerId))
  const quotaID = resolveQuotaProviderID(input.modelProviderID, known)
  const base: ArcModel = { ...EMPTY, brandProviderID: brand, quotaProviderID: quotaID }

  if (!input.modelProviderID) return { ...base, status: input.providers === undefined ? "loading" : "empty" }

  // OpenCode Go is not served by the quota endpoint at all — it streams live
  // per-credential spend over `/fork/usage`, which is also the only provider
  // whose key can be swapped straight from the composer.
  if (quotaID === "opencode-go") {
    const fork = input.fork
    const segments = markBinding(segmentsFromFork(fork?.windows ?? []), null)
    return {
      ...base,
      status: segments.length > 0 ? "ready" : "empty",
      providerName: "OpenCode Go",
      segments,
      worst: worstOf(segments),
      scope: fork?.credentialLabel ?? null,
      switchable: (fork?.credentialCount ?? 0) > 0,
    }
  }

  if (input.providers === undefined) return { ...base, status: "loading" }

  const provider = quotaID ? input.providers.find((p) => p.result.providerId === quotaID) : undefined
  if (!provider) return { ...base, status: "unsupported" }

  const result = provider.result
  const stale = !result.ok && !!result.usage
  if (!result.usage) {
    return {
      ...base,
      status: "error",
      providerName: result.providerName,
      planLabel: result.planLabel ?? null,
      error: result.error ?? null,
    }
  }

  const isCredit = result.providerId === "workbuddy" || result.providerId === "verdent"
  const free = result.providerId === "openrouter" ? openRouterFreeSegment(input.modelID, input.openRouterFree) : null
  const built = isCredit
    ? segmentsFromCreditProvider(result, { modelID: input.modelID, modelName: input.modelName })
    : {
        segments: capSegments(
          [
            ...(free ? [free] : []),
            ...segmentsFromWindows(provider.windowsSorted, {
              modelID: input.modelID,
              modelName: input.modelName,
              bindingKey: provider.gate.bindingKey,
            }),
          ],
          provider.gate.bindingKey,
        ),
        scope: null,
      }
  const segments = markBinding(built.segments, provider.gate.bindingKey)

  return {
    ...base,
    status: segments.length > 0 ? "ready" : "empty",
    providerName: result.providerName,
    planLabel: result.planLabel ?? null,
    error: result.ok ? null : (result.error ?? null),
    stale,
    segments,
    worst: worstOf(segments),
    scope: built.scope,
    switchable: false,
  }
}

export interface ArcSector {
  /** Degrees clockwise from 12 o'clock. */
  start: number
  end: number
}

/**
 * Sector geometry for an N-part ring.
 *
 * A solo ring is a near-closed circle with one notch at the top (it reads as a
 * gauge, not as a truncated tripartite); two or three parts split the circle
 * evenly with a fixed visual gap. The gap is constant in degrees rather than a
 * fraction of the sector so the seams look identical at every arity.
 */
export function arcSectors(count: number): ArcSector[] {
  if (count <= 0) return []
  const gap = count === 1 ? 16 : 14
  const span = (360 - gap * count) / count
  return Array.from({ length: count }, (_, i) => {
    const start = gap / 2 + i * (span + gap)
    return { start, end: start + span }
  })
}

export function polarPoint(cx: number, cy: number, r: number, angle: number) {
  const radian = ((angle - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(radian), y: cy + r * Math.sin(radian) }
}

/** Clockwise arc, so a dash-offset fill grows from the sector's start edge. */
export function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
  const a = polarPoint(cx, cy, r, start)
  const b = polarPoint(cx, cy, r, end)
  const delta = end >= start ? end - start : end + 360 - start
  const round = (n: number) => Math.round(n * 1000) / 1000
  return `M ${round(a.x)} ${round(a.y)} A ${r} ${r} 0 ${delta <= 180 ? 0 : 1} 1 ${round(b.x)} ${round(b.y)}`
}
