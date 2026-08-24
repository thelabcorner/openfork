import { createEffect, createResource, createRoot, onCleanup, type Resource } from "solid-js"
import { useSDK } from "@/context/sdk"
import { clearOpenRouterFreeUsageCache, getOpenRouterFreeUsage, type FreeUsageReport } from "@/utils/openrouter-free-usage"

/**
 * Shared singleton poller for OpenRouter free usage.
 * Every consumer (model dialogs, models/usage panels, context tab, limits
 * pane) subscribes to ONE module-level resource driven by ONE interval —
 * previously each mount ran its own 30s poller and its own cache stream,
 * doubling upstream hits (includeValue=true/false pair firing together).
 * Canonical shape is includeValue=true (superset); lighter consumers just
 * ignore the value fields.
 *
 * Circuit breaker: 3 consecutive empty results pause network attempts for
 * 10 minutes (the util still serves its cached/negative entries). Success
 * resets both counters.
 */

const POLL_MS = 30_000
const FAILURE_THRESHOLD = 3
const BREAKER_MS = 10 * 60_000

let failures = 0
let pausedUntil = 0
let subscribers = 0
let interval: ReturnType<typeof setInterval> | undefined
let visibilityTimer: ReturnType<typeof setTimeout> | undefined
// Set by the first subscriber so the singleton uses the unified directory client.
let sdkClient: (() => any) | undefined

function networkFetch(): Promise<FreeUsageReport> {
  if (!sdkClient) return Promise.reject(new Error("no-sdk"))
  if (Date.now() < pausedUntil) return Promise.reject(new Error("circuit-open"))
  return sdkClient()
    .client.experimental.openrouterFreeUsage.get({ includeValue: "true" as const }, { throwOnError: true })
    .then((response: any) => {
      failures = 0
      pausedUntil = 0
      return response.data as FreeUsageReport
    })
}

async function fetchShared(): Promise<FreeUsageReport | undefined> {
  const report = await getOpenRouterFreeUsage({ includeValue: true }, networkFetch)
  // Undefined here means negative-cached / circuit-open with no stale data:
  // count it so repeated hard failures trip the breaker.
  if (!report && typeof document !== "undefined" && !document.hidden && Date.now() >= pausedUntil) {
    failures += 1
    if (failures >= FAILURE_THRESHOLD) {
      pausedUntil = Date.now() + BREAKER_MS
      failures = 0
    }
  }
  return report
}

// Module-level singleton lives for the whole renderer session; createRoot
// gives its internal effects a stable owner (never disposed in prod).
// Created lazily on first subscriber to avoid an immediate network fetch on
// renderer init (which would race the SDK context and block first paint).
let shared: ReturnType<typeof createResource<FreeUsageReport | undefined>> | undefined
function getShared() {
  if (!shared) {
    shared = createRoot((dispose) => {
      const resource = createResource(fetchShared)
      onCleanup(dispose)
      return resource
    })
  }
  return shared!
}

function startPolling(refetch: () => void) {
  if (interval) return
  interval = setInterval(() => {
    if (document.hidden) return
    if (Date.now() < pausedUntil) return
    void refetch()
  }, POLL_MS)
}

function stopPolling() {
  if (interval) {
    clearInterval(interval)
    interval = undefined
  }
}

export function useOpenRouterFreeUsage(_options?: { includeValue?: boolean; enabled?: boolean }) {
  const sdk = useSDK()
  if (!sdkClient) {
    sdkClient = sdk
    // The module-level resource fires its first fetch at import time, before
    // any SDK context exists — kick an immediate refetch now that one does.
    const [data, { refetch }] = getShared() as unknown as [Resource<FreeUsageReport | undefined>, { refetch: () => void }]
    setTimeout(() => {
      if (subscribers > 0 && data() === undefined && !data.loading && Date.now() >= pausedUntil) void refetch()
    }, 0)
  }

  const [data, { refetch }] = getShared() as unknown as [Resource<FreeUsageReport | undefined>, { refetch: () => void }]

  subscribers += 1
  startPolling(refetch)
  onCleanup(() => {
    subscribers -= 1
    if (subscribers <= 0) stopPolling()
  })

  const onVisibility = () => {
    if (visibilityTimer) clearTimeout(visibilityTimer)
    if (document.hidden) return
    visibilityTimer = setTimeout(() => {
      if (subscribers > 0) void refetch()
    }, 2_000)
  }
  document.addEventListener("visibilitychange", onVisibility)
  window.addEventListener("focus", onVisibility)
  onCleanup(() => {
    document.removeEventListener("visibilitychange", onVisibility)
    window.removeEventListener("focus", onVisibility)
    if (visibilityTimer) clearTimeout(visibilityTimer)
  })

  createEffect(() => {
    void sdk()
  })

  const safeData = () => {
    if (data.state !== "ready" && data.state !== "refreshing") return undefined
    return data.latest
  }

  return {
    data: safeData,
    refetch,
    refresh: () => {
      clearOpenRouterFreeUsageCache()
      void refetch()
    },
    loading: () => data.loading,
  }
}
