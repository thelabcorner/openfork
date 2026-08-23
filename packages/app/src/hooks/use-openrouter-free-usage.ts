import { createEffect, createResource, onCleanup } from "solid-js"
import { useSDK } from "@/context/sdk"
import { getOpenRouterFreeUsage, type FreeUsageReport } from "@/utils/openrouter-free-usage"

const POLL_MS = 30_000
const VISIBILITY_DEBOUNCE_MS = 2_000

export function useOpenRouterFreeUsage(options?: { includeValue?: boolean; enabled?: boolean }) {
  const sdk = useSDK()
  const includeValue = () => options?.includeValue ?? true
  const enabled = () => options?.enabled ?? true

  const fetcher = async (): Promise<FreeUsageReport | undefined> => {
    if (!enabled()) return undefined
    return getOpenRouterFreeUsage({ includeValue: includeValue() }, async (opts) => {
      const response = await sdk().client.experimental.openrouterFreeUsage.get(
        {
          includeValue: opts.includeValue ? ("true" as const) : ("false" as const),
          forceRefresh: opts.forceRefresh ? ("true" as const) : undefined,
        },
        { throwOnError: true },
      )
      // Normalize generated numeric strings (NaN/Infinity) to numbers - server returns plain numbers
      return response.data as unknown as FreeUsageReport
    })
  }

  const [data, { refetch }] = createResource(() => {
    // Create a reactive dependency on enabled/includeValue so resource re-fetches when they change
    if (!enabled()) return undefined as unknown as FreeUsageReport | undefined
    void includeValue()
    return fetcher()
  })

  // Polling: 30s heartbeat, paused while hidden, debounced on visibility
  let interval: ReturnType<typeof setInterval> | undefined
  let visibilityTimer: ReturnType<typeof setTimeout> | undefined

  const startPolling = () => {
    if (interval) clearInterval(interval)
    interval = setInterval(() => {
      if (document.hidden) return
      void refetch()
    }, POLL_MS)
  }

  const stopPolling = () => {
    if (interval) {
      clearInterval(interval)
      interval = undefined
    }
  }

  createEffect(() => {
    if (!enabled()) {
      stopPolling()
      return
    }
    startPolling()
    onCleanup(stopPolling)
  })

  const onVisibility = () => {
    if (visibilityTimer) clearTimeout(visibilityTimer)
    if (document.hidden) return
    visibilityTimer = setTimeout(() => {
      void refetch()
    }, VISIBILITY_DEBOUNCE_MS)
  }

  document.addEventListener("visibilitychange", onVisibility)
  window.addEventListener("focus", onVisibility)
  onCleanup(() => {
    document.removeEventListener("visibilitychange", onVisibility)
    window.removeEventListener("focus", onVisibility)
    if (visibilityTimer) clearTimeout(visibilityTimer)
    stopPolling()
  })

  return {
    data,
    refetch,
    loading: () => data.loading,
  }
}
