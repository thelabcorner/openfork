import { untrack } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import type { FileNode } from "@opencode-ai/sdk/v2"

type DirectoryState = {
  expanded: boolean
  loaded?: boolean
  loading?: boolean
  error?: string
  children?: string[]
}

export type TreeSnapshot = {
  node: Record<string, FileNode>
  dir: Record<string, DirectoryState>
}

type TreeStoreOptions = {
  scope: () => string
  normalizeDir: (input: string) => string
  list: (input: string) => Promise<FileNode[]>
  onError: (message: string) => void
  cache?: {
    maxScopes?: number
    maxNodes?: number
    /** Override the LRU backing map (tests only) -- production uses the shared module cache. */
    store?: Map<string, TreeSnapshot>
  }
}

const DEFAULT_MAX_SCOPES = 5
const DEFAULT_MAX_NODES = 50_000
const PREWARM_DELAY_MS = 150

// Module-level (not per-store) so a scope's tree survives a FileProvider remount, not just
// a scope switch within one provider's lifetime. FileProvider is torn down and rebuilt on
// every navigation away from a session and back (e.g. via Home or a draft tab) -- without
// this, that always re-mounts to an empty store and pays a full uncached re-list, even for
// a directory visited seconds ago. Bounded by the same maxScopes/maxNodes eviction as
// before, so a long-lived app session doesn't grow this unbounded. Tests inject their own
// `cache.store` (see createFileTreeStore) so this shared singleton never leaks between them.
const scopeCache = new Map<string, TreeSnapshot>()

export function createFileTreeStore(options: TreeStoreOptions) {
  let currentScope = options.scope()

  // Per-project LRU cache of tree snapshots, keyed by project scope. On a
  // scope switch we save the outgoing project's state here and restore the
  // incoming project's cached state (or start fresh), so switching back to a
  // previously-visited project is instant instead of a full re-list.
  const maxScopes = options.cache?.maxScopes ?? DEFAULT_MAX_SCOPES
  const maxNodes = options.cache?.maxNodes ?? DEFAULT_MAX_NODES
  const cache = options.cache?.store ?? scopeCache
  const initialSnapshot = cache.get(currentScope)

  const [tree, setTree] = createStore<{
    node: Record<string, FileNode>
    dir: Record<string, DirectoryState>
  }>(
    initialSnapshot
      ? { node: { ...initialSnapshot.node }, dir: { ...initialSnapshot.dir } }
      : { node: {}, dir: { "": { expanded: true } } },
  )

  const inflight = new Map<string, Promise<void>>()

  const snapshot = (): TreeSnapshot =>
    untrack(() => ({
      node: { ...tree.node },
      dir: { ...tree.dir },
    }))

  const restore = (snap: TreeSnapshot) => {
    setTree("node", reconcile(snap.node))
    setTree("dir", reconcile(snap.dir))
    if (!tree.dir[""]) setTree("dir", "", { expanded: true })
  }

  const touch = (key: string) => {
    const snap = cache.get(key)
    if (!snap) return
    cache.delete(key)
    cache.set(key, snap)
  }
  // Seeded from the module cache above (if a hit) -- bump it to MRU so a
  // just-reused scope doesn't look like the coldest entry for eviction.
  if (initialSnapshot) touch(currentScope)

  const evict = () => {
    while (cache.size > maxScopes) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    let total = 0
    for (const snap of cache.values()) total += Object.keys(snap.node).length
    while (total > maxNodes && cache.size > 0) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      const snap = cache.get(oldest)
      if (snap) total -= Object.keys(snap.node).length
      cache.delete(oldest)
    }
  }

  const reset = () => {
    inflight.clear()
    setTree("node", reconcile({}))
    setTree("dir", reconcile({}))
    setTree("dir", "", { expanded: true })
  }

  const ensureDir = (path: string) => {
    if (tree.dir[path]) return
    setTree("dir", path, { expanded: false })
  }

  const listDir = (input: string, opts?: { force?: boolean }) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)

    const current = tree.dir[dir]
    if (!opts?.force && current?.loaded) return Promise.resolve()

    const pending = inflight.get(dir)
    if (pending) return pending

    setTree(
      "dir",
      dir,
      produce((draft) => {
        draft.error = undefined
        if (!current?.loaded) draft.loading = true
      }),
    )

    const directory = options.scope()

    const promise = options
      .list(dir)
      .then((nodes) => {
        if (options.scope() !== directory) return
        const prevChildren = tree.dir[dir]?.children ?? []
        const nextChildren = nodes.map((node) => node.path)
        const nextSet = new Set(nextChildren)

        setTree(
          "node",
          produce((draft) => {
            const removedDirs: string[] = []

            for (const child of prevChildren) {
              if (nextSet.has(child)) continue
              const existing = draft[child]
              if (existing?.type === "directory") removedDirs.push(child)
              delete draft[child]
            }

            if (removedDirs.length > 0) {
              const keys = Object.keys(draft)
              for (const key of keys) {
                for (const removed of removedDirs) {
                  if (!key.startsWith(removed + "/")) continue
                  delete draft[key]
                  break
                }
              }
            }

            for (const node of nodes) {
              draft[node.path] = node
            }
          }),
        )

        setTree(
          "dir",
          dir,
          produce((draft) => {
            draft.loaded = true
            draft.loading = false
            draft.children = nextChildren
          }),
        )
      })
      .catch((e) => {
        if (options.scope() !== directory) return
        setTree(
          "dir",
          dir,
          produce((draft) => {
            draft.loading = false
            draft.error = e.message
          }),
        )
        options.onError(e.message)
      })
      .finally(() => {
        inflight.delete(dir)
      })

    inflight.set(dir, promise)
    return promise
  }

  // `list: false` marks a directory expanded without fetching its children, for
  // trees whose nodes are synthesized from a filter; listing directories that
  // only exist on a diff's base branch fails and surfaces error toasts.
  const expandDir = (input: string, behavior?: { list?: boolean }) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree("dir", dir, "expanded", true)
    if (behavior?.list === false) return
    void listDir(dir)
  }

  const collapseDir = (input: string) => {
    const dir = options.normalizeDir(input)
    ensureDir(dir)
    setTree("dir", dir, "expanded", false)
  }

  const dirState = (input: string) => {
    const dir = options.normalizeDir(input)
    return tree.dir[dir]
  }

  const children = (input: string) => {
    const dir = options.normalizeDir(input)
    const ids = tree.dir[dir]?.children
    if (!ids) return []
    const out: FileNode[] = []
    for (const id of ids) {
      const node = tree.node[id]
      if (node) out.push(node)
    }
    return out
  }

  const allNodes = () => Object.values(tree.node)

  // Expand every directory, recursively listing directories that have not
  // been listed yet, so expand-all reaches the full tree — not just the
  // previously listed subset. Level-parallel: each depth costs one
  // round-trip per directory at that depth instead of a serial walk over the
  // whole tree. `listDir` never rejects (errors land in the dir state), so a
  // failing directory just stops that branch.
  const expandAll = async () => {
    const seen = new Set<string>()
    let frontier: string[] = [options.normalizeDir("")]
    while (frontier.length > 0) {
      const next = await Promise.all(
        frontier.map(async (dir) => {
          if (seen.has(dir)) return []
          seen.add(dir)
          ensureDir(dir)
          setTree("dir", dir, "expanded", true)
          await listDir(dir)
          const ids = tree.dir[dir]?.children
          if (!ids) return []
          const subdirs: string[] = []
          for (const id of ids) {
            const node = tree.node[id]
            if (node?.type === "directory") subdirs.push(node.path)
          }
          return subdirs
        }),
      )
      frontier = next.flat()
    }
  }

  const collapseAll = () => {
    for (const dir of Object.keys(tree.dir)) {
      if (dir === "" || !tree.dir[dir]?.children) continue
      setTree("dir", dir, "expanded", false)
    }
  }

  // Prewarm: after switching to a cold project, list the root and its
  // top-level directories in the background (debounced + idle priority) so
  // the pane renders with data ready instead of waiting on the first paint.
  let prewarmTimer: ReturnType<typeof setTimeout> | undefined
  const schedulePrewarm = () => {
    if (prewarmTimer) clearTimeout(prewarmTimer)
    prewarmTimer = setTimeout(() => {
      prewarmTimer = undefined
      void prewarm()
    }, PREWARM_DELAY_MS)
  }

  const prewarm = async () => {
    await listDir("")
    const rootChildren = tree.dir[""]?.children ?? []
    for (const child of rootChildren) {
      const node = tree.node[child]
      if (node?.type === "directory") void listDir(node.path)
    }
  }

  // Called by the consumer when the project scope changes. Saves the outgoing
  // project's tree state into the LRU, restores the incoming project's cached
  // state (or starts fresh + prewarms), and evicts cold entries.
  const switchScope = () => {
    const next = options.scope()
    if (next === currentScope) return
    cache.set(currentScope, snapshot())
    currentScope = next
    inflight.clear()
    const cached = cache.get(next)
    if (cached) {
      touch(next)
      restore(cached)
    } else {
      reset()
      schedulePrewarm()
    }
    evict()
  }

  // Called when the OWNING FileProvider itself is about to unmount (not just a scope
  // switch within it -- see switchScope above). Saves the current scope's tree into the
  // module cache so a future FileProvider mount for the same directory seeds warm instead
  // of starting empty.
  const persist = () => {
    cache.set(currentScope, snapshot())
    touch(currentScope)
    evict()
  }

  // On a cold mount (no cached snapshot), eagerly seed the root and its
  // top-level directories in the background so the tree renders with data on
  // first paint and the first expand of any top-level dir is instant. This
  // previously only happened on scope *switches* — a fresh FileProvider mount
  // left the cold path un-pre-warmed, so the panel opened empty and every
  // first expand paid a round trip.
  if (!initialSnapshot) schedulePrewarm()

  return {
    listDir,
    expandDir,
    collapseDir,
    dirState,
    children,
    allNodes,
    expandAll,
    collapseAll,
    node: (path: string) => tree.node[path],
    isLoaded: (path: string) => Boolean(tree.dir[path]?.loaded),
    reset,
    prewarm,
    switchScope,
    persist,
  }
}
