/** Pure helpers for the chat sidebar's ChatGPT / OXP activity section. */

export const ATTRIBUTION_WINDOW_MS = 24 * 60 * 60 * 1000
export const ATTRIBUTION_MIN_INTERVAL_MS = 60_000
export const LIVE_WINDOW_MS = 2 * 60 * 1000
export const OXP_PAGE_INITIAL = 5
export const OXP_PAGE_STEP = 10

/** Coerces numbers and the "NaN"/"Infinity" strings the API may emit to a finite number (else 0). */
export function finite(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  return Number.isFinite(n) ? n : 0
}

export function compact(value: unknown): string {
  const n = finite(value)
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 1 : 2)}B`
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 1 : 2)}k`
  return n.toFixed(abs < 10 && n % 1 ? 1 : 0)
}

export type PlaneInput = {
  augmentationCalls: unknown
  supervisionCalls: unknown
  delegationCalls: unknown
}

export type PlaneMix = {
  augmentation: number
  supervision: number
  delegation: number
  total: number
  /** Fractions in [0, 1] summing to 1, or all 0 when total is 0. */
  augmentationShare: number
  supervisionShare: number
  delegationShare: number
}

export function planeMix(input: PlaneInput): PlaneMix {
  const augmentation = Math.max(0, finite(input.augmentationCalls))
  const supervision = Math.max(0, finite(input.supervisionCalls))
  const delegation = Math.max(0, finite(input.delegationCalls))
  const total = augmentation + supervision + delegation
  const share = (n: number) => (total > 0 ? n / total : 0)
  return {
    augmentation,
    supervision,
    delegation,
    total,
    augmentationShare: share(augmentation),
    supervisionShare: share(supervision),
    delegationShare: share(delegation),
  }
}

export function sumPlaneMix(items: readonly PlaneInput[]): PlaneMix {
  let a = 0
  let s = 0
  let d = 0
  for (const item of items) {
    a += Math.max(0, finite(item.augmentationCalls))
    s += Math.max(0, finite(item.supervisionCalls))
    d += Math.max(0, finite(item.delegationCalls))
  }
  return planeMix({ augmentationCalls: a, supervisionCalls: s, delegationCalls: d })
}

export type StampUnit = "now" | "minutes" | "hours" | "days"

export function relativeStampParts(
  ts: number | undefined,
  now: number,
): { unit: StampUnit; value: number } | undefined {
  if (!ts) return undefined
  const diff = now - ts
  const days = Math.floor(diff / 86_400_000)
  if (days > 0) return { unit: "days", value: days }
  const hours = Math.floor(diff / 3_600_000)
  if (hours > 0) return { unit: "hours", value: hours }
  const minutes = Math.floor(diff / 60_000)
  if (minutes > 0) return { unit: "minutes", value: minutes }
  return { unit: "now", value: 0 }
}

/** Compact stamp ("now", "5m", "2h", "3d"); same logic as the pane's relativeStamp. */
export function relativeStamp(ts: number | undefined, now: number): string {
  const parts = relativeStampParts(ts, now)
  if (!parts) return ""
  if (parts.unit === "now") return "now"
  return `${parts.value}${parts.unit === "days" ? "d" : parts.unit === "hours" ? "h" : "m"}`
}

export function isLive(lastSeenAt: unknown, now: number): boolean {
  const ts = finite(lastSeenAt)
  return ts > 0 && now - ts >= 0 && now - ts < LIVE_WINDOW_MS
}

/**
 * Whether the 24h attribution snapshot should be (re)fetched.
 * Never while collapsed or in flight; first expansion always; afterwards only
 * once the 60s throttle elapsed AND (the section was re-expanded OR the newest
 * activity advanced since the last fetch).
 */
export function shouldRefreshAttribution(input: {
  collapsed: boolean
  inflight: boolean
  now: number
  lastFetchAt?: number
  reexpanded: boolean
  newestSeenAt: number
  lastFetchedNewestSeenAt?: number
}): boolean {
  if (input.collapsed || input.inflight) return false
  if (input.lastFetchAt === undefined) return true
  if (input.now - input.lastFetchAt < ATTRIBUTION_MIN_INTERVAL_MS) return false
  const advanced = input.newestSeenAt > (input.lastFetchedNewestSeenAt ?? 0)
  return input.reexpanded || advanced
}

export function newestSeenAt(items: readonly { lastSeenAt: unknown }[]): number {
  let newest = 0
  for (const item of items) newest = Math.max(newest, finite(item.lastSeenAt))
  return newest
}
