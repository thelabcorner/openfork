import { createMemo, createRoot, createSignal, getOwner, onCleanup, runWithOwner, type Owner } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import type { VcsInfo } from "@opencode-ai/sdk/v2/client"
import {
  DIR_IDLE_TTL_MS,
  MAX_DIR_STORES,
  type ChildOptions,
  type DirState,
  type IconCache,
  type MetaCache,
  type ProjectMeta,
  type State,
  type VcsCache,
} from "./types"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./eviction"
import { useQuery } from "@tanstack/solid-query"
import type { QueryOptionsApi } from "../server-sync"
import { pathKey as directoryKey, type PathKey as DirectoryKey } from "@/utils/path-key"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import type { ServerScope } from "@/utils/server-scope"
import { safeQueryData } from "@/utils/safe-query-data"
import { sessionStatusIsWorking } from "@/utils/session-status"

export function createChildStoreManager(input: {
  owner: Owner
  scope: ServerScope
  persist: typeof persisted
  isBooting: (directory: string) => boolean
  isLoadingSessions: (directory: string) => boolean
  onBootstrap: (directory: string) => void
  onDispose: (directory: string) => void
  translate: (key: string, vars?: Record<string, string | number>) => string
  queryOptions: QueryOptionsApi
  global: {
    provider: NormalizedProviderListResponse
  }
}) {
  const children: Record<string, [Store<State>, SetStoreFunction<State>]> = {}
  const vcsCache = new Map<string, VcsCache>()
  const metaCache = new Map<string, MetaCache>()
  const iconCache = new Map<string, IconCache>()
  const lifecycle = new Map<string, DirState>()
  const pins = new Map<string, number>()
  const ownerPins = new WeakMap<object, Set<string>>()
  const disposers = new Map<string, () => void>()
  // Persisted VCS/project/icon stores register onCleanup and write-flush
  // callbacks. They must have the same eviction lifetime as this directory,
  // not the global provider owner that may survive thousands of directory
  // switches. Keep their own root separate from the query child root.
  const cacheDisposers = new Map<string, () => void>()
  const mcpDirectories = new Set<string>()
  const mcpRequestToggles = new Map<string, (requested: boolean) => void>()
  const mcpQueryToggles = new Map<string, (enabled: boolean) => void>()
  const activeDirectories = new Set<string>()
  const activationToggles = new Map<string, (enabled: boolean) => void>()
  const catalogToggles = new Map<string, (enabled: boolean) => void>()

  // Solid createRoot returns an independent disposer: unloading the parent
  // does not automatically invoke the per-directory disposal callbacks.
  // Attach one finalizer to the supplied global owner, so shutdown releases
  // any still-pinned/active query and persistence roots as well as eviction.
  runWithOwner(input.owner, () => onCleanup(() => {
    for (const dispose of disposers.values()) dispose()
    for (const dispose of cacheDisposers.values()) dispose()
    disposers.clear()
    cacheDisposers.clear()
  }))

  const markKey = (key: DirectoryKey) => {
    if (!key) return
    lifecycle.set(key, { lastAccessAt: Date.now() })
    runEviction(key)
  }

  const mark = (directory: string) => {
    const key = directoryKey(directory)
    markKey(key)
  }

  const pin = (directory: string) => {
    const key = directoryKey(directory)
    if (!key) return
    pins.set(key, (pins.get(key) ?? 0) + 1)
    markKey(key)
  }

  const unpin = (directory: string) => {
    const key = directoryKey(directory)
    if (!key) return
    const next = (pins.get(key) ?? 0) - 1
    if (next > 0) {
      pins.set(key, next)
      return
    }
    pins.delete(key)
    runEviction()
  }

  const pinned = (directory: string) => (pins.get(directoryKey(directory)) ?? 0) > 0

  const pinForOwner = (directory: string) => {
    const current = getOwner()
    if (!current) return
    if (current === input.owner) return
    const key = current as object
    const set = ownerPins.get(key)
    if (set?.has(directory)) return
    if (set) set.add(directory)
    if (!set) ownerPins.set(key, new Set([directory]))
    pin(directory)
    onCleanup(() => {
      const set = ownerPins.get(key)
      if (set) {
        set.delete(directory)
        if (set.size === 0) ownerPins.delete(key)
      }
      unpin(directory)
    })
  }

  function disposeDirectory(directory: DirectoryKey) {
    const key = directory
    if (
      !canDisposeDirectory({
        directory: key,
        hasStore: !!children[key],
        pinned: pinned(key),
        booting: input.isBooting(key),
        loadingSessions: input.isLoadingSessions(key),
      })
    ) {
      return false
    }

    vcsCache.delete(key)
    metaCache.delete(key)
    iconCache.delete(key)
    lifecycle.delete(key)
    mcpDirectories.delete(key)
    mcpRequestToggles.delete(key)
    mcpQueryToggles.delete(key)
    activeDirectories.delete(key)
    activationToggles.delete(key)
    catalogToggles.delete(key)
    const dispose = disposers.get(key)
    if (dispose) {
      dispose()
      disposers.delete(key)
    }
    const disposeCache = cacheDisposers.get(key)
    if (disposeCache) {
      disposeCache()
      cacheDisposers.delete(key)
    }
    delete children[key]
    input.onDispose(key)
    return true
  }

  function runEviction(skip?: string) {
    const stores = Object.keys(children)
    if (stores.length === 0) return
    const list = pickDirectoriesToEvict({
      stores,
      state: lifecycle,
      pins: new Set(stores.filter(pinned)),
      max: MAX_DIR_STORES,
      ttl: DIR_IDLE_TTL_MS,
      now: Date.now(),
    }).filter((directory) => directory !== skip)
    if (list.length === 0) return
    for (const directory of list) {
      if (!disposeDirectory(directoryKey(directory))) continue
    }
  }

  function ensureChild(directory: string) {
    const key = directoryKey(directory)
    if (!key) console.error("No directory provided")
    if (!children[key]) {
      // The original runWithOwner(global, persisted(...)) attached every
      // onCleanup/flush observer to the application's global root. Eviction
      // disposed the query root but NEVER detached these observers. One
      // dedicated cache root per directory makes all three persist callbacks
      // independently reclaimable by disposeDirectory.
      const cacheStores = (() => {
        try {
          return runWithOwner(input.owner, () => createRoot((dispose) => {
            cacheDisposers.set(key, dispose)
            return {
              vcs: input.persist(
                { ...Persist.serverWorkspace(input.scope, directory, "vcs", ["vcs.v1"]), defer: true },
                createStore({ value: undefined as VcsInfo | undefined }),
              ),
              meta: input.persist(
                { ...Persist.serverWorkspace(input.scope, directory, "project", ["project.v1"]), defer: true },
                createStore({ value: undefined as ProjectMeta | undefined }),
              ),
              icon: input.persist(
                { ...Persist.serverWorkspace(input.scope, directory, "icon", ["icon.v1"]), defer: true },
                createStore({ value: undefined as string | undefined }),
              ),
            }
          }))
        } catch (error) {
          // A storage/provider failure midway through creating three caches
          // must not strand the first already-registered persistence observer.
          cacheDisposers.get(key)?.()
          cacheDisposers.delete(key)
          throw error
        }
      })()
      if (!cacheStores?.vcs || !cacheStores?.meta || !cacheStores?.icon) {
        cacheDisposers.get(key)?.()
        cacheDisposers.delete(key)
        throw new Error(input.translate("error.childStore.persistedCacheCreateFailed"))
      }
      const { vcs, meta, icon } = cacheStores
      const vcsStore = vcs[0]
      vcsCache.set(key, { store: vcsStore, setStore: vcs[1], ready: vcs[3] })
      metaCache.set(key, { store: meta[0], setStore: meta[1], ready: meta[3] })
      iconCache.set(key, { store: icon[0], setStore: icon[1], ready: icon[3] })

      const init = () =>
        createRoot((dispose) => {
          const initialMeta = meta[0].value
          const initialIcon = icon[0].value
          const [mcpRequested, setMcpRequested] = createSignal(false)
          const [mcpEnabled, setMcpEnabled] = createSignal(false)
          const [instanceQueriesEnabled, setInstanceQueriesEnabled] = createSignal(false)
          const [catalogQueriesEnabled, setCatalogQueriesEnabled] = createSignal(false)
          // Deferred tier: references are not on critical paint and can
          // idle-delay to avoid the 36-request burst. They auto-enable after
          // instanceQueriesEnabled has been true for one idle callback.
          const [deferredQueriesEnabled, setDeferredQueriesEnabled] = createSignal(false)
          // Keep the memo behind a stable method on the store. Solid's store
          // setter treats a function value as an updater, so passing the memo
          // itself to setStore would store its current Map instead of the
          // accessor and make session_children() fail at render time.
          let sessionChildren = () => new Map<string, string[]>()

          const pathQuery = useQuery(() => ({ ...input.queryOptions.path(key), enabled: instanceQueriesEnabled() }))
          const mcpQuery = useQuery(() => ({ ...input.queryOptions.mcp(key), enabled: mcpEnabled() }))
          const mcpResourceQuery = useQuery(() => ({ ...input.queryOptions.mcpResources(key), enabled: mcpEnabled() }))
          const providerQuery = useQuery(() => ({
            ...input.queryOptions.providers(key),
            enabled: catalogQueriesEnabled(),
          }))
          const referenceQuery = useQuery(() => ({
            ...input.queryOptions.references(key),
            enabled: deferredQueriesEnabled(),
          }))

          const child = createStore<State>({
            project: "",
            projectMeta: initialMeta,
            icon: initialIcon,
            get provider_ready() {
              return catalogQueriesEnabled() && !providerQuery.isLoading
            },
            get provider() {
              const EMPTY = { all: new Map(), connected: [], default: {} }
              const catalog = safeQueryData(providerQuery, EMPTY)
              return catalog
            },
            config: {},
            get path() {
              const EMPTY = { state: "", config: "", worktree: "", directory, home: "" }
              if (pathQuery.isLoading) return EMPTY
              return pathQuery.data ?? EMPTY
            },
            status: "loading" as const,
            agent: [],
            command: [],
            get reference() {
              return referenceQuery.isLoading ? [] : (referenceQuery.data ?? [])
            },
            session: [],
            session_children: () => sessionChildren(),
            sessionTotal: 0,
            session_status: {},
            session_working(id: string) {
              const type = this.session_status[id]?.type
              return sessionStatusIsWorking(type)
            },
            session_diff: {},
            todo: {},
            permission: {},
            question: {},
            get mcp_ready() {
              return !mcpRequested() || (mcpEnabled() && !mcpQuery.isLoading)
            },
            get mcp() {
              return mcpQuery.isLoading ? {} : (mcpQuery.data ?? {})
            },
            get mcp_resource() {
              return mcpResourceQuery.isLoading ? {} : (mcpResourceQuery.data ?? {})
            },
            // LSP status is an event-owned snapshot. An empty initial value is
            // already a complete answer; lsp.updated replaces it when the
            // server reports active language servers.
            lsp_ready: true,
            lsp: [],
            vcs: vcsStore.value,
            limit: 5,
            message: {},
            session_message: {},
            part: {},
            part_text_accum_delta: {},
          })
          sessionChildren = createMemo(() => {
            const children = new Map<string, string[]>()
            for (const item of child[0].session) {
              if (!item.parentID) continue
              const siblings = children.get(item.parentID)
              if (siblings) siblings.push(item.id)
              else children.set(item.parentID, [item.id])
            }
            return children
          })
          children[key] = child
          disposers.set(key, dispose)
          mcpRequestToggles.set(key, setMcpRequested)
          mcpQueryToggles.set(key, setMcpEnabled)
          catalogToggles.set(key, setCatalogQueriesEnabled)
          activationToggles.set(key, (value: boolean) => {
            setInstanceQueriesEnabled(value)
            if (!value) {
              setDeferredQueriesEnabled(false)
              return
            }
            // Burst control: first two active directories get references
            // immediately (tests + critical path); beyond that idle-defer so
            // startup goes from 24 parallel auxiliary requests to
            // 4-8 + deferred 16, cutting 705ms thundering herd.
            const immediate = activeDirectories.size < 2
            if (immediate) {
              setDeferredQueriesEnabled(true)
              return
            }
            if (typeof requestIdleCallback === "function") {
              requestIdleCallback(() => setDeferredQueriesEnabled(true), { timeout: 900 })
            } else {
              setTimeout(() => setDeferredQueriesEnabled(true), 180)
            }
          })

          const onPersistedInit = (init: Promise<string> | string | null, run: () => void) => {
            if (!(init instanceof Promise)) return
            void init.then(() => {
              if (children[key] !== child) return
              run()
            })
          }

          onPersistedInit(vcs[2], () => {
            const cached = vcsStore.value
            if (!cached?.branch) return
            child[1]("vcs", (value) => value ?? cached)
          })

          onPersistedInit(meta[2], () => {
            if (child[0].projectMeta !== initialMeta) return
            child[1]("projectMeta", meta[0].value)
          })

          onPersistedInit(icon[2], () => {
            if (child[0].icon !== initialIcon) return
            child[1]("icon", icon[0].value)
          })
        })

      runWithOwner(input.owner, init)
    }
    markKey(key)
    const childStore = children[key]
    if (!childStore) throw new Error(input.translate("error.childStore.storeCreateFailed"))
    return childStore
  }

  function child(directory: string, options: ChildOptions = {}) {
    const key = directoryKey(directory)
    const childStore = ensureChild(directory)
    pinForOwner(key)
    if (options.mcp) enableMcp(directory, key, childStore)
    const shouldBootstrap = options.bootstrap ?? true
    if (shouldBootstrap) activate(key)
    if (shouldBootstrap && childStore[0].status === "loading") {
      input.onBootstrap(directory)
    }
    return childStore
  }

  function peek(directory: string, options: ChildOptions = {}) {
    const key = directoryKey(directory)
    const childStore = ensureChild(directory)
    if (options.mcp) enableMcp(directory, key, childStore)
    const shouldBootstrap = options.bootstrap ?? true
    if (shouldBootstrap) activate(key)
    if (shouldBootstrap && childStore[0].status === "loading") {
      input.onBootstrap(directory)
    }
    return childStore
  }

  function enableMcp(directory: string, key: DirectoryKey, childStore: [Store<State>, SetStoreFunction<State>]) {
    if (mcpDirectories.has(key)) return
    mcpDirectories.add(key)
    mcpRequestToggles.get(key)?.(true)
    // Initial directory acquisition must not let MCP jump ahead of the staged
    // bootstrap and wake an expensive backend instance during the critical
    // startup window. bootstrapDirectory fetches the initial MCP snapshot in
    // its late tier and then calls enableMcpQueries(). Later MCP demand on an
    // already-complete child remains immediate.
    if (childStore[0].status !== "complete") return
    mcpQueryToggles.get(key)?.(true)
  }

  function enableMcpQueries(directory: string) {
    const key = directoryKey(directory)
    if (!mcpDirectories.has(key)) return
    mcpQueryToggles.get(key)?.(true)
  }

  // Passive Home/project metadata reads must not initialize the directory.
  // A real directory access enables these queries once for the store lifetime.
  // TODO(v2): After Home switches to v2.project.list and root-filtered,
  // updated-time v2.session.list, remove any Home-only passive child creation.
  function activate(key: DirectoryKey) {
    if (activeDirectories.has(key)) return
    activeDirectories.add(key)
    catalogToggles.get(key)?.(true)
  }

  // Catalog intent is Tier 2 and independent of execution/auxiliary bootstrap.
  // A picker may ask for this without activating a directory session index.
  function enableProviderQueries(directory: string) {
    ensureChild(directory)
    catalogToggles.get(directoryKey(directory))?.(true)
  }

  /**
   * Directory activation and auxiliary query activation are intentionally two
   * different phases. A real route access should bootstrap the session list
   * immediately, but path/provider/LSP/reference queries are secondary UI data
   * and must not race that critical request on startup.
   */
  function enableQueries(directory: string) {
    const key = directoryKey(directory)
    if (!activeDirectories.has(key)) return
    activationToggles.get(key)?.(true)
  }

  function disableMcp(directory: string) {
    const key = directoryKey(directory)
    if (!mcpDirectories.delete(key)) return
    mcpRequestToggles.get(key)?.(false)
    mcpQueryToggles.get(key)?.(false)
  }

  function projectMeta(directory: string, patch: ProjectMeta) {
    const key = directoryKey(directory)
    const [store, setStore] = ensureChild(directory)
    const cached = metaCache.get(key)
    if (!cached) return
    const previous = store.projectMeta ?? {}
    const icon = patch.icon ? { ...previous.icon, ...patch.icon } : previous.icon
    const commands = patch.commands ? { ...previous.commands, ...patch.commands } : previous.commands
    const next = {
      ...previous,
      ...patch,
      icon,
      commands,
    }
    cached.setStore("value", next)
    setStore("projectMeta", next)
  }

  function projectIcon(directory: string, value: string | undefined) {
    const key = directoryKey(directory)
    const [store, setStore] = ensureChild(directory)
    const cached = iconCache.get(key)
    if (!cached) return
    if (store.icon === value) return
    cached.setStore("value", value)
    setStore("icon", value)
  }

  return {
    children,
    ensureChild,
    child,
    peek,
    projectMeta,
    projectIcon,
    mark,
    pin,
    unpin,
    pinned,
    mcp: (directory: string) => mcpDirectories.has(directoryKey(directory)),
    active: (directory: string) => activeDirectories.has(directoryKey(directory)),
    enableQueries,
    enableProviderQueries,
    enableMcpQueries,
    disableMcp,
    disposeDirectory,
    runEviction,
    vcsCache,
    metaCache,
    iconCache,
  }
}
