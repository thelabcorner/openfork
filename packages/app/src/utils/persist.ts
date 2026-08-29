import { Platform, usePlatform } from "@/context/platform"
import { makePersisted, type AsyncStorage, type SyncStorage } from "@solid-primitives/storage"
import { checksum } from "@opencode-ai/core/util/encode"
import { createSignal, onCleanup, type Accessor } from "solid-js"
import { trackPending } from "@/utils/pending-work"
import { unwrap, type SetStoreFunction, type Store } from "solid-js/store"
import { pathKey } from "@/utils/path-key"
import { ScopedKey, ServerScope, type ServerScope as ServerScopeValue } from "@/utils/server-scope"

type InitType = Promise<string> | string | null
type PersistedWithReady<T> = [
  Store<T>,
  SetStoreFunction<T>,
  InitType,
  Accessor<boolean> & { promise: undefined | Promise<any> },
]

type PersistTarget = {
  draft?: boolean
  storage?: string
  scope?: "window"
  legacyStorageNames?: string[]
  key: string
  legacy?: string[]
  migrate?: (value: unknown) => unknown
  defer?: boolean
}

const LEGACY_STORAGE = "default.dat"
const GLOBAL_STORAGE = "opencode.global.dat"
const WINDOW_STORAGE = "opencode.window"
const LOCAL_PREFIX = "opencode."
const fallback = new Map<string, boolean>()

const CACHE_MAX_ENTRIES = 500
const CACHE_MAX_BYTES = 8 * 1024 * 1024

type CacheEntry = { value: string; bytes: number }
const cache = new Map<string, CacheEntry>()
const cacheTotal = { bytes: 0 }

function cacheDelete(key: string) {
  const entry = cache.get(key)
  if (!entry) return
  cacheTotal.bytes -= entry.bytes
  cache.delete(key)
}

function cachePrune() {
  for (;;) {
    if (cache.size <= CACHE_MAX_ENTRIES && cacheTotal.bytes <= CACHE_MAX_BYTES) return
    const oldest = cache.keys().next().value as string | undefined
    if (!oldest) return
    cacheDelete(oldest)
  }
}

function cacheSet(key: string, value: string) {
  const bytes = value.length * 2
  if (bytes > CACHE_MAX_BYTES) {
    cacheDelete(key)
    return
  }

  const entry = cache.get(key)
  if (entry) cacheTotal.bytes -= entry.bytes
  cache.delete(key)
  cache.set(key, { value, bytes })
  cacheTotal.bytes += bytes
  cachePrune()
}

function cacheGet(key: string) {
  const entry = cache.get(key)
  if (!entry) return
  cache.delete(key)
  cache.set(key, entry)
  return entry.value
}

const DRAFT_DEBOUNCE_MS = 500
const pendingDraftWrites = new Map<string, { timer: ReturnType<typeof setTimeout>; value: string }>()
let draftFlushListenersInstalled = false

function flushPendingDraftWrites(draft: AsyncStorage) {
  for (const [key, pending] of pendingDraftWrites) {
    clearTimeout(pending.timer)
    pendingDraftWrites.delete(key)
    void draft.setItem(key, pending.value)
  }
}

function ensureDraftFlushListeners(draft: AsyncStorage) {
  if (draftFlushListenersInstalled) return
  draftFlushListenersInstalled = true
  const flush = () => flushPendingDraftWrites(draft)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush()
  })
  window.addEventListener("pagehide", flush)
  window.addEventListener("beforeunload", flush)
}

function createDebouncedDraftStorage(draft: AsyncStorage, prefix: string): AsyncStorage {
  ensureDraftFlushListeners(draft)
  return {
    getItem: (key) => draft.getItem(prefix + key),
    setItem: (key, value) => {
      const fullKey = prefix + key
      const existing = pendingDraftWrites.get(fullKey)
      if (existing) clearTimeout(existing.timer)
      const timer = setTimeout(() => {
        pendingDraftWrites.delete(fullKey)
        void draft.setItem(fullKey, value)
      }, DRAFT_DEBOUNCE_MS)
      pendingDraftWrites.set(fullKey, { timer, value })
      return Promise.resolve()
    },
    removeItem: (key) => {
      const fullKey = prefix + key
      const existing = pendingDraftWrites.get(fullKey)
      if (existing) {
        clearTimeout(existing.timer)
        pendingDraftWrites.delete(fullKey)
      }
      return draft.removeItem(fullKey)
    },
  }
}

const GENERAL_DEBOUNCE_MS = 120
const pendingGeneralFlushes = new Set<() => void>()
let generalFlushListenersInstalled = false

function flushPendingGeneralWrites() {
  for (const flush of pendingGeneralFlushes) flush()
}

function ensureGeneralFlushListeners() {
  if (generalFlushListenersInstalled) return
  generalFlushListenersInstalled = true
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingGeneralWrites()
  })
  window.addEventListener("pagehide", flushPendingGeneralWrites)
  window.addEventListener("beforeunload", flushPendingGeneralWrites)
}

function fallbackDisabled(scope: string) {
  return fallback.get(scope) === true
}

function fallbackSet(scope: string) {
  fallback.set(scope, true)
}

function quota(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "QuotaExceededError") return true
    if (error.name === "NS_ERROR_DOM_QUOTA_REACHED") return true
    if (error.name === "QUOTA_EXCEEDED_ERR") return true
    if (error.code === 22 || error.code === 1014) return true
    return false
  }

  if (!error || typeof error !== "object") return false
  const name = (error as { name?: string }).name
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return true
  if (name && /quota/i.test(name)) return true

  const code = (error as { code?: number }).code
  if (code === 22 || code === 1014) return true

  const message = (error as { message?: string }).message
  if (typeof message !== "string") return false
  if (/quota/i.test(message)) return true
  return false
}

type Evict = { key: string; size: number }

function evict(storage: Storage, keep: string, value: string) {
  const total = storage.length
  const indexes = Array.from({ length: total }, (_, index) => index)
  const items: Evict[] = []

  for (const index of indexes) {
    const name = storage.key(index)
    if (!name) continue
    if (!name.startsWith(LOCAL_PREFIX)) continue
    if (name === keep) continue
    const stored = storage.getItem(name)
    items.push({ key: name, size: stored?.length ?? 0 })
  }

  items.sort((a, b) => b.size - a.size)

  for (const item of items) {
    storage.removeItem(item.key)
    cacheDelete(item.key)

    try {
      storage.setItem(keep, value)
      cacheSet(keep, value)
      return true
    } catch (error) {
      if (!quota(error)) throw error
    }
  }

  return false
}

function write(storage: Storage, key: string, value: string) {
  try {
    storage.setItem(key, value)
    cacheSet(key, value)
    return true
  } catch (error) {
    if (!quota(error)) throw error
  }

  try {
    storage.removeItem(key)
    cacheDelete(key)
    storage.setItem(key, value)
    cacheSet(key, value)
    return true
  } catch (error) {
    if (!quota(error)) throw error
  }

  const ok = evict(storage, key, value)
  return ok
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isShallowDefault(value: unknown) {
  if (value === null || typeof value !== "object") return true
  if (Array.isArray(value)) {
    if (value.length > 4) return false
    return value.every((item) => {
      if (item === null || typeof item !== "object") return true
      return isRecord(item) && Object.keys(item).length <= 8
    })
  }
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length > 8) return false
  return keys.every((key) => {
    const item = value[key]
    return item === null || typeof item !== "object" || (Array.isArray(item) && item.length === 0)
  })
}

function cloneValue(value: unknown) {
  const sc = globalThis.structuredClone
  if (typeof sc === "function") {
    try {
      return sc(value)
    } catch {}
  }
  return JSON.parse(JSON.stringify(value)) as unknown
}

function snapshot(value: unknown) {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) {
    if (value.length === 0) return []
    return cloneValue(value)
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 0) return {}
  if (keys.length <= 24 && keys.every((key) => isShallowDefault(record[key]))) {
    const out: Record<string, unknown> = {}
    for (const key of keys) {
      const item = record[key]
      out[key] = Array.isArray(item) ? item.slice() : isRecord(item) ? { ...item } : item
    }
    return out
  }
  return cloneValue(value)
}

function merge(defaults: unknown, value: unknown): unknown {
  if (value === undefined) return defaults
  if (value === null) return value

  if (Array.isArray(defaults)) {
    if (Array.isArray(value)) return value
    return defaults
  }

  if (!isRecord(defaults)) return value
  if (!isRecord(value)) return defaults

  let missing = false
  let nested = false
  for (const key of Object.keys(defaults)) {
    if (!(key in value)) {
      missing = true
      break
    }
    if (isRecord(defaults[key])) nested = true
  }
  if (!missing && !nested) return value

  const result: Record<string, unknown> = { ...defaults }
  for (const key of Object.keys(value)) {
    if (key in defaults) {
      result[key] = merge(defaults[key], value[key])
    } else {
      result[key] = value[key]
    }
  }
  return result
}

function parse(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function normalize(defaults: unknown, raw: string, migrate?: (value: unknown) => unknown) {
  const parsed = parse(raw)
  if (parsed === undefined) return
  const migrated = migrate ? migrate(parsed) : parsed
  if (!migrate && isRecord(defaults) && isRecord(parsed)) {
    let missing = false
    for (const key of Object.keys(defaults)) {
      if (!(key in parsed)) {
        missing = true
        break
      }
    }
    if (!missing) return raw
  }
  const merged = merge(defaults, migrated)
  return JSON.stringify(merged)
}

function readCurrent(input: {
  storage: SyncStorage
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}) {
  const raw = input.storage.getItem(input.key)
  if (raw === null) return
  const next = normalize(input.defaults, raw, input.migrate)
  if (next === undefined) {
    input.storage.removeItem(input.key)
    return null
  }
  return next
}

function migrateLegacy(input: {
  current: SyncStorage
  legacyStore?: SyncStorage
  stores: SyncStorage[]
  keys: string[]
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}) {
  for (const store of input.stores) {
    const raw = store.getItem(input.key)
    if (raw === null) continue

    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      store.removeItem(input.key)
      continue
    }
    input.current.setItem(input.key, next)
    store.removeItem(input.key)
    return next
  }

  if (!input.legacyStore) return null

  for (const key of input.keys) {
    const raw = input.legacyStore.getItem(key)
    if (raw === null) continue

    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      input.legacyStore.removeItem(key)
      continue
    }
    input.current.setItem(input.key, next)
    input.legacyStore.removeItem(key)
    return next
  }

  return null
}

async function readCurrentAsync(input: {
  storage: AsyncStorage
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}) {
  const raw = await input.storage.getItem(input.key)
  if (raw === null) return
  const next = normalize(input.defaults, raw, input.migrate)
  if (next === undefined) {
    await input.storage.removeItem(input.key).catch(() => undefined)
    return null
  }
  return next
}

async function removeAsync(storage: AsyncStorage, key: string) {
  try {
    await storage.removeItem(key)
  } catch {}
}

function toAsyncStorage(storage: SyncStorage | AsyncStorage): AsyncStorage {
  return {
    getItem: async (key) => storage.getItem(key),
    setItem: async (key, value) => storage.setItem(key, value),
    removeItem: async (key) => storage.removeItem(key),
  }
}

async function migrateLegacyAsync(input: {
  current: AsyncStorage
  legacyStore?: AsyncStorage
  stores: AsyncStorage[]
  keys: string[]
  key: string
  defaults: unknown
  migrate?: (value: unknown) => unknown
}) {
  for (const store of input.stores) {
    const raw = await store.getItem(input.key)
    if (raw === null) continue

    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      await removeAsync(store, input.key)
      continue
    }
    await input.current.setItem(input.key, next)
    await store.removeItem(input.key)
    return next
  }

  if (!input.legacyStore) return null

  for (const key of input.keys) {
    const raw = await input.legacyStore.getItem(key)
    if (raw === null) continue

    const next = normalize(input.defaults, raw, input.migrate)
    if (next === undefined) {
      await removeAsync(input.legacyStore, key)
      continue
    }
    await input.current.setItem(input.key, next)
    await input.legacyStore.removeItem(key)
    return next
  }

  return null
}

function workspaceStorage(dir: string) {
  const head = (dir.slice(0, 12) || "workspace").replace(/[^a-zA-Z0-9._-]/g, "-")
  const sum = checksum(dir) ?? "0"
  return `opencode.workspace.${head}.${sum}.dat`
}

function draftStorage(draftID: string) {
  const head = (draftID.slice(0, 12) || "draft").replace(/[^a-zA-Z0-9._-]/g, "-")
  const sum = checksum(draftID) ?? "0"
  return `opencode.draft.${head}.${sum}.dat`
}

function windowStorage(windowID: string) {
  const safe = (windowID || "browser").replace(/[^a-zA-Z0-9._-]/g, "-")
  return `${WINDOW_STORAGE}.${safe}.dat`
}

function legacyWorkspaceStorage(dir: string) {
  const storage = workspaceStorage(pathKey(dir))
  const result = new Set<string>()
  const raw = workspaceStorage(dir)
  if (raw !== storage) result.add(raw)

  const key = pathKey(dir)
  const drive = key.length >= 3 && key[1] === ":" && key[2] === "/"
  if (drive) {
    const backslash = workspaceStorage(key.replaceAll("/", "\\"))
    if (backslash !== storage) result.add(backslash)
  }

  if (result.size === 0) return
  return [...result]
}

function serverWorkspaceTarget(scope: ServerScopeValue, dir: string, key: string, legacy?: string[]): PersistTarget {
  if (scope !== ServerScope.local)
    return { storage: workspaceStorage(ScopedKey.from(scope, pathKey(dir))), key, defer: true }
  return { storage: workspaceStorage(pathKey(dir)), legacyStorageNames: legacyWorkspaceStorage(dir), key, legacy, defer: true }
}

function localStorageWithPrefix(prefix: string): SyncStorage {
  const base = `${prefix}:`
  const scope = `prefix:${prefix}`
  const item = (key: string) => base + key
  return {
    getItem: (key) => {
      const name = item(key)
      const cached = cacheGet(name)
      if (fallbackDisabled(scope)) return cached ?? null

      const stored = (() => {
        try {
          return localStorage.getItem(name)
        } catch {
          fallbackSet(scope)
          return null
        }
      })()
      if (stored === null) return cached ?? null
      cacheSet(name, stored)
      return stored
    },
    setItem: (key, value) => {
      const name = item(key)
      if (fallbackDisabled(scope)) return
      try {
        if (write(localStorage, name, value)) return
      } catch {
        fallbackSet(scope)
        return
      }
      fallbackSet(scope)
    },
    removeItem: (key) => {
      const name = item(key)
      cacheDelete(name)
      if (fallbackDisabled(scope)) return
      try {
        localStorage.removeItem(name)
      } catch {
        fallbackSet(scope)
      }
    },
  }
}

function localStorageDirect(): SyncStorage {
  const scope = "direct"
  return {
    getItem: (key) => {
      const cached = cacheGet(key)
      if (fallbackDisabled(scope)) return cached ?? null

      const stored = (() => {
        try {
          return localStorage.getItem(key)
        } catch {
          fallbackSet(scope)
          return null
        }
      })()
      if (stored === null) return cached ?? null
      cacheSet(key, stored)
      return stored
    },
    setItem: (key, value) => {
      if (fallbackDisabled(scope)) return
      try {
        if (write(localStorage, key, value)) return
      } catch {
        fallbackSet(scope)
        return
      }
      fallbackSet(scope)
    },
    removeItem: (key) => {
      cacheDelete(key)
      if (fallbackDisabled(scope)) return
      try {
        localStorage.removeItem(key)
      } catch {
        fallbackSet(scope)
      }
    },
  }
}

const DRAFT_PERSISTED_KEYS = ["prompt", "comments", "file-view", "layout"]

export function draftPersistedKeys() {
  return DRAFT_PERSISTED_KEYS
}

export const PersistTesting = {
  localStorageDirect,
  localStorageWithPrefix,
  migrateLegacy,
  normalize,
  resolveTarget,
  windowStorage,
  workspaceStorage,
}

export const Persist = {
  global(key: string, legacy?: string[]): PersistTarget {
    return { storage: GLOBAL_STORAGE, key, legacy }
  },
  window(key: string, legacy?: string[]): PersistTarget {
    return { scope: "window", key, legacy }
  },
  draft(draftID: string, key: string, legacy?: string[]): PersistTarget {
    return { storage: draftStorage(draftID), key: `draft:${key}`, legacy }
  },
  serverGlobal(scope: ServerScopeValue, key: string, legacy?: string[]): PersistTarget {
    if (scope === ServerScope.local) return Persist.global(key, legacy)
    return { storage: GLOBAL_STORAGE, key: ScopedKey.from(scope, key) }
  },
  workspace(dir: string, key: string, legacy?: string[]): PersistTarget {
    return serverWorkspaceTarget(ServerScope.local, dir, `workspace:${key}`, legacy)
  },
  serverWorkspace(scope: ServerScopeValue, dir: string, key: string, legacy?: string[]): PersistTarget {
    return serverWorkspaceTarget(scope, dir, `workspace:${key}`, legacy)
  },
  session(dir: string, session: string, key: string, legacy?: string[]): PersistTarget {
    return serverWorkspaceTarget(ServerScope.local, dir, `session:${session}:${key}`, legacy)
  },
  serverSession(scope: ServerScopeValue, dir: string, session: string, key: string, legacy?: string[]): PersistTarget {
    return serverWorkspaceTarget(scope, dir, `session:${session}:${key}`, legacy)
  },
  scoped(dir: string, session: string | undefined, key: string, legacy?: string[]): PersistTarget {
    if (session) return Persist.session(dir, session, key, legacy)
    return Persist.workspace(dir, key, legacy)
  },
  serverScoped(scope: ServerScopeValue, dir: string, session: string | undefined, key: string, legacy?: string[]) {
    if (session) return Persist.serverSession(scope, dir, session, key, legacy)
    return Persist.serverWorkspace(scope, dir, key, legacy)
  },
  prompt(target: PersistTarget): PersistTarget {
    return { ...target, draft: true, defer: true }
  },
}

function resolveTarget(target: PersistTarget, platform: Platform): PersistTarget {
  if (target.scope !== "window") return target
  if (platform.platform === "desktop" && !platform.windowID) return { ...target, storage: GLOBAL_STORAGE }
  const windowID = platform.platform === "desktop" ? (platform.windowID ?? "browser") : "browser"
  return {
    ...target,
    storage: windowStorage(windowID),
  }
}

export function removePersisted(
  target: { draft?: boolean; storage?: string; legacyStorageNames?: string[]; key: string },
  platform?: Platform,
) {
  if (target.draft && platform?.draftStore) {
    const fullKey = `${target.storage ?? "default"}:${target.key}`
    const pending = pendingDraftWrites.get(fullKey)
    if (pending) {
      clearTimeout(pending.timer)
      pendingDraftWrites.delete(fullKey)
    }
    void platform.draftStore.removeItem(fullKey)
  }
  const isDesktop = platform?.platform === "desktop" && !!platform.storage

  if (isDesktop) {
    void platform.storage?.(target.storage)?.removeItem(target.key)
    for (const storage of target.legacyStorageNames ?? []) {
      void platform.storage?.(storage)?.removeItem(target.key)
    }
    return
  }

  if (!target.storage) {
    localStorageDirect().removeItem(target.key)
    return
  }

  localStorageWithPrefix(target.storage).removeItem(target.key)
  for (const storage of target.legacyStorageNames ?? []) {
    localStorageWithPrefix(storage).removeItem(target.key)
  }
}

export function persisted<T>(
  target: string | PersistTarget,
  store: [Store<T>, SetStoreFunction<T>],
  platformOverride?: Platform,
): PersistedWithReady<T> {
  const platform = platformOverride ?? usePlatform()
  const config = resolveTarget(typeof target === "string" ? { key: target } : target, platform)

  const defaults = snapshot(store[0])
  const legacy = config.legacy ?? []

  const isDesktop = platform.platform === "desktop" && !!platform.storage
  const draft = config.draft ? platform.draftStore : undefined

  const currentStorage = (() => {
    if (draft) {
      const prefix = `${config.storage ?? "default"}:`
      return createDebouncedDraftStorage(draft, prefix)
    }
    if (isDesktop) return platform.storage?.(config.storage)
    if (!config.storage) return localStorageDirect()
    return localStorageWithPrefix(config.storage)
  })()

  const legacyStorage = (() => {
    if (!isDesktop) return localStorageDirect()
    if (!config.storage) return platform.storage?.()
    return platform.storage?.(LEGACY_STORAGE)
  })()

  const legacyStorageNames = config.legacyStorageNames ?? []

  const storage = (() => {
    if (!isDesktop && !draft) {
      const current = currentStorage as SyncStorage
      const legacyStore = legacyStorage as SyncStorage
      const legacyStores = legacyStorageNames.map(localStorageWithPrefix)

      const api: SyncStorage = {
        getItem: (key) => {
          const value = readCurrent({ storage: current, key, defaults, migrate: config.migrate })
          if (value !== undefined) return value
          return migrateLegacy({
            current,
            legacyStore,
            stores: legacyStores,
            keys: legacy,
            key,
            defaults,
            migrate: config.migrate,
          })
        },
        setItem: (key, value) => {
          current.setItem(key, value)
        },
        removeItem: (key) => {
          current.removeItem(key)
        },
      }

      return api
    }

    const current = currentStorage as AsyncStorage
    const legacyStore = legacyStorage as AsyncStorage | undefined
    const oldCurrent = draft
      ? isDesktop
        ? platform.storage?.(config.storage)
        : config.storage
          ? localStorageWithPrefix(config.storage)
          : localStorageDirect()
      : undefined
    const legacyStores = [
      oldCurrent,
      ...legacyStorageNames.map((name) => (isDesktop ? platform.storage?.(name) : localStorageWithPrefix(name))),
    ]
      .filter((x) => !!x)
      .map(toAsyncStorage)
    let draftLatest: string | undefined

    const api: AsyncStorage = {
      getItem: async (key) => {
        const value = await readCurrentAsync({ storage: current, key, defaults, migrate: config.migrate })
        if (value !== undefined) return value
        const migrated = await migrateLegacyAsync({
          current,
          legacyStore,
          stores: legacyStores,
          keys: legacy,
          key,
          defaults,
          migrate: config.migrate,
        })
        if (draftLatest === undefined) {
          if (draft && migrated !== null) return (await current.getItem(key)) ?? migrated
          return migrated
        }
        await current.setItem(key, draftLatest)
        return draftLatest
      },
      setItem: async (key, value) => {
        if (draft) draftLatest = value
        await current.setItem(key, value)
      },
      removeItem: async (key) => {
        await current.removeItem(key)
      },
    }

    return api
  })()

  const reader = config.defer
    ? {
        getItem: async (key: string) => {
          await afterPaint()
          return (storage as { getItem: (k: string) => unknown }).getItem(key)
        },
        setItem: () => {},
        removeItem: (key: string) => (storage as { removeItem: (k: string) => unknown }).removeItem(key),
      }
    : {
        getItem: (key: string) => (storage as { getItem: (k: string) => unknown }).getItem(key),
        setItem: () => {},
        removeItem: (key: string) => (storage as { removeItem: (k: string) => unknown }).removeItem(key),
      }

  const [state, setStateRaw, init] = makePersisted(store, {
    name: config.key,
    storage: reader as never,
    serialize: () => "",
    deserialize: (v: string) => {
      try {
        return JSON.parse(v) as T
      } catch {
        return undefined as T
      }
    },
  }) as unknown as [Store<T>, SetStoreFunction<T>, InitType]

  const isAsync = init instanceof Promise
  if (isAsync && !config.defer) {
    const done = trackPending(`persist:${config.key}`)
    void (init as Promise<unknown>).finally(done)
  }
  const [ready, setReady] = createSignal(!isAsync)
  if (isAsync) {
    void (init as Promise<unknown>).then(
      () => setReady(true),
      () => setReady(true),
    )
  }

  let hydrated = !isAsync
  let dirty = false
  let lastJson: string | undefined
  let writeTimer: ReturnType<typeof setTimeout> | undefined
  let idleHandle: number | undefined
  const cancelIdle =
    typeof globalThis.cancelIdleCallback === "function" ? globalThis.cancelIdleCallback.bind(globalThis) : undefined
  const requestIdle =
    typeof globalThis.requestIdleCallback === "function" ? globalThis.requestIdleCallback.bind(globalThis) : undefined

  const cancelWrite = () => {
    if (writeTimer !== undefined) clearTimeout(writeTimer)
    writeTimer = undefined
    if (idleHandle !== undefined) cancelIdle?.(idleHandle)
    idleHandle = undefined
  }

  const flushWrite = () => {
    if (!dirty) return
    dirty = false
    cancelWrite()
    try {
      const json = persistJson(unwrap(state as unknown as Store<unknown>))
      if (json === lastJson) return
      lastJson = json
      void (storage as unknown as { setItem: (k: string, v: string) => unknown }).setItem(config.key, json)
    } catch {}
  }

  const scheduleWrite = () => {
    dirty = true
    if (writeTimer !== undefined) clearTimeout(writeTimer)
    writeTimer = setTimeout(() => {
      writeTimer = undefined
      if (requestIdle) {
        idleHandle = requestIdle(
          () => {
            idleHandle = undefined
            flushWrite()
          },
          { timeout: 250 },
        )
        return
      }
      flushWrite()
    }, GENERAL_DEBOUNCE_MS)
  }

  if (isAsync) {
    void (init as Promise<unknown>).then(() => {
      hydrated = true
    })
  }

  ensureGeneralFlushListeners()
  pendingGeneralFlushes.add(flushWrite)
  onCleanup(() => {
    pendingGeneralFlushes.delete(flushWrite)
    flushWrite()
  })

  const setState = ((...args: never[]) => {
    const result = (setStateRaw as (...input: never[]) => unknown)(...args)
    if (hydrated) scheduleWrite()
    return result
  }) as typeof setStateRaw

  return [
    state,
    setState,
    init,
    Object.assign(() => ready(), {
      promise: init instanceof Promise ? init : undefined,
    }),
  ]
}

const HISTORY_PERSIST_CAP = 100

function persistJson(value: unknown) {
  if (isRecord(value) && Array.isArray(value.entries) && value.entries.length > HISTORY_PERSIST_CAP) {
    return JSON.stringify({ ...value, entries: value.entries.slice(0, HISTORY_PERSIST_CAP) })
  }
  return JSON.stringify(value)
}

function afterPaint() {
  return new Promise<void>((resolve) => {
    const raf = globalThis.requestAnimationFrame
    if (typeof raf === "function") {
      raf(() => resolve())
      return
    }
    setTimeout(resolve, 0)
  })
}
