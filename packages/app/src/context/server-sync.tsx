import type {
  AgentConfig,
  Config,
  OpencodeClient,
  Path,
  Project,
  ProviderAuthResponse,
  Session,
  SessionStatus,
} from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { type Accessor, batch, createMemo, createSignal, getOwner, onCleanup, onMount, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { InitError } from "../pages/error"
import { ServerSDK, type ServerEvent } from "./server-sdk"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  clearProviderRev,
  loadAgentsQuery,
  loadCommands,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
  loadReferencesQuery,
} from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent, applyGlobalEvent } from "./global-sync/event-reducer"
import { reconcilePendingBySession } from "./global-sync/pending-response-snapshot"
import { createPendingResponseRepairOwner } from "./global-sync/pending-response-repair"
import { createProviderCatalogRefresh, providerCatalogQueryMatches, providerCatalogRevision } from "./global-sync/provider-catalog-events"
import {
  estimateRootSessionTotal,
  loadRootSessions,
  loadRootSessionsFast,
  loadRootSessionsV1,
  rootSessionFastPathUnavailable,
} from "./global-sync/session-load"
import { trimSessions } from "./global-sync/session-trim"
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { formatServerError, isCancelledRequestError, sessionNotFoundError } from "@/utils/server-errors"
import { normalizeSessionInfo } from "@/utils/session"
import { safeQueryData } from "@/utils/safe-query-data"
import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
import type { SolidQueryOptions } from "@tanstack/solid-query"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey } from "./global-sync/utils"
import { pathKey, PathKey } from "@/utils/path-key"
import {
  rootSessionProjectID,
  sessionEventIndexDirectories,
  sessionIndexDirectory,
} from "./global-sync/session-project-index"
import { createDirSyncContext } from "./directory-sync"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import type { ServerScope } from "@/utils/server-scope"
import { createHomeSessionIndexCache, homeSessionIndexRefreshRelevant } from "./global-sync/home-session-index"
import { persisted } from "@/utils/persist"
import type { ServerApi } from "@/utils/server"
import type {
  McpListInput,
  McpListOutput,
  McpResource,
  McpResourceCatalogInput,
  McpResourceCatalogOutput,
  McpServer,
  SessionActiveOutput,
} from "@opencode-ai/client/promise"
import { toggleMcp } from "./global-sync/mcp"
import { createServerSession, type ServerSession } from "./server-session"
import { applySessionActivityRepair, shouldApplyTelemetrySnapshot } from "./session-activity-repair"
import { perf } from "./perf"
import { phaseTrace } from "./phase-trace"
import type { ServerRequestPriority, ServerRequestScheduler } from "@/utils/server-request-scheduler"
import { sessionTelemetryClientNow } from "@/utils/session-telemetry-time"
import type { Info as SessionTelemetryInfo } from "@opencode-ai/schema/session-telemetry"

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  /** Compact global observability projection; never owns message/part content. */
  telemetry: Record<string, SessionTelemetryInfo | undefined>
  reload: undefined | "pending" | "complete"
}

export { rootSessionProjectID, sessionEventIndexDirectories, sessionIndexDirectory } from "./global-sync/session-project-index"

type McpListApi = {
  readonly list: (input?: McpListInput) => Promise<McpListOutput>
}

type McpResourceApi = {
  readonly resource: {
    readonly catalog: (input?: McpResourceCatalogInput) => Promise<McpResourceCatalogOutput>
  }
}

type ApiQueryOptions<T, K extends readonly unknown[]> = SolidQueryOptions<T, Error, T, K> & {
  initialData?: undefined
  queryKey: K
}

// Native session events already have a dedicated reducer. Feeding their adapted
// payload through the legacy reducer as well only repeats session-ID lookup and
// store bookkeeping; for stream deltas it also makes every token pay that cost
// before the directory event reducer sees it. The reducer is intentionally
// bilingual: it accepts both the older `session.*` compatibility family and the
// current `session.next.*` native schema.
const isNativeSessionEvent = (type: string | undefined) => {
  if (!type) return false
  if (type.startsWith("session.next.")) return true
  return (
    type.startsWith("session.input.") ||
    type.startsWith("session.text.") ||
    type.startsWith("session.reasoning.") ||
    type.startsWith("session.tool.") ||
    type.startsWith("session.shell.") ||
    type.startsWith("session.step.") ||
    type.startsWith("session.compaction.") ||
    type === "session.agent.selected" ||
    type === "session.model.selected" ||
    type === "session.synthetic" ||
    type === "session.skill.activated" ||
    type === "session.retry.scheduled" ||
    type.startsWith("session.execution.") ||
    type === "session.renamed" ||
    type === "session.moved" ||
    type === "session.usage.updated" ||
    type === "session.forked" ||
    type.startsWith("session.revert.")
  )
}
const isNativeStreamDelta = (type: string | undefined) =>
  type === "session.text.delta" ||
  type === "session.reasoning.delta" ||
  type === "session.tool.input.delta" ||
  type === "session.compaction.delta" ||
  type === "session.next.text.delta" ||
  type === "session.next.reasoning.delta" ||
  type === "session.next.tool.input.delta" ||
  type === "session.next.compaction.delta"

type SessionActiveApi = {
  readonly active: () => Promise<SessionActiveOutput>
}

export function telemetryStatusTransition(input: {
  previous: SessionTelemetryInfo["phase"] | undefined
  next: SessionTelemetryInfo["phase"]
  statusWorking: boolean
  paused: boolean
}): "busy" | "idle" | undefined {
  const wasActive = input.previous !== undefined && input.previous !== "idle"
  const isActive = input.next !== "idle"
  if (isActive) return !input.statusWorking && !input.paused ? "busy" : undefined
  // An initial settled/idle snapshot must not erase a real pre-provider busy
  // status. Only a live -> idle telemetry edge owns status reconciliation.
  return wasActive ? "idle" : undefined
}

export const loadMcpQuery = (
  scope: ServerScope,
  directory: string,
  api: McpListApi,
  legacy?: OpencodeClient,
  protocol?: Promise<"v1" | "v2">,
  requests?: ServerRequestScheduler,
): ApiQueryOptions<Record<string, McpServer["status"]>, readonly [ServerScope, string, "mcp"]> =>
  queryOptions<
    Record<string, McpServer["status"]>,
    Error,
    Record<string, McpServer["status"]>,
    readonly [ServerScope, string, "mcp"]
  >({
    queryKey: [scope, directoryKey(directory), "mcp"] as const,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async () => {
      if ((await protocol) === "v1" && legacy)
        return requests
          ? requests.schedule("background", () => legacy.mcp.status(), { kind: "mcp-list" }).then((result) => result.data ?? {})
          : (await legacy.mcp.status()).data ?? {}
      const request = () => api.list({ location: { directory } })
      return (requests ? requests.schedule("background", request, { kind: "mcp-list" }) : request())
        .then((result) => Object.fromEntries(result.data.map((server) => [server.name, server.status])))
    },
  })

export const loadMcpResourcesQuery = (
  scope: ServerScope,
  directory: string,
  api: McpResourceApi,
  legacy?: OpencodeClient,
  protocol?: Promise<"v1" | "v2">,
  requests?: ServerRequestScheduler,
): ApiQueryOptions<Record<string, McpResource>, readonly [ServerScope, string, "mcpResources"]> =>
  queryOptions<
    Record<string, McpResource>,
    Error,
    Record<string, McpResource>,
    readonly [ServerScope, string, "mcpResources"]
  >({
    queryKey: [scope, directoryKey(directory), "mcpResources"] as const,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async () => {
      if ((await protocol) === "v1" && legacy) {
        const response = requests
          ? await requests.schedule("background", () => legacy.experimental.resource.list(), { kind: "mcp-resources" })
          : await legacy.experimental.resource.list()
        return Object.fromEntries(
          Object.entries(response.data ?? {}).map(([key, resource]) => [
            key,
            { ...resource, server: resource.client },
          ]),
        )
      }
      const request = () => api.resource.catalog({ location: { directory } })
      return (requests ? requests.schedule("background", request, { kind: "mcp-resources" }) : request())
        .then((result) =>
          Object.fromEntries(result.data.resources.map((resource) => [`${resource.server}:${resource.uri}`, resource])),
        )
    },
    placeholderData: {},
  })

export const loadLspQuery = (
  scope: ServerScope,
  directory: string,
  sdk: OpencodeClient,
  requests?: ServerRequestScheduler,
) =>
  queryOptions({
    queryKey: [scope, directoryKey(directory), "lsp"] as const,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: () => {
      const request = () => sdk.lsp.status()
      return (requests ? requests.schedule("background", request, { kind: "lsp-status" }) : request()).then((r) => r.data ?? [])
    },
  })

export const loadActiveSessionsQuery = (
  scope: ServerScope,
  api: SessionActiveApi,
  session: Pick<ServerSession, "data" | "set">,
  requests?: ServerRequestScheduler,
): ApiQueryOptions<SessionActiveOutput, readonly [ServerScope, "activeSessions"]> =>
  queryOptions<SessionActiveOutput, Error, SessionActiveOutput, readonly [ServerScope, "activeSessions"]>({
    queryKey: [scope, "activeSessions"] as const,
    queryFn: async () => {
      const active = requests
        ? await requests.schedule("interactive", () => api.active(), { kind: "session-active" })
        : await api.active()
      seedActiveSessionStatuses(session, active)
      return active
    },
    enabled: true,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })

export function seedActiveSessionStatuses(
  session: Pick<ServerSession, "data" | "set">,
  active: SessionActiveOutput | Record<string, SessionStatus>,
) {
  for (const sessionID of Object.keys(active)) {
    if (session.data.session_status[sessionID] !== undefined) continue
    const status = normalizeActiveSessionStatus(active[sessionID])
    if (status) session.set("session_status", sessionID, status)
  }
}

/**
 * Serializes the expensive auxiliary bootstrap wave across directories while
 * leaving each admitted directory free to use its own bounded internal
 * concurrency. The server coalesces same-directory requests behind one
 * Instance initialization; overlapping *different* directories is the costly
 * case because each can independently load config/plugins/LSP state.
 */
export function createDirectoryBootstrapGate() {
  let tail: Promise<void> = Promise.resolve()
  let queued = 0
  let active = 0
  let maxActive = 0

  const run = <T,>(work: () => Promise<T>): Promise<T> => {
    queued += 1
    const result = tail.then(async () => {
      queued -= 1
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        return await work()
      } finally {
        active -= 1
      }
    })
    // A failed metadata wave must never poison the queue behind it.
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  return {
    run,
    snapshot: () => ({ active, queued, maxActive }),
  }
}

function normalizeActiveSessionStatus(status: SessionActiveOutput[string] | SessionStatus | undefined): SessionStatus | undefined {
  const type = (status as { type?: string } | undefined)?.type
  if (type === "running") return { type: "busy" }
  if (type === "paused") return { type: "idle" }
  return status as SessionStatus | undefined
}

function makeQueryOptionsApi(
  scope: ServerScope,
  serverSDK: () => OpencodeClient,
  serverAPI: ServerApi,
  sdkFor: (dir: PathKey) => OpencodeClient,
  protocol: Promise<"v1" | "v2">,
  requests: ServerRequestScheduler,
) {
  return {
    globalConfig: () => loadGlobalConfigQuery(scope, serverSDK(), protocol, requests, "interactive"),
    projects: () => loadProjectsQuery(scope, serverAPI.project, requests, "interactive", serverSDK()),
    providers: (directory: PathKey | null) =>
      loadProvidersQuery(
        scope,
        directory,
        serverAPI,
        directory ? sdkFor(directory) : serverSDK(),
        protocol,
        requests,
        "background",
      ),
    path: (directory: PathKey | null) =>
      loadPathQuery(scope, directory, directory ? sdkFor(directory) : serverSDK(), protocol, requests, "interactive"),
    agents: (directory: PathKey) =>
      loadAgentsQuery(scope, directory, serverAPI.agent, sdkFor(directory), protocol, requests, "background"),
    references: (directory: PathKey) =>
      loadReferencesQuery(scope, directory, serverAPI.reference, sdkFor(directory), protocol, requests, "background"),
    mcp: (directory: PathKey) => loadMcpQuery(scope, directory, serverAPI.mcp, sdkFor(directory), protocol, requests),
    mcpResources: (directory: PathKey) =>
      loadMcpResourcesQuery(scope, directory, serverAPI.mcp, sdkFor(directory), protocol, requests),
    lsp: (directory: PathKey) => loadLspQuery(scope, directory, sdkFor(directory), requests),
    sessions: (directory: PathKey) => ({ queryKey: [scope, directory, "loadSessions"] as const }),
    // No tool-def query is registered today (tool calls render from streamed ToolParts), but the
    // query key is the contract `tool.reloaded` invalidates so a future /experimental/tool fetch
    // returns fresh data (tool-hot-reload §3.4).
    tools: (directory: PathKey) => ({ queryKey: [scope, directory, "loadTools"] as const }),
  }
}
export type QueryOptionsApi = ReturnType<typeof makeQueryOptionsApi>

export function createServerSyncContextInner(serverSDK: ServerSDK) {
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("ServerSync must be created within owner")

  const sdkCache = new Map<string, OpencodeClient>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number; projectID?: string }>()
  const staleSessionLists = new Map<string, number>()
  const sessionProjectScope = new Map<string, string>()
  const directoryBootstrapGate = createDirectoryBootstrapGate()

  const sdkFor = (directory: string) => {
    const key = directoryKey(directory)
    const cached = sdkCache.get(key)
    if (cached) return cached
    const sdk = serverSDK.createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(key, sdk)
    return sdk
  }

  const session = createServerSession(serverSDK.client, serverSDK.api.session, serverSDK.api.message, {
    protocol: serverSDK.protocol,
    requests: serverSDK.requests,
    getSessionInfo: async (sessionID) => {
      try {
        const result = await serverSDK.client.global.sessionGet({ sessionID })
        if (!result.data) throw sessionNotFoundError(sessionID)
        return normalizeSessionInfo(result.data)
      } catch (error) {
        // Session info is Tier 1 metadata. Keep it on the global, bootstrap-free
        // route whenever supported; old sidecars may only expose the
        // instance-scoped compatibility route.
        if (!rootSessionFastPathUnavailable(error)) throw error
        return serverSDK.api.session.get({ sessionID }).then(normalizeSessionInfo)
      }
    },
    onStreamInterestChanged: serverSDK.event.setStreamContentSessions,
  })
  // Push the foreground-content gate up to the SSE reader. The session store is
  // still the authority: rejecting a cached background delta marks that session
  // stale so resume()/sync() repairs exactly what was skipped.
  const releaseStreamContentInterest = serverSDK.event.setStreamContentInterest(
    session.acceptStreamContent,
    session.invalidateStreamContent,
  )
  onCleanup(releaseStreamContentInterest)
  const queryOptionsApi = makeQueryOptionsApi(
    serverSDK.scope,
    () => serverSDK.client,
    serverSDK.api,
    sdkFor,
    serverSDK.protocol,
    serverSDK.requests,
  )

  const [catalogEnabled, setCatalogEnabled] = createSignal(false)
  const ensureProviderCatalog = () => {
    if (catalogEnabled()) return
    setCatalogEnabled(true)
  }
  const [configQuery, providerQuery, pathQuery] = useQueries(() => ({
    queries: [
      queryOptionsApi.globalConfig(),
      { ...queryOptionsApi.providers(null), enabled: catalogEnabled() },
      queryOptionsApi.path(null),
    ],
  }))
  const activeSessionsQuery = useQuery(() =>
    loadActiveSessionsQuery(
      serverSDK.scope,
      { active: () => serverSDK.api.session.active() },
      session,
      serverSDK.requests,
    ),
  )

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    get ready() {
      return !bootstrap.isPending
    },
    project: [],
    provider_auth: {},
    telemetry: {},
    // JSDOC: Suspension-safe query getters (route-level black-screen fix).
    // `@tanstack/solid-query` uses an internal `createResource()` per query.
    // Reading `.data` while the resource is unresolved (isPending true)
    // parks the Suspense boundary. Check `isPending` first; only then
    // access `.data`, with a safe default (`?? EMPTY` / `?? {}`).
    get path() {
      const EMPTY = { state: "", config: "", worktree: "", directory: "", home: "" }
      return safeQueryData(pathQuery, EMPTY)
    },
    get provider() {
      const EMPTY = { all: new Map(), connected: [], default: {} }
      return safeQueryData(providerQuery, EMPTY)
    },
    get config() {
      return safeQueryData(configQuery, {})
    },
    get reload() {
      return updateConfigMutation.isPending ? "pending" : undefined
    },
  })

  const queryClient = useQueryClient()
  const homeSessions = createHomeSessionIndexCache(queryClient, ServerConnection.key(serverSDK.server))

  // One bootstrap request for every newly visible session ID, coalesced across
  // rows/groups into batches. This deliberately is not a query per row: dense
  // sidebars should own one telemetry transport and expose O(1) lookups.
  const telemetryKnown = new Set<string>()
  const telemetryPending = new Set<string>()
  // Local monotonic receipt anchors are deliberately kept out of the wire
  // contract/store. They let consumers continue producer-measured durations
  // without ever mixing the producer wall clock with the renderer wall clock.
  const telemetryReceivedAt = new Map<string, number>()
  let telemetryFlushTimer: ReturnType<typeof setTimeout> | undefined
  let telemetryUnsupported = false
  // Bumps only at an explicit transport repair barrier. Snapshot requests
  // capture this generation so an HTTP response issued before a dropped-event
  // repair can never resurrect stale live telemetry afterward.
  let telemetrySnapshotGeneration = 0
  let activityRepairChanged: Set<string> | undefined
  let activityRepairRunning = false
  let activityRepairQueued = false
  let activityRepairDisposed = false

  type SessionTelemetryWire = Omit<SessionTelemetryInfo, "sessionID"> & { sessionID: string }
  type TelemetryApplySource = "event" | "snapshot" | "repair"
  const applyTelemetry = (items: Iterable<SessionTelemetryWire>, source: TelemetryApplySource = "event") => {
    const receivedAt = sessionTelemetryClientNow()
    batch(() => {
      for (const wire of items) {
        // SessionID's runtime schema only enforces the stable "ses" prefix.
        // Keep that validation on untrusted transport data without pulling the
        // Effect schema runtime into every connected PWA launch.
        if (!wire.sessionID.startsWith("ses")) continue
        const sessionID = wire.sessionID as SessionTelemetryInfo["sessionID"]
        const item: SessionTelemetryInfo = { ...wire, sessionID }
        const previous = globalStore.telemetry[wire.sessionID]
        // A cold snapshot can race a newer SSE event. Event order is already
        // authoritative, so only snapshot reads need a timestamp freshness
        // guard. Explicit repair snapshots bypass it because they intentionally
        // replace state from the pre-repair transport generation.
        if (source === "snapshot" && !shouldApplyTelemetrySnapshot(previous, item)) {
          telemetryKnown.add(wire.sessionID)
          continue
        }
        const transition =
          source === "repair"
            ? undefined
            : telemetryStatusTransition({
                previous: previous?.phase,
                next: item.phase,
                statusWorking: session.data.session_working(wire.sessionID),
                paused: session.data.session_paused(wire.sessionID),
              })
        if (transition) {
          session.apply({
            type: "session.status",
            properties: { sessionID: wire.sessionID, status: { type: transition } },
          })
        }
        telemetryKnown.add(wire.sessionID)
        telemetryReceivedAt.set(wire.sessionID, receivedAt)
        setGlobalStore("telemetry", wire.sessionID, reconcile(item))
      }
    })
  }

  const flushTelemetry = async () => {
    telemetryFlushTimer = undefined
    if (telemetryUnsupported || telemetryPending.size === 0) return
    const generation = telemetrySnapshotGeneration
    const ids = Array.from(telemetryPending)
    let superseded = false
    telemetryPending.clear()
    for (let offset = 0; offset < ids.length; offset += 500) {
      const sessions = ids.slice(offset, offset + 500)
      try {
        const response = await serverSDK.requests.schedule(
          "background",
          () =>
            serverSDK.client.global.sessionTelemetry({
              globalSessionTelemetryInput: { sessions },
            }),
          { key: `session-telemetry:${sessions.join(",")}`, kind: "session-telemetry" },
        )
        const data = response.data ?? {}
        if (generation !== telemetrySnapshotGeneration) {
          for (const id of sessions) if (!telemetryKnown.has(id)) telemetryPending.add(id)
          superseded = true
          continue
        }
        applyTelemetry(Object.values(data), "snapshot")
        // Missing rows are still a completed lookup (new/never-run sessions).
        for (const id of sessions) telemetryKnown.add(id)
      } catch (error) {
        const status = Number(
          (error as { status?: unknown })?.status ??
            (error as { response?: { status?: unknown } })?.response?.status ??
            (error as { cause?: { status?: unknown } })?.cause?.status,
        )
        if (status === 404 || status === 405) {
          telemetryUnsupported = true
          return
        }
        for (const id of sessions) telemetryPending.add(id)
      }
    }
    if (superseded && telemetryPending.size > 0 && telemetryFlushTimer === undefined) {
      telemetryFlushTimer = setTimeout(() => void flushTelemetry(), 0)
    }
  }

  const ensureTelemetry = (sessionIDs: Iterable<string>) => {
    if (telemetryUnsupported) return
    let added = false
    for (const id of sessionIDs) {
      if (!id || telemetryKnown.has(id) || telemetryPending.has(id)) continue
      telemetryPending.add(id)
      added = true
    }
    if (!added || telemetryFlushTimer !== undefined) return
    telemetryFlushTimer = setTimeout(() => void flushTelemetry(), 0)
  }
  onCleanup(() => {
    activityRepairDisposed = true
    if (telemetryFlushTimer !== undefined) clearTimeout(telemetryFlushTimer)
    telemetryPending.clear()
    telemetryReceivedAt.clear()
  })
  const refreshProviders = () =>
    queryClient.refetchQueries({
      predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "providers",
    })

  const repairPendingResponses = async (directory: string) => {
    const key = directoryKey(directory)
    const child = children.children[key]
    if (!key || !child || !children.active(key)) return
    const sdk = serverSDK.createClient({ directory, throwOnError: true })
    const [permission, question] = await Promise.all([
      serverSDK.requests.schedule("critical", () => sdk.permission.list(), {
        key: `pending-response-repair:permission:${key}`,
        kind: "permission-list",
      }),
      serverSDK.requests.schedule("critical", () => sdk.question.list(), {
        key: `pending-response-repair:question:${key}`,
        kind: "question-list",
      }),
    ])
    const permissions = permission.data ?? []
    const questions = question.data ?? []
    const [store, setStore] = child
    batch(() => {
      const groupedPermission = reconcilePendingBySession(store.permission, permissions)
      const groupedQuestion = reconcilePendingBySession(store.question, questions)
      setStore("permission", groupedPermission)
      setStore("question", groupedQuestion)
      for (const sessionID of Object.keys(session.data.permission)) {
        if (session.get(sessionID)?.directory === directory)
          session.set("permission", sessionID, groupedPermission[sessionID] ?? [])
      }
      for (const sessionID of Object.keys(session.data.question)) {
        if (session.get(sessionID)?.directory === directory)
          session.set("question", sessionID, groupedQuestion[sessionID] ?? [])
      }
      for (const [sessionID, items] of Object.entries(groupedPermission)) session.set("permission", sessionID, items)
      for (const [sessionID, items] of Object.entries(groupedQuestion)) session.set("question", sessionID, items)
    })
  }
  const pendingResponseRepair = createPendingResponseRepairOwner({
    directories: () => Object.keys(children.children),
    active: (directory) => children.active(directory),
    repair: repairPendingResponses,
  })
  onCleanup(pendingResponseRepair.dispose)

  // Query objects leave this weak map when the query cache evicts them. The
  // event channel owns one invalidation per catalog revision, not per model.
  const refreshProviderCatalogRevision = createProviderCatalogRefresh()
  let providerCatalogDisposed = false
  onCleanup(() => { providerCatalogDisposed = true })

  let bootedAt = 0
  let bootingRoot = false
  let eventFrame: number | undefined
  let eventTimer: ReturnType<typeof setTimeout> | undefined

  const sessionOf = (value: unknown): string | undefined => {
    if (value === null || typeof value !== "object") return undefined
    const data = (value as { data?: unknown }).data
    const props = (value as { properties?: unknown }).properties
    const candidate =
      data !== null && typeof data === "object"
        ? (data as Record<string, unknown>).sessionID
        : props !== null && typeof props === "object"
          ? (props as Record<string, unknown>).sessionID
          : undefined
    return typeof candidate === "string" ? candidate : undefined
  }

  const markActivityRepairEvent = (event: ServerEvent, eventType: string) => {
    const changed = activityRepairChanged
    if (!changed) return
    if (eventType === "session.telemetry.updated") {
      const items = (event.properties as { items?: SessionTelemetryInfo[] } | undefined)?.items ?? []
      for (const item of items) if (item.sessionID) changed.add(item.sessionID)
      return
    }
    // Raw content deltas cannot change the working/paused authority and are the
    // hottest path in the app. Never add repair bookkeeping to that fan-out.
    if (isNativeStreamDelta(event.current?.type)) return
    const sessionID = sessionOf(event.current) ?? sessionOf(event)
    if (sessionID) changed.add(sessionID)
  }

  const runActivityRepair = async (changed: ReadonlySet<string>, generation: number) => {
    let active: SessionActiveOutput
    try {
      active = await serverSDK.requests.schedule(
        "critical",
        () => serverSDK.api.session.active(),
        { key: "session-activity-repair:active", kind: "session-activity-repair" },
      )
    } catch {
      return
    }
    if (activityRepairDisposed || generation !== telemetrySnapshotGeneration) return

    const candidates = new Set<string>([
      ...Object.entries(globalStore.telemetry)
        .filter(([, value]) => value !== undefined && value.phase !== "idle")
        .map(([sessionID]) => sessionID),
      ...Object.keys(session.data.session_status),
      ...Object.entries(session.data.paused)
        .filter(([, paused]) => paused)
        .map(([sessionID]) => sessionID),
      ...Object.keys(active),
    ])
    const ids = Array.from(candidates)
    const telemetryData: Record<string, SessionTelemetryWire | undefined> = {}
    let telemetryRead = !telemetryUnsupported

    if (telemetryRead && ids.length > 0) {
      try {
        for (let offset = 0; offset < ids.length; offset += 500) {
          const sessions = ids.slice(offset, offset + 500)
          const response = await serverSDK.requests.schedule(
            "interactive",
            () =>
              serverSDK.client.global.sessionTelemetry({
                globalSessionTelemetryInput: { sessions },
              }),
            { key: `session-activity-repair:telemetry:${offset}`, kind: "session-activity-repair" },
          )
          Object.assign(telemetryData, response.data ?? {})
        }
      } catch (error) {
        const status = Number(
          (error as { status?: unknown })?.status ??
            (error as { response?: { status?: unknown } })?.response?.status ??
            (error as { cause?: { status?: unknown } })?.cause?.status,
        )
        if (status === 404 || status === 405) telemetryUnsupported = true
        telemetryRead = false
      }
    }

    if (activityRepairDisposed || generation !== telemetrySnapshotGeneration) return
    queryClient.setQueryData([serverSDK.scope, "activeSessions"], active)
    batch(() => {
      if (telemetryRead) {
        const items: SessionTelemetryWire[] = []
        for (const sessionID of ids) {
          if (changed.has(sessionID)) continue
          telemetryPending.delete(sessionID)
          telemetryKnown.add(sessionID)
          const item = telemetryData[sessionID]
          if (item) {
            items.push(item)
            continue
          }
          // Missing means this process has no live/durable telemetry for the
          // session. At a repair barrier that is meaningful: discard any
          // pre-repair client clock rather than letting it tick indefinitely.
          telemetryReceivedAt.delete(sessionID)
          setGlobalStore("telemetry", sessionID, undefined)
        }
        applyTelemetry(items, "repair")
      }
      applySessionActivityRepair(session, active, candidates, changed)
    })
  }

  const scheduleActivityRepair = () => {
    // Invalidate every ordinary telemetry snapshot already in flight before
    // scheduling the authoritative repair pass.
    telemetrySnapshotGeneration += 1
    activityRepairQueued = true
    if (activityRepairRunning || activityRepairDisposed) return
    activityRepairRunning = true
    void (async () => {
      try {
        while (activityRepairQueued && !activityRepairDisposed) {
          activityRepairQueued = false
          const generation = telemetrySnapshotGeneration
          const changed = new Set<string>()
          activityRepairChanged = changed
          await runActivityRepair(changed, generation)
          if (activityRepairChanged === changed) activityRepairChanged = undefined
        }
      } finally {
        activityRepairChanged = undefined
        activityRepairRunning = false
      }
    })()
  }

  const time = (name: "applyV2" | "apply" | "dir" | "home" | "invalid", fn: () => void, sessionID?: string) => {
    const started = phaseTrace.enabled ? performance.now() : 0
    if (!perf.enabled) {
      fn()
      if (phaseTrace.enabled && (name === "applyV2" || name === "apply")) {
        phaseTrace.reducer(name, performance.now() - started, sessionID)
      }
      return
    }
    const t = performance.now()
    fn()
    perf.span(name, performance.now() - t)
    if (name === "applyV2" || name === "apply") phaseTrace.reducer(name, performance.now() - started, sessionID)
  }

  onCleanup(() => {
    if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
    if (eventTimer !== undefined) clearTimeout(eventTimer)
  })

  const setProjects = (next: Project[] | ((draft: Project[]) => Project[])) => {
    setGlobalStore("project", next)
    const liveRoots = new Set<string>()
    for (const project of globalStore.project) {
      const key = directoryKey(project.worktree)
      liveRoots.add(key)
      sessionProjectScope.set(key, project.id)
    }
    for (const key of sessionProjectScope.keys()) {
      if (!liveRoots.has(key)) sessionProjectScope.delete(key)
    }
    // Persisted startup projects may be directory-only. Once the authoritative
    // project catalog arrives, upgrade any already-started/already-loaded root
    // Session census to project scope. This belongs here, at cache ownership:
    // consumers should not need to notice that project identity arrived after
    // their initial directory load.
    queueMicrotask(() => {
      for (const project of globalStore.project) {
        const key = directoryKey(project.worktree)
        const meta = sessionMeta.get(key)
        // Only upgrade roots that already participated in Session loading.
        // setProjects can run before the child-store manager is initialized, so
        // this owner-level metadata is intentionally the dependency-free fence.
        if (!sessionLoads.has(key) && !meta) continue
        if (meta?.projectID === project.id) continue
        void loadSessions(project.worktree, { projectID: project.id, priority: "background" }).catch(() => {})
      }
    })
  }

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const bootstrap = useQuery(() => ({
    queryKey: [serverSDK.scope, "bootstrap"],
    queryFn: async () => {
      await bootstrapGlobal({
        serverSDK: serverSDK.client,
        serverAPI: serverSDK.api,
        protocol: serverSDK.protocol,
        scope: serverSDK.scope,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: setBootStore,
        queryClient,
        requests: serverSDK.requests,
      })
      bootedAt = Date.now()
      return bootedAt
    },
  }))

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => Project[]))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    key: directoryKey,
    bootstrap: () => queryClient.fetchQuery({ queryKey: [serverSDK.scope, "bootstrap"] }),
    bootstrapInstance,
  })

  const children = createChildStoreManager({
    owner,
    scope: serverSDK.scope,
    persist: persisted,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onMcp: (directory, setStore) => {
      void loadCommands(
        directory,
        serverSDK.api.command,
        sdkFor(directory),
        serverSDK.protocol,
        serverSDK.requests,
        "background",
      )
        .then((commands) => setStore("command", commands))
        .catch((err) => {
          if (isCancelledRequestError(err)) return
          showToast({
            variant: "error",
            title: language.t("toast.project.reloadFailed.title", { project: getFilename(directory) }),
            description: formatServerError(err, language.t),
          })
        })
    },
    onDispose: (directory) => {
      const key = directoryKey(directory)
      queue.clear(key)
      sessionMeta.delete(key)
      staleSessionLists.delete(key)
      sdkCache.delete(key)
      clearProviderRev(serverSDK.scope, key)
    },
    translate: language.t,
    queryOptions: queryOptionsApi,
    global: {
      provider: globalStore.provider,
    },
  })

  async function loadSessions(
    directory: string,
    options?: { limit?: number; shrinkTo?: number; priority?: ServerRequestPriority; projectID?: string },
  ) {
    const key = directoryKey(directory)
    const staleGeneration = staleSessionLists.get(key)
    const priority = options?.priority ?? "interactive"
    // Scope is part of the cache contract. A directory-only root snapshot and
    // a project-wide root snapshot may share the same canonical child store,
    // but the former must never satisfy the latter merely because its row limit
    // is already warm. Prefer an explicit caller-owned project identity; late
    // callers may also resolve it from the durable project catalog.
    const projectID =
      options?.projectID ??
      sessionProjectScope.get(key) ??
      rootSessionProjectID(directory, globalStore.project) ??
      sessionMeta.get(key)?.projectID
    const requestKey = `session-list:${key}`
    const pending = sessionLoads.get(key)
    if (pending) {
      // A project that began as speculative startup hydration can become the
      // foreground Chat project before its queued request starts. Promote the
      // existing transport job instead of making the user wait behind the old
      // background ordering.
      serverSDK.requests.promote(requestKey, priority)
      await pending
      // Re-resolve scope after the in-flight request. The authoritative project
      // catalog can land while a speculative directory-only request is pending.
      // Replaying the stale caller options would otherwise suppress the required
      // directory -> project census upgrade.
      return loadSessions(directory, {
        ...options,
        projectID:
          options?.projectID ??
          sessionProjectScope.get(key) ??
          rootSessionProjectID(directory, globalStore.project),
      })
    }

    children.pin(key)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    // Explicit user-intended shrink (e.g. a "show less" control): trim the
    // retained list to the requested cap and lower the meta high-water mark to
    // match. Without the meta update, the floor below would keep every later
    // loadSessions at the old larger size — and a plain store.limit decrement
    // alone would no-op entirely against it.
    if (options?.shrinkTo !== undefined) {
      const target = Math.max(0, options.shrinkTo)
      const next = trimSessions(store.session, {
        limit: target,
        permission: session.data.permission,
      })
      batch(() => {
        setStore("limit", target)
        setStore("session", reconcile(next, { key: "id" }))
      })
      sessionMeta.set(key, { limit: target, projectID })
      children.unpin(key)
      return
    }
    const meta = sessionMeta.get(key)
    const retainedLimit = Math.max(store.limit, options?.limit ?? 0, meta?.limit ?? 0)
    if (staleGeneration === undefined && meta && meta.projectID === projectID && meta.limit >= retainedLimit) {
      const next = trimSessions(store.session, {
        limit: retainedLimit,
        permission: session.data.permission,
      })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
      }
      children.unpin(key)
      return
    }

    const limit = Math.max(retainedLimit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const promise = queryClient
      .fetchQuery({
        ...queryOptionsApi.sessions(key),
        // Keep TanStack's freshness cache scope-aware as well. The base prefix
        // remains unchanged, so existing useIsFetching/invalidation consumers
        // still observe both directory and project variants.
        queryKey: [...queryOptionsApi.sessions(key).queryKey, projectID ? `project:${projectID}` : "directory"] as const,
        queryFn: () =>
          serverSDK.requests
            .schedule(
              priority,
              () =>
                loadRootSessionsFast({
                  client: serverSDK.client,
                  directory,
                  projectID,
                  limit,
                }).catch((error) => {
                  if (!rootSessionFastPathUnavailable(error)) throw error
                  return serverSDK.protocol.then((protocol) =>
                    protocol === "v1"
                      ? loadRootSessionsV1({ client: sdkFor(directory), directory, limit })
                      : loadRootSessions({ api: serverSDK.api.session, directory, limit }),
                  )
                }),
              { key: requestKey, kind: "session-list" },
            )
            .then((x) => {
              const nonArchived = (x.data ?? [])
                .filter((s) => !!s?.id)
                .filter((s) => !s.time?.archived)
              const limit = Math.max(store.limit, options?.limit ?? 0, sessionMeta.get(key)?.limit ?? 0)
              const childSessions = store.session.filter((s) => !!s.parentID)
              const next = trimSessions([...nonArchived, ...childSessions], {
                limit,
                permission: session.data.permission,
              })
              batch(() => {
                next.forEach(session.remember)
                setStore(
                  "sessionTotal",
                  estimateRootSessionTotal({
                    count: nonArchived.length,
                    limit: x.limit,
                    limited: x.limited,
                  }),
                )
                setStore("session", reconcile(next, { key: "id" }))
              })
              sessionMeta.set(key, { limit, projectID })
              if (staleGeneration !== undefined && staleSessionLists.get(key) === staleGeneration) {
                staleSessionLists.delete(key)
              }
            })
            .catch((err) => {
              if (isCancelledRequestError(err)) return
              console.error("Failed to load sessions", err)
              const project = getFilename(directory)
              showToast({
                variant: "error",
                title: language.t("toast.session.listFailed.title", { project }),
                description: formatServerError(err, language.t),
              })
            })
            .then(() => null),
      })
      .then(() => {})

    sessionLoads.set(key, promise)
    void promise.finally(() => {
      sessionLoads.delete(key)
      children.unpin(key)
    })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    const key = directoryKey(directory)
    if (!key) return
    const pending = booting.get(key)
    if (pending) return pending

    children.pin(key)
    const promise = Promise.resolve().then(async () => {
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(key)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        scope: serverSDK.scope,
        mcp: children.mcp(key),
        global: {
          config: globalStore.config,
          path: globalStore.path,
          project: globalStore.project,
          provider: globalStore.provider,
        },
        sdk,
        serverSDK: serverSDK.client,
        api: serverSDK.api,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions: (target) =>
          loadSessions(target, {
            projectID: rootSessionProjectID(target, globalStore.project),
          }),
        translate: language.t,
        queryClient,
        session,
        protocol: serverSDK.protocol,
        requests: serverSDK.requests,
        runBackgroundBootstrap: directoryBootstrapGate.run,
        onBackgroundReady: () => children.enableQueries(key),
        onMcpReady: () => children.enableMcpQueries(key),
      })
    })

    booting.set(key, promise)
    void promise.finally(() => {
      booting.delete(key)
      children.unpin(key)
    })
    return promise
  }

  const indexSession = (info: Parameters<typeof session.remember>[0]) => {
    for (const indexedDirectory of sessionEventIndexDirectories(info, info.directory, globalStore.project)) {
      const key = directoryKey(indexedDirectory)
      const existing = children.children[key]
      if (!existing) continue
      applyDirectoryEvent({
        event: { type: "session.created", properties: { info } },
        directory: indexedDirectory,
        store: existing[0],
        setStore: existing[1],
        push: queue.push,
        retainedLimit: sessionMeta.get(key)?.limit,
        sessionContent: false,
        permission: session.data.permission,
        loadLsp() {},
      })
    }
  }

  const findLoadedSession = (sessionID: string) => {
    const cached = session.get(sessionID)
    if (cached) return cached
    for (const [store] of Object.values(children.children)) {
      const info = store.session.find((item) => item.id === sessionID)
      if (info) return info
    }
  }

  /**
   * Keep directory-scoped root indexes coherent with the server-scoped session
   * cache after a move. This is intentionally local and bounded: we touch only
   * already-materialized child stores and never trigger a project-wide refetch.
   * The store manager caps the number of children, while each root slice is
   * itself bounded, so a rare user move stays dramatically cheaper than
   * invalidating every project/session query.
   */
  const reindexSession = (info: Session) => {
    const targetKey = directoryKey(sessionIndexDirectory(info, globalStore.project))
    let indexed = false

    batch(() => {
      for (const [key, existing] of Object.entries(children.children)) {
        const [store, setStore] = existing
        const current = store.session.find((item) => item.id === info.id)

        if (key === targetKey) {
          indexed = true
          applyDirectoryEvent({
            event: { type: current ? "session.updated" : "session.created", properties: { info } },
            directory: key,
            store,
            setStore,
            push: queue.push,
            retainedLimit: sessionMeta.get(key)?.limit,
            sessionContent: false,
            permission: session.data.permission,
            loadLsp() {},
          })
          continue
        }

        if (!current) continue
        applyDirectoryEvent({
          event: { type: "session.deleted", properties: { info: current } },
          directory: key,
          store,
          setStore,
          push: queue.push,
          retainedLimit: sessionMeta.get(key)?.limit,
          sessionContent: false,
          permission: session.data.permission,
          loadLsp() {},
        })
      }
    })

    return indexed
  }

  const unsub = serverSDK.event.listen((e) => {
    const directory = e.name
    const event = e.details
    const eventType: string = event.type
    if (eventType === "server.pending-response-state-invalidated") {
      pendingResponseRepair.invalidate(directory, (event.properties as { all?: boolean } | undefined)?.all === true)
      return
    }
    const connectedRepair =
      eventType === "server.connected" &&
      !!(event.properties as { repair?: boolean } | undefined)?.repair
    const recent = bootingRoot || Date.now() - bootedAt < 1500
    const nativeMove = event.current?.type === "session.next.moved" ? event.current : undefined
    const nativeRename = event.current?.type === "session.next.renamed" ? event.current : undefined
    // Capture before applyV2: the server-scoped cache can legitimately evict
    // cold metadata while a still-visible directory row remains materialized.
    const moveSource = nativeMove ? findLoadedSession(nativeMove.data.sessionID) : undefined
    perf.event()
    markActivityRepairEvent(event, eventType)

    if (event.current) {
      const current = event.current
      time("applyV2", () => session.applyV2(current), sessionOf(current))
    }
    const nativeSessionEvent = isNativeSessionEvent(event.current?.type)
    if (!nativeSessionEvent) time("apply", () => session.apply(event), sessionOf(event))

    if (nativeMove) {
      let info = session.get(nativeMove.data.sessionID)
      if (!info && moveSource) {
        info = session.remember({
          ...moveSource,
          projectID: nativeMove.data.projectID ?? moveSource.projectID,
          workspaceID: nativeMove.data.location.workspaceID,
          directory: nativeMove.data.location.directory,
          path: nativeMove.data.subdirectory,
          time: { ...moveSource.time, updated: nativeMove.data.timestamp },
        })
      }
      if (info) reindexSession(info)
    }

    // Native rename events carry only the changed title and timestamp. The
    // detail cache reducer above can update a loaded Session, but the Home and
    // directory indexes consume compatibility Session events. Project that
    // compact producer event into the already-known metadata once here so all
    // materialized consumers converge without a per-rename fetch.
    let indexEvent: ServerEvent = event
    let renamedInfo: Session | undefined
    if (nativeRename) {
      const previous = session.get(nativeRename.data.sessionID) ?? findLoadedSession(nativeRename.data.sessionID)
      if (previous) {
        renamedInfo = session.remember({
          ...previous,
          title: nativeRename.data.title,
          time: { ...previous.time, updated: nativeRename.data.timestamp },
        })
        indexEvent = {
          ...event,
          type: "session.updated",
          properties: { sessionID: renamedInfo.id, info: renamedInfo },
        } as ServerEvent
      }
    }

    // Stream deltas have already been reduced into the shared session store.
    // They cannot affect directory metadata, home indexing, invalidation, or
    // any other legacy event path, so stop here after the one necessary V2
    // reduction. This keeps concurrent sessions from multiplying per-token
    // fan-out work across every directory store.
    if (isNativeStreamDelta(event.current?.type)) return

    const homeSessionChanged =
      indexEvent.type === "session.created" || indexEvent.type === "session.updated" || indexEvent.type === "session.deleted" || !!nativeRename
    if (homeSessions.live() && homeSessionChanged) {
      time("home", () => {
        if (nativeRename && !renamedInfo) {
          homeSessions.apply({
            type: "session.renamed",
            properties: {
              sessionID: nativeRename.data.sessionID,
              title: nativeRename.data.title,
              updated: nativeRename.data.timestamp,
            },
          })
          return
        }
        homeSessions.apply(indexEvent as Parameters<typeof homeSessions.apply>[0])
      })
    }
    if (homeSessionIndexRefreshRelevant(event.type) || homeSessionChanged)
      time("home", () => homeSessions.refresh(homeSessionChanged ? "session.updated" : indexEvent.type, connectedRepair))
    if (eventType === "integration.connection.updated") void refreshProviders()
    if (eventType === "provider.catalog.updated") {
      const revision = providerCatalogRevision(event.properties)
      if (revision) for (const query of queryClient.getQueryCache().findAll({
        predicate: (query) => providerCatalogQueryMatches(query.queryKey, serverSDK.scope, revision.directory),
      })) void refreshProviderCatalogRevision(query, revision.revision, {
        pending: () => query.state.fetchStatus === "fetching" ? query.promise : undefined,
        refresh: () => providerCatalogDisposed
          ? Promise.resolve()
          : queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }, { throwOnError: true }),
      }).catch(() => {})
    }

    const groupScope = `session-groups:${ServerConnection.key(serverSDK.server)}`
    const isGroupEvent =
      eventType === "session_group.created" ||
      eventType === "session_group.updated" ||
      eventType === "session_group.deleted" ||
      eventType === "session_group.session.added" ||
      eventType === "session_group.session.removed"
    if (isGroupEvent) {
      void queryClient.invalidateQueries({ queryKey: [groupScope, "session-groups"] })
      const groupID = (event.properties as { groupID?: string } | undefined)?.groupID
      if (groupID) {
        void queryClient.invalidateQueries({ queryKey: [groupScope, "session-group", groupID] })
      }
    }

    // JSDOC: Read `.data` only after confirming `!isPending`, else the
    // internal `createResource()` suspends and the route hangs.
    if (directory === "global") {
      if (connectedRepair) scheduleActivityRepair()
      if (eventType === "session.telemetry.updated") {
        const items = (event.properties as { items?: SessionTelemetryInfo[] } | undefined)?.items ?? []
        applyTelemetry(items)
      }
      if (eventType === "server.connected" && !activeSessionsQuery.isPending && activeSessionsQuery.data === undefined && !activeSessionsQuery.isFetching)
        void activeSessionsQuery.refetch()
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: () => {
          if (recent) return
          bootstrap.refetch()
        },
        setGlobalProject: setProjects,
      })
      if (
        eventType === "config.updated" ||
        eventType === "catalog.updated" ||
        eventType === "agent.updated" ||
        eventType === "project.directories.updated"
      )
        bootstrap.refetch()
      if (connectedRepair || eventType === "global.disposed") {
        for (const directory of Object.keys(children.children)) {
          const key = directoryKey(directory)
          staleSessionLists.set(key, (staleSessionLists.get(key) ?? 0) + 1)
          if (!recent && children.active(directory)) queue.push(directory)
        }
      }
      return
    }

    // Keep the compatibility event on its existing path. Current servers emit
    // session.next.moved (handled above); older clients may still surface the
    // legacy session.moved family through OpenCodeEvent.
    if (event.current?.type === "session.moved") {
      const info = session.get(event.current.data.sessionID)
      if (info) reindexSession(info)
    }
    if (event.current?.type === "session.forked")
      void session
        .resolve(event.current.data.sessionID, { force: true })
        .then(indexSession)
        .catch(() => {})

    const rootInfo =
      indexEvent.type === "session.created" || indexEvent.type === "session.updated" || indexEvent.type === "session.deleted"
        ? (indexEvent.properties as { info?: Session } | undefined)?.info
        : undefined
    const eventDirectories = rootInfo
      ? sessionEventIndexDirectories(rootInfo, directory, globalStore.project)
      : [directory]

    // Root metadata can have two already-materialized consumers: the canonical
    // project-wide root index and its physical directory detail store. Mirror
    // the same ordinary Session event into both; this is bounded (<= 2), issues
    // no requests, and keeps producer-specific state out of the sidebar.
    for (const eventDirectory of eventDirectories) {
      const eventKey = directoryKey(eventDirectory)
      const existing = children.children[eventKey]
      if (!existing) continue
      children.mark(eventKey)
      if (
        event.current?.type === "session.moved" ||
        // event.current?.type === "session.archived" ||
        event.current?.type === "session.forked" ||
        eventType === "command.updated" ||
        eventType === "config.updated" ||
        eventType === "agent.updated"
      )
        queue.push(eventKey)
      if (eventType === "mcp.status.changed")
        time("invalid", () => void queryClient.invalidateQueries(queryOptionsApi.mcp(eventKey)))
      if (eventType === "mcp.resources.changed")
        time("invalid", () => void queryClient.invalidateQueries(queryOptionsApi.mcpResources(eventKey)))
      if (eventType === "tool.reloaded")
        time("invalid", () => void queryClient.invalidateQueries(queryOptionsApi.tools(eventKey)))
      const [store, setStore] = existing
      time("dir", () =>
        applyDirectoryEvent({
          event: indexEvent,
          directory: eventDirectory,
          store,
          setStore,
          push: (nextDirectory) => {
            if (children.active(nextDirectory)) queue.push(nextDirectory)
          },
          retainedLimit: sessionMeta.get(eventKey)?.limit,
          sessionContent: false,
          permission: session.data.permission,
          vcsCache: children.vcsCache.get(eventKey),
          loadLsp: () => {
            if (!children.active(eventKey)) return
            void queryClient.fetchQuery(queryOptionsApi.lsp(eventKey))
          },
          loadReferences: () => {
            if (!children.active(eventKey)) return
            void queryClient.fetchQuery(queryOptionsApi.references(eventKey))
          },
        }),
      )
    }
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  if (perf.enabled) {
    const id = setInterval(() => perf.tick(), 250)
    onCleanup(() => clearInterval(id))
    onCleanup(perf.startFrameMonitor())
  }
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directoryKey(directory))
    }
  })

  onMount(() => {
    if (typeof requestAnimationFrame === "function") {
      eventFrame = requestAnimationFrame(() => {
        eventFrame = undefined
        eventTimer = setTimeout(() => {
          eventTimer = undefined
          void serverSDK.event.start()
        }, 0)
      })
    } else {
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        void serverSDK.event.start()
      }, 0)
    }
  })

  const projectApi = {
    loadSessions,
    reindexSession,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const updateConfigMutation = useMutation(() => ({
    mutationFn: (config: Config) => serverSDK.client.global.config.update({ config }),
    onSuccess: (_data, config) => {
      bootstrap.refetch()
      if (config.agent) {
        void queryClient
          .invalidateQueries({
            predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "agents",
          })
          .then(() => {
            for (const directory of Object.keys(children.children)) {
              if (!children.active(directory)) continue
              queue.push(directory)
            }
          })
      }
      // Invalidate all provider queries so newly configured custom providers
      // appear immediately in the available provider list across all directories.
      queryClient.invalidateQueries({ queryKey: [serverSDK.scope, null, "providers"] })
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "providers",
      })
    },
  }))

  /**
   * Exact per-agent global config mutation.
   *
   * `PUT /global/config/agent/:agentID` replaces one agent definition and
   * `DELETE` removes it, both Tier-0 and bootstrap-free. The previous
   * whole-config `config.update` shim could not express "delete this key":
   * JSON has no `undefined`, so clearing nested fields required either a
   * deep-merge that kept stale values or a whole-file rewrite from the client.
   * `value: null` is the only honest delete signal, and the server owns the
   * resulting file shape.
   */
  const updateAgentConfigMutation = useMutation(() => ({
    mutationFn: (input: { id: string; value: AgentConfig | null }) =>
      input.value === null
        ? serverSDK.client.global.configAgentDelete({ agentID: input.id }, { throwOnError: true })
        : serverSDK.client.global.configAgentSet(
            { agentID: input.id, agentConfig: input.value },
            { throwOnError: true },
          ),
    onSuccess: () => {
      // The route disposes every workspace Instance (agent definitions are
      // instance config), so the global config snapshot the Studio renders from
      // and every active workspace's resolved `agent` catalog both have to be
      // re-read. Invalidate first, then replay the directory bootstrap wave:
      // `ensureQueryData` only refetches because the invalidation marked the
      // per-directory `agents` query stale.
      void bootstrap.refetch()
      void queryClient
        .invalidateQueries({
          predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "agents",
        })
        .then(() => {
          for (const directory of Object.keys(children.children)) {
            if (!children.active(directory)) continue
            queue.push(directory)
          }
        })
    },
  }))

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    peek: children.peek,
    disableMcp: children.disableMcp,
    queryOptions: queryOptionsApi,
    refreshProviders,
    // bootstrap,
    updateConfig: updateConfigMutation.mutateAsync,
    updateAgentConfig: updateAgentConfigMutation.mutateAsync,
    project: projectApi,
    providers: {
      ensure: ensureProviderCatalog,
      ensureDirectory: children.enableProviderQueries,
    },
    telemetry: {
      ensure: ensureTelemetry,
      get: (sessionID: string) => globalStore.telemetry[sessionID],
      receivedAt: (sessionID: string) => telemetryReceivedAt.get(sessionID),
      get unsupported() {
        return telemetryUnsupported
      },
    },
    session,
    homeSessions,
    mcp: {
      toggle: async (directory: string, name: string) => {
        const key = directoryKey(directory)
        const sdk = sdkFor(key)
        const status = children.child(key, { bootstrap: false })[0].mcp[name]?.status
        if (!status) return
        await toggleMcp({
          status,
          connect: async () => {
            if ((await serverSDK.protocol) === "v1") {
              await sdk.mcp.connect({ name })
              return
            }
            await serverSDK.api.mcp.connect({ server: name, location: { directory: key } })
          },
          disconnect: async () => {
            if ((await serverSDK.protocol) === "v1") {
              await sdk.mcp.disconnect({ name })
              return
            }
            await serverSDK.api.mcp.disconnect({ server: name, location: { directory: key } })
          },
          authenticate: async () => {
            await sdk.mcp.auth.authenticate({ name })
          },
          refresh: async () => {
            await queryClient.refetchQueries(queryOptionsApi.mcp(key))
            await queryClient.refetchQueries(queryOptionsApi.mcpResources(key))
          },
        })
      },
    },
  }
}

export function createServerSyncContext(serverSDK: ServerSDK) {
  const inner = createServerSyncContextInner(serverSDK)
  return Object.assign(inner, {
    ensureDirSyncContext: createRefCountMap(
      (dir) => createDirSyncContext(dir, inner, serverSDK),
      (dir) => inner.disableMcp(dir),
      directoryKey,
    ),
  })
}

export type ServerSync = ReturnType<typeof createServerSyncContext>

export const { use: useServerSync, provider: ServerSyncProvider } = createSimpleContext({
  name: "ServerSync",
  // Returns an accessor so the resolved server can change reactively without
  // re-instantiating the subtree (mirrors useServerSDK).
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    return createMemo<ServerSync>(() => {
      const conn = props.server?.() ?? server.current
      if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.ensureServerCtx(conn).sync
    })
  },
})

export function useQueryOptions() {
  const sync = useServerSync()
  return createMemo(() => sync().queryOptions)
}
