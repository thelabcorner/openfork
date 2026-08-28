// Ported (pure functions only) from packages/app/src/utils/limits-format.ts so
// the mobile Limits page computes the exact same "which window is binding"
// gate logic as the desktop app, instead of reinventing a simpler heuristic.

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
  usage: { windows: Record<string, UsageWindow> } | null
  fetchedAt: number
}

export type Tone = "danger" | "warning" | "success" | "muted"

export function toneForRemaining(remaining: number | null): Tone {
  if (remaining === null || remaining === undefined || !Number.isFinite(remaining)) return "muted"
  if (remaining <= 10) return "danger"
  if (remaining <= 30) return "warning"
  return "success"
}

export function formatPercent(value: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—"
  const v = Math.max(0, Math.min(100, value))
  return v % 1 === 0 ? `${v.toFixed(0)}%` : `${v.toFixed(1)}%`
}

export function formatCountdownSeconds(seconds: number): string {
  if (seconds <= 0) return "now"
  const total = Math.floor(seconds)
  const s = total % 60
  const totalMinutes = Math.floor(total / 60)
  const m = totalMinutes % 60
  const totalHours = Math.floor(totalMinutes / 60)
  const h = totalHours % 24
  const d = Math.floor(totalHours / 24)
  if (d > 0) return `${d}d ${h}h`
  if (totalHours > 0) return `${totalHours}h ${m}m`
  return `${m}m ${s}s`
}

export function displayWindowLabel(key: string): string {
  const lower = key.toLowerCase()
  if (lower === "5h") return "5-Hour"
  if (lower === "weekly" || lower === "week") return "Weekly"
  if (lower === "monthly" || lower === "month") return "Monthly"
  if (lower === "credits") return "Credits"
  if (lower === "credits_balance" || lower === "balance") return "Credits balance"
  if (lower === "billing_cycle") return "Billing cycle"
  const spaced = key.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
  return spaced
    .split(" ")
    .map((part) => (part.length ? part.charAt(0).toUpperCase() + part.slice(1) : part))
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
    if (key.startsWith("weekly:")) continue
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
