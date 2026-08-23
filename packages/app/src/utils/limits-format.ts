export interface UsageWindow {
  usedPercent: number | null
  remainingPercent: number | null
  windowSeconds: number | null
  resetAt: number | null
  resetAfterSeconds: number | null
  valueLabel: string | null
}

export interface ProviderResult {
  providerId: string
  providerName: string
  ok: boolean
  configured: boolean
  error?: string
  planLabel?: string | null
  usage: { windows: Record<string, UsageWindow>; models?: Record<string, { windows: Record<string, UsageWindow> }> } | null
  fetchedAt: number
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

export function worstRemainingFromWindows(windows: Array<[string, { usedPercent: number | null; remainingPercent: number | null }]>) {
  let worst: number | null = null
  for (const [, w] of windows) {
    const r = w.remainingPercent ?? (w.usedPercent !== null ? 100 - w.usedPercent : null)
    if (r === null || !Number.isFinite(r)) continue
    if (worst === null || r < worst) worst = r
  }
  return worst
}
