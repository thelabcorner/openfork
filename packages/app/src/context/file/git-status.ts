import { createSignal } from "solid-js"
import type { Kind } from "@/components/file-tree"

type LegacyStatus = {
  path: string
  status: "added" | "deleted" | "modified"
}

type GitStatusStoreOptions = {
  /** Current project scope (directory). Re-read on every access so it is reactive. */
  scope: () => string
  /** Normalize a path to the tree's key convention (forward-slash, root-relative). */
  normalize: (input: string) => string
  /** Fetch the full git status for the current project scope. */
  fetchStatus: () => Promise<LegacyStatus[]>
  onError: (message: string) => void
  /** Debounce window for coalescing watcher invalidations (default 150ms). */
  refreshDelayMs?: number
  /** Maximum time a sustained watcher burst may defer a refresh (default 750ms). */
  refreshMaxWaitMs?: number
}

const LRU_MAX = 5
const DEFAULT_REFRESH_DELAY_MS = 150
const DEFAULT_REFRESH_MAX_WAIT_MS = 750

const toKind = (status: LegacyStatus["status"]): Kind =>
  status === "added" ? "add" : status === "deleted" ? "del" : "mix"

/**
 * Cached + incrementally-invalidated git status for the explorer.
 *
 * - Per-project-scope LRU cache: switching back to a project reuses its map
 *   instead of running a fresh `git status` scan.
 * - Watcher events mark the status snapshot dirty; a debounced refresh
 *   coalesces bursts into one full status query. The endpoint currently only
 *   accepts a full query, so retaining every changed path would be pure memory
 *   overhead rather than an incremental scan.
 */
export function createGitStatusStore(options: GitStatusStoreOptions) {
  const cache = new Map<string, ReadonlyMap<string, Kind>>()
  const [status, setStatus] = createSignal<ReadonlyMap<string, Kind>>()

  let dirty = false
  let dirtySince: number | undefined
  let lastInvalidatedAt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let inflight: { scope: string; promise: Promise<void> } | undefined
  let disposed = false

  const touch = (scope: string) => {
    const value = cache.get(scope)
    if (!value) return
    cache.delete(scope)
    cache.set(scope, value)
  }

  const evict = () => {
    while (cache.size > LRU_MAX) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  }

  const apply = (scope: string, map: ReadonlyMap<string, Kind>) => {
    cache.set(scope, map)
    evict()
    if (options.scope() === scope) setStatus(map)
  }

  const fetch = async (scope: string) => {
    try {
      const list = await options.fetchStatus()
      if (disposed || options.scope() !== scope) return
      apply(scope, new Map(list.map((item) => [options.normalize(item.path), toKind(item.status)])))
    } catch (error) {
      if (disposed || options.scope() !== scope) return
      options.onError(error instanceof Error ? error.message : String(error))
    }
  }

  const startFetch = (scope: string) => {
    if (disposed) return
    if (inflight?.scope === scope) return
    const promise = fetch(scope)
    inflight = { scope, promise }
    void promise.finally(() => {
      if (inflight?.promise !== promise) return
      inflight = undefined
      refresh()
    })
  }

  const refresh = () => {
    const scope = options.scope()
    if (disposed || inflight?.scope === scope) return
    if (!dirty) return
    const now = Date.now()
    dirtySince ??= now
    const quietDelay = options.refreshDelayMs ?? DEFAULT_REFRESH_DELAY_MS
    const maxWait = Math.max(quietDelay, options.refreshMaxWaitMs ?? DEFAULT_REFRESH_MAX_WAIT_MS)
    const quietRemaining = Math.max(0, quietDelay - Math.max(0, now - lastInvalidatedAt))
    const maxRemaining = Math.max(0, maxWait - Math.max(0, now - dirtySince))
    const delay = Math.min(quietRemaining, maxRemaining)

    // This is intentionally a trailing debounce, not the old first-event
    // throttle. Every watcher invalidation moves the quiet-period deadline,
    // while maxWait guarantees a continuously-writing process cannot postpone
    // status indefinitely.
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (disposed) return
      dirty = false
      dirtySince = undefined
      startFetch(options.scope())
    }, delay)
  }

  /** Load the current scope's status, reusing the cache when present. */
  const ensure = () => {
    const scope = options.scope()
    const cached = cache.get(scope)
    if (cached) {
      touch(scope)
      setStatus(cached)
      if (dirty) refresh()
      return
    }
    startFetch(scope)
  }

  /** Mark a single changed path dirty and schedule a debounced re-query. */
  const invalidate = (path: string, options?: { schedule?: boolean }) => {
    if (!path) return
    const now = Date.now()
    dirtySince ??= now
    lastInvalidatedAt = now
    dirty = true
    if (options?.schedule !== false) refresh()
  }

  const dispose = () => {
    disposed = true
    if (timer) clearTimeout(timer)
    timer = undefined
    dirty = false
    dirtySince = undefined
  }

  return { status, ensure, invalidate, dispose }
}
