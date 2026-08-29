import { createResource, onCleanup, type Accessor } from "solid-js"
import type { UsageSummaryResponse } from "@opencode-ai/sdk/v2/client"
import { useServerSDK } from "@/context/server-sdk"

export const USAGE_WINDOWS = [
  { key: "1h", labelKey: "usage.window.1h", ms: 3_600_000, resolution: "hour" },
  { key: "12h", labelKey: "usage.window.12h", ms: 12 * 3_600_000, resolution: "hour" },
  { key: "1d", labelKey: "usage.window.1d", ms: 24 * 3_600_000, resolution: "hour" },
  { key: "7d", labelKey: "usage.window.7d", ms: 7 * 86_400_000, resolution: "day" },
  { key: "14d", labelKey: "usage.window.14d", ms: 14 * 86_400_000, resolution: "day" },
  { key: "30d", labelKey: "usage.window.30d", ms: 30 * 86_400_000, resolution: "day" },
  { key: "90d", labelKey: "usage.window.90d", ms: 90 * 86_400_000, resolution: "day" },
  { key: "all", labelKey: "usage.window.all", ms: 0, resolution: "day" },
] as const

export type UsageWindowDef = (typeof USAGE_WINDOWS)[number]

export const USAGE_WINDOW_MAP = new Map<string, UsageWindowDef>(USAGE_WINDOWS.map((window) => [window.key, window]))

// Client-side memo so switching back to a previously-viewed range (or
// reopening the panel) renders instantly instead of round-tripping the server.
const CLIENT_CACHE_TTL_MS = 30_000
const clientCache = new Map<string, { at: number; data: UsageSummaryResponse }>()

export function createUsageSummary(input: {
  windowDef: Accessor<UsageWindowDef>
  projectID: Accessor<string | null>
  refreshTick: Accessor<number>
}) {
  const serverSDK = useServerSDK()
  let activeController: AbortController | undefined
  const [summary] = createResource(
    () => `${input.windowDef().key}\u0000${input.projectID() ?? ""}\u0000${input.refreshTick()}`,
    async (key) => {
      activeController?.abort()
      const cached = clientCache.get(key)
      if (cached && Date.now() - cached.at < CLIENT_CACHE_TTL_MS) return cached.data
      const controller = new AbortController()
      activeController = controller
      const [windowKey, projectID] = key.split("\u0000")
      const win = USAGE_WINDOW_MAP.get(windowKey) ?? USAGE_WINDOWS[4]
      const now = Date.now()
      const client = serverSDK().client
      // Guard against an SDK/server mismatch (stale sidecar without the usage
      // endpoint): surface a resource error instead of a synchronous
      // "not a function" throw, which would crash the renderer.
      if (!client.usage?.summary) throw new Error("usage.summary endpoint unavailable")
      let response
      try {
        response = await client.usage.summary(
          {
            since: win.ms === 0 ? 0 : now - win.ms,
            until: now,
            resolution: win.resolution,
            projectID: projectID || undefined,
          },
          { throwOnError: true, signal: controller.signal },
        )
      } catch (error) {
        if (controller.signal.aborted) return null
        throw error
      }
      const data = response.data ?? null
      if (data) clientCache.set(key, { at: Date.now(), data })
      if (clientCache.size > 40) clientCache.clear()
      return data
    },
  )
  onCleanup(() => activeController?.abort())
  return summary
}

export type UsageSummaryData = UsageSummaryResponse | null | undefined
