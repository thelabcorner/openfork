import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { useServerSDK, type ServerSDK } from "@/context/server-sdk"
import type {
  ForkCapacityEstimate,
  ForkCapacityPredictiveRange,
  ForkCapacityResult,
  ForkCapacityWindowCapacity,
  ForkGeneralUsageModel,
  ForkGeneralUsageSnapshot,
  ForkGeneralUsageWorkload,
  ForkProviderCapacity,
  ForkProviderCapacityEstimate,
  ForkProviderCapacityWindow,
  ForkServer,
  ForkWindowUsage,
} from "@/utils/fork-client"
import { splitModelIDForProvider } from "@/utils/model-account-identity"

const HEARTBEAT_MS = 60_000
const EVENT_DEBOUNCE_MS = 3_000
const CAPACITY_TTL_MS = 2_000

type ForkUsageEventSource = Pick<ServerSDK, "event">

export function createForkUsageEventBinding(
  handlers: {
    repair: () => void
    idle: () => void
  },
) {
  let unsubscribe: (() => void) | undefined

  const set = (sdk: ForkUsageEventSource | undefined) => {
    unsubscribe?.()
    unsubscribe = undefined
    if (!sdk) return
    unsubscribe = sdk.event.listen((e) => {
      const event = e.details
      if (
        event.type === "server.connected" &&
        !!(event.properties as { repair?: boolean } | undefined)?.repair
      ) {
        handlers.repair()
        return
      }
      if (event.type !== "session.status") return
      const status = event.properties?.status
      if (status?.type === "idle") handlers.idle()
    })
  }

  return {
    set,
    dispose() {
      unsubscribe?.()
      unsubscribe = undefined
    },
  }
}

export type CapacityView = {
  status: "ready" | "learning" | "unavailable" | "unlimited"
  estimatedRequests?: number
  remainingPercent?: number
  personalized: boolean
  predictiveRange?: ForkCapacityPredictiveRange
  /**
   * Normalized per-window projection, O(1) off the indexed snapshot. Only
   * present when the owner published at least one window; consumers fall back to
   * `estimatedRequests` as the current 5-hour remaining count when it is absent.
   */
  capacityWindows?: CapacityWindow[]
  accountID?: string
  accountLabel?: string
  reason?: string
}

export type GeneralUsageView = {
  source: "personal-model" | "personal-general" | "standardized-workload-prior"
  personalized: boolean
  workload: ForkGeneralUsageWorkload
  corpusSource: "personal-general" | "standardized-workload-prior"
  corpus: ForkGeneralUsageWorkload[]
  corpusFingerprint: string
  corpusEvidence: {
    observations: number
    requestEffectiveSamples: number
    sessionEffectiveSamples: number
  }
  evidence?: {
    observations: number
    requestEffectiveSamples: number
    sessionEffectiveSamples: number
  }
  observedRequestBand?: {
    requests: number
    lowerContextTokens: number
    upperContextTokens: number
    lowerGenerationTokens: number
    upperGenerationTokens: number
  }
  observedScopeBand?: {
    scopeCount: number
    lowerContextTokens: number
    upperContextTokens: number
    lowerGenerationTokens: number
    upperGenerationTokens: number
  }
}
let forkClientRuntime: Promise<typeof import("@/utils/fork-client")> | undefined
const loadForkClientRuntime = () => (forkClientRuntime ??= import("@/utils/fork-client"))

/**
 * Pure provenance selection for `generalFor`, extracted so the hierarchy is
 * directly testable without mounting the Solid context.
 *
 * Ranking, strictest evidence first:
 *  1. `personal-model` — this exact provider/base-model's own settled requests.
 *     The only source that may be presented as "your usage with this model".
 *  2. `personal-general` — the user's own overall recent requests (the server
 *     only reports this once the profile is mature), repriced through the
 *     target model's pricing by the consumer.
 *  3. `standardized-workload-prior` — the population coding-agent corpus.
 *
 * Deliberately absent: any donor model's mean. A chronological model-disjoint
 * replay rejected cross-model point transfer outright
 * (docs/plans/personalized-request-yield-capacity-ledger.md §22.3), so a
 * workload vector is transferred and repriced, never a mean.
 *
 * Also deliberately absent: any "requests left" field. Inverting money into
 * requests needs a real quota/resource denominator, which Capacity owns.
 */
export function selectGeneralUsage(
  general: ForkGeneralUsageSnapshot | undefined,
  byModel: ReadonlyMap<string, ForkGeneralUsageModel>,
  providerID: string,
  baseModelID: string,
): GeneralUsageView | undefined {
  if (!general) return undefined
  const direct = byModel.get(`${providerID}:${baseModelID}`)
  const bands = {
    ...(general.observedRequestBand ? { observedRequestBand: general.observedRequestBand } : {}),
    ...(general.observedScopeBand ? { observedScopeBand: general.observedScopeBand } : {}),
  }
  if (direct) {
    return {
      source: direct.source,
      personalized: true,
      workload: direct.workload,
      corpusSource: general.source,
      corpus: general.corpus,
      corpusFingerprint: general.fingerprint,
      corpusEvidence: general.evidence,
      evidence: direct.evidence,
      ...bands,
    }
  }
  // No direct per-model scope. A mature personal-general profile describes the
  // user's own recent requests and strictly dominates the population prior;
  // an immature profile must fall back to the standardized corpus median.
  const source = general.source
  return {
    source,
    personalized: source === "personal-general",
    workload: source === "personal-general" ? general.typical : general.fallback,
    corpusSource: general.source,
    corpus: general.corpus,
    corpusFingerprint: general.fingerprint,
    corpusEvidence: general.evidence,
    ...(source === "personal-general" ? { evidence: general.evidence } : {}),
    ...bands,
  }
}

/**
 * One renderer-friendly window, normalized at the transport boundary.
 *
 * `pointRequests` and `remaining` are deliberately independent: a window can
 * know its total without knowing what is left in it (Go's personalized-total rows),
 * or know what is left without publishing a total (most providers' observed-
 * remaining rows). A consumer must never fill one from the other — a remainder is
 * not a total, and a total is not a remainder.
 */
export type CapacityWindow = {
  /** Stable window key; also the display label the owner published. */
  id: string
  label: string
  /** Full-window TOTAL capacity. Absent means "no authoritative total". */
  pointRequests?: number
  /** Requests left in the CURRENT window. Absent means unknown, never zero. */
  remaining?: {
    remainingRequests?: number | null
    remainingPercent?: number
    resetAt?: number
    status: "ready" | "unavailable"
  }
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

/**
 * Normalize ONE wire window row.
 *
 * The generic provider projection reuses a single `estimatedRequests` field for
 * two different quantities and disambiguates them with `basis`. Reading that
 * field without honoring `basis` would silently turn a remainder into an
 * authoritative window total, and every downstream band would then be drawn
 * around a number that does not mean capacity.
 */
export function normalizeCapacityWindow(window: ForkProviderCapacityWindow): CapacityWindow | undefined {
  const id = window.id?.trim()
  if (!id) return undefined
  const count = finite(window.estimatedRequests) ? window.estimatedRequests : undefined
  const percent = finite(window.remainingPercent) ? window.remainingPercent : undefined
  const isTotal = window.basis === "personalized-total-capacity"
  const observed = window.basis === "observed-remaining"
  // Only an explicitly total-basis row may carry a point. On observed-remaining
  // the same field is a remainder and must never reach a capacity band.
  const pointRequests = isTotal ? count : undefined
  const remainder =
    observed && (count !== undefined || percent !== undefined)
      ? {
          ...(count !== undefined ? { remainingRequests: count } : {}),
          ...(percent !== undefined ? { remainingPercent: percent } : {}),
          ...(finite(window.resetAt) ? { resetAt: window.resetAt } : {}),
          status: window.status === "unavailable" ? ("unavailable" as const) : ("ready" as const),
        }
      : undefined
  // A row that says nothing about either quantity is noise, not a window.
  if (pointRequests === undefined && remainder === undefined) return undefined
  return {
    id,
    label: window.label?.trim() || id,
    ...(pointRequests !== undefined ? { pointRequests } : {}),
    ...(remainder ? { remaining: remainder } : {}),
  }
}

/**
 * Normalize a whole window list, merging defensively by id.
 *
 * Two different projections can legitimately publish the same window (Go's own
 * list plus the generalized provider view). Merging keeps whichever side knows
 * MORE: a total from either, an observed remainder from either, never a blend.
 */
export function normalizeCapacityWindows(
  sources: ReadonlyArray<readonly CapacityWindow[] | null | undefined> | null | undefined,
): CapacityWindow[] {
  const byId = new Map<string, CapacityWindow>()
  for (const source of sources ?? []) {
    for (const window of source ?? []) {
      const existing = byId.get(window.id)
      if (!existing) {
        byId.set(window.id, window)
        continue
      }
      byId.set(window.id, {
        ...existing,
        ...(window.pointRequests !== undefined || existing.pointRequests === undefined
          ? { pointRequests: window.pointRequests ?? existing.pointRequests }
          : {}),
        ...(window.remaining ?? existing.remaining ? { remaining: window.remaining ?? existing.remaining } : {}),
      })
    }
  }
  return [...byId.values()]
}

/** Map the Go estimate's own window list onto the normalized shape. */
export function normalizeGoCapacityWindows(
  windows: readonly ForkCapacityWindowCapacity[] | null | undefined,
): CapacityWindow[] {
  const result: CapacityWindow[] = []
  for (const window of windows ?? []) {
    const id = window?.window?.trim()
    if (!id) continue
    const point = finite(window.pointRequests) && window.pointRequests > 0 ? window.pointRequests : undefined
    const observed = window.remaining
      ? {
          ...(window.remaining.remainingRequests !== null ? { remainingRequests: window.remaining.remainingRequests } : {}),
          ...(finite(window.remaining.remainingPercent) ? { remainingPercent: window.remaining.remainingPercent } : {}),
          ...(finite(window.remaining.resetAt) ? { resetAt: window.remaining.resetAt } : {}),
          status: window.remaining.status === "unavailable" ? ("unavailable" as const) : ("ready" as const),
        }
      : undefined
    if (point === undefined && observed === undefined) continue
    result.push({
      id,
      label: id,
      ...(point !== undefined ? { pointRequests: point } : {}),
      ...(observed ? { remaining: observed } : {}),
    })
  }
  return result
}

/** Map a generic provider estimate's bounded window list onto the normalized shape. */
export function normalizeProviderCapacityWindows(
  windows: readonly ForkProviderCapacityWindow[] | null | undefined,
): CapacityWindow[] {
  const result: CapacityWindow[] = []
  for (const window of windows ?? []) {
    const normalized = normalizeCapacityWindow(window)
    if (normalized) result.push(normalized)
  }
  return result
}

export type IndexedProviderCapacityAccount = {
  estimates: Map<string, ForkProviderCapacityEstimate>
  defaultEstimate?: ForkProviderCapacityEstimate
}

export type IndexedProviderCapacity = {
  status: ForkProviderCapacity["status"]
  estimates: Map<string, ForkProviderCapacityEstimate>
  defaultEstimates: Map<string, ForkProviderCapacityEstimate>
  defaultEstimate?: ForkProviderCapacityEstimate
  accounts: Map<string, IndexedProviderCapacityAccount>
}

const INCOMPLETE_ACCOUNTING_REASON =
  "Local post-snapshot resource consumption could not be normalized safely."

/**
 * Project one Go estimate onto the renderer view.
 *
 * The window list is normalized BEFORE the incomplete-accounting branch on
 * purpose. A full-window TOTAL comes from the published window limit and the
 * personal request-size posterior; neither depends on the local spend
 * settlement, and the server projection says so explicitly when it builds the
 * rows. Incomplete local accounting invalidates the *remaining fraction* only.
 * Returning early there would discard the one capacity answer that is still
 * trustworthy — and would do so for exactly the accounts whose quota state is
 * most worth checking.
 */
export function goCapacityView(estimate: ForkCapacityEstimate): CapacityView {
  const windows = normalizeGoCapacityWindows(estimate.windowCapacity)
  const projection = windows.length > 0 ? { capacityWindows: windows } : {}
  if (estimate.projectionStatus === "incomplete-local-accounting") {
    // The remaining REQUEST COUNT is what fails closed, so there is deliberately
    // no `estimatedRequests` here. The upstream percentage is real telemetry and
    // survives; the reason explains why the count is missing.
    return {
      status: "unavailable",
      remainingPercent: estimate.remainingPercent,
      personalized: estimate.personalized,
      ...projection,
      ...(estimate.accountID ? { accountID: estimate.accountID } : {}),
      reason: INCOMPLETE_ACCOUNTING_REASON,
    }
  }
  return {
    status: "ready",
    estimatedRequests: estimate.estimatedRequests,
    remainingPercent: estimate.remainingPercent,
    personalized: estimate.personalized,
    predictiveRange: estimate.predictiveRange,
    ...projection,
    ...(estimate.accountID ? { accountID: estimate.accountID } : {}),
  }
}

/**
 * Build the O(1) provider-capacity lookup for one Capacity snapshot.
 *
 * Exact quota-provider identity is authoritative: a key is claimed by
 * `quotaProviderID` unconditionally, and an exact claim always replaces an
 * alias a previously indexed provider parked on the same key. `modelProviderIDs`
 * are fallback routing hints only — they fill keys that are still unclaimed, so
 * provider array order cannot change which provider owns a key.
 *
 * One indexed object per provider is shared by every key it claims (exact plus
 * aliases), so a dense model row pays a single map hit and never rebuilds
 * account/estimate maps.
 */
export function indexProviderCapacity(
  providers: readonly ForkProviderCapacity[] | undefined,
): Map<string, IndexedProviderCapacity> {
  const map = new Map<string, IndexedProviderCapacity>()
  for (const provider of providers ?? []) {
    const estimates = new Map<string, ForkProviderCapacityEstimate>()
    for (const estimate of provider.estimates) if (estimate.modelID) estimates.set(estimate.modelID, estimate)
    const defaultEstimates = new Map<string, ForkProviderCapacityEstimate>()
    let defaultEstimate: ForkProviderCapacityEstimate | undefined
    for (const estimate of provider.defaultEstimates) {
      if (estimate.modelID) defaultEstimates.set(estimate.modelID, estimate)
      else defaultEstimate = estimate
    }
    const accounts = new Map<string, IndexedProviderCapacityAccount>()
    for (const account of provider.accounts) {
      const accountEstimates = new Map<string, ForkProviderCapacityEstimate>()
      for (const estimate of account.estimates) {
        if (estimate.modelID) accountEstimates.set(estimate.modelID, estimate)
      }
      accounts.set(account.accountID, {
        estimates: accountEstimates,
        defaultEstimate: account.defaultEstimate,
      })
    }
    const indexed: IndexedProviderCapacity = {
      status: provider.status,
      estimates,
      defaultEstimates,
      ...(defaultEstimate ? { defaultEstimate } : {}),
      accounts,
    }
    map.set(provider.quotaProviderID, indexed)
    for (const providerID of provider.modelProviderIDs) {
      if (!map.has(providerID)) map.set(providerID, indexed)
    }
  }
  return map
}

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
    // ServerSDK is a reactive accessor and may briefly be unresolved across
    // HMR/server retargeting. Keep this quota sidecar non-fatal during that
    // transition; resources simply pause until the SDK resolves again.
    const currentServerSDK = () => serverSDK() as ServerSDK | undefined
    const server = (): ForkServer | undefined => currentServerSDK()?.server.http
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
    // Generalized workload is a separate fast local-only projection. Keeping it
    // independent from Capacity means the model picker does not wait on remote
    // provider quota fan-out before it can show useful cold-start economics.
    const [generalUsage, setGeneralUsage] = createSignal<ForkGeneralUsageSnapshot>()
    const [generalUsageLoadedAt, setGeneralUsageLoadedAt] = createSignal(0)
    let generalUsageUnsupportedServer: string | undefined
    let generalUsagePending: Promise<void> | undefined
    const ensureGeneralUsage = (force = false) => {
      const currentServer = server()
      if (!currentServer) return Promise.resolve()
      if (generalUsageUnsupportedServer === currentServer.url) return Promise.resolve()
      if (
        !force &&
        generalUsageLoadedAt() > 0 &&
        Date.now() - generalUsageLoadedAt() < CAPACITY_TTL_MS
      )
        return Promise.resolve()
      if (generalUsagePending) return generalUsagePending
      generalUsagePending = loadForkClientRuntime()
        .then(({ ForkClient }) => ForkClient.generalUsage(currentServer))
        .then((value) => {
          setGeneralUsage(value)
          setGeneralUsageLoadedAt(Date.now())
        })
        .catch((error: unknown) => {
          // Rolling compatibility: an older server has no fast endpoint. The
          // full Capacity response still carries the additive projection.
          const status =
            error && typeof error === "object" && "status" in error
              ? Number((error as { status?: unknown }).status)
              : undefined
          if (status === 404 || status === 410) generalUsageUnsupportedServer = currentServer.url
          setGeneralUsageLoadedAt(Date.now())
        })
        .finally(() => {
          generalUsagePending = undefined
        })
      return generalUsagePending
    }
    let capacityPending: Promise<void> | undefined
    const ensureCapacity = (force = false) => {
      const currentServer = server()
      if (!currentServer) return Promise.resolve()
      if (
        !force &&
        capacityLoadedAt() > 0 &&
        Date.now() - capacityLoadedAt() < CAPACITY_TTL_MS
      )
        return Promise.resolve()
      if (capacityPending) return capacityPending
      capacityPending = loadForkClientRuntime()
        .then(({ ForkClient }) => ForkClient.capacity(currentServer))
        .then((value) => {
          setCapacity(value)
          if (value.generalUsage) setGeneralUsage(value.generalUsage)
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
    const providerCapacity = createMemo(() => indexProviderCapacity(capacity()?.providers))
    const generalSnapshot = () => generalUsage() ?? capacity()?.generalUsage
    const generalUsageByModel = createMemo(() => {
      const map = new Map<string, NonNullable<ForkCapacityResult["generalUsage"]>["models"][number]>()
      for (const estimate of generalSnapshot()?.models ?? []) {
        map.set(`${estimate.providerID}:${estimate.modelID}`, estimate)
      }
      return map
    })
    // Materialize stable view objects once per Capacity snapshot. Dense model
    // rows then get an O(1) map hit without allocating a new provenance object
    // on every `generalFor()` call.
    const generalUsageViews = createMemo(() => {
      const general = generalSnapshot()
      const views = new Map<string, GeneralUsageView>()
      if (!general) return { views, fallback: undefined as GeneralUsageView | undefined }
      const raw = generalUsageByModel()
      for (const estimate of general.models) {
        const view = selectGeneralUsage(general, raw, estimate.providerID, estimate.modelID)
        if (view) views.set(`${estimate.providerID}:${estimate.modelID}`, view)
      }
      // Deliberately use an impossible catalog identity so this selects only
      // the mature personal-general / standardized fallback branch.
      const fallback = selectGeneralUsage(general, raw, "\u0000", "\u0000")
      return { views, fallback }
    })

    const capacityFor = (providerID: string, modelID: string, accountID?: string): CapacityView | undefined => {
      const id = splitModelIDForProvider(modelID, providerID).baseModelID

      // Preserve the calibrated Go-specific evidence/range while older servers
      // are still in the rolling-compatibility window.
      if (providerID === "opencode-go") {
        const estimate = accountID ? accountCapacity().get(accountID)?.get(id) : routedCapacity().get(id)
        return estimate ? goCapacityView(estimate) : undefined
      }

      const provider = providerCapacity().get(providerID)
      if (!provider || provider.status !== "ok") return undefined

      const account = accountID ? provider.accounts.get(accountID) : undefined
      const estimate = accountID
        ? account?.estimates.get(id) ?? account?.defaultEstimate
        : provider.estimates.get(id) ?? provider.defaultEstimates.get(id) ?? provider.defaultEstimate

      if (!estimate) return undefined
      const capacityWindows = normalizeCapacityWindows([
        normalizeProviderCapacityWindows(estimate.windows),
        normalizeProviderCapacityWindows(account?.defaultEstimate?.windows),
      ])
      return {
        status: estimate.status,
        ...(estimate.estimatedRequests !== null ? { estimatedRequests: estimate.estimatedRequests } : {}),
        ...(estimate.remainingPercent !== null ? { remainingPercent: estimate.remainingPercent } : {}),
        personalized: estimate.personalized,
        ...(capacityWindows.length > 0 ? { capacityWindows } : {}),
        ...(estimate.accountID ? { accountID: estimate.accountID } : {}),
        ...(estimate.accountLabel ? { accountLabel: estimate.accountLabel } : {}),
        ...(estimate.reason ? { reason: estimate.reason } : {}),
      }
    }

    const generalFor = (providerID: string, modelID: string): GeneralUsageView | undefined => {
      const id = splitModelIDForProvider(modelID, providerID).baseModelID
      const materialized = generalUsageViews()
      return materialized.views.get(`${providerID}:${id}`) ?? materialized.fallback
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
        if (generalUsageLoadedAt() > 0) {
          void ensureGeneralUsage(true).finally(() => {
            if (capacityLoadedAt() > 0) void ensureCapacity(true)
          })
        } else if (capacityLoadedAt() > 0) void ensureCapacity(true)
      }, EVENT_DEBOUNCE_MS)
    }
    const eventBinding = createForkUsageEventBinding({
      repair: () => {
        void refetchCredentials()
        void refetchUsage()
        if (generalUsageLoadedAt() > 0) {
          void ensureGeneralUsage(true).finally(() => {
            if (capacityLoadedAt() > 0) void ensureCapacity(true)
          })
        } else if (capacityLoadedAt() > 0) void ensureCapacity(true)
      },
      idle: scheduleRefresh,
    })
    createEffect(() => eventBinding.set(currentServerSDK()))

    // Heartbeat for official-limit convergence; paused while hidden.
    const tick = () => {
      if (document.hidden) return
      void refetchUsage()
      if (generalUsageLoadedAt() > 0) {
        void ensureGeneralUsage(true).finally(() => {
          if (capacityLoadedAt() > 0) void ensureCapacity(true)
        })
      } else if (capacityLoadedAt() > 0) void ensureCapacity(true)
    }
    const interval = window.setInterval(tick, heartbeatMs)

    const onVisibility = () => {
      if (!document.hidden) tick()
    }
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("focus", onVisibility)

    onCleanup(() => {
      if (eventTimer !== undefined) clearTimeout(eventTimer)
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("focus", onVisibility)
      eventBinding.dispose()
    })

    return {
      credentials,
      usage,
      capacity,
      generalUsage,
      ensureCapacity,
      ensureGeneralUsage,
      capacityFor,
      generalFor,
      refreshUsage: () => void refetchUsage(),
      refreshAll: () => {
        void refetchCredentials()
        void refetchUsage()
        if (generalUsageLoadedAt() > 0) {
          void ensureGeneralUsage(true).finally(() => {
            if (capacityLoadedAt() > 0) void ensureCapacity(true)
          })
        } else if (capacityLoadedAt() > 0) void ensureCapacity(true)
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
