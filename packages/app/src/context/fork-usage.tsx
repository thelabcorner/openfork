import { createSimpleContext } from "@opencode-ai/ui/context"
import { createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import type {
  ForkCapacityEstimate,
  ForkCapacityPredictiveRange,
  ForkCapacityResult,
  ForkServer,
  ForkWindowUsage,
} from "@/utils/fork-client"
import { splitModelIDForProvider } from "@/utils/model-account-identity"

const HEARTBEAT_MS = 60_000
const EVENT_DEBOUNCE_MS = 3_000
const CAPACITY_TTL_MS = 2_000

export type CapacityView = {
  status: "ready" | "learning" | "unavailable" | "unlimited"
  estimatedRequests?: number
  remainingPercent?: number
  personalized: boolean
  predictiveRange?: ForkCapacityPredictiveRange
  accountID?: string
  accountLabel?: string
  reason?: string
}
let forkClientRuntime: Promise<typeof import("@/utils/fork-client")> | undefined
const loadForkClientRuntime = () => (forkClientRuntime ??= import("@/utils/fork-client"))

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
    const [armed, setArmed] = createSignal(false)
    onMount(() => {
      const timer = window.setTimeout(() => setArmed(true), 800)
      onCleanup(() => window.clearTimeout(timer))
    })

    const [credentials, { refetch: refetchCredentials }] = createResource(
      () => (armed() ? server() : undefined),
      async (value) => {
        const { ForkClient } = await loadForkClientRuntime()
        return ForkClient.list(value).catch(() => undefined)
      },
      { initialValue: undefined },
    )
    const [usage, { refetch: refetchUsage }] = createResource(
      () => (armed() ? server() : undefined),
      async (value) => {
        const { ForkClient } = await loadForkClientRuntime()
        return ForkClient.usage(value).catch(() => undefined)
      },
      { initialValue: undefined },
    )

    // Request-capacity is deliberately lazy: ordinary quota heartbeats should
    // not fan out across provider quota sources until a capacity consumer exists.
    // Once requested by the model picker, it stays fresh after settled turns and
    // normal heartbeats. Provider adapters own their remote caches/single-flight;
    // OpenCode Go additionally reuses its process-global >=5m official gate.
    const [capacity, setCapacity] = createSignal<ForkCapacityResult>()
    const [capacityLoadedAt, setCapacityLoadedAt] = createSignal(0)
    let capacityPending: Promise<void> | undefined
    const ensureCapacity = (force = false) => {
      if (
        !force &&
        capacityLoadedAt() > 0 &&
        Date.now() - capacityLoadedAt() < CAPACITY_TTL_MS
      )
        return Promise.resolve()
      if (capacityPending) return capacityPending
      capacityPending = loadForkClientRuntime()
        .then(({ ForkClient }) => ForkClient.capacity(server()))
        .then((value) => {
          setCapacity(value)
          setCapacityLoadedAt(Date.now())
        })
        .catch(() => {
          // Older/degraded servers simply expose no capacity projection. Do not
          // fall back to the structurally-wrong universal-dollar estimator.
          setCapacity(undefined)
          setCapacityLoadedAt(Date.now())
        })
        .finally(() => {
          capacityPending = undefined
        })
      return capacityPending
    }

    const routedCapacity = createMemo(() => {
      const map = new Map<string, ForkCapacityEstimate>()
      for (const estimate of capacity()?.routed ?? []) map.set(estimate.modelID, estimate)
      return map
    })
    const accountCapacity = createMemo(() => {
      const map = new Map<string, Map<string, ForkCapacityEstimate>>()
      for (const account of capacity()?.accounts ?? []) {
        map.set(account.accountID, new Map(account.estimates.map((estimate) => [estimate.modelID, estimate])))
      }
      return map
    })
    const providerCapacity = createMemo(() => {
      const map = new Map<string, NonNullable<ForkCapacityResult["providers"]>[number]>()
      for (const provider of capacity()?.providers ?? []) {
        for (const providerID of provider.modelProviderIDs) map.set(providerID, provider)
      }
      return map
    })

    const capacityFor = (providerID: string, modelID: string, accountID?: string): CapacityView | undefined => {
      const id = splitModelIDForProvider(modelID, providerID).baseModelID

      // Preserve the calibrated Go-specific evidence/range while older servers
      // are still in the rolling-compatibility window.
      if (providerID === "opencode-go") {
        const estimate = accountID ? accountCapacity().get(accountID)?.get(id) : routedCapacity().get(id)
        if (!estimate || estimate.projectionStatus === "incomplete-local-accounting") return undefined
        return {
          status: "ready" as const,
          estimatedRequests: estimate.estimatedRequests,
          remainingPercent: estimate.remainingPercent,
          personalized: estimate.personalized,
          predictiveRange: estimate.predictiveRange,
          accountID: estimate.accountID,
        }
      }

      const provider = providerCapacity().get(providerID)
      if (!provider || provider.status !== "ok") return undefined

      const account = accountID
        ? provider.accounts.find((candidate) => candidate.accountID === accountID)
        : undefined
      const estimate = accountID
        ? account?.estimates.find((candidate) => candidate.modelID === id) ?? account?.defaultEstimate
        : provider.estimates.find((candidate) => candidate.modelID === id) ??
          provider.defaultEstimates.find((candidate) => candidate.modelID === id) ??
          provider.defaultEstimates.find((candidate) => candidate.modelID === undefined)

      if (!estimate) return undefined
      return {
        status: estimate.status,
        ...(estimate.estimatedRequests !== null ? { estimatedRequests: estimate.estimatedRequests } : {}),
        ...(estimate.remainingPercent !== null ? { remainingPercent: estimate.remainingPercent } : {}),
        personalized: estimate.personalized,
        ...(estimate.accountID ? { accountID: estimate.accountID } : {}),
        ...(estimate.accountLabel ? { accountLabel: estimate.accountLabel } : {}),
        ...(estimate.reason ? { reason: estimate.reason } : {}),
      }
    }

    // SSE: refetch local usage shortly after a step finishes (session.status
    // flips to idle at step-finish). A normal reconnect is only transport
    // recovery; refresh both resources only when the server marks the reconnect
    // as a repair after a detected stream gap.
    // Debounced so bursts of session events collapse into one request.
    let eventTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = () => {
      if (eventTimer !== undefined) clearTimeout(eventTimer)
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        void refetchUsage()
        if (capacityLoadedAt() > 0) void ensureCapacity(true)
      }, EVENT_DEBOUNCE_MS)
    }
    const unsub = serverSDK().event.listen((e) => {
      const event = e.details
      if (
        event.type === "server.connected" &&
        !!(event.properties as { repair?: boolean } | undefined)?.repair
      ) {
        void refetchCredentials()
        void refetchUsage()
        if (capacityLoadedAt() > 0) void ensureCapacity(true)
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
      if (capacityLoadedAt() > 0) void ensureCapacity(true)
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
      capacity,
      ensureCapacity,
      capacityFor,
      refreshUsage: () => void refetchUsage(),
      refreshAll: () => {
        void refetchCredentials()
        void refetchUsage()
        if (capacityLoadedAt() > 0) void ensureCapacity(true)
      },
      // The actual account a bare opencode-go request routes to. New servers
      // report direct-provider-auth > pool precedence explicitly; old servers
      // fall back to the pool default and then the vault active flag.
      activeCredentialID: () =>
        usage.latest?.routedAccountID ??
        usage.latest?.defaultAccountID ??
        credentials.latest?.find((credential) => credential.active)?.id,
      activeCredentialLabel: () =>
        usage.latest?.routedAccountLabel ??
        usage.latest?.defaultAccountLabel ??
        credentials.latest?.find((credential) => credential.active)?.label,
      // Per-account Go spend windows matched by EITHER the pool account id or
      // the vault UUID (old servers, or a synthesized group built from vault
      // rows before the pool envelope arrived).
      usageWindowsFor: (id?: string): ForkWindowUsage[] => {
        if (!id) return []
        const entry = usage.latest?.byCredential.find((candidate) => candidate.credentialID === id || candidate.accountID === id)
        return entry?.windows ?? []
      },
    }
  },
})
