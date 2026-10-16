import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot, getOwner, onCleanup, type Owner } from "solid-js"
import { createStore } from "solid-js/store"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import type { State } from "./types"
import type { QueryOptionsApi } from "../server-sync"
import { ServerScope } from "@/utils/server-scope"
import { pathKey as directoryKey } from "@/utils/path-key"

let createChildStoreManager: typeof import("./child-store").createChildStoreManager
let queryExports: typeof import("@tanstack/solid-query")
const querySingles: Array<() => { queryKey?: unknown[]; enabled?: boolean }> = []
const persist: typeof import("@/utils/persist").persisted = (_target, store) => [
  store[0],
  store[1],
  null,
  Object.assign(() => true, { promise: undefined }),
  async () => undefined,
]

const child = () => createStore({} as State)
const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse

const queryOptionsApi = {
  globalConfig: () => ({ queryKey: ["globalConfig"], queryFn: async () => ({}) }),
  projects: () => ({ queryKey: ["projects"], queryFn: async () => [] }),
  providers: (directory: string | null) => ({ queryKey: [directory, "providers"], queryFn: async () => provider }),
  path: (directory: string | null) => ({
    queryKey: [directory, "path"],
    queryFn: async () => ({
      state: "",
      config: "",
      worktree: "",
      directory: directory ?? "",
      home: "",
    }),
  }),
  agents: (directory: string) => ({ queryKey: [directory, "agents"], queryFn: async () => [] }),
  mcp: (directory: string) => ({ queryKey: [directory, "mcp"], queryFn: async () => ({}) }),
  mcpResources: (directory: string) => ({ queryKey: [directory, "mcpResources"], queryFn: async () => ({}) }),
  references: (directory: string) => ({ queryKey: [directory, "references"], queryFn: async () => [] }),
  sessions: (directory: string) => ({ queryKey: [directory, "loadSessions"] as const }),
} as unknown as QueryOptionsApi

function createOwner(callback: (owner: Owner) => void) {
  return createRoot((dispose) => {
    const owner = getOwner()
    if (!owner) throw new Error("owner required")
    callback(owner)

    return dispose
  })
}

beforeAll(async () => {
  // The real platform context is a JSX component and must be compiled through
  // Vite's Solid transform, not Bun's generic jsxDEV runner. These are
  // headless lifecycle tests and only need the storage-independent web type.
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ platform: "web" }),
  }))
  queryExports = { ...await import("@tanstack/solid-query") }
  mock.module("@tanstack/solid-query", () => ({
    ...queryExports,
    useQuery: (options: () => { queryKey?: unknown[]; enabled?: boolean }) => {
      querySingles.push(options)
      return {
        get isLoading() {
          return options().queryKey?.[1] === "path"
        },
        get data() {
          if (options().queryKey?.[1] === "path") throw new Error("pending path data read")
          if (options().queryKey?.[1] === "mcp") return options().enabled ? { demo: { status: "disabled" } } : undefined
          if (options().queryKey?.[1] === "providers") return provider
          return undefined
        },
      }
    },
  }))

  createChildStoreManager = (await import("./child-store")).createChildStoreManager
})

afterAll(() => {
  mock.module("@tanstack/solid-query", () => queryExports)
})

describe("createChildStoreManager", () => {
  test("evicting a directory also disposes its three persistence observers and recreates them only on reuse", () => {
    let created = 0
    let disposed = 0
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const observedPersist: typeof persist = (target, store, platform) => {
      created++
      onCleanup(() => { disposed++ })
      return persist(target, store, platform)
    }
    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner, scope: ServerScope.local, persist: observedPersist,
        isBooting: () => false, isLoadingSessions: () => false,
        onBootstrap() {}, onDispose() {}, translate: (key) => key,
        queryOptions: queryOptionsApi, global: { provider },
      })
    })
    try {
      manager!.peek("/cache-lifetime", { bootstrap: false })
      expect(created).toBe(3)
      expect(disposed).toBe(0)
      expect(manager!.disposeDirectory(directoryKey("/cache-lifetime"))).toBe(true)
      expect(disposed).toBe(3)
      expect(manager!.children["/cache-lifetime"]).toBeUndefined()
      manager!.peek("/cache-lifetime", { bootstrap: false })
      expect(created).toBe(6)
      expect(disposed).toBe(3)
    } finally {
      dispose()
    }
    expect(disposed).toBe(6)
  })

  test("120 sequential directory switches bound retained persistence owners to the live directory cap", () => {
    let created = 0
    let disposed = 0
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const observedPersist: typeof persist = (target, store, platform) => {
      created++
      onCleanup(() => { disposed++ })
      return persist(target, store, platform)
    }
    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner, scope: ServerScope.local, persist: observedPersist,
        isBooting: () => false, isLoadingSessions: () => false,
        onBootstrap() {}, onDispose() {}, translate: (key) => key,
        queryOptions: queryOptionsApi, global: { provider },
      })
    })
    try {
      for (let index = 0; index < 120; index++) {
        manager!.peek(`/switch-${index}`, { bootstrap: false })
        expect(Object.keys(manager!.children).length).toBeLessThanOrEqual(30)
      }
      expect(created).toBe(360)
      expect(created - disposed).toBeLessThanOrEqual(90)
      expect(disposed).toBeGreaterThanOrEqual(270)
    } finally {
      dispose()
    }
    expect(disposed).toBe(360)
  })

  test("partial storage initialization failure tears down observers before a clean retry", () => {
    let registered = 0
    let disposed = 0
    let shouldThrow = true
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const observedPersist: typeof persist = (target, store, platform) => {
      registered++
      if (shouldThrow && registered === 2) {
        shouldThrow = false
        throw new Error("synthetic storage failure")
      }
      onCleanup(() => { disposed++ })
      return persist(target, store, platform)
    }
    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner, scope: ServerScope.local, persist: observedPersist,
        isBooting: () => false, isLoadingSessions: () => false,
        onBootstrap() {}, onDispose() {}, translate: (key) => key,
        queryOptions: queryOptionsApi, global: { provider },
      })
    })
    try {
      expect(() => manager!.peek("/failed-storage", { bootstrap: false })).toThrow("synthetic storage failure")
      expect(disposed).toBe(1)
      expect(manager!.children["/failed-storage"]).toBeUndefined()
      expect(manager!.peek("/failed-storage", { bootstrap: false })[0].status).toBe("loading")
      expect(registered).toBe(5)
      expect(disposed).toBe(1)
    } finally {
      dispose()
    }
    expect(disposed).toBe(4)
  })

  test("does not evict the active directory during mark", () => {
    const owner = createRoot((dispose) => {
      const current = getOwner()
      dispose()
      return current
    })
    if (!owner) throw new Error("owner required")

    const manager = createChildStoreManager({
      owner,
      scope: ServerScope.local,
      persist,
      isBooting: () => false,
      isLoadingSessions: () => false,
      onBootstrap() {},
      onDispose() {},
      translate: (key) => key,
      queryOptions: queryOptionsApi,
      global: { provider },
    })

    Array.from({ length: 30 }, (_, index) => `/pinned-${index}`).forEach((directory) => {
      manager.children[directory] = child()
      manager.pin(directory)
    })

    const directory = "/active"
    manager.children[directory] = child()
    manager.mark(directory)

    expect(manager.children[directory]).toBeDefined()
  })

  test("starts new child stores as loading and bootstraps them on first access", () => {
    const bootstraps: string[] = []
    let manager: ReturnType<typeof createChildStoreManager> | undefined

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap(directory) {
          bootstraps.push(directory)
        },
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")

      const [store] = manager.child("/project")

      expect(store.status).toBe("loading")
      expect(store.limit).toBe(5)
      expect(bootstraps).toEqual(["/project"])
    } finally {
      dispose()
    }
  })

  test("provides the requested directory while the path query is pending", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")

      const [store] = manager.child("/project", { bootstrap: false })

      expect(store.path.directory).toBe("/project")
      expect(store.path.worktree).toBe("")
    } finally {
      dispose()
    }
  })

  test("enables MCP status and resource queries only when requested for the directory", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const offset = querySingles.length

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")
      const [store, setStore] = manager.child("/project", { bootstrap: false })
      expect(querySingles.length - offset).toBe(5)
      const query = querySingles[offset + 1]
      const resourceQuery = querySingles[offset + 2]
      if (!query) throw new Error("query required")
      if (!resourceQuery) throw new Error("resource query required")
      expect(query().enabled).toBe(false)
      expect(resourceQuery().enabled).toBe(false)

      setStore("status", "complete")
      manager.child("/project", { bootstrap: false, mcp: true })
      expect(query().enabled).toBe(true)
      expect(resourceQuery().enabled).toBe(true)
      expect(store.mcp).toEqual({ demo: { status: "disabled" } })

      manager.disableMcp("/project")
      expect(query().enabled).toBe(false)
      expect(manager.mcp("/project")).toBe(false)
    } finally {
      dispose()
    }
  })

  test("holds MCP queries while a requested directory is still bootstrapping", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const offset = querySingles.length

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap() {},
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })

    try {
      const [store] = manager!.child("/project", { bootstrap: false, mcp: true })
      const created = querySingles.slice(offset)
      const query = () => created.find((entry) => entry().queryKey?.[1] === "mcp")!()
      const resourceQuery = () => created.find((entry) => entry().queryKey?.[1] === "mcpResources")!()

      expect(store.status).toBe("loading")
      expect(store.mcp_ready).toBe(false)
      expect(query().enabled).toBe(false)
      expect(resourceQuery().enabled).toBe(false)

      // Another consumer may have already started bootstrap, which changes the
      // store from loading -> partial before MCP demand arrives. Partial is
      // still inside the staged startup window and must remain gated too.
      manager!.disableMcp("/project")
      ;(store as { status: State["status"] }).status = "partial"
      manager!.child("/project", { bootstrap: false, mcp: true })
      expect(query().enabled).toBe(false)
      expect(resourceQuery().enabled).toBe(false)
      expect(store.mcp_ready).toBe(false)

      manager!.enableMcpQueries("/project")
      expect(query().enabled).toBe(true)
      expect(resourceQuery().enabled).toBe(true)
      expect(store.mcp).toEqual({ demo: { status: "disabled" } })
    } finally {
      dispose()
    }
  })

  test("keeps non-bootstrapping children passive until a real directory access", () => {
    let manager: ReturnType<typeof createChildStoreManager> | undefined
    const offset = querySingles.length
    const bootstraps: string[] = []

    const dispose = createOwner((owner) => {
      manager = createChildStoreManager({
        owner,
        scope: ServerScope.local,
        persist,
        isBooting: () => false,
        isLoadingSessions: () => false,
        onBootstrap(directory) {
          bootstraps.push(directory)
        },
        onDispose() {},
        translate: (key) => key,
        queryOptions: queryOptionsApi,
        global: { provider },
      })
    })

    try {
      if (!manager) throw new Error("manager required")
      const [store] = manager.child("/project", { bootstrap: false })
      const queries = querySingles.slice(offset)

      expect(queries).toHaveLength(5)
      expect(queries[0]?.().enabled).toBe(false)
      expect(queries[3]?.().enabled).toBe(false)
      expect(queries[4]?.().enabled).toBe(false)
      expect(store.path.directory).toBe("/project")
      expect(store.provider_ready).toBe(false)
      expect(store.lsp_ready).toBe(true)
      expect(store.lsp).toEqual([])
      expect(queries.some((query) => query().queryKey?.[1] === "lsp")).toBe(false)
      expect(bootstraps).toEqual([])

      manager.enableProviderQueries("/project")
      expect(queries[3]?.().enabled).toBe(true)
      expect(queries[0]?.().enabled).toBe(false)
      expect(queries[4]?.().enabled).toBe(false)
      expect(bootstraps).toEqual([])

      manager.child("/project")
      // The narrow catalog can run while runtime auxiliary queries stay gated.
      expect(queries[0]?.().enabled).toBe(false)
      expect(queries[2]?.().enabled).toBe(false)
      expect(queries[3]?.().enabled).toBe(true)
      expect(queries[4]?.().enabled).toBe(false)
      expect(bootstraps).toEqual(["/project"])

      manager.enableQueries("/project")
      expect(queries[0]?.().enabled).toBe(true)
      expect(queries[2]?.().enabled).toBe(false)
      expect(queries[3]?.().enabled).toBe(true)
      expect(queries[4]?.().enabled).toBe(true)

      manager.child("/project", { bootstrap: false })
      expect(queries[0]?.().enabled).toBe(true)
    } finally {
      dispose()
    }
  })
})
