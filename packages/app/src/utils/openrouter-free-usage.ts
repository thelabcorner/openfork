// Optimized client cache for OpenRouter Free Usage (FUT).
// Mirrors the pattern in `openrouter-endpoints.ts`: in-memory + localStorage
// cache, single-flight dedup, idle-persisted writes, TTL-bounded.
// The renderer calls the local server proxy at `/experimental/openrouter-free-usage`
// so the Management key never leaves the server. This module owns only the
// cache + in-flight dedup and never blocks UI on fetch failure.
//
// Server owns the heavy TTLs (15s snapshot, 6h tier/pricing) and single-flight
// per account. Client adds a second layer to collapse N panes into 1 server
// request per window and to survive reload via localStorage.

export type FreeUsageReport = {
  free: {
    remaining: number
    limit: 50 | 1000
    remainingPercent: number
    used: number
    usedPercent: number
    status: "healthy" | "draining" | "low" | "critical" | "terminal" | "depleted"
    tier: { source: "override" | "credits-api"; totalCreditsPurchased: number | null }
    tokens: { prompt: number; completion: number; reasoning: number; total: number }
    value: {
      equivalentPaidValueUsd: number
      valuedRequests: number
      unvaluedRequests: number
      methodology: "current-paid-sibling-list-price"
      cacheAware: false
      note: string
    }
    window: { type: "calendar-day"; timezone: "UTC"; startedAt: string; resetsAt: string; secondsUntilReset: number }
    reset: { policy: "midnight-utc"; confidence: "high"; basis: string }
    rate: { limitPerMinute: 20; observedRequestsPerMinute: number; source: "snapshot-delta" | "day-average" | "insufficient-data" }
    projection: {
      requestsPerHour: number
      rateSource: "snapshot-delta" | "day-average" | "insufficient-data"
      sustainableRequestsPerHour: number
      projectedRemainingAtReset: number
      willExhaustBeforeReset: boolean
      estimatedExhaustionAt: string | null
    }
    models: Array<{
      model: string
      paidSibling: string | null
      requests: number
      tokens: { prompt: number; completion: number; reasoning: number; total: number }
      value: { equivalentPaidValueUsd: number | null; pricingFound: boolean }
    }>
  }
  source: {
    mode: "openrouter-analytics"
    scope: "account"
    analyticsAsOf: string
    fetchedAt: string
    stale: boolean
    analyticsRows: number
    analyticsTruncated: boolean
    upstreamCalls: number
  }
}

type CacheEntry = { version: number; fetchedAt: number; report: FreeUsageReport }

const CACHE_TTL_MS = 15_000
const NEGATIVE_TTL_MS = 5 * 60_000
const CACHE_VERSION = 1

const memoryCache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<FreeUsageReport | undefined>>()
const pendingWrites = new Map<string, CacheEntry>()
let persistHandle: number | ReturnType<typeof setTimeout> | undefined

type NegativeEntry = { version: number; fetchedAt: number; stale: true }
const negativeCache = new Map<string, NegativeEntry>()

const cacheKey = (includeValue: boolean) => `opencode.openrouter-free-usage.v1.includeValue=${includeValue ? 1 : 0}`

function readCache(includeValue: boolean): CacheEntry | undefined {
  const key = cacheKey(includeValue)
  const mem = memoryCache.get(key)
  if (mem) return mem
  if (typeof localStorage === "undefined") return undefined
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return undefined
    const entry = JSON.parse(raw) as CacheEntry
    if (entry.version !== CACHE_VERSION) return undefined
    memoryCache.set(key, entry)
    return entry
  } catch {
    return undefined
  }
}

function writeCache(includeValue: boolean, entry: CacheEntry) {
  const key = cacheKey(includeValue)
  memoryCache.set(key, entry)
  if (typeof localStorage === "undefined") return
  pendingWrites.set(key, entry)
  schedulePersist()
}

function readNegative(includeValue: boolean): NegativeEntry | undefined {
  const key = `${cacheKey(includeValue)}:negative`
  const mem = negativeCache.get(key)
  if (mem) return mem
  if (typeof localStorage === "undefined") return undefined
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return undefined
    const entry = JSON.parse(raw) as NegativeEntry
    if (entry.version !== CACHE_VERSION) return undefined
    negativeCache.set(key, entry)
    return entry
  } catch {
    return undefined
  }
}

function writeNegative(includeValue: boolean) {
  const key = `${cacheKey(includeValue)}:negative`
  const entry: NegativeEntry = { version: CACHE_VERSION, fetchedAt: Date.now(), stale: true }
  negativeCache.set(key, entry)
  if (typeof localStorage === "undefined") return
  pendingWrites.set(key, entry as unknown as CacheEntry)
  schedulePersist()
}

function schedulePersist() {
  if (persistHandle !== undefined || pendingWrites.size === 0) return
  const flush = () => {
    persistHandle = undefined
    const next = pendingWrites.entries().next()
    if (next.done) return
    pendingWrites.delete(next.value[0])
    try {
      localStorage.setItem(next.value[0], JSON.stringify(next.value[1]))
    } catch {
      // best-effort cache only
    }
    schedulePersist()
  }
  persistHandle =
    typeof requestIdleCallback === "function"
      ? requestIdleCallback(flush, { timeout: 1_000 })
      : setTimeout(flush, 100)
}

// The actual HTTP request is delegated to `fetchReport`, which the caller
// wires to the unified SDK's `/experimental/openrouter-free-usage` proxy.
// This module only owns the cache + in-flight dedup.
export async function getOpenRouterFreeUsage(
  options: { includeValue?: boolean; forceRefresh?: boolean },
  fetchReport: (opts: { includeValue: boolean; forceRefresh: boolean }) => Promise<FreeUsageReport>,
): Promise<FreeUsageReport | undefined> {
  const includeValue = options.includeValue ?? true
  const forceRefresh = options.forceRefresh ?? false
  const key = cacheKey(includeValue)
  const negativeKey = `${key}:negative`

  if (!forceRefresh) {
    const cached = readCache(includeValue)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.report
    const neg = readNegative(includeValue)
    if (neg && Date.now() - neg.fetchedAt < NEGATIVE_TTL_MS) return undefined
  }

  if (!inflight.has(key)) {
    const promise = fetchReport({ includeValue, forceRefresh })
      .then((report) => {
        // Success clears any negative marker
        negativeCache.delete(negativeKey)
        if (typeof localStorage !== "undefined") {
          try {
            localStorage.removeItem(negativeKey)
          } catch {
            // ignore
          }
        }
        const entry: CacheEntry = { version: CACHE_VERSION, fetchedAt: Date.now(), report }
        writeCache(includeValue, entry)
        return report
      })
      .catch((error) => {
        console.warn("[openrouter-free-usage] fetch failed", error)
        // Cache negative for 5m to avoid hammering when not configured or upstream down
        writeNegative(includeValue)
        const stale = readCache(includeValue)
        if (stale) return stale.report
        return undefined
      })
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, promise)
  }
  return inflight.get(key)
}

export function clearOpenRouterFreeUsageCache() {
  memoryCache.clear()
  negativeCache.clear()
  inflight.clear()
  if (typeof localStorage !== "undefined") {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i)
        if (k && k.startsWith("opencode.openrouter-free-usage.")) localStorage.removeItem(k)
      }
    } catch {
      // ignore
    }
  }
}
