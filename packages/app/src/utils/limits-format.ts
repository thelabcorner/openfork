export interface UsageWindow {
  usedPercent: number | null
  remainingPercent: number | null
  windowSeconds: number | null
  resetAt: number | null
  resetAfterSeconds: number | null
  valueLabel: string | null
}

/**
 * Per-model metadata for providers that bill per request rather than per token.
 *
 * `rate` is the provider's own consumption rate per request in its billing unit
 * (WorkBuddy: credits). `0`/absent means "not published" and is NOT "free" —
 * `rateFree` marks a genuine zero-cost promotion and `promotionLabel` carries
 * the badge the provider is currently showing (e.g. "Free now"). A missing rate
 * must degrade to "no estimate", never to "unlimited requests".
 */
export interface ProviderModelUsage {
  windows: Record<string, UsageWindow>
  rate?: number
  rateFree?: boolean
  rateLabel?: string | null
  promotionLabel?: string | null
}

export interface ProviderResult {
  providerId: string
  providerName: string
  ok: boolean
  configured: boolean
  error?: string
  planLabel?: string | null
  usage: {
    windows: Record<string, UsageWindow>
    models?: Record<string, ProviderModelUsage>
    /** Stable account key -> the label used in `windows` keys. See the schema note. */
    accountLabels?: Record<string, string>
  } | null
  fetchedAt: number
  /**
   * Epoch ms before which a re-read is served from the adapter's own cache.
   * Absent (or 0) means a refresh always does real work — never treat it as
   * "never refresh", or an older server would disable the button forever.
   */
  nextRefreshAt?: number
}

/**
 * Pure formatting helpers for the limits/usage system.
 * No SolidJS/reactive dependencies — safe for server, tests, and hooks.
 */

export function toneForRemaining(remaining: number | null): "danger" | "warning" | "success" | "muted" {
  if (remaining === null || remaining === undefined || !Number.isFinite(remaining)) return "muted"
  if (remaining <= 10) return "danger"
  if (remaining <= 30) return "warning"
  return "success"
}

export function colorForTone(tone: ReturnType<typeof toneForRemaining>): string {
  if (tone === "danger") return "var(--v2-state-fg-danger)"
  if (tone === "warning") return "var(--v2-state-fg-warning)"
  if (tone === "success") return "var(--v2-state-fg-success)"
  return "var(--v2-text-text-faint)"
}

export function formatPercent(value: number | null, locale?: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—"
  const v = Math.max(0, Math.min(100, value))
  if (v % 1 === 0) return `${v.toFixed(0)}%`
  return `${v.toFixed(1)}%`
}

export function formatRemainingPercent(value: number | null): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, value))
}

export function formatResetDate(ms: number | null, locale?: string): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) return ""
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toLocaleString()
  }
}

export function formatAge(fetchedAt: number, now: number, t: (key: string, params?: Record<string, string | number | boolean>) => string): string {
  const diff = Math.max(0, now - fetchedAt)
  if (diff < 45_000) return t("limits.updated.justNow")
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return t("common.time.minutesAgo.short", { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t("common.time.hoursAgo.short", { count: hours })
  const days = Math.floor(hours / 24)
  return t("common.time.daysAgo.short", { count: days })
}

export function formatCountdownSeconds(seconds: number, t: (key: string, params?: Record<string, string | number | boolean>) => string): string {
  if (seconds <= 0) return t("usage.duration.zero")
  const totalSeconds = Math.floor(seconds)
  const s = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const m = totalMinutes % 60
  const totalHours = Math.floor(totalMinutes / 60)
  const h = totalHours % 24
  const d = Math.floor(totalHours / 24)
  if (d > 0) return t("usage.duration.daysHoursSeconds", { days: d, hours: h, seconds: s })
  if (totalHours > 0) return t("usage.duration.hoursMinutesSeconds", { hours: totalHours, minutes: m, seconds: s })
  return t("usage.duration.minutesSeconds", { minutes: m, seconds: s })
}

export function displayWindowLabel(key: string, t: (key: string, params?: Record<string, string | number | boolean>) => string): string {
  const lower = key.toLowerCase()
  if (lower === "5h") return t("limits.window.5h.short")
  if (lower === "weekly") return t("limits.window.weekly")
  if (lower === "monthly") return t("limits.window.monthly")
  if (lower === "credits") return t("limits.window.credits")
  if (lower === "credits_balance" || lower === "balance") return t("limits.window.creditsBalance")
  if (lower === "billing_cycle") return t("limits.window.billingCycle")
  if (lower === "rate limit (5h)" || lower === "rate limit") return key
  const spaced = key.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
  return spaced
    .split(" ")
    .map((part) => (part.length ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}

export function sortWindows(entries: Array<[string, UsageWindow]>) {
  return [...entries].sort((a, b) => {
    const aSec = a[1].windowSeconds
    const bSec = b[1].windowSeconds
    if (aSec !== null && bSec !== null) return aSec - bSec
    if (aSec !== null) return -1
    if (bSec !== null) return 1
    return a[0].localeCompare(b[0])
  })
}

/**
 * A WorkBuddy quota window's key encodes account + package scope (see
 * `quota/providers/workbuddy.ts`'s header comment for the full grammar):
 * `"aggregate:basic|gift|extra|combined"` (summed across every enrolled
 * account) or `"account:<label>:Basic|Gift|Extra|Combined"` (one account's
 * own breakdown, nested under it in the collapsible per-account section).
 *
 * WorkBuddy credits are additive, not tiered: Basic hitting 0% does not mean
 * the account is exhausted if Extra or Gift still has balance. So ONLY
 * `aggregate:combined` (the Basic+Extra+Gift sum) should ever gate or feed
 * the "worst remaining" indicator — the individual basic/gift/extra windows,
 * and every `account:*` window (combined included), are informational only,
 * exactly like `weekly:<model>` is excluded for Claude's model-scoped rows.
 */
export type WorkBuddyWindowKey =
  | { scope: "aggregate"; kind: "basic" | "gift" | "extra" | "combined" }
  | { scope: "account"; account: string; kind: "Basic" | "Gift" | "Extra" | "Combined" }

export function parseWorkBuddyKey(key: string): WorkBuddyWindowKey | null {
  if (key.startsWith("aggregate:")) {
    const kind = key.slice("aggregate:".length)
    if (kind === "basic" || kind === "gift" || kind === "extra" || kind === "combined") return { scope: "aggregate", kind }
    return null
  }
  if (key.startsWith("account:")) {
    const rest = key.slice("account:".length)
    const idx = rest.lastIndexOf(":")
    if (idx < 0) return null
    const kind = rest.slice(idx + 1)
    if (kind !== "Basic" && kind !== "Gift" && kind !== "Extra" && kind !== "Combined") return null
    return { scope: "account", account: rest.slice(0, idx), kind }
  }
  return null
}

function isWorkBuddyNonGating(key: string): boolean {
  const parsed = parseWorkBuddyKey(key)
  if (!parsed) return false
  return !(parsed.scope === "aggregate" && parsed.kind === "combined")
}

/**
 * Absolute credit counts behind a WorkBuddy window.
 *
 * The quota adapter publishes only percentages plus a `valueLabel` like
 * `"412 / 2000 pts (top-up value ~$12.36)"`, but a stretch estimate needs real
 * numbers: `remaining / rate` is meaningless when `remaining` is a percent. The
 * label is a display string, so it is parsed here rather than by widening the
 * wire contract — the adapter stays free to change its wording for humans.
 * Returns null when the label shape isn't recognized, so callers degrade to
 * "no bar" instead of dividing a percent by a rate.
 */
export function workBuddyCredits(window: UsageWindow): { remaining: number; total: number } | null {
  const label = window.valueLabel
  if (!label) return null
  // Accept "412 / 2000 pts" and a bare "2000 pts".
  const match = label.match(/([0-9][0-9.,]*)\s*\/\s*([0-9][0-9.,]*)\s*pts/i)
  const num = (raw: string) => Number(raw.replace(/,/g, ""))
  if (match) {
    const total = num(match[2]!)
    const used = num(match[1]!)
    if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0) return null
    return { remaining: Math.max(0, total - used), total }
  }
  const bare = label.match(/([0-9][0-9.,]*)\s*pts/i)
  if (bare) {
    const total = num(bare[1]!)
    if (!Number.isFinite(total) || total <= 0) return null
    const pct = window.remainingPercent
    if (pct !== null && Number.isFinite(pct)) return { remaining: (total * Math.max(0, Math.min(100, pct))) / 100, total }
    return { remaining: total, total }
  }
  return null
}

export function worstRemainingFromWindows(windows: Array<[string, { usedPercent: number | null; remainingPercent: number | null }]>) {
  let worst: number | null = null
  for (const [key, w] of windows) {
    if (key.startsWith("weekly:") || isWorkBuddyNonGating(key)) continue
    const r = w.remainingPercent ?? (w.usedPercent !== null ? 100 - w.usedPercent : null)
    if (r === null || !Number.isFinite(r)) continue
    if (worst === null || r < worst) worst = r
  }
  return worst
}

const FORK_WINDOW_SECONDS: Record<string, number> = { "5h": 18_000, week: 604_800, month: 2_592_000 }

/**
 * Tiered-limit gate: a provider is usable up to its MOST constrained
 * percent window — an empty weekly blocks even a fresh 5h. Model-scoped
 * windows (`weekly:<model>`) gate only that model and never the provider.
 * Balance-only rows (null percents) never gate.
 */
export interface TierGate {
  effectiveRemaining: number | null
  bindingKey: string | null
}

export function resolveTierGate(
  windows: Array<[string, { usedPercent: number | null; remainingPercent: number | null; windowSeconds: number | null }]>,
): TierGate {
  let effective: number | null = null
  let bindingKey: string | null = null
  let bindingSeconds = -1
  for (const [key, w] of windows) {
    if (key.startsWith("weekly:") || isWorkBuddyNonGating(key)) continue
    const r = w.remainingPercent ?? (w.usedPercent !== null ? 100 - w.usedPercent : null)
    if (r === null || !Number.isFinite(r)) continue
    const secs = w.windowSeconds ?? Number.MAX_SAFE_INTEGER
    const wins = effective === null || r < effective || (r === effective && secs > bindingSeconds)
    if (!wins) continue
    effective = r
    bindingKey = key
    bindingSeconds = secs
  }
  return { effectiveRemaining: effective, bindingKey }
}

export type GateState = "binding" | "gated" | "normal"

export function tierGateState(key: string, remaining: number | null, gate: TierGate): GateState {
  if (gate.bindingKey === null || gate.effectiveRemaining === null) return "normal"
  if (key === gate.bindingKey) return "binding"
  return remaining !== null && remaining > gate.effectiveRemaining ? "gated" : "normal"
}

/** Maps a `/fork/usage` ForkWindowUsage onto the pane's normalized UsageWindow. */
export function forkWindowToUsageWindow(w: {
  label: string
  spentUSD: number
  limitUSD: number
  estimatedPercent?: number
  resetsAt: number
}): UsageWindow {
  const used =
    typeof w.estimatedPercent === "number"
      ? Math.max(0, Math.min(100, w.estimatedPercent))
      : w.limitUSD > 0
        ? Math.max(0, Math.min(100, (w.spentUSD / w.limitUSD) * 100))
        : null
  return {
    usedPercent: used,
    remainingPercent: used !== null ? Math.max(0, Math.min(100, 100 - used)) : null,
    windowSeconds: FORK_WINDOW_SECONDS[w.label] ?? null,
    resetAt: w.resetsAt,
    resetAfterSeconds: null,
    valueLabel: null,
  }
}
