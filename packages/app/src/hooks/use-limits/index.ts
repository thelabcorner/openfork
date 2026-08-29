import { createMemo, createResource, createSignal, onCleanup } from "solid-js"
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
    // Fallback when the providers endpoint fails or is still loading: still
    // surface the automatic providers so Zen is never hidden behind a fetch
    // error. Zen is IP-based and needs no enrollment.
    if (!isReady || !latest) {
      if (providersRes.error) {
        return {
          providers: [
            { providerId: "opencode-zen", providerName: "OpenCode Zen", configured: true },
            { providerId: "claude", providerName: "Claude", configured: true },
          ],
        }
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

  const [quotasRes] = createResource(
    () => {
      const data = providerData()
      void tick()
      return data ? { providers: data.providers, tick: tick() } : undefined
    },
    async (input) => {
      const fallback = (entry: { providerId: string; providerName: string; configured: boolean }, message: string): ProviderResult => ({
        providerId: entry.providerId,
        providerName: entry.providerName,
        ok: false,
        configured: entry.configured,
        error: message,
        usage: null,
        fetchedAt: Date.now(),
      })
      const results = await Promise.all(
        input.providers.map(async (entry) => {
          try {
            const response = await sdk().client.quota.get({ providerID: entry.providerId }, { throwOnError: false })
            // The generated client's non-throwing branches (network failure,
            // HTTP error status, unknown-provider 404) all resolve with
            // `data: undefined` rather than rejecting — casting that straight
            // to ProviderResult let `undefined` reach `r.ok` downstream and
            // throw out of this fetcher entirely, surfacing as "Couldn't load
            // limits" for every provider instead of just this one.
            if (!response.data) {
              const err = response.error
              const message = err instanceof Error ? err.message : typeof err === "string" ? err : "Request failed"
              return fallback(entry, message)
            }
            return response.data as ProviderResult
          } catch (err) {
            return fallback(entry, err instanceof Error ? err.message : String(err))
          }
        }),
      )
      results.forEach((r) => {
        if (r.ok && r.usage) {
          lastGoodQuotas.set(r.providerId, r)
        }
        if (r.ok && r.providerId === "claude") {
          setLastRateLimitedAt(0)
        } else if (!r.ok && isRateLimited(r.error) && r.providerId === "claude") {
          setLastRateLimitedAt(Date.now())
        }
      })
      return results
    },
  )

  // THE hide-not-connected rule — single choke point.
  const connected = createMemo(() => {
    if (quotasRes.state !== "ready" && quotasRes.state !== "refreshing") return undefined
    const raw = quotasRes.latest
    if (!raw) return undefined
    return raw.filter((r) => r.configured)
  })

  const providers = createMemo<LimitProvider[] | undefined>(() => {
    const list = connected()
    if (!list) return undefined
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

  const isLoading = () => providersRes.loading || quotasRes.loading
  const hasError = () => Boolean(providersRes.error || quotasRes.error)
  const error = () => (providersRes.error ?? quotasRes.error) as unknown

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
