import { createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useForkUsage } from "@/context/fork-usage"
import { useOpenRouterFreeUsage } from "@/hooks/use-openrouter-free-usage"
import {
  toneForRemaining,
  sortWindows,
  resolveTierGate,
  worstRemainingFromWindows,
  type TierGate,
  type UsageWindow,
  type ProviderResult,
} from "@/utils/limits-format"
import { loadLimitsCache, saveLimitsCache } from "@/utils/limits-persistent-cache"

export interface LimitProvider {
  result: ProviderResult
  windowsSorted: [string, UsageWindow][]
  worstRemaining: number | null
  tone: ReturnType<typeof toneForRemaining>
  gate: TierGate
}

/**
 * Floor on the refresh cooldown, independent of provider caching. Even when
 * every provider could be re-read instantly, a manual refresh fires one
 * request per provider, so this stops genuine button-mashing.
 */
const REFRESH_FLOOR_MS = 5_000

// Mirrors the backend's CLAUDE_429_DEFAULT_MS. Kept client-side because the
// backend's own nextRefreshAt only reports a cooldown once it has been
// observed on a later read — this covers the gap on the read that GETS the
// 429, where the pane would otherwise re-enable immediately.
const CLAUDE_429_BACKOFF_MS = 300_000

/**
 * Dedicated limits-system hook: owns provider fetching, filtering
 * (configured-only), sorting, enrichment (worst-remaining + tone), the
 * refresh cooldown, and Go multi-key / OpenRouter-free merges. The pane is a
 * pure projection.
 *
 * Performance optimizations:
 * - Persistent localStorage cache (quota-cache.json equivalent) -> instant paint
 *   on cold open, survives reloads/restarts, stale-while-revalidate.
 * - Only configured providers are fetched (cuts 10 -> 2-3 HTTP calls).
 * - Incremental per-provider updates: each `quota.get` resolves independently
 *   and paints its card immediately; the slowest provider no longer blocks the
 *   entire pane (no `Promise.all` barrier).
 */
export function useLimits(options?: { now?: Accessor<number> }) {
  const now = options?.now ?? Date.now
  const sdk = useServerSDK()
  const forkUsage = useForkUsage()
  // Shared singleton poller — adds no extra network traffic.
  const freeUsage = useOpenRouterFreeUsage()

  const [tick, setTick] = createSignal(0)
  const [lastRefreshedAt, setLastRefreshedAt] = createSignal(0)
  const [lastRateLimitedAt, setLastRateLimitedAt] = createSignal(0)

  const cooldownRemainingMs = () => {
    const floor = Math.max(0, REFRESH_FLOOR_MS - (now() - lastRefreshedAt()))
    const since429 = now() - lastRateLimitedAt()
    const claudeBackoff = lastRateLimitedAt() > 0 ? Math.max(0, CLAUDE_429_BACKOFF_MS - since429) : 0
    return Math.max(floor, claudeBackoff, providerCooldownRemainingMs())
  }
  const isCoolingDown = () => cooldownRemainingMs() > 0

  const lastGoodQuotas = new Map<string, ProviderResult>()
  const isRateLimited = (error?: string | null) => !!error && /429|rate.?limit/i.test(error)

  /**
   * The generated hey-api client returns `response.error` as the parsed JSON
   * body for HTTP-error responses, which is usually a structured OpenAPI error
   * envelope (`{ name: "NotFoundError", data: { message: "..." } }`) and NOT
   * an `Error` or a string. The previous fallback string was a literal
   * "Request failed", which surfaced in the Limits pane as a placeholder with
   * zero diagnostic value. Walk the common envelope shapes here so the user
   * sees the real reason — "Unsupported quota provider: workbuddy", the
   * upstream's 502 message, etc. The string check is the cheap path; the
   * object check is the realistic one.
   */
  const describeResponseError = (err: unknown): string => {
    if (err === null || err === undefined) return "Request failed"
    if (err instanceof Error) return err.message || err.name || "Request failed"
    if (typeof err === "string") return err
    if (typeof err === "object") {
      const obj = err as { message?: unknown; name?: unknown; data?: { message?: unknown } | unknown; error?: unknown }
      if (obj.data && typeof obj.data === "object" && obj.data !== null) {
        const inner = (obj.data as { message?: unknown }).message
        if (typeof inner === "string" && inner.length > 0) return inner
      }
      if (typeof obj.message === "string" && obj.message.length > 0) return obj.message
      if (typeof obj.name === "string" && obj.name.length > 0) {
        return typeof obj.error === "string" && obj.error.length > 0 ? `${obj.name}: ${obj.error}` : obj.name
      }
      if (typeof obj.error === "string" && obj.error.length > 0) return obj.error
    }
    return "Request failed"
  }

  const getEffectiveResult = (r: ProviderResult): ProviderResult => {
    if (r.ok || !isRateLimited(r.error)) return r
    const prev = lastGoodQuotas.get(r.providerId)
    if (prev && prev.usage) {
      return {
        ...prev,
        ok: false,
        error: r.error,
      }
    }
    return r
  }

  // --- Persistent cache hydration ---
  const initialCache = typeof window !== "undefined" ? loadLimitsCache() : undefined
  const initialMap = new Map<string, ProviderResult>()
  if (initialCache) {
    for (const r of initialCache.results) {
      initialMap.set(r.providerId, r)
      if (r.ok && r.usage) lastGoodQuotas.set(r.providerId, r)
    }
    // Prime 429 backoff if cached entry was rate-limited
    for (const r of initialCache.results) {
      if (!r.ok && isRateLimited(r.error) && r.providerId === "claude") {
        setLastRateLimitedAt(r.fetchedAt)
      }
    }
  }

  const [providersRes] = createResource(
    () => tick(),
    async () => {
      const response = await sdk().client.quota.providers({ throwOnError: true })
      return response.data as { providers: Array<{ providerId: string; providerName: string; configured: boolean }> }
    },
  )
  const providerData = createMemo(() => {
    const latest = providersRes.latest
    const isReady = providersRes.state === "ready" || providersRes.state === "refreshing"
    // If we have a persistent cache and providers endpoint is still loading/error,
    // serve the cached provider list instantly (stale-while-revalidate).
    if (!isReady || !latest) {
      if (providersRes.error) {
        // Try persistent cache first
        if (initialCache && initialCache.providers.length > 0) {
          return { providers: initialCache.providers }
        }
        return {
          providers: [
            { providerId: "opencode-zen", providerName: "OpenCode Zen", configured: true },
            { providerId: "claude", providerName: "Claude", configured: true },
          ],
        }
      }
      if (initialCache && !isReady) {
        // providers endpoint still loading - use cached list for instant paint
        if (initialCache.providers.length > 0) return { providers: initialCache.providers }
      }
      return undefined
    }
    // Claude Code is a machine account. Always surface it (and force configured)
    // regardless of what the server reports. The presence of local creds on the
    // backend is authoritative for visibility.
    const hasClaude = latest.providers.some((p) => p.providerId === "claude")
    let providers = hasClaude
      ? latest.providers.map((p) => (p.providerId === "claude" ? { ...p, configured: true } : p))
      : [...latest.providers, { providerId: "claude", providerName: "Claude", configured: true }]
    // OpenCode Zen free quota is IP-based and requires no enrollment.
    // Always inject it so the Limits pane shows local free usage even if the
    // server's provider list is stale or the DB snapshot is empty.
    if (!providers.some((p) => p.providerId === "opencode-zen")) {
      providers = [...providers, { providerId: "opencode-zen", providerName: "OpenCode Zen", configured: true }]
    }
    return { providers }
  })

  // Incremental quota map - each provider updates independently
  const [quotaMap, setQuotaMap] = createSignal<Map<string, ProviderResult>>(new Map(initialMap))
  const [pendingCount, setPendingCount] = createSignal(0)
  const [quotaError, setQuotaError] = createSignal<unknown>(undefined)

  // Track which generation we're on to ignore stale fetches after a tick bump
  let fetchGeneration = 0

  createEffect(() => {
    const data = providerData()
    const currentTick = tick()
    if (!data) return
    // Only fetch configured providers - cuts 10 -> 2-3 calls, huge latency win
    const toFetch = data.providers.filter((p) => p.configured)
    if (toFetch.length === 0) {
      setQuotaMap(new Map())
      setPendingCount(0)
      return
    }
    const generation = ++fetchGeneration
    setPendingCount(toFetch.length)
    setQuotaError(undefined)

    const fallback = (entry: { providerId: string; providerName: string; configured: boolean }, message: string): ProviderResult => ({
      providerId: entry.providerId,
      providerName: entry.providerName,
      ok: false,
      configured: entry.configured,
      error: message,
      usage: null,
      fetchedAt: Date.now(),
    })

    let completed = 0
    const resultsThisGen = new Map<string, ProviderResult>()

    const checkDone = () => {
      completed++
      if (completed === toFetch.length && generation === fetchGeneration) {
        setPendingCount(0)
        // Persist successful batch for instant next-open
        const allResults = Array.from(resultsThisGen.values())
        if (allResults.length > 0) {
          try {
            saveLimitsCache(data.providers, allResults)
          } catch {}
        }
      }
    }

    for (const entry of toFetch) {
      // For stale-while-revalidate: if we have a cached entry that's still fresh
      // per localStorage TTL, we can keep showing it while background refresh happens.
      // But we still fetch - the in-memory fetch will dedup via backend cache (5 min TTL)
      // so it's cheap. We just don't clear the map before fetches complete.
      const fetchOne = async () => {
        try {
          const response = await sdk().client.quota.get({ providerID: entry.providerId }, { throwOnError: false })
          let result: ProviderResult
          if (!response.data) {
            const message = describeResponseError(response.error)
            result = fallback(entry, message)
          } else {
            result = response.data as ProviderResult
          }
          if (generation !== fetchGeneration) return
          resultsThisGen.set(result.providerId, result)
          if (result.ok && result.usage) lastGoodQuotas.set(result.providerId, result)
          if (result.ok && result.providerId === "claude") setLastRateLimitedAt(0)
          else if (!result.ok && isRateLimited(result.error) && result.providerId === "claude") setLastRateLimitedAt(Date.now())
          setQuotaMap((prev) => {
            const next = new Map(prev)
            next.set(result.providerId, result)
            return next
          })
        } catch (err) {
          if (generation !== fetchGeneration) return
          const result = fallback(entry, err instanceof Error ? err.message : String(err))
          resultsThisGen.set(result.providerId, result)
          setQuotaMap((prev) => {
            const next = new Map(prev)
            next.set(result.providerId, result)
            return next
          })
          // Only surface as resource error if we have no cached data at all
          if (quotaMap().size === 0 && initialMap.size === 0) setQuotaError(err)
        } finally {
          if (generation === fetchGeneration) checkDone()
        }
      }
      void fetchOne()
    }
  })

  // Initialize from persistent cache immediately if available and providerData not yet ready
  // This effect ensures that even before providerData resolves, we show cached quotas
  // (handled via initialMap above). No extra work needed.

  // THE hide-not-connected rule — single choke point.
  // Now derived from incremental map, not from a single blocking resource.
  // Intersect with the current configured provider list so a removed provider
  // doesn't linger from cache, and pending providers simply don't appear yet
  // (incremental paint).
  const connected = createMemo(() => {
    const map = quotaMap()
    const data = providerData()
    if (map.size === 0) {
      if (initialMap.size > 0) {
        if (data) {
          const allowed = new Set(data.providers.filter((p) => p.configured).map((p) => p.providerId))
          const filtered = Array.from(initialMap.values()).filter((r) => allowed.has(r.providerId))
          if (filtered.length > 0) return filtered
          return Array.from(initialMap.values()).filter((r) => r.configured)
        }
        return Array.from(initialMap.values()).filter((r) => r.configured)
      }
      return undefined
    }
    if (data) {
      const allowed = new Set(data.providers.filter((p) => p.configured).map((p) => p.providerId))
      const filtered = Array.from(map.values()).filter((r) => allowed.has(r.providerId))
      // If we have a map but none match current configured set, fall back to showing
      // whatever is configured in the map (covers initial cache before providerData refresh)
      if (filtered.length > 0) return filtered
      if (map.size > 0) return Array.from(map.values()).filter((r) => r.configured)
    }
    return Array.from(map.values()).filter((r) => r.configured)
  })

  const providers = createMemo<LimitProvider[] | undefined>(() => {
    const list = connected()
    if (!list) return undefined
    // If incremental fetches are still in flight, we may have partial results.
    // Show what we have immediately rather than waiting for all.
    return list
      .map((r) => {
        const effective = getEffectiveResult(r)
        const windowsSorted = effective.usage ? sortWindows(Object.entries(effective.usage.windows) as [string, UsageWindow][]) : []
        const gate = resolveTierGate(windowsSorted)
        const worstRemaining = effective.usage ? (gate.effectiveRemaining ?? worstRemainingFromWindows(windowsSorted)) : null
        return { result: effective, windowsSorted, worstRemaining, tone: toneForRemaining(worstRemaining), gate }
      })
      .sort((a, b) => {
        // Pin OpenCode Zen at the top — it's the only automatic/IP-based
        // free quota and should be visible without scrolling.
        const aIsZen = a.result.providerId === "opencode-zen"
        const bIsZen = b.result.providerId === "opencode-zen"
        if (aIsZen !== bIsZen) return aIsZen ? -1 : 1
        if (a.result.ok !== b.result.ok) return a.result.ok ? -1 : 1
        return a.result.providerName.localeCompare(b.result.providerName)
      })
  })

  /**
   * How long until a refresh would actually return new numbers.
   *
   * Every adapter that caches its upstream read (kimi/codex/xai/workbuddy via
   * createQuotaCache, claude, opencode-go) publishes `nextRefreshAt` — the
   * epoch ms its own cache expires, or the end of a 429 backoff. Refreshing
   * before the SLOWEST one expires re-serves identical data for that provider,
   * so the cooldown is the max across providers rather than a flat guess.
   *
   * Providers without that field (older servers, or adapters that read
   * locally like Zen/NVIDIA) contribute 0 — a missing value means "refresh
   * is useful now", never "never refresh".
   */
  const providerCooldownRemainingMs = createMemo(() => {
    const list = providers()
    if (!list) return 0
    const latest = list.reduce((max, p) => Math.max(max, p.result.nextRefreshAt ?? 0), 0)
    return Math.max(0, latest - now())
  })

  const isLoading = () => {
    // If we have cached data to show, don't block on network
    if (providers() !== undefined) return false
    // No data yet - show loading if either providers or quotas are pending
    if (providersRes.loading) return true
    if (pendingCount() > 0) return true
    // If we have initial cache, not loading
    if (initialMap.size > 0) return false
    return false
  }
  const hasError = () => {
    if (providers() !== undefined) return false
    return Boolean(providersRes.error || quotaError())
  }
  const error = () => (providersRes.error ?? quotaError()) as unknown

  const goByCredential = () => forkUsage.usage.latest?.byCredential ?? []
  const goAggregate = () => forkUsage.usage.latest?.aggregate ?? []
  const goCredentials = () => forkUsage.credentials.latest ?? []
  const openRouterFree = () => freeUsage.data()

  const refresh = () => {
    if (isCoolingDown() || isLoading()) return
    setLastRefreshedAt(now())
    setTick((v) => v + 1)
    freeUsage.refresh()
  }

  const onFocus = () => {
    if (document.hidden || isCoolingDown()) return
    setTimeout(() => {
      if (!document.hidden && !isCoolingDown()) refresh()
    }, 200)
  }
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onFocus)
    onCleanup(() => window.removeEventListener("focus", onFocus))
  }

  return {
    providers,
    goByCredential,
    goAggregate,
    goCredentials,
    openRouterFree,
    isLoading,
    hasError,
    error,
    refresh,
    isCoolingDown,
    cooldownRemainingMs,
  } as const
}

export type LimitsState = ReturnType<typeof useLimits>
export type { Accessor }
