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

export type WorkBuddyWindowKey =
  | { scope: "aggregate"; kind: "basic" | "gift" | "extra" | "combined" }
  | { scope: "account"; account: string; kind: "Basic" | "Gift" | "Extra" | "Combined" }

/**
 * WorkBuddy is genuinely multi-account, so it namespaces every window:
 * `aggregate:combined`, `account:someone@example.com:Basic`. Rendered as a flat
 * list that is 50+ rows of colon-delimited keys, which is what the mobile
 * Limits page was doing — the account name repeated on every one of its rows,
 * and the keys were wide enough to overrun the label column and print straight
 * across the meter beside them.
 *
 * Same grammar as packages/app/src/utils/limits-format.ts; the two must agree
 * or desktop and mobile disagree about which account a row belongs to.
 */
export function parseWorkBuddyKey(key: string): WorkBuddyWindowKey | null {
  if (key.startsWith("aggregate:")) {
    const kind = key.slice("aggregate:".length)
    if (kind === "basic" || kind === "gift" || kind === "extra" || kind === "combined")
      return { scope: "aggregate", kind }
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

/**
 * WorkBuddy credits are additive, not tiered: Basic running out does not stop
 * you, because Extra and then Gift still serve. Only the combined aggregate
 * says whether the provider is actually constrained, so every other WorkBuddy
 * window must be kept out of the "which window is binding" calculation — or an
 * exhausted Basic row claims to be limiting while requests keep flowing.
 */
export function isWorkBuddyNonGating(key: string): boolean {
  const parsed = parseWorkBuddyKey(key)
  if (!parsed) return false
  return !(parsed.scope === "aggregate" && parsed.kind === "combined")
}

/**
 * Splits WorkBuddy's flat window map into the provider-level aggregate rows and
 * one group per account — the same aggregate-on-top, collapsible-per-key shape
 * OpenCode Go already uses, so the account label appears once as a header
 * rather than on all four of its rows.
 */
export function splitWorkBuddyWindows(entries: Array<[string, UsageWindow]>) {
  const aggregate: Array<[string, UsageWindow]> = []
  const byAccount = new Map<string, Array<[string, UsageWindow]>>()
  const other: Array<[string, UsageWindow]> = []
  for (const entry of entries) {
    const parsed = parseWorkBuddyKey(entry[0])
    if (!parsed) {
      other.push(entry)
      continue
    }
    if (parsed.scope === "aggregate") {
      aggregate.push(entry)
      continue
    }
    const list = byAccount.get(parsed.account) ?? []
    list.push(entry)
    byAccount.set(parsed.account, list)
  }
  return {
    // Anything unrecognised stays visible rather than being silently dropped.
    aggregate: [...other, ...aggregate],
    accounts: [...byAccount].map(([account, windows]) => ({ account, windows })),
  }
}

/**
 * How a window key should read in a row, given that its account (when it has
 * one) is already shown as the group header above it.
 */
export function describeWindow(key: string): { label: string; tag?: string } {
  const parsed = parseWorkBuddyKey(key)
  // No "all accounts" qualifier on aggregate rows: the provider card *is* the
  // aggregate (accounts live behind the per-key disclosure), so the tag was
  // true of every row, told the reader nothing, and cost "Combined" enough
  // width to render as "Com…".
  if (parsed) return { label: titleCase(parsed.kind) }
  return { label: displayWindowLabel(key) }
}

function titleCase(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return trimmed
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
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
    // Additive credits never gate; see isWorkBuddyNonGating.
    if (isWorkBuddyNonGating(key)) continue
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
