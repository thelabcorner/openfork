import { createMemo } from "solid-js"
import { useSync } from "@/context/sync"
import {
  buildVerdentFreeReport,
  countVerdentFreeToday,
  VERDENT_FREE_DAILY_LIMIT,
  type VerdentFreeReport,
} from "@/utils/verdent-free-usage"

// Verdent free — local estimator hook (client-side only).
// Mirrors `useOpenRouterFreeUsage`'s call shape but, unlike OpenRouter, there
// is no `/experimental/verdent-free-usage` server endpoint yet — so the hook
// derives `used` directly from synced message history (providerID === "verdent"
// + modelID `*-free`), similar to how Zen derives its snapshot from the local
// DB in `usage/zen-free.ts`. The 50 req/day cap is a conservative fallback;
// see `utils/verdent-free-usage.ts` for the documented assumption.

export function useVerdentFreeUsage(options?: { limit?: number; now?: () => number }) {
  const limit = options?.limit ?? VERDENT_FREE_DAILY_LIMIT
  // useSync is only available inside a directory layout; outside (home view)
  // it throws. Gracefully degrade to a no-op report in that scope.
  let sync: ReturnType<typeof useSync> | undefined
  try {
    sync = useSync()
  } catch {
    sync = undefined
  }

  const report = createMemo<VerdentFreeReport | undefined>(() => {
    // Verdent free — subscribe to `now` so the daily window/count rolls over at UTC midnight
    const now = options?.now ? options.now() : Date.now()
    if (!sync) {
      // No sync context — still return a zero-usage report so the panel can
      // render a placeholder if it wants; callers can treat undefined as "no data".
      return undefined
    }
    try {
      const map = sync()?.data?.message as Record<string, Array<{ role?: string; providerID?: string; modelID?: string; time?: { created?: number } }>> | undefined
      const used = countVerdentFreeToday(map, now)
      return buildVerdentFreeReport({ now, used, limit })
    } catch {
      return undefined
    }
  })

  return {
    data: report,
    // Compatibility surface with `useOpenRouterFreeUsage` — no polling needed
    // for a purely local estimator; refresh is a no-op for callers that
    // generically call it.
    refetch: () => {},
    refresh: () => {},
    loading: () => false,
  }
}
