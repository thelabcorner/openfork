import { createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { useForkUsage } from "@/context/fork-usage"
import { useOpenRouterFreeUsage } from "@/hooks/use-openrouter-free-usage"
import {
  toneForRemaining,
  colorForTone,
  formatPercent,
  displayWindowLabel,
  sortWindows,
  worstRemainingFromWindows,
} from "@/utils/limits-format"
import type { UsageWindow, ProviderResult } from "@/utils/limits-format"

export interface LimitProvider {
  result: ProviderResult
  windowsSorted: [string, UsageWindow][]
  worstRemaining: number | null
  tone: ReturnType<typeof toneForRemaining>
}

export function useLimits() {
  const sdk = useServerSDK()
  const forkUsage = useForkUsage()
  const openRouterFree = useOpenRouterFreeUsage({ enabled: true })
  const [tick, setTick] = createSignal(0)
  const [lastRefreshedAt, setLastRefreshedAt] = createSignal(0)

  const COOLDOWN_MS = 30_000
  const cooldownRemaining = () => Math.max(0, COOLDOWN_MS - (Date.now() - lastRefreshedAt()))
  const isCoolingDown = () => cooldownRemaining() > 0

  const [providersRes] = createResource(
    () => tick(),
    async () => {
      const response = await sdk().client.quota.providers({ throwOnError: true })
      return response.data as { providers: Array<{ providerId: string; providerName: string; configured: boolean }> }
    },
  )

  const [quotasRes] = createResource(
    () => {
      const data = providersRes()
      void tick()
      return data ? { providers: data.providers, tick: tick() } : undefined
    },
    async (input) => {
      if (!input) return []
      const list = input.providers
      const results = await Promise.all(
        list.map(async (entry) => {
          try {
            const response = await sdk().client.quota.get({ providerID: entry.providerId }, { throwOnError: false })
            return response.data as ProviderResult
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return {
              providerId: entry.providerId,
              providerName: entry.providerName,
              ok: false,
              configured: entry.configured,
              error: message,
              usage: null,
              fetchedAt: Date.now(),
            } as ProviderResult
          }
        }),
      )
      return results
    },
  )

  const providers = createMemo(() => {
    const raw = quotasRes()
    if (!raw) return undefined
    // Filter: hide not-connected providers (configured === false)
    const connected = raw.filter((r) => r.configured)
    return connected.sort((a, b) => {
      if (a.configured !== b.configured) return a.configured ? -1 : 1
      if (a.ok !== b.ok) return a.ok ? -1 : 1
      return (a.providerName ?? a.providerId).localeCompare(b.providerName ?? b.providerId)
    })
  })

  const isLoading = () => providersRes.loading || quotasRes.loading
  const hasError = () => Boolean(providersRes.error || quotasRes.error)

  const refresh = () => {
    if (isCoolingDown() || isLoading()) return
    setLastRefreshedAt(Date.now())
    setTick((v) => v + 1)
  }

  // Auto-refresh on focus (debounced)
  const onFocus = () => {
    if (document.hidden) return
    if (isCoolingDown()) return
    setTimeout(() => {
      if (isCoolingDown()) return
      setLastRefreshedAt(Date.now())
      setTick((v) => v + 1)
    }, 200)
  }
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onFocus)
    onCleanup(() => window.removeEventListener("focus", onFocus))
  }

  // Go multi-key data from ForkClient usage (reuse existing L1/L2 cache)
  const goByCredential = () => {
    const latest = forkUsage.usage.latest
    if (!latest) return []
    return latest.byCredential ?? []
  }

  // Enrich providers with sorted windows, tone, worstRemaining
  const enrichedProviders = createMemo(() => {
    const list = providers()
    if (!list) return [] as LimitProvider[]
    return list.map((r) => {
      const windowsSorted = r.usage
        ? sortWindows(Object.entries(r.usage.windows) as [string, UsageWindow][])
        : []
      const worst = r.usage ? worstRemainingFromWindows(windowsSorted) : null
      const tone = toneForRemaining(worst)
      return { result: r, windowsSorted, worstRemaining: worst, tone } as LimitProvider
    })
  })

  return {
    providers: enrichedProviders,
    goByCredential,
    openRouterFree: () => openRouterFree.data?.(),
    isLoading,
    hasError,
    error: () => (providersRes.error ?? quotasRes.error) as unknown,
    refresh,
    isCoolingDown,
    cooldownRemainingMs: () => cooldownRemaining(),
  } as const
}
