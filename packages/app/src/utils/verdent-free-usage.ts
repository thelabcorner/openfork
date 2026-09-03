// Verdent free — client-side estimator for the two real limits Verdent
// enforces on free models: a rolling 5-hour window and a rolling weekly
// (7-day) window. The pane screenshot says "Free to use · 5-hour and weekly
// usage limits apply" — daily is wrong.
// Server-side learning now lives in `packages/opencode/src/usage/verdent-free.ts`
// (snapshot built from `part.step-finish` + persisted `APIError` rows, same
// pattern as `usage/zen-free.ts`) and `quota/providers/verdent.ts` (dual
// weighted-median estimator, half-life 14 days, fallback 20/100, dedup per
// 5h/weekly bucket). This file remains as the degraded client-side fallback
// when the quota provider has not yet been polled or the DB is unavailable:
// it scans `sync().data.message` (assistant messages, coarser than
// `step-finish` but the best local proxy) and any persisted 429 error rows
// visible in sync, then applies the same half-life median logic so the pane
// can already show a learning estimate offline.
// Fallback limits are deliberately low-confidence priors (20/100) matching the
// server fallback; any hit immediately starts teaching the real regime.

export const VERDENT_FREE_DAILY_LIMIT = 50 // legacy — kept for compat, not used for UI
export const VERDENT_FREE_DAY_MS = 86_400_000
export const VERDENT_FREE_5H_MS = 5 * 60 * 60 * 1000
export const VERDENT_FREE_WEEK_MS = 7 * 24 * 60 * 60 * 1000
export const VERDENT_FREE_5H_FALLBACK = 20
export const VERDENT_FREE_WEEK_FALLBACK = 100
const VERDENT_HIT_HALF_LIFE_MS = 14 * VERDENT_FREE_DAY_MS

export type VerdentFreeStatus = "healthy" | "draining" | "low" | "critical" | "depleted"

export type VerdentFreeReport = {
  used: number
  limit: number
  remaining: number
  remainingPercent: number
  usedPercent: number
  status: VerdentFreeStatus
  window: { type: "calendar-day"; timezone: "UTC"; startedAt: string; resetsAt: string; secondsUntilReset: number }
  resetsAt: number
}

function statusForRemaining(remainingPercent: number): VerdentFreeStatus {
  if (remainingPercent <= 0) return "depleted"
  if (remainingPercent <= 10) return "critical"
  if (remainingPercent <= 30) return "low"
  if (remainingPercent <= 60) return "draining"
  return "healthy"
}

export function isVerdentFreeModelID(modelID: string | null | undefined): boolean {
  if (!modelID) return false
  return modelID.trim().toLowerCase().endsWith("-free")
}

export function isVerdentFreeMessage(msg: { providerID?: string | null; modelID?: string | null }): boolean {
  const provider = (msg.providerID ?? "").toLowerCase()
  if (provider !== "verdent") return false
  return isVerdentFreeModelID(msg.modelID)
}

export function verdentUtcDayStart(timestamp: number): number {
  return Math.floor(timestamp / VERDENT_FREE_DAY_MS) * VERDENT_FREE_DAY_MS
}

export function verdentUtcDayEnd(timestamp: number): number {
  return verdentUtcDayStart(timestamp) + VERDENT_FREE_DAY_MS
}

export function verdentWindowStart(timestamp: number, windowMs: number): number {
  return timestamp - windowMs
}

// --- 429 hit extraction (client-side, best-effort) -------------------------

function extractErrorBody(raw: unknown): string {
  const obj = raw as Record<string, unknown>
  const candidates = [
    (obj as { error?: { data?: { responseBody?: unknown } } })?.error?.data?.responseBody,
    (obj as { data?: { error?: { data?: { responseBody?: unknown } } } })?.data?.error?.data?.responseBody,
    (obj as { error?: { message?: unknown } })?.error?.message,
    (obj as { data?: { error?: { message?: unknown } } })?.data?.error?.message,
  ]
  for (const c of candidates) if (typeof c === "string" && c) return c
  return ""
}

function isVerdentRateLimitError(raw: unknown): boolean {
  const body = extractErrorBody(raw).toLowerCase()
  if (!body) return false
  return body.includes("rate_limit") || body.includes("rate limit") || body.includes("rate_limit_error")
}

function classifyVerdentWindow(body: string): "5h" | "weekly" | "unknown" {
  const lower = body.toLowerCase()
  if (lower.includes("weekly") || lower.includes("week")) return "weekly"
  if (lower.includes("5-hour") || lower.includes("5 hour") || lower.includes("5h")) return "5h"
  return "unknown"
}

function messageTime(raw: unknown): number | undefined {
  const obj = raw as Record<string, unknown>
  const t = (obj as { time?: { created?: unknown; completed?: unknown } }).time
  if (typeof t?.completed === "number") return t.completed
  if (typeof t?.created === "number") return t.created
  if (typeof (obj as { time_created?: unknown }).time_created === "number") return (obj as { time_created: number }).time_created
  if (typeof (obj as { time_updated?: unknown }).time_updated === "number") return (obj as { time_updated: number }).time_updated
  return undefined
}

export function buildVerdentFreeReport(input: {
  now?: number
  used: number
  limit?: number
}): VerdentFreeReport {
  const now = input.now ?? Date.now()
  const limit = Math.max(1, Math.round(input.limit ?? VERDENT_FREE_DAILY_LIMIT))
  const used = Math.max(0, Math.round(input.used))
  const remaining = Math.max(0, limit - used)
  const remainingPercent = Math.max(0, Math.min(100, (remaining / limit) * 100))
  const usedPercent = Math.max(0, Math.min(100, 100 - remainingPercent))
  const start = verdentUtcDayStart(now)
  const end = verdentUtcDayEnd(now)
  return {
    used,
    limit,
    remaining,
    remainingPercent,
    usedPercent,
    status: statusForRemaining(remainingPercent),
    window: {
      type: "calendar-day",
      timezone: "UTC",
      startedAt: new Date(start).toISOString(),
      resetsAt: new Date(end).toISOString(),
      secondsUntilReset: Math.max(0, Math.round((end - now) / 1000)),
    },
    resetsAt: end,
  }
}

// Count helper reused by the hook — scans the sync message map for today's
// Verdent free assistant turns. One assistant message == one request unit
// (mirrors `zen-free.ts:buildZenFreeSnapshot` counting `step-finish` per
// assistant generation; we lack step granularity in sync so a coarser
// message count is the best local proxy).
export function countVerdentFreeToday(
  messagesBySession: Record<string, Array<{ role?: string; providerID?: string; modelID?: string; time?: { created?: number } } | null | undefined> | undefined> | undefined,
  now: number,
): number {
  if (!messagesBySession) return 0
  const dayStart = verdentUtcDayStart(now)
  let count = 0
  for (const messages of Object.values(messagesBySession)) {
    if (!messages) continue
    for (const raw of messages as Array<{ role?: string; providerID?: string; modelID?: string; time?: { created?: number }; time_created?: number }>) {
      if (!raw || raw.role !== "assistant") continue
      if (!isVerdentFreeMessage(raw as { providerID?: string | null; modelID?: string | null })) continue
      const at = messageTime(raw as unknown)
      if (at !== undefined && at < dayStart) continue
      count++
    }
  }
  return count
}

export function countVerdentFreeInWindow(
  messagesBySession: Record<string, Array<unknown> | undefined> | undefined,
  now: number,
  windowMs: number,
): number {
  if (!messagesBySession) return 0
  const since = now - windowMs
  let count = 0
  for (const messages of Object.values(messagesBySession)) {
    if (!messages) continue
    for (const raw of messages as Array<{ role?: string }>) {
      if (!raw || (raw as { role?: string }).role !== "assistant") continue
      if (!isVerdentFreeMessage(raw as { providerID?: string | null; modelID?: string | null })) continue
      if (isVerdentRateLimitError(raw as unknown)) continue
      const at = messageTime(raw as unknown)
      if (at !== undefined && at < since) continue
      count++
    }
  }
  return count
}

export type VerdentRateLimitHit = { at: number; modelID: string; window: "5h" | "weekly" | "unknown"; raw: string }

export function collectVerdentHits(
  messagesBySession: Record<string, Array<unknown> | undefined> | undefined,
  now: number,
): VerdentRateLimitHit[] {
  if (!messagesBySession) return []
  const since = now - 90 * VERDENT_FREE_DAY_MS
  const hits: VerdentRateLimitHit[] = []
  for (const messages of Object.values(messagesBySession)) {
    if (!messages) continue
    for (const raw of messages as Array<Record<string, unknown>>) {
      if (!raw || (raw as { role?: string }).role !== "assistant") continue
      if (!isVerdentFreeMessage(raw as { providerID?: string | null; modelID?: string | null })) continue
      if (!isVerdentRateLimitError(raw as unknown)) continue
      const at = messageTime(raw as unknown)
      if (at === undefined || at < since || at >= now) continue
      const body = extractErrorBody(raw as unknown)
      hits.push({ at, modelID: (raw as { modelID?: string }).modelID ?? "", window: classifyVerdentWindow(body), raw: body })
    }
  }
  hits.sort((a, b) => a.at - b.at)
  const seen = new Set<string>()
  const deduped: VerdentRateLimitHit[] = []
  for (const h of hits) {
    const bucket = h.window === "5h" ? `5h:${Math.floor(h.at / VERDENT_FREE_5H_MS)}` : h.window === "weekly" ? `wk:${Math.floor(h.at / VERDENT_FREE_WEEK_MS)}` : `unk:${Math.floor(h.at / (10 * 60 * 1000))}`
    if (seen.has(bucket)) continue
    seen.add(bucket)
    deduped.push(h)
  }
  return deduped
}

// --- Client-side dual-window estimator (mirrors server) ------------------

function hitWeight(now: number, at: number) {
  return 2 ** (-Math.max(0, now - at) / VERDENT_HIT_HALF_LIFE_MS)
}

function weightedMedian(values: { value: number; weight: number }[]) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a.value - b.value)
  const total = sorted.reduce((s, x) => s + x.weight, 0)
  if (!(total > 0)) return null
  let cur = 0
  for (const item of sorted) {
    cur += item.weight
    if (cur >= total / 2) return item.value
  }
  return sorted.at(-1)?.value ?? null
}

function estimateWindowClient(input: { used: number; hits: { at: number; requests: number }[]; now: number; fallback: number }) {
  const hits = input.hits.filter((h) => Number.isFinite(h.requests) && h.requests > 0)
  const latestAt = hits.reduce<number | null>((m, h) => (m === null || h.at > m ? h.at : m), null)
  const weighted: { value: number; weight: number }[] = [{ value: input.fallback, weight: 0.35 }]
  let wTotal = 0
  for (const h of hits) {
    const w = hitWeight(input.now, h.at)
    wTotal += w
    weighted.push({ value: Math.max(1, Math.round(h.requests)), weight: w })
  }
  const learned = hits.length > 0 ? weightedMedian(weighted) : null
  const knownAtLeast = input.used
  if (learned !== null) {
    const lim = Math.max(1, Math.round(learned))
    if (knownAtLeast > lim) return { used: input.used, limit: null as number | null, knownAtLeast, source: "lower-bound" as const, confidence: Math.min(0.7, 0.4 + wTotal * 0.1), hitSamples: hits.length, lastHitAt: latestAt }
    return { used: input.used, limit: lim, knownAtLeast: Math.max(knownAtLeast, lim), source: "learned" as const, confidence: Math.min(0.98, 0.55 + (1 - Math.exp(-wTotal)) * 0.4), hitSamples: hits.length, lastHitAt: latestAt }
  }
  if (knownAtLeast > input.fallback) return { used: input.used, limit: null as number | null, knownAtLeast, source: "lower-bound" as const, confidence: 0.35 as number, hitSamples: 0, lastHitAt: null }
  return { used: input.used, limit: input.fallback, knownAtLeast: Math.max(knownAtLeast, input.fallback), source: "fallback" as const, confidence: 0.15 as number, hitSamples: 0, lastHitAt: null }
}

export type VerdentWindowEstimate = ReturnType<typeof estimateWindowClient>
export type VerdentDualEstimate = { fiveHour: VerdentWindowEstimate; weekly: VerdentWindowEstimate }

export function estimateVerdentDualClient(input: {
  now: number
  used5h: number
  usedWeek: number
  hits: VerdentRateLimitHit[]
  messagesBySession: Record<string, Array<unknown> | undefined> | undefined
}): VerdentDualEstimate {
  const times = (() => {
    const out: number[] = []
    if (!input.messagesBySession) return out
    for (const messages of Object.values(input.messagesBySession)) {
      if (!messages) continue
      for (const raw of messages as Array<Record<string, unknown>>) {
        if (!raw || (raw as { role?: string }).role !== "assistant") continue
        if (!isVerdentFreeMessage(raw as { providerID?: string | null; modelID?: string | null })) continue
        if (isVerdentRateLimitError(raw as unknown)) continue
        const at = messageTime(raw as unknown)
        if (at !== undefined) out.push(at)
      }
    }
    return out.sort((a, b) => a - b)
  })()

  function lowerBound(arr: number[], v: number) {
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
      const mid = lo + ((hi - lo) >> 1)
      if (arr[mid] < v) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const hits5h = input.hits
    .filter((h) => h.window === "5h" || h.window === "unknown")
    .map((h) => ({ at: h.at, requests: lowerBound(times, h.at) - lowerBound(times, h.at - VERDENT_FREE_5H_MS) }))
  const hitsWeek = input.hits
    .filter((h) => h.window === "weekly" || h.window === "unknown")
    .map((h) => ({ at: h.at, requests: lowerBound(times, h.at) - lowerBound(times, h.at - VERDENT_FREE_WEEK_MS) }))

  return {
    fiveHour: estimateWindowClient({ used: input.used5h, hits: hits5h, now: input.now, fallback: VERDENT_FREE_5H_FALLBACK }),
    weekly: estimateWindowClient({ used: input.usedWeek, hits: hitsWeek, now: input.now, fallback: VERDENT_FREE_WEEK_FALLBACK }),
  }
}
