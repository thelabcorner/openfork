import { createEffect, createResource, createRoot, createSignal, onCleanup, type Accessor, type Resource } from "solid-js"
import { useServerSDK, type ServerSDK } from "@/context/server-sdk"
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
const [activeSubscribers, setActiveSubscribers] = createSignal(0)
let interval: ReturnType<typeof setInterval> | undefined
let visibilityTimer: ReturnType<typeof setTimeout> | undefined
// Account usage belongs to the server, independently of a selected directory.
let sdkClient: Accessor<ServerSDK> | undefined
let stopVisibility: (() => void) | undefined

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
      const resource = createResource(() => activeSubscribers() > 0, fetchShared)
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
  const onVisibility = () => {
    if (visibilityTimer) clearTimeout(visibilityTimer)
    visibilityTimer = undefined
    if (document.hidden) return
    visibilityTimer = setTimeout(() => {
      visibilityTimer = undefined
      if (activeSubscribers() > 0) void refetch()
    }, 2_000)
  }
  document.addEventListener("visibilitychange", onVisibility)
  window.addEventListener("focus", onVisibility)
  stopVisibility = () => {
    document.removeEventListener("visibilitychange", onVisibility)
    window.removeEventListener("focus", onVisibility)
    if (visibilityTimer) clearTimeout(visibilityTimer)
    visibilityTimer = undefined
  }
}

function stopPolling() {
  if (interval) {
    clearInterval(interval)
    interval = undefined
  }
  stopVisibility?.()
  stopVisibility = undefined
}

export function useOpenRouterFreeUsage(options?: { includeValue?: boolean; enabled?: boolean | Accessor<boolean> }) {
  const sdk = useServerSDK()

  const [data, { refetch }] = getShared() as unknown as [Resource<FreeUsageReport | undefined>, { refetch: () => void }]

  createEffect(() => {
    const enabled = typeof options?.enabled === "function" ? options.enabled() : options?.enabled !== false
    if (!enabled) return
    sdkClient = sdk
    setActiveSubscribers((count) => count + 1)
    startPolling(refetch)
    onCleanup(() => {
      setActiveSubscribers((count) => Math.max(0, count - 1))
      if (activeSubscribers() === 0) stopPolling()
    })
  })

  const safeData = () => {
    if (data.state !== "ready" && data.state !== "refreshing") return undefined
    return data.latest
  }

  return {
    data: safeData,
    refetch: () => activeSubscribers() > 0 ? refetch() : undefined,
    refresh: () => {
      clearOpenRouterFreeUsageCache()
      if (activeSubscribers() > 0) void refetch()
    },
    loading: () => data.loading,
  }
}
