import { createSimpleContext } from "@opencode-ai/ui/context"
import { createResource, onCleanup } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { ForkClient, type ForkServer } from "@/utils/fork-client"

const HEARTBEAT_MS = 60_000
const EVENT_DEBOUNCE_MS = 3_000

/**
 * Single shared realtime OpenCode Go usage controller per server/window.
 *
 * Owns one credentials resource + one usage resource, one heartbeat (paused
 * while the document is hidden), and one SSE listener that refetches local
 * usage a few seconds after a step finishes. Mount once per server — every
 * composer's arc and the credential dialog subscribe instead of running their
 * own polls, so N tabs produce one request per heartbeat instead of N.
 *
 * Version guard: `createResource` refetch only commits the latest in-flight
 * promise (Solid drops stale resolutions in loadEnd), so an interval race can
 * never overwrite a newer mutation-triggered result.
 */
export const { use: useForkUsage, provider: ForkUsageProvider } = createSimpleContext({
  name: "ForkUsage",
  init: (props: { heartbeatMs?: number } = {}) => {
    const serverSDK = useServerSDK()
    const server = (): ForkServer => serverSDK().server.http
    const heartbeatMs = props.heartbeatMs ?? HEARTBEAT_MS

    // SWR-style resources: keep the last value while a refetch is in flight.
    const [credentials, { refetch: refetchCredentials }] = createResource(() => ForkClient.list(server()))
    const [usage, { refetch: refetchUsage }] = createResource(() => ForkClient.usage(server()))

    // SSE: refetch local usage shortly after a step finishes (session.status
    // flips to idle at step-finish), and refresh everything on reconnect.
    // Debounced so bursts of session events collapse into one request.
    let eventTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = () => {
      if (eventTimer !== undefined) clearTimeout(eventTimer)
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        void refetchUsage()
      }, EVENT_DEBOUNCE_MS)
    }
    const unsub = serverSDK().event.listen((e) => {
      const event = e.details
      if (event.type === "server.connected") {
        void refetchCredentials()
        void refetchUsage()
        return
      }
      if (event.type === "session.status") {
        const status = event.properties?.status
        if (status?.type === "idle") scheduleRefresh()
      }
    })

    // Heartbeat for official-limit convergence; paused while hidden.
    const tick = () => {
      if (document.hidden) return
      void refetchUsage()
    }
    const interval = window.setInterval(tick, heartbeatMs)

    const onVisibility = () => {
      if (!document.hidden) void refetchUsage()
    }
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("focus", onVisibility)

    onCleanup(() => {
      if (eventTimer !== undefined) clearTimeout(eventTimer)
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("focus", onVisibility)
      unsub()
    })

    return {
      credentials,
      usage,
      refreshUsage: () => void refetchUsage(),
      refreshAll: () => {
        void refetchCredentials()
        void refetchUsage()
      },
      activeCredentialID: () => credentials.latest?.find((credential) => credential.active)?.id,
    }
  },
})
