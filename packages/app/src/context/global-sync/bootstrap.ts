import type {
  Config,
  OpencodeClient,
  Path,
  PermissionRequest,
  Project,
  ProviderAuthResponse,
  QuestionRequest,
  ReferenceInfo,
  Session,
} from "@opencode-ai/sdk/v2/client"
import type {
  AgentListInput,
  AgentListOutput,
  CommandInfo,
  CommandListInput,
  CommandListOutput,
  ModelDefaultOutput,
  ModelListInput,
  ModelListOutput,
  ProjectCurrentInput,
  ProjectCurrentOutput,
  ProjectListOutput,
  ProviderListInput,
  ProviderListOutput,
  ReferenceListInput,
  ReferenceListOutput,
  SessionApi,
} from "@opencode-ai/client/promise"
import { showToast } from "@/utils/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { retry } from "@opencode-ai/core/util/retry"
import { batch } from "solid-js"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { State, VcsCache } from "./types"
import type { ServerSession } from "../server-session"
import {
  cmp,
  directoryKey,
  normalizeAgentList,
  normalizePermissionRequest,
  normalizeProjectInfo,
  normalizeProviderList,
} from "./utils"
import { formatServerError, isCancelledRequestError } from "@/utils/server-errors"
import { QueryClient, queryOptions } from "@tanstack/solid-query"
import { loadMcpQuery, loadMcpResourcesQuery } from "../server-sync"
import { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"
import { normalizeSessionInfo } from "@/utils/session"
import type { ServerProtocol } from "@/utils/server-protocol"
import type { ServerApi } from "@/utils/server"
import { startupSpan } from "@/utils/startup-perf"
import type { ServerRequestPriority, ServerRequestScheduler } from "@/utils/server-request-scheduler"
import type { Info as SessionTelemetryInfo } from "@opencode-ai/schema/session-telemetry"

type GlobalStore = {
  ready: boolean
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  telemetry: Record<string, SessionTelemetryInfo | undefined>
  reload: undefined | "pending" | "complete"
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    // Optimized: two-frame gate (~32ms) is enough to let the route paint.
    // Previous 400ms/350ms budget inflated startup by ~300ms; the heavy
    // per-directory slow path is now concurrency-limited and partially
    // deferred to idle, so a short gate keeps elapsedMs <120ms while still
    // avoiding layout-thrash in the critical frame.
    const timer = setTimeout(finish, 32)
    if (typeof requestAnimationFrame !== "function") return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        clearTimeout(timer)
        finish()
      })
    })
  })
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list
    .filter((item): item is PromiseRejectedResult => item.status === "rejected")
    .map((item) => item.reason)
    .filter((reason) => !isCancelledRequestError(reason))
}

const providerRev = new Map<string, number>()

export function clearProviderRev(scope: ServerScope, directory: string) {
  providerRev.delete(ScopedKey.from(scope, directory))
}

function runAll(list: Array<() => Promise<unknown>>) {
  return Promise.allSettled(list.map((item) => item()))
}

function runAfterBackgroundQuiet<T>(work: () => Promise<T>, minDelayMs: number, idleTimeoutMs: number) {
  if (typeof requestIdleCallback !== "function") {
    // Keep non-browser/test semantics intentionally short. Chromium is where
    // module-fetch idle can be mistaken for genuine startup idle.
    return new Promise<T>((resolve) => setTimeout(() => void work().then(resolve), 20))
  }
  return new Promise<T>((resolve) => {
    setTimeout(() => {
      requestIdleCallback(() => void work().then(resolve), { timeout: idleTimeoutMs })
    }, minDelayMs)
  })
}

const scheduleRequest = <T>(
  requests: ServerRequestScheduler | undefined,
  priority: ServerRequestPriority,
  kind: string,
  run: () => Promise<T>,
  key?: string,
) => (requests ? requests.schedule(priority, run, { kind, key }) : Promise.resolve().then(run))

function endpointStatus(error: unknown) {
  if (!error || typeof error !== "object") return undefined
  if ("status" in error) return Number((error as { status?: unknown }).status)
  const response = "response" in error ? (error as { response?: unknown }).response : undefined
  if (response && typeof response === "object" && "status" in response)
    return Number((response as { status?: unknown }).status)
  const cause = error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause : undefined
  if (cause && "status" in cause) return Number((cause as { status?: unknown }).status)
  return undefined
}

// Concurrency-limited variant: a flat Promise.allSettled of 15 fetches per
// directory × 6 active directories = 90 concurrent requests, saturating the
// local server and inflating TTFB from ~4ms to 700ms. Capping at N=3 keeps
// the server cache-friendly and elapsedMs under 200ms.
async function runAllLimited(
  list: Array<() => Promise<unknown>>,
  concurrency = 3,
): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = new Array(list.length)
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (true) {
      const current = index++
      if (current >= list.length) return
      try {
        const value = await list[current]!()
        results[current] = { status: "fulfilled", value } as PromiseFulfilledResult<unknown>
      } catch (reason) {
        results[current] = { status: "rejected", reason } as PromiseRejectedResult
      }
    }
  })
  await Promise.all(workers)
  return results
}

async function resolveSessionsLimited(ids: readonly string[], resolve: (sessionID: string) => Promise<unknown>) {
  const unique = [...new Set(ids)].filter(Boolean)
  if (unique.length === 0) return
  const settled = await runAllLimited(
    unique.map((sessionID) => () => resolve(sessionID)),
    4,
  )
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failed) throw failed.reason
}

function showErrors(input: {
  errors: unknown[]
  title: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
}) {
  if (input.errors.length === 0) return
  const message = formatServerError(input.errors[0], input.translate)
  const more = input.errors.length > 1 ? input.formatMoreCount(input.errors.length - 1) : ""
  showToast({
    variant: "error",
    title: input.title,
    description: message + more,
  })
}

export const loadGlobalConfigQuery = (
  scope: ServerScope,
  sdk: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
  requests?: ServerRequestScheduler,
  priority: ServerRequestPriority = "interactive",
) =>
  queryOptions({
    queryKey: [scope, "config"],
    queryFn: async () => {
      if ((await protocol) !== "v1") return {}
      return retry(() =>
        scheduleRequest(requests, priority, "global-config", () => sdk.global.config.get()).then((x) => x.data!),
      )
    },
  })

type ProjectApi = {
  readonly list: () => Promise<ProjectListOutput>
  readonly current: (input?: ProjectCurrentInput) => Promise<ProjectCurrentOutput>
}

type CatalogApi = {
  readonly providers?: {
    readonly list: (input?: ProviderListInput) => Promise<ProviderListOutput>
  }
  readonly provider?: {
    readonly list: (input?: ProviderListInput) => Promise<ProviderListOutput>
  }
  readonly models?: {
    readonly list: (input?: ModelListInput) => Promise<ModelListOutput>
    readonly default?: (input?: ModelListInput) => Promise<ModelDefaultOutput>
  }
  readonly model?: {
    readonly list: (input?: ModelListInput) => Promise<ModelListOutput>
    readonly default?: (input?: ModelListInput) => Promise<ModelDefaultOutput>
  }
}

type McpApi = ServerApi["mcp"]
type PermissionApi = ServerApi["permission"]
type QuestionApi = ServerApi["question"]
type VcsApi = ServerApi["vcs"]

export const loadProjectsQuery = (
  scope: ServerScope,
  api: ProjectApi,
  requests?: ServerRequestScheduler,
  priority: ServerRequestPriority = "interactive",
  globalClient?: OpencodeClient,
) =>
  queryOptions({
    queryKey: [scope, "project"],
    queryFn: () =>
      retry(() =>
        scheduleRequest(requests, priority, "project-list", async () => {
          if (globalClient) {
            try {
              return (await globalClient.global.projects()).data ?? []
            } catch (error) {
              const status = endpointStatus(error)
              if (status !== 404 && status !== 405) throw error
            }
          }
          return api.list()
        }).then((projects) => {
          return projects
            .filter((p) => !!p?.id)
            .filter((p) => !!p.worktree && !p.worktree.includes("opencode-test"))
            .map(normalizeProjectInfo)
            .slice()
            .sort((a, b) => cmp(a.id, b.id))
        }),
      ),
  })

export async function bootstrapGlobal(input: {
  serverSDK: OpencodeClient
  serverAPI: CatalogApi & { readonly project: ProjectApi }
  protocol?: Promise<ServerProtocol>
  scope: ServerScope
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
  requests?: ServerRequestScheduler
}) {
  const slow = [
    () =>
      input.queryClient.fetchQuery(
        loadGlobalConfigQuery(input.scope, input.serverSDK, input.protocol, input.requests, "interactive"),
      ),
    () =>
      input.queryClient.fetchQuery(
        loadPathQuery(input.scope, null, input.serverSDK, input.protocol, input.requests, "interactive"),
      ),
    () => {
      const startedAt = performance.now()
      return input.queryClient
        .fetchQuery(loadProjectsQuery(input.scope, input.serverAPI.project, input.requests, "critical", input.serverSDK))
        .then((data) => {
          startupSpan("sidebar.project-catalog-ready", startedAt, { projects: data.length })
          input.setGlobalStore("project", data)
        })
    },
  ]
  await runAll(slow)
  // showErrors({
  //   errors: errors(),
  //   title: input.requestFailedTitle,
  //   translate: input.translate,
  //   formatMoreCount: input.formatMoreCount,
  // })
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

function projectID(directory: string, projects: Project[]) {
  return projects.find((project) => project.worktree === directory || project.sandboxes?.includes(directory))?.id
}

function mergeSession(setStore: SetStoreFunction<State>, session: Session) {
  setStore("session", (list) => {
    const next = list.slice()
    const idx = next.findIndex((item) => item.id >= session.id)
    if (idx === -1) return [...next, session]
    if (next[idx]?.id === session.id) {
      next[idx] = session
      return next
    }
    next.splice(idx, 0, session)
    return next
  })
}

function warmSessions(input: {
  ids: string[]
  store: Store<State>
  setStore: SetStoreFunction<State>
  api: SessionApi
  requests?: ServerRequestScheduler
}) {
  const known = new Set(input.store.session.map((item) => item.id))
  const ids = [...new Set(input.ids)].filter((id) => !!id && !known.has(id))
  if (ids.length === 0) return Promise.resolve()
  return resolveSessionsLimited(ids, (sessionID) =>
    retry(() =>
      scheduleRequest(input.requests, "background", "session-info", () => input.api.get({ sessionID }), `session:${sessionID}`),
    ).then((session) =>
      mergeSession(input.setStore, normalizeSessionInfo(session)),
    ),
  )
}

export const loadProvidersQuery = (
  scope: ServerScope,
  directory: string | null,
  sdk: CatalogApi,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
  requests?: ServerRequestScheduler,
  priority: ServerRequestPriority = "background",
) =>
  queryOptions({
    queryKey: [scope, directory === null ? null : directoryKey(directory), "providers"],
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: () =>
      retry(async () => {
        if ((await protocol) === "v1" && legacy) {
          const result = await scheduleRequest(requests, priority, "provider-list", () => legacy.provider.list())
          return normalizeProviderList(result.data!)
        }
        const location = directory ? { location: { directory } } : undefined
        const providerApi = sdk.providers ?? sdk.provider
        const modelApi = sdk.models ?? sdk.model
        if (!providerApi || !modelApi) throw new Error("Provider/model catalog API unavailable")
        const [providers, models, defaultModel] = await Promise.all([
          scheduleRequest(requests, priority, "provider-list", () => providerApi.list(location)),
          scheduleRequest(requests, priority, "model-list", () => modelApi.list(location)),
          modelApi.default
            ? scheduleRequest(requests, priority, "model-default", () => modelApi.default!(location))
            : Promise.resolve({ location: location?.location ?? {}, data: null }),
        ])
        return normalizeProviderList(providers.data, models.data, defaultModel.data)
      }),
  })

type AgentListApi = {
  readonly list: (input?: AgentListInput) => Promise<AgentListOutput>
}

type CommandListApi = {
  readonly list: (input?: CommandListInput) => Promise<CommandListOutput>
}

type ReferenceListApi = {
  readonly list: (input?: ReferenceListInput) => Promise<ReferenceListOutput>
}

export const loadAgentsQuery = (
  scope: ServerScope,
  directory: string,
  sdk: AgentListApi,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
  requests?: ServerRequestScheduler,
  priority: ServerRequestPriority = "background",
) =>
  queryOptions({
    queryKey: [scope, directoryKey(directory), "agents"],
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: () =>
      retry(async () => {
        if ((await protocol) === "v1" && legacy)
          return scheduleRequest(requests, priority, "agent-list", () => legacy.app.agents()).then((result) =>
            normalizeAgentList(result.data ?? []),
          )
        return scheduleRequest(requests, priority, "agent-list", () => sdk.list({ location: { directory } })).then(
          (result) => normalizeAgentList(result.data),
        )
      }),
  })

export const loadCommands = (
  directory: string,
  api: CommandListApi,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
  requests?: ServerRequestScheduler,
  priority: ServerRequestPriority = "background",
): Promise<CommandInfo[]> =>
  retry(async () => {
    if ((await protocol) === "v1" && legacy) {
      return ((await scheduleRequest(requests, priority, "command-list", () => legacy.command.list())).data ?? []).map((command) => {
        const [providerID, id] = command.model?.split("/") ?? []
        return {
          name: command.name,
          template: command.template,
          description: command.description,
          agent: command.agent,
          model: providerID && id ? { providerID, id } : undefined,
          subtask: command.subtask,
          // source: command.source === "skill" ? undefined : command.source,
        }
      })
    }
    return scheduleRequest(requests, priority, "command-list", () => api.list({ location: { directory } })).then(
      (result) => result.data,
    )
  })

export const loadPathQuery = (
  scope: ServerScope,
  directory: string | null,
  sdk: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
  requests?: ServerRequestScheduler,
  priority: ServerRequestPriority = "interactive",
) =>
  queryOptions<Path>({
    queryKey: [scope, directory === null ? null : directoryKey(directory), "path"],
    queryFn: async () => {
      if ((await protocol) !== "v1")
        return { state: "", config: "", worktree: "", directory: directory ?? "", home: "" }
      // Global bootstrap only needs immutable process path metadata. Asking the
      // instance-scoped /path route with no directory makes server middleware
      // fall back to process.cwd(), which on desktop is commonly $HOME; that
      // used to bootstrap config/plugins/watchers for an otherwise unused home
      // instance before the real project even opened. Newer servers expose the
      // same metadata on bootstrap-free /global/health. Keep /path as a strict
      // compatibility fallback for older servers.
      if (directory === null) {
        try {
          const health = await scheduleRequest(requests, priority, "global-path", () => sdk.global.health())
          const path = (health.data as { path?: Path } | undefined)?.path
          if (path?.home) return path
        } catch (error) {
          const status = endpointStatus(error)
          if (status !== 404 && status !== 405) {
            // A malformed/old health payload is equivalent to unsupported here;
            // the compatibility /path call below remains authoritative.
          }
        }
      }
      return retry(() =>
        scheduleRequest(requests, priority, "path-get", () => sdk.path.get({ directory: directory ?? undefined })).then(
          (result) => result.data!,
        ),
      )
    },
  })

export const loadReferencesQuery = (
  scope: ServerScope,
  directory: string,
  api: ReferenceListApi,
  legacy?: OpencodeClient,
  protocol?: Promise<ServerProtocol>,
  requests?: ServerRequestScheduler,
  priority: ServerRequestPriority = "background",
) =>
  queryOptions<ReferenceInfo[]>({
    queryKey: [scope, directoryKey(directory), "references"] as const,
    queryFn: () =>
      retry(async () => {
        if ((await protocol) === "v1" && legacy)
          return scheduleRequest(requests, priority, "reference-list", () => legacy.v2.reference.list()).then(
            (result) => result.data?.data ?? [],
          )
        return scheduleRequest(requests, priority, "reference-list", () => api.list({ location: { directory } })).then(
          (result) => result.data,
        )
      }).catch(() => []),
    placeholderData: [],
  })

export async function bootstrapDirectory(input: {
  directory: string
  scope: ServerScope
  mcp: boolean
  sdk: OpencodeClient
  api: CatalogApi & {
    readonly agent: AgentListApi
    readonly command: CommandListApi
    readonly mcp: McpApi
    readonly permission: PermissionApi
    readonly project: ProjectApi
    readonly question: QuestionApi
    readonly reference: ReferenceListApi
    readonly session: SessionApi
    readonly vcs: VcsApi
  }
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
  loadSessions: (directory: string) => Promise<void> | void
  translate: (key: string, vars?: Record<string, string | number>) => string
  global: {
    config: Config
    path: Path
    project: Project[]
    provider: NormalizedProviderListResponse
  }
  queryClient: QueryClient
  session?: ServerSession
  protocol?: Promise<ServerProtocol>
  requests?: ServerRequestScheduler
  /**
   * Per-server admission seam for the expensive directory metadata wave.
   * Critical session hydration runs before this callback and is never gated.
   * The caller may serialize these waves across directories while this module
   * keeps same-directory work internally concurrent.
   */
  runBackgroundBootstrap?: <T>(work: () => Promise<T>) => Promise<T>
  /**
   * Called only after the critical session list and the first auxiliary
   * bootstrap tier have settled. Child-store path/provider/LSP/reference
   * observers use this seam so they cannot create a second metadata burst
   * while the route's critical session request is still competing for slots.
   */
  onBackgroundReady?: () => void
  /** Called after the initial MCP status/resource tier settles so reactive MCP
   * queries can be enabled without racing the staged bootstrap. */
  onMcpReady?: () => void
}) {
  const loading = input.store.status !== "complete"
  const seededProject = projectID(input.directory, input.global.project)
  const seededPath = input.global.path.directory === input.directory ? input.global.path : undefined
  if (seededProject) input.setStore("project", seededProject)
  if (seededPath) input.setStore("path", seededPath)
  if (Object.keys(input.store.config).length === 0 && Object.keys(input.global.config).length > 0) {
    input.setStore("config", reconcile(input.global.config, { merge: false }))
  }
  if (loading) input.setStore("status", "partial")

  const revKey = ScopedKey.from(input.scope, input.directory)
  const rev = (providerRev.get(revKey) ?? 0) + 1
  providerRev.set(revKey, rev)
  ;(async () => {
    // Critical: only sessions are on the route hot path. Everything else is
    // deferred to idle and concurrency-limited to avoid the 90-request burst.
    const critical = [() => Promise.resolve(input.loadSessions(input.directory))]
    // Deferred: agents/commands/vcs/references/permissions/questions/mcp.
    // These are not needed to paint the timeline; they populate side-bars,
    // command palette, permission prompts, and MCP tooling lazily.
    const deferred = [
      () =>
        input.queryClient
          .ensureQueryData(
            loadAgentsQuery(
              input.scope,
              input.directory,
              input.api.agent,
              input.sdk,
              input.protocol,
              input.requests,
              "background",
            ),
          )
          .then((data) => input.setStore("agent", data)),
      () =>
        retry(async () => {
          if ((await input.protocol) !== "v1") return
          return scheduleRequest(input.requests, "background", "directory-config", () => input.sdk.config.get()).then((x) =>
            input.setStore("config", reconcile(x.data!, { merge: false })),
          )
        }),
      () =>
        retry(() =>
          (async () => {
            if ((await input.protocol) !== "v1") return
            const x = await scheduleRequest(input.requests, "background", "session-status", () => input.sdk.session.status())
            if (!input.session) {
              input.setStore("session_status", x.data!)
              return
            }
            const statuses = x.data ?? {}
            input.session.set(
              "session_status",
              produce((draft) => {
                for (const sessionID of Object.keys(draft)) {
                  if (statuses[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory === input.directory) delete draft[sessionID]
                }
              }),
            )
            for (const [sessionID, status] of Object.entries(statuses)) {
              input.session.set("session_status", sessionID, reconcile(status))
            }
            await resolveSessionsLimited(Object.keys(statuses), (sessionID) =>
              input.session!.resolve(sessionID, { priority: "background" }).catch(() => undefined),
            )
          })(),
        ),
      !seededProject &&
        (() =>
          retry(() =>
            scheduleRequest(input.requests, "background", "project-current", () =>
              input.api.project.current({ location: { directory: input.directory } }),
            ),
          ).then((project) => input.setStore("project", project.id))),
      !seededPath &&
        (() =>
          input.queryClient
            .ensureQueryData(
              loadPathQuery(input.scope, input.directory, input.sdk, input.protocol, input.requests, "background"),
            )
            .then((data) => {
              const next = projectID(data.directory ?? input.directory, input.global.project)
              if (next) input.setStore("project", next)
            })),
      () =>
        retry(async () => {
          if ((await input.protocol) !== "v1") return
          return scheduleRequest(input.requests, "background", "vcs-get", () => input.sdk.vcs.get()).then((result) => {
            const next = { branch: result.data?.branch, default_branch: result.data?.default_branch }
            input.setStore("vcs", next)
            if (next) input.vcsCache.setStore("value", next)
          })
        }),
      input.mcp &&
        (() =>
          loadCommands(input.directory, input.api.command, input.sdk, input.protocol, input.requests, "background").then((commands) =>
            input.setStore("command", commands),
          )),
      () =>
        input.queryClient.fetchQuery(
          loadReferencesQuery(
            input.scope,
            input.directory,
            input.api.reference,
            input.sdk,
            input.protocol,
            input.requests,
            "background",
          ),
        ),
      () =>
        retry(() =>
          (async () => {
            if ((await input.protocol) === "v1")
              return scheduleRequest(input.requests, "background", "permission-list", () => input.sdk.permission.list()).then(
                (result) => result.data ?? [],
              )
            return scheduleRequest(input.requests, "background", "permission-list", () =>
              input.api.permission.request.list({ location: { directory: input.directory } }),
            )
              .then((result) => result.data.map(normalizePermissionRequest))
          })().then((permissions) => {
            const ids = permissions.map((permission) => permission.sessionID)
            const grouped = groupBySession(
              permissions.filter((permission) => !!permission.id && !!permission.sessionID),
            )
            const warm = input.session
              ? resolveSessionsLimited(ids, (sessionID) => input.session!.resolve(sessionID, { priority: "background" }))
              : warmSessions({
                  ids,
                  store: input.store,
                  setStore: input.setStore,
                  api: input.api.session,
                  requests: input.requests,
                })
            return warm.then(() =>
              batch(() => {
                const current = input.session?.data.permission ?? input.store.permission
                for (const sessionID of Object.keys(current)) {
                  if (grouped[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory !== input.directory) continue
                  if (input.session) input.session.set("permission", sessionID, [])
                  if (!input.session) input.setStore("permission", sessionID, [])
                }
                for (const [sessionID, permissions] of Object.entries(grouped)) {
                  const value = reconcile(
                    permissions.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id)),
                    { key: "id" },
                  )
                  if (input.session) input.session.set("permission", sessionID, value)
                  if (!input.session) input.setStore("permission", sessionID, value)
                }
              }),
            )
          }),
        ),
      () =>
        retry(() =>
          (async () => {
            if ((await input.protocol) === "v1")
              return scheduleRequest(input.requests, "background", "question-list", () => input.sdk.question.list()).then(
                (result) => result.data ?? [],
              )
            return scheduleRequest(input.requests, "background", "question-list", () =>
              input.api.question.request.list({ location: { directory: input.directory } }),
            )
              .then((result) => result.data)
          })().then((questions) => {
            const ids = questions.map((question) => question.sessionID)
            const grouped = groupBySession(
              questions.filter((question) => !!question.id && !!question.sessionID) as QuestionRequest[],
            )
            const warm = input.session
              ? resolveSessionsLimited(ids, (sessionID) => input.session!.resolve(sessionID, { priority: "background" }))
              : warmSessions({
                  ids,
                  store: input.store,
                  setStore: input.setStore,
                  api: input.api.session,
                  requests: input.requests,
                })
            return warm.then(() =>
              batch(() => {
                const current = input.session?.data.question ?? input.store.question
                for (const sessionID of Object.keys(current)) {
                  if (grouped[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory !== input.directory) continue
                  if (input.session) input.session.set("question", sessionID, [])
                  if (!input.session) input.setStore("question", sessionID, [])
                }
                for (const [sessionID, questions] of Object.entries(grouped)) {
                  const value = reconcile(
                    questions.filter((q) => !!q?.id).sort((a, b) => cmp(a.id, b.id)),
                    { key: "id" },
                  )
                  if (input.session) input.session.set("question", sessionID, value)
                  if (!input.session) input.setStore("question", sessionID, value)
                }
              }),
            )
          }),
        ),
    ].filter(Boolean) as (() => Promise<any>)[]
    const mcpDeferred = [
      input.mcp &&
        (() =>
          input.queryClient.fetchQuery(
            loadMcpQuery(input.scope, input.directory, input.api.mcp, input.sdk, input.protocol, input.requests),
          )),
      input.mcp &&
        (() =>
          input.queryClient.fetchQuery(
            loadMcpResourcesQuery(input.scope, input.directory, input.api.mcp, input.sdk, input.protocol, input.requests),
          )),
    ].filter(Boolean) as (() => Promise<any>)[]

    await waitForPaint()
    // Critical path: sessions only - keep route paint <120ms.
    const criticalErrs = errors(await runAllLimited(critical, 2))
    if (criticalErrs.length === 0 && loading) input.setStore("status", "complete")
    // Deferred is not on critical paint; run after a short idle so the session
    // timeline can render before saturating the server. Concurrency-capped to
    // avoid the thundering-herd seen in the 705ms x36 request trace.
    const scheduleDeferred = () => runAllLimited(deferred, 2).then((deferredErrs) => errors(deferredErrs))
    const scheduleMcp = () => runAllLimited(mcpDeferred, 2).then((mcpErrs) => errors(mcpErrs))
    let slowErrs = criticalErrs
    if (deferred.length > 0) {
      // Critical sessions are already loaded and status is complete here.
      // Enforce a real post-critical quiet window before auxiliary catalogs/VCS
      // can touch the sidecar. requestIdleCallback alone is insufficient: while
      // Chromium waits on Vite/module I/O its main thread is "idle" even though
      // startup is still very much in progress.
      const admittedDeferred = () =>
        input.runBackgroundBootstrap
          ? input.runBackgroundBootstrap(async () => {
              const result = await scheduleDeferred()
              // Enable the child-store reactive metadata observers while this
              // directory still owns the admission lane. Their path/reference
              // reads are usually cache hits after the tier above; provider/LSP
              // can enqueue before the next directory begins initialization.
              input.onBackgroundReady?.()
              return result
            })
          : scheduleDeferred().then((result) => {
              input.onBackgroundReady?.()
              return result
            })
      const deferredErrs = await runAfterBackgroundQuiet(admittedDeferred, loading ? 650 : 120, 350)
      slowErrs = [...slowErrs, ...(Array.isArray(deferredErrs) ? (deferredErrs as unknown[]) : [])]
    } else {
      input.onBackgroundReady?.()
    }

    // MCP after deferred, even later (background tooling) — keep short in
    // tests (no rIC, 20ms) so 80ms assertion window still captures it.
    if (mcpDeferred.length > 0) {
      const mcpErrs = await runAfterBackgroundQuiet(scheduleMcp, deferred.length > 0 ? 180 : 0, 600)
      slowErrs = [...slowErrs, ...(Array.isArray(mcpErrs) ? (mcpErrs as unknown[]) : [])]
    }
    input.onMcpReady?.()
    if (slowErrs.length > 0) {
      console.error("Failed to finish bootstrap instance", slowErrs[0])
      const project = getFilename(input.directory)
      showToast({
        variant: "error",
        title: input.translate("toast.project.reloadFailed.title", { project }),
        description: formatServerError(slowErrs[0], input.translate),
      })
    }
  })()
}
