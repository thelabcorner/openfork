import type {
  Config,
  OpencodeClient,
  Path,
  Project,
  ProviderAuthResponse,
  SessionStatus,
} from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { type Accessor, batch, createMemo, createSignal, getOwner, onCleanup, onMount, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { InitError } from "../pages/error"
import { ServerSDK } from "./server-sdk"
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
import { formatServerError, isCancelledRequestError } from "@/utils/server-errors"
import { safeQueryData } from "@/utils/safe-query-data"
import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
import type { SolidQueryOptions } from "@tanstack/solid-query"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey } from "./global-sync/utils"
import { PathKey } from "@/utils/path-key"
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
import { perf } from "./perf"
import { phaseTrace } from "./phase-trace"
import type { ServerRequestPriority, ServerRequestScheduler } from "@/utils/server-request-scheduler"

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

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
  requests?: ServerRequestScheduler,
): ApiQueryOptions<SessionActiveOutput, readonly [ServerScope, "activeSessions"]> =>
  queryOptions<SessionActiveOutput, Error, SessionActiveOutput, readonly [ServerScope, "activeSessions"]>({
    queryKey: [scope, "activeSessions"] as const,
    queryFn: () =>
      requests
        ? requests.schedule("interactive", () => api.active(), { kind: "session-active" })
        : api.active(),
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

export function createActiveSessionInfoWarmup(resolve: (sessionID: string) => Promise<unknown>) {
  const pending = new Set<string>()
  let tail = Promise.resolve()
  return {
    push(sessionIDs: Iterable<string>) {
      for (const sessionID of sessionIDs) {
        if (!sessionID || pending.has(sessionID)) continue
        pending.add(sessionID)
        tail = tail
          .then(() => resolve(sessionID))
          .catch(() => undefined)
          .finally(() => pending.delete(sessionID))
          .then(() => undefined)
      }
      return tail
    },
    pending() {
      return pending.size
    },
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
  const sessionMeta = new Map<string, { limit: number }>()
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
    onStreamInterestChanged: serverSDK.event.setStreamContentSessions,
  })
  const activeSessionInfoWarmup = createActiveSessionInfoWarmup((sessionID) =>
    session.resolve(sessionID, { priority: "background" }),
  )
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
    loadActiveSessionsQuery(serverSDK.scope, {
      active: async () => {
        if ((await serverSDK.protocol) === "v1") {
          const statuses = (await serverSDK.client.session.status()).data ?? {}
          seedActiveSessionStatuses(session, statuses)
          void activeSessionInfoWarmup.push(Object.keys(statuses))
          return Object.fromEntries(
            Object.entries(statuses).flatMap(([sessionID, status]) =>
              status.type === "idle" ? [] : [[sessionID, { type: "running" as const }]],
            ),
          )
        }
        const active = await serverSDK.api.session.active()
        seedActiveSessionStatuses(session, active)
        void activeSessionInfoWarmup.push(Object.keys(active))
        return active
      },
    }, serverSDK.requests),
  )

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    get ready() {
      return !bootstrap.isPending
    },
    project: [],
    provider_auth: {},
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
  const refreshProviders = () =>
    queryClient.refetchQueries({
      predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "providers",
    })

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
    options?: { limit?: number; shrinkTo?: number; priority?: ServerRequestPriority },
  ) {
    const key = directoryKey(directory)
    const priority = options?.priority ?? "interactive"
    const requestKey = `session-list:${key}`
    const pending = sessionLoads.get(key)
    if (pending) {
      // A project that began as speculative startup hydration can become the
      // foreground Chat project before its queued request starts. Promote the
      // existing transport job instead of making the user wait behind the old
      // background ordering.
      serverSDK.requests.promote(requestKey, priority)
      await pending
      return loadSessions(directory, options)
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
      sessionMeta.set(key, { limit: target })
      children.unpin(key)
      return
    }
    const meta = sessionMeta.get(key)
    const retainedLimit = Math.max(store.limit, options?.limit ?? 0, meta?.limit ?? 0)
    if (meta && meta.limit >= retainedLimit) {
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
        queryFn: () =>
          serverSDK.requests
            .schedule(
              priority,
              () =>
                loadRootSessionsFast({ client: serverSDK.client, directory, limit }).catch((error) => {
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
              sessionMeta.set(key, { limit })
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
        api: serverSDK.api,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions,
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
    const key = directoryKey(info.directory)
    const existing = children.children[key]
    if (!existing) return
    applyDirectoryEvent({
      event: { type: "session.created", properties: { info } },
      directory: key,
      store: existing[0],
      setStore: existing[1],
      push: queue.push,
      retainedLimit: sessionMeta.get(key)?.limit,
      sessionContent: false,
      permission: session.data.permission,
      loadLsp() {},
    })
  }

  const unsub = serverSDK.event.listen((e) => {
    const directory = e.name
    const key = directoryKey(directory)
    const event = e.details
    const eventType: string = event.type
    const connectedRepair =
      eventType === "server.connected" &&
      !!(event.properties as { repair?: boolean } | undefined)?.repair
    const recent = bootingRoot || Date.now() - bootedAt < 1500
    perf.event()

    if (event.current) {
      const current = event.current
      time("applyV2", () => session.applyV2(current), sessionOf(current))
    }
    const nativeSessionEvent = isNativeSessionEvent(event.current?.type)
    if (!nativeSessionEvent) time("apply", () => session.apply(event), sessionOf(event))

    // Stream deltas have already been reduced into the shared session store.
    // They cannot affect directory metadata, home indexing, invalidation, or
    // any other legacy event path, so stop here after the one necessary V2
    // reduction. This keeps concurrent sessions from multiplying per-token
    // fan-out work across every directory store.
    if (isNativeStreamDelta(event.current?.type)) return

    if (homeSessions.live()) {
      if (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted") {
        time("home", () => homeSessions.apply(event))
      }
      if (homeSessionIndexRefreshRelevant(event.type))
        time("home", () => homeSessions.refresh(event.type, connectedRepair))
    }
    if (eventType === "integration.connection.updated") void refreshProviders()

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
        if (recent) return
        for (const directory of Object.keys(children.children)) {
          if (!children.active(directory)) continue
          queue.push(directory)
        }
      }
      return
    }

    if (event.current?.type === "session.moved") {
      const info = session.get(event.current.data.sessionID)
      if (info) indexSession(info)
    }
    if (event.current?.type === "session.forked")
      void session
        .resolve(event.current.data.sessionID, { force: true })
        .then(indexSession)
        .catch(() => {})

    const existing = children.children[key]
    if (!existing) return
    children.mark(key)
    if (
      event.current?.type === "session.moved" ||
      // event.current?.type === "session.archived" ||
      event.current?.type === "session.forked" ||
      eventType === "command.updated" ||
      eventType === "config.updated" ||
      eventType === "agent.updated"
    )
      queue.push(key)
    if (eventType === "mcp.status.changed")
      time("invalid", () => void queryClient.invalidateQueries(queryOptionsApi.mcp(key)))
    if (eventType === "mcp.resources.changed")
      time("invalid", () => void queryClient.invalidateQueries(queryOptionsApi.mcpResources(key)))
    if (eventType === "tool.reloaded")
      time("invalid", () => void queryClient.invalidateQueries(queryOptionsApi.tools(key)))
    const [store, setStore] = existing
    time("dir", () =>
      applyDirectoryEvent({
        event,
        directory,
        store,
        setStore,
        push: (directory) => {
          if (children.active(directory)) queue.push(directory)
        },
        retainedLimit: sessionMeta.get(key)?.limit,
        sessionContent: false,
        permission: session.data.permission,
        vcsCache: children.vcsCache.get(key),
        loadLsp: () => {
          if (!children.active(key)) return
          void queryClient.fetchQuery(queryOptionsApi.lsp(key))
        },
        loadReferences: () => {
          if (!children.active(key)) return
          void queryClient.fetchQuery(queryOptionsApi.references(key))
        },
      }),
    )
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
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const updateConfigMutation = useMutation(() => ({
    mutationFn: (config: Config) => serverSDK.client.global.config.update({ config }),
    onSuccess: () => {
      bootstrap.refetch()
      // Invalidate all provider queries so newly configured custom providers
      // appear immediately in the available provider list across all directories.
      queryClient.invalidateQueries({ queryKey: [serverSDK.scope, null, "providers"] })
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "providers",
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
    project: projectApi,
    providers: {
      ensure: ensureProviderCatalog,
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
