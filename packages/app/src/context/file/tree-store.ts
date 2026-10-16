import { batch, createSignal, untrack } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { perf } from "@/context/perf"

type DirectoryState = {
  expanded: boolean
  loaded?: boolean
  loadedEpoch?: number
  loading?: boolean
  error?: string
  children?: string[]
}

export type TreeSnapshot = {
  node: Record<string, FileNode>
  dir: Record<string, DirectoryState>
  /** Cached so LRU eviction never rescans every snapshot's node map. */
  nodeCount?: number
  /** Preserve watcher-loss staleness across provider remounts. */
  stale?: boolean
  /**
   * The `loadedEpoch` value the saved `dir` entries were loaded at. Persisted
   * alongside the snapshot because every directory's freshness is the pair
   * (`loaded`, `loadedEpoch === staleEpoch()`). Saving only `stale` and
   * re-deriving the epoch as `stale ? 1 : 0` compared directory epochs from the
   * previous store against a counter that had restarted at 0 -- so a snapshot
   * taken at epoch 3 restored as entirely not-loaded and the whole tree
   * re-listed on switch-back, silently defeating the scope cache.
   */
  loadedEpoch?: number
}

type TreeStoreOptions = {
  scope: () => string
  /** Cache identity may be wider than the filesystem directory (for example server + directory). */
  cacheScope?: () => string
  normalizeDir: (input: string) => string
  list: (input: string, priority: "interactive" | "background") => Promise<FileNode[]>
  /** Promote an already-admitted backend request without creating a duplicate. */
  promote?: (input: string) => void
  onError: (message: string) => void
  cache?: {
    maxScopes?: number
    maxNodes?: number
    /** Live-tree ceiling. Kept separate from the snapshot budget. */
    maxLiveNodes?: number
    /** Override the LRU backing map (tests only) -- production uses the shared module cache. */
    store?: Map<string, TreeSnapshot>
  }
}

const DEFAULT_MAX_SCOPES = 5
const DEFAULT_MAX_NODES = 50_000
const DIRECTORY_LIST_CONCURRENCY = 4
const BACKGROUND_LIST_CONCURRENCY = DIRECTORY_LIST_CONCURRENCY - 1
const MAX_QUEUED_LIST_REQUESTS = 1024
const MAX_QUEUED_BACKGROUND_REQUESTS = 256
const MAX_CHILD_CACHE_ENTRIES = 8192
const WARM_SNAPSHOT_MAX_NODES = 1024
const WARM_SNAPSHOT_MAX_DIRECTORIES = 96

/** File-list metadata equality: preserve identity when a watcher reports no change. */
function sameFileNode(previous: FileNode | undefined, node: FileNode) {
  return Boolean(
    previous &&
    previous.name === node.name &&
    previous.path === node.path &&
    previous.absolute === node.absolute &&
    previous.type === node.type &&
    previous.ignored === node.ignored &&
    previous.size === node.size &&
    previous.mtime === node.mtime &&
    previous.lineCount === node.lineCount,
  )
}

/**
 * Outcome of an expandAll run. `truncated` is the signal that used to be
 * missing: when the scheduler queue overflows, requests are dropped without an
 * answer, and the affected branches must be reported rather than silently
 * excluded from the expansion.
 */
export type ExpandAllResult = {
  /** True when at least one directory could not be listed. */
  truncated: boolean
  /** Directories this run could not list -- retryable, and user-reportable. */
  droppedDirectories: string[]
  /** Directories this run visited. */
  expanded: number
  /** Directories this run actually listed (expanded - dropped). */
  reached: number
}
// Cancellation is not an authoritative empty directory response.
const CANCELLED_LIST: FileNode[] = []

async function mapLimited<A, B>(
  items: readonly A[],
  fn: (item: A, index: number) => Promise<B>,
  concurrency = DIRECTORY_LIST_CONCURRENCY,
): Promise<B[]> {
  const results: B[] = []
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

// Module-level (not per-store) so a scope's tree survives a FileProvider remount, not just
// a scope switch within one provider's lifetime. FileProvider is torn down and rebuilt on
// every navigation away from a session and back (e.g. via Home or a draft tab) -- without
// this, that always re-mounts to an empty store and pays a full uncached re-list, even for
// a directory visited seconds ago. Bounded by the same maxScopes/maxNodes eviction as
// before, so a long-lived app session doesn't grow this unbounded. Tests inject their own
// `cache.store` (see createFileTreeStore) so this shared singleton never leaks between them.
const scopeCache = new Map<string, TreeSnapshot>()

export function createFileTreeStore(options: TreeStoreOptions) {
  const cacheScope = () => options.cacheScope?.() ?? options.scope()
  let currentScope = cacheScope()

  // Per-project LRU cache of tree snapshots, keyed by project scope. On a
  // scope switch we save the outgoing project's state here and restore the
  // incoming project's cached state (or start fresh), so switching back to a
  // previously-visited project is instant instead of a full re-list.
  const maxScopes = options.cache?.maxScopes ?? DEFAULT_MAX_SCOPES
  const maxNodes = options.cache?.maxNodes ?? DEFAULT_MAX_NODES
  const maxLiveNodes = options.cache?.maxLiveNodes ?? DEFAULT_MAX_NODES
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

  const inflight = new Map<string, { promise: Promise<void>; generation: number }>()
  let disposed = false
  let generation = 0
  const emptyChildren: FileNode[] = []
  const childCache = new Map<string, { ids: readonly string[]; nodes: FileNode[] }>()
  const directoryTouches = new Map<string, number>()
  let touchClock = 0
  const [nodeVersion, bumpNodeVersion] = createSignal(0)
  // Domain-owned journal of structural changes, so presentation consumers
  // can update a changed branch rather than reflattening unrelated folders.
  const [viewVersion, setViewVersion] = createSignal(0)
  const viewChanges: Array<{
    revision: number
    directory?: string
    removedRoots: readonly string[]
    convertedDirectories: readonly string[]
  }> = []
  const recordViewChange = (
    directory?: string,
    removedRoots: readonly string[] = [],
    convertedDirectories: readonly string[] = [],
  ) => {
    const revision = viewVersion() + 1
    viewChanges.push({ revision, directory, removedRoots, convertedDirectories })
    if (viewChanges.length > 256) viewChanges.splice(0, viewChanges.length - 256)
    setViewVersion(revision)
  }
  const changesSince = (revision: number) => {
    const current = viewVersion()
    if (revision === current) return {
      revision: current, directories: [] as string[], removedRoots: [] as string[],
      convertedDirectories: [] as string[],
    }
    const first = viewChanges[0]?.revision
    if (revision < 0 || first === undefined || revision < first - 1) return
    const changes = viewChanges.filter((change) => change.revision > revision)
    if (changes.some((change) => change.directory === undefined)) return
    return {
      revision: current,
      directories: changes.map((change) => change.directory!),
      // Only authoritative completed directory listings report removals.
      // A scope reset, eviction or collapsed presentation node must never
      // become evidence that a file ceased to exist on disk.
      removedRoots: changes.flatMap((change) => change.removedRoots),
      convertedDirectories: changes.flatMap((change) => change.convertedDirectories),
    }
  }
  // Search walks asynchronously in cooperative slices. Never hand it the
  // mutable index array: a simultaneous directory refresh can swap-delete
  // or append nodes midway through a generation, making it skip/duplicate
  // candidates. Copy only on demand, once per index revision.
  let searchIndexVersion = -1
  let searchIndexSnapshot: readonly FileNode[] = []
  // Resume the persisted epoch rather than restarting at 0/1. Directory
  // freshness is (`loaded`, `loadedEpoch === staleEpoch()`), so the restored
  // epoch must be the same one the restored `loadedEpoch`s were written under.
  const [staleEpoch, setStaleEpoch] = createSignal(initialSnapshot?.loadedEpoch ?? (initialSnapshot?.stale ? 1 : 0))
  let nodeIndex: FileNode[] = initialSnapshot ? Object.values(initialSnapshot.node) : []
  const nodePositions = new Map<string, number>(nodeIndex.map((node, index) => [node.path, index]))

  const upsertNodeIndex = (node: FileNode) => {
    const index = nodePositions.get(node.path)
    if (index === undefined) {
      nodePositions.set(node.path, nodeIndex.length)
      nodeIndex.push(node)
      return
    }
    nodeIndex[index] = node
  }

  const removeNodeIndex = (path: string) => {
    const index = nodePositions.get(path)
    if (index === undefined) return
    const lastIndex = nodeIndex.length - 1
    const last = nodeIndex[lastIndex]
    if (index !== lastIndex && last) {
      nodeIndex[index] = last
      nodePositions.set(last.path, index)
    }
    nodeIndex.pop()
    nodePositions.delete(path)
  }

  const rebuildNodeIndex = (nodes: Record<string, FileNode>) => {
    nodeIndex = Object.values(nodes)
    nodePositions.clear()
    for (const [index, node] of nodeIndex.entries()) nodePositions.set(node.path, index)
  }

  const touchDirectory = (directory: string) => {
    directoryTouches.set(directory, ++touchClock)
  }

  /**
   * Number of nodes reachable below each directory, excluding the directory's
   * own node. Maintained incrementally so trimLiveTree can pick victims by the
   * size of the subtree it is about to drop, instead of walking each candidate
   * subtree in turn to discover that number.
   *
   * Only directories that have ever had `children` carry an entry; absence
   * means 0. The map is authoritative at the entry points that matter (after a
   * listing commit and after a trim), and trimLiveTree treats it as advisory
   * input for victim ORDERING only -- correctness never depends on it.
   */
  const subtreeSizes = new Map<string, number>()
  const subtreeSize = (directory: string) => subtreeSizes.get(directory) ?? 0

  /** Recompute `directory`'s own subtree size from its current children. */
  const refreshSubtreeSize = (directory: string) => {
    let size = 0
    for (const child of tree.dir[directory]?.children ?? []) {
      size += 1 + (tree.node[child]?.type === "directory" ? subtreeSize(child) : 0)
    }
    if (size === 0) subtreeSizes.delete(directory)
    else subtreeSizes.set(directory, size)
  }

  /**
   * A directory's children changed: recompute it, then fold the delta into every
   * ancestor so the ancestor sizes stay consistent without a full recompute.
   * Ancestors are derived by walking the path, which is bounded by tree depth,
   * not by tree size.
   */
  const propagateSubtreeSize = (directory: string, previous: number) => {
    refreshSubtreeSize(directory)
    const next = subtreeSize(directory)
    const delta = next - previous
    if (delta === 0 || directory === "") return
    // Walk every strict ancestor up to and including the root "". A top-level
    // directory like "src" has no "/" but still belongs to the root, so the
    // loop is prefix-driven rather than cut-driven.
    let prefix = directory
    for (;;) {
      const cut = prefix.lastIndexOf("/")
      prefix = cut < 0 ? "" : prefix.slice(0, cut)
      const updated = subtreeSize(prefix) + delta
      if (updated <= 0) subtreeSizes.delete(prefix)
      else subtreeSizes.set(prefix, updated)
      if (prefix === "") break
    }
  }

  /** Rebuild every size from the live tree. Used after a restore/reset. */
  const rebuildSubtreeSizes = () => {
    subtreeSizes.clear()
    const directories = Object.keys(tree.dir).sort((left, right) => right.length - left.length)
    for (const directory of directories) refreshSubtreeSize(directory)
  }

  /**
   * Keep the live store bounded independently of the persisted LRU. A large
   * expand-all can otherwise retain every node until the next scope switch.
   * Collapsed, least-recently-used subtrees are discarded first; if every
   * subtree is expanded, the least-recently-used branch is collapsed before it
   * is dropped. The directory node itself remains visible and will be listed
   * again when opened.
   */
  const trimLiveTree = () => {
    if (nodeIndex.length <= maxLiveNodes) return
    // Victims are ordered by the size of the subtree each one would free, so a
    // pass removes the fewest, largest subtrees that get us under the ceiling.
    // Sizes come from `subtreeSizes`, maintained incrementally on listing
    // commits -- walking each candidate's subtree here instead would cost
    // O(subtree) per candidate and make a large overage quadratic on the
    // critical path of every directory listing.
    //
    // Bigger first, then the same LRU preference as before among equals:
    // collapsed before expanded, least-recently-used first, deepest first.
    const candidates = Object.keys(tree.dir)
      .filter((directory) => directory !== "" && (tree.dir[directory]?.children?.length ?? 0) > 0)
      .map((directory) => ({
        directory,
        size: subtreeSize(directory),
        expanded: tree.dir[directory]?.expanded ? 1 : 0,
        touch: directoryTouches.get(directory) ?? 0,
        depth: directory.split("/").length,
      }))
      .sort((left, right) => {
        if (left.size !== right.size) return right.size - left.size
        if (left.expanded !== right.expanded) return left.expanded - right.expanded
        if (left.touch !== right.touch) return left.touch - right.touch
        return right.depth - left.depth
      })

    // One descending sweep. Each removal frees `size` nodes, so the running
    // overage tells us when to stop without re-measuring the index.
    let overage = nodeIndex.length - maxLiveNodes
    for (const candidate of candidates) {
      if (overage <= 0) break
      const directory = candidate.directory
      const children = tree.dir[directory]?.children
      // A parent candidate may have removed this subtree in an earlier pass.
      if (!children || children.length === 0) continue

      const removed = new Set<string>()
      const pending = [...children]
      // Deep dependency trees can contain thousands of nested directories.
      // Iterative traversal is stack-safe and guards malformed listing cycles.
      while (pending.length > 0) {
        const path = pending.pop()!
        if (removed.has(path)) continue
        removed.add(path)
        if (tree.node[path]?.type !== "directory") continue
        for (const child of tree.dir[path]?.children ?? []) pending.push(child)
      }
      if (removed.size === 0) continue

      // The directory's own node stays (it remains visible); its children and
      // everything below them go.
      const before = subtreeSize(directory)
      batch(() => {
        setTree(
          "node",
          produce((draft) => {
            for (const path of removed) delete draft[path]
          }),
        )
        setTree(
          "dir",
          produce((draft) => {
            for (const path of removed) delete draft[path]
            const state = draft[directory]
            if (state) {
              state.expanded = false
              state.loaded = false
              state.loadedEpoch = undefined
              state.loading = false
              state.children = undefined
            }
          }),
        )
        childCache.delete(directory)
        for (const path of removed) {
          childCache.delete(path)
          directoryTouches.delete(path)
          subtreeSizes.delete(path)
        }
        for (const path of removed) removeNodeIndex(path)
        bumpNodeVersion((value) => value + 1)
        recordViewChange()
      })
      propagateSubtreeSize(directory, before)
      overage -= removed.size
    }
  }

  // `listDir` is called from several independent paths (manual expansion,
  // search expansion, prewarm, and watcher invalidation).  The per-directory
  // `inflight` map deduplicates identical requests, but it does not prevent a
  // burst of different directories from opening one HTTP request each.  Keep
  // the transport fan-out bounded; callers still receive a promise for their
  // own directory and the existing error semantics are unchanged.
  let activeListRequests = 0
  let activeBackgroundListRequests = 0
  type ListPriority = "interactive" | "background"
  type ListJob = {
    dir: string
    run: (priority: ListPriority) => void
    cancel: () => void
    priority: ListPriority
    generation: number
  }
  const interactiveQueue: ListJob[] = []
  const backgroundQueue: ListJob[] = []
  const queuedByDir = new Map<string, ListJob>()
  const queuedCount = () => interactiveQueue.length + backgroundQueue.length
  const forgetQueued = (job: ListJob) => {
    if (queuedByDir.get(job.dir) === job) queuedByDir.delete(job.dir)
  }
  const cancelQueued = () => {
    for (const queue of [interactiveQueue, backgroundQueue]) {
      for (const job of queue) {
        forgetQueued(job)
        job.cancel()
      }
      queue.length = 0
    }
  }
  const pumpListRequests = () => {
    while (activeListRequests < DIRECTORY_LIST_CONCURRENCY && queuedCount() > 0) {
      // Two FIFO lanes avoid repeatedly scanning the entire (up to 1,024)
      // backlog for interactive work. Reserve one slot for user gestures.
      const job = interactiveQueue.shift() ??
        (activeBackgroundListRequests < BACKGROUND_LIST_CONCURRENCY ? backgroundQueue.shift() : undefined)
      if (!job) break
      forgetQueued(job)
      if (job.generation !== generation) {
        job.cancel()
        continue
      }
      activeListRequests += 1
      if (job.priority === "background") activeBackgroundListRequests += 1
      job.run(job.priority)
    }
  }
  const promoteQueued = (dir: string, requestGeneration: number) => {
    const job = queuedByDir.get(dir)
    if (!job || job.generation !== requestGeneration || job.priority !== "background") return
    const index = backgroundQueue.indexOf(job)
    if (index < 0) return
    backgroundQueue.splice(index, 1)
    job.priority = "interactive"
    interactiveQueue.push(job)
    pumpListRequests()
  }
  const scheduleListRequest = (
    task: (priority: ListPriority) => Promise<FileNode[]>,
    options: { dir: string; generation: number; priority: ListPriority },
  ) => {
    if (disposed) return Promise.resolve(CANCELLED_LIST)
    return new Promise<FileNode[]>((resolve, reject) => {
      let settled = false
      const finish = (priority: ListPriority) => {
        activeListRequests -= 1
        if (priority === "background") activeBackgroundListRequests -= 1
        pumpListRequests()
      }
      const job: ListJob = {
        dir: options.dir,
        priority: options.priority,
        generation: options.generation,
        run: (priority) => {
          if (settled) {
            finish(priority)
            return
          }
          void Promise.resolve()
            .then(() => {
              if (disposed || options.generation !== generation) return CANCELLED_LIST
              return task(priority)
            })
            .then(
              (value) => {
                settled = true
                finish(priority)
                resolve(value)
              },
              (error) => {
                settled = true
                finish(priority)
                reject(error)
              },
            )
        },
        cancel: () => {
          if (settled) return
          settled = true
          resolve(CANCELLED_LIST)
        },
      }
      if (options.priority === "background" && backgroundQueue.length >= MAX_QUEUED_BACKGROUND_REQUESTS) {
        const oldest = backgroundQueue.shift()!
        forgetQueued(oldest)
        oldest.cancel()
      }
      if (queuedCount() >= MAX_QUEUED_LIST_REQUESTS) return resolve(CANCELLED_LIST)
      queuedByDir.set(options.dir, job)
      ;(options.priority === "interactive" ? interactiveQueue : backgroundQueue).push(job)
      pumpListRequests()
    })
  }

  const snapshot = (): TreeSnapshot =>
    untrack(() => ({
      node: { ...tree.node },
      dir: { ...tree.dir },
      nodeCount: Object.keys(tree.node).length,
      stale: staleEpoch() > 0,
      // Persisted so restore() can resume the SAME epoch the saved `loadedEpoch`s
      // were written under. Without it, a snapshot taken at epoch N restores at
      // 0/1 and every directory compares unequal, so the entire tree re-lists.
      loadedEpoch: staleEpoch(),
    }))

  /**
   * Small cross-process warm-start snapshot. Keep only the visible spine
   * (root + expanded descendants) and hard-cap it so persistence can never
   * turn a large repository into a multi-megabyte JSON/IPC/GC event.
   *
   * Every directory is deliberately persisted as NOT loaded. Its cached
   * children are paint hints only: a consumer may render them immediately,
   * while listDir() still revalidates against the authoritative filesystem.
   */
  const warmSnapshot = (
    maxNodes = WARM_SNAPSHOT_MAX_NODES,
    maxDirectories = WARM_SNAPSHOT_MAX_DIRECTORIES,
  ): TreeSnapshot => {
    const node: Record<string, FileNode> = {}
    const dir: Record<string, DirectoryState> = {}
    const queue = [""]
    const seen = new Set<string>()
    let nodes = 0

    while (queue.length > 0 && seen.size < Math.max(1, maxDirectories) && nodes < Math.max(1, maxNodes)) {
      const directory = queue.shift()!
      if (seen.has(directory)) continue
      seen.add(directory)
      const state = tree.dir[directory]
      if (!state?.children) continue

      const children: string[] = []
      for (const path of state.children) {
        if (nodes >= maxNodes) break
        const child = tree.node[path]
        if (!child) continue
        node[path] = child
        children.push(path)
        nodes += 1
        if (child.type === "directory" && tree.dir[path]?.expanded) queue.push(path)
      }
      dir[directory] = {
        expanded: directory === "" ? true : state.expanded,
        loaded: false,
        loading: false,
        children,
      }
    }

    if (!dir[""]) dir[""] = { expanded: true, loaded: false, loading: false, children: [] }
    return { node, dir, nodeCount: nodes, stale: true, loadedEpoch: 0 }
  }

  /**
   * Seed a cold store from a persisted paint-hint snapshot. Never overwrite
   * an authoritative answer (including a real empty root); an in-flight cold
   * request may continue and will replace these stale rows when it completes.
   */
  const seedWarmSnapshot = (snap: TreeSnapshot) => {
    if (disposed || tree.dir[""]?.children !== undefined) return false
    const nextDir: Record<string, DirectoryState> = {}
    for (const [directory, state] of Object.entries(snap.dir ?? {})) {
      nextDir[directory] = {
        expanded: directory === "" ? true : Boolean(state.expanded),
        loaded: false,
        loading: false,
        children: state.children?.filter((path) => snap.node[path] !== undefined),
      }
    }
    if (!nextDir[""]) nextDir[""] = { expanded: true, loaded: false, loading: false, children: [] }
    restore({
      node: { ...snap.node },
      dir: nextDir,
      nodeCount: Object.keys(snap.node).length,
      stale: true,
      loadedEpoch: 0,
    })
    return true
  }

  const restore = (snap: TreeSnapshot) => {
    childCache.clear()
    directoryTouches.clear()
    touchClock = 0
    rebuildNodeIndex(snap.node)
    setTree("node", reconcile(snap.node))
    setTree("dir", reconcile(snap.dir))
    if (!tree.dir[""]) setTree("dir", "", { expanded: true })
    rebuildSubtreeSizes()
    // Resume the persisted epoch. `snap.stale ? 1 : 0` is only the fallback for
    // a snapshot written before `loadedEpoch` existed; it is deliberately
    // conservative (everything re-lists) so an old snapshot can never be
    // mistaken for fresh.
    setStaleEpoch(snap.loadedEpoch ?? (snap.stale ? 1 : 0))
    bumpNodeVersion((value) => value + 1)
    trimLiveTree()
    recordViewChange()
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
    for (const snap of cache.values()) total += snap.nodeCount ?? Object.keys(snap.node).length
    while (total > maxNodes && cache.size > 0) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      const snap = cache.get(oldest)
      if (snap) total -= snap.nodeCount ?? Object.keys(snap.node).length
      cache.delete(oldest)
    }
  }

  const reset = () => {
    beginGeneration()
    inflight.clear()
    childCache.clear()
    directoryTouches.clear()
    nodeIndex = []
    nodePositions.clear()
    subtreeSizes.clear()
    setTree("node", reconcile({}))
    setTree("dir", reconcile({}))
    setTree("dir", "", { expanded: true })
    setStaleEpoch(0)
    bumpNodeVersion((value) => value + 1)
    recordViewChange()
  }

  const ensureDir = (path: string) => {
    touchDirectory(path)
    if (tree.dir[path]) return
    setTree("dir", path, { expanded: false })
  }

  const listDir = (input: string, opts?: { force?: boolean; generation?: number; priority?: ListPriority }) => {
    if (disposed) return Promise.resolve()
    const dir = options.normalizeDir(input)
    const requestGeneration = opts?.generation ?? generation
    ensureDir(dir)

    const current = tree.dir[dir]
    const currentEpoch = staleEpoch()
    if (!opts?.force && current?.loaded && current.loadedEpoch === currentEpoch) return Promise.resolve()

    const pending = inflight.get(dir)
    if (pending?.generation === requestGeneration) {
      if (opts?.priority !== "background") {
        promoteQueued(dir, requestGeneration)
        options.promote?.(dir)
      }
      return pending.promise
    }

    setTree(
      "dir",
      dir,
      produce((draft) => {
        draft.error = undefined
        if (!current?.loaded || current.loadedEpoch !== currentEpoch) draft.loading = true
      }),
    )

    const directory = options.scope()
    const listStarted = performance.now()

    const promise = scheduleListRequest((priority) => {
      // A scope switch can happen while a request is waiting behind the
      // semaphore.  Avoid starting stale network work in that case; the
      // completion path below also ignores stale results from requests that
      // were already in flight when the switch happened.
      //
      // This must resolve CANCELLED_LIST, never a fresh `[]`: the sentinel is
      // the ONE chokepoint that distinguishes "no answer" from "an empty
      // directory". Returning `[]` here is indistinguishable from a real
      // empty listing, so a future edit that removed the redundant guard in
      // the completion path would silently wipe a directory's children.
      if (disposed || options.scope() !== directory || requestGeneration !== generation) return Promise.resolve(CANCELLED_LIST)
      return options.list(dir, priority)
    }, { dir, generation: requestGeneration, priority: opts?.priority ?? "interactive" })
      .then((nodes) => {
        if (nodes === CANCELLED_LIST) {
          // Dropped without an answer. This is NOT an empty directory: leave
          // `loaded`/`children` untouched so expandAll cannot mistake it for a
          // listed-and-empty branch and silently truncate its frontier.
          return
        }
        if (disposed || options.scope() !== directory || requestGeneration !== generation) return
        const prevChildren = tree.dir[dir]?.children ?? []
        const sameOrder =
          prevChildren.length === nodes.length &&
          nodes.every((node, index) => node.path === prevChildren[index])
        // Most watcher-triggered force lists return an identical directory.
        // Updating thousands of Solid store entries, search indexes and
        // subtree accounting for that no-op burns renderer time and creates
        // avoidable reactive invalidations. A successfully validated result
        // still advances loadedEpoch (important after watcher loss).
        // An *unlisted* empty directory has undefined children, not [].
        // It must commit the authoritative [] so expandAll can distinguish a
        // real empty response from a cancelled/dropped request.
        if (
          tree.dir[dir]?.children !== undefined &&
          sameOrder &&
          nodes.every((node) => sameFileNode(tree.node[node.path], node))
        ) {
          setTree(
            "dir",
            dir,
            produce((draft) => {
              draft.loaded = true
              draft.loadedEpoch = currentEpoch
              draft.loading = false
            }),
          )
          return
        }
        // Captured before the children are rewritten; propagateSubtreeSize folds
        // the difference into `dir` and its ancestors.
        const sizeBefore = subtreeSize(dir)
        const nextChildren = nodes.map((node) => node.path)
        const nextSet = new Set(nextChildren)
        let nodeIndexChanged = !sameOrder
        if (nodeIndexChanged) {
          childCache.delete(dir)
        }
        const convertedDirectories = nodes.filter(
          (node) => node.type !== "directory" && tree.node[node.path]?.type === "directory",
        ).map((node) => node.path)
        const removedDirectoryPaths = prevChildren.filter(
          (path) => !nextSet.has(path) && tree.node[path]?.type === "directory",
        ).concat(convertedDirectories)
        const removedPaths = new Set<string>()
        // A directory->file replacement retains the path itself but must drop
        // all descendants and the old directory state. A same-order listing
        // is not evidence that the former subtree still exists.
        const removedDirs = new Set<string>(convertedDirectories)
        // Iterative pruning survives pathological nested trees and avoids a
        // deep recursive stack during branch switches or dependency installs.
        const pendingRemovals = prevChildren.filter((path) => !nextSet.has(path))
        for (const path of convertedDirectories) {
          for (const child of tree.dir[path]?.children ?? []) pendingRemovals.push(child)
        }
        while (pendingRemovals.length > 0) {
          const path = pendingRemovals.pop()!
          if (removedPaths.has(path)) continue
          removedPaths.add(path)
          if (tree.node[path]?.type !== "directory") continue
          removedDirs.add(path)
          for (const child of tree.dir[path]?.children ?? []) pendingRemovals.push(child)
        }
        const pruneStarted = removedDirectoryPaths.length > 0 ? performance.now() : 0
        if (removedDirectoryPaths.length > 0) {
          // A wide delete used to test every cached path against every removed
          // directory: O(removed siblings × cached branches). Parent-prefix
          // membership yields O(cached branches × tree depth) instead.
          const removedRoots = new Set(removedDirectoryPaths)
          for (const cachedDir of childCache.keys()) {
            let cursor = cachedDir
            while (cursor) {
              if (removedRoots.has(cursor)) {
                childCache.delete(cachedDir)
                break
              }
              const slash = cursor.lastIndexOf("/")
              cursor = slash < 0 ? "" : cursor.slice(0, slash)
            }
          }
          for (const removed of removedDirs) directoryTouches.delete(removed)
        }

        batch(() => {
          setTree(
            "node",
            produce((draft) => {
              for (const child of prevChildren) {
                if (nextSet.has(child)) continue
                delete draft[child]
              }
              for (const path of removedPaths) delete draft[path]

              for (const node of nodes) {
                const previous = draft[node.path]
                // File list responses commonly allocate fresh objects even
                // when nothing changed. Preserve the existing object in that
                // case so downstream WeakMap projections and row components
                // retain identity across a watcher refresh.
                if (sameFileNode(previous, node)) {
                  continue
                }
                nodeIndexChanged = true
                draft[node.path] = node
              }
            }),
          )

          setTree(
            "dir",
            produce((draft) => {
              for (const path of removedDirs) delete draft[path]
            }),
          )

          setTree(
            "dir",
            dir,
            produce((draft) => {
              draft.loaded = true
              draft.loadedEpoch = currentEpoch
              draft.loading = false
              draft.children = sameOrder ? prevChildren : nextChildren
            }),
          )
          for (const child of prevChildren) {
            if (!nextSet.has(child)) removeNodeIndex(child)
          }
          for (const path of removedPaths) removeNodeIndex(path)
          // Keep the index aligned with the live store. A watcher refresh often
          // returns freshly allocated objects whose fields are unchanged; the
          // store deliberately retains the old object in that case so row
          // projections remain stable. Index the retained object as well, or a
          // search consumer would observe a new identity on every refresh.
          for (const node of nodes) upsertNodeIndex(tree.node[node.path] ?? node)
          // All direct-child node writes happen through this listing commit.
          // Invalidate the parent's materialized child array even if the
          // ordered path IDs are unchanged (metadata updates). That makes
          // cached reads O(1) rather than comparing every node in a 50k-wide
          // directory during each tree flatten or rerender.
          if (nodeIndexChanged) childCache.delete(dir)
          // `allNodes()` backs the explorer's O(N) search index. A watcher
          // force-list that returns byte-for-byte identical rows must not bump
          // its revision and rebuild that index for the whole project.
          if (nodeIndexChanged || removedPaths.size > 0) bumpNodeVersion((value) => value + 1)
          // The whole subtree below every removed path is gone, so its cached
          // sizes are garbage: drop them before the ancestor fold, or a later
          // recompute could resurrect a stale child size.
          for (const path of removedPaths) subtreeSizes.delete(path)
          propagateSubtreeSize(dir, sizeBefore)
          trimLiveTree()
          if (nodeIndexChanged || removedPaths.size > 0) {
            recordViewChange(dir, prevChildren.filter((path) => !nextSet.has(path)), convertedDirectories)
          }
          if (pruneStarted > 0) perf.span("prune", performance.now() - pruneStarted)
        })
      })
      .catch((e) => {
        if (disposed || options.scope() !== directory || requestGeneration !== generation) return
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
        perf.span("list", performance.now() - listStarted)
        if (inflight.get(dir)?.promise === promise) {
          inflight.delete(dir)
          if (!disposed && options.scope() === directory && tree.dir[dir]) setTree("dir", dir, "loading", false)
        }
      })

    inflight.set(dir, { promise, generation: requestGeneration })
    return promise
  }

  // `list: false` marks a directory expanded without fetching its children, for
  // trees whose nodes are synthesized from a filter; listing directories that
  // only exist on a diff's base branch fails and surfaces error toasts.
  const expandDir = (
    input: string,
    behavior?: { list?: boolean; generation?: number; priority?: ListPriority },
  ) => {
    const dir = options.normalizeDir(input)
    touchDirectory(dir)
    ensureDir(dir)
    const changed = tree.dir[dir]?.expanded !== true
    setTree("dir", dir, "expanded", true)
    if (changed) recordViewChange(dir)
    if (behavior?.list === false) return
    void listDir(dir, { generation: behavior?.generation, priority: behavior?.priority })
  }

  const collapseDir = (input: string) => {
    const dir = options.normalizeDir(input)
    touchDirectory(dir)
    ensureDir(dir)
    const changed = tree.dir[dir]?.expanded !== false
    setTree("dir", dir, "expanded", false)
    if (changed) recordViewChange(dir)
  }

  const dirState = (input: string) => {
    const dir = options.normalizeDir(input)
    touchDirectory(dir)
    return tree.dir[dir]
  }

  const children = (input: string) => {
    const dir = options.normalizeDir(input)
    touchDirectory(dir)
    const ids = tree.dir[dir]?.children
    if (!ids) return emptyChildren
    const cached = childCache.get(dir)
    if (cached?.ids === ids) {
      // Mutation sites invalidate this directory's child cache whenever a
      // direct node changes, including a same-order metadata refresh.
      // Avoid O(width) per-access identity verification. The IDs array is
      // authoritative and retains identity for unchanged listings.
      childCache.delete(dir)
      childCache.set(dir, cached)
      return cached.nodes
    }
    const out: FileNode[] = []
    for (const id of ids) {
      const node = tree.node[id]
      if (node) out.push(node)
    }
    childCache.set(dir, { ids, nodes: out })
    while (childCache.size > MAX_CHILD_CACHE_ENTRIES) {
      const oldest = childCache.keys().next().value
      if (oldest === undefined) break
      childCache.delete(oldest)
    }
    return out
  }

  const allNodes = () => {
    const version = nodeVersion()
    if (searchIndexVersion !== version) {
      searchIndexSnapshot = nodeIndex.slice()
      searchIndexVersion = version
    }
    return searchIndexSnapshot
  }

  const markAllStale = () => {
    setStaleEpoch((value) => value + 1)
  }

  const loadedDirectories = () => {
    staleEpoch()
    return Object.keys(tree.dir).filter((path) => tree.dir[path]?.loaded)
  }

  // Expand every directory, recursively listing directories that have not
  // been listed yet, so expand-all reaches the full tree — not just the
  // previously listed subset. Level-parallel: each depth costs one
  // round-trip per directory at that depth instead of a serial walk over the
  // whole tree. `listDir` never rejects (errors land in the dir state), so a
  // failing directory just stops that branch.
  const beginGeneration = () => {
    generation += 1
    cancelQueued()
    return generation
  }

  const expandAll = async (): Promise<ExpandAllResult> => {
    const runGeneration = beginGeneration()
    const seen = new Set<string>()
    const dropped: string[] = []
    let frontier: string[] = [options.normalizeDir("")]
    while (frontier.length > 0) {
      const next = await mapLimited(frontier, async (dir) => {
        if (disposed || runGeneration !== generation) return []
        if (seen.has(dir)) return []
        seen.add(dir)
        ensureDir(dir)
        setTree("dir", dir, "expanded", true)
        await listDir(dir, { generation: runGeneration, priority: "interactive" })
        if (disposed || runGeneration !== generation) return []
        const ids = tree.dir[dir]?.children
        // A directory with no `children` was never listed: its request was
        // dropped (queue overflow) rather than answered. A genuine empty
        // listing commits `children: []`, which is truthy -- so `!ids` isolates
        // "no answer" from "empty" exactly as CANCELLED_LIST does in listDir.
        // Reporting it is the point: previously this read as undefined and the
        // branch was silently dropped, truncating the expansion with no signal.
        if (!ids) {
          dropped.push(dir)
          return []
        }
        const subdirs: string[] = []
        for (const id of ids) {
          const node = tree.node[id]
          if (node?.type === "directory") subdirs.push(node.path)
        }
        return subdirs
      })
      frontier = next.flat()
    }
    // `expanded` counts directories this run claimed; `reached` those it could
    // actually list. Any gap is truncation the caller must be able to see.
    recordViewChange()
    return {
      truncated: dropped.length > 0,
      droppedDirectories: dropped,
      expanded: seen.size,
      reached: seen.size - dropped.length,
    }
  }

  const collapseAll = () => {
    beginGeneration()
    batch(() => {
      for (const dir of Object.keys(tree.dir)) {
        if (dir === "" || !tree.dir[dir]?.children) continue
        setTree("dir", dir, "expanded", false)
      }
    })
    recordViewChange()
  }

  // Explicit root-only prewarm. The store used to schedule this automatically
  // on every cold FileProvider mount and then fan out into *every top-level
  // directory*. FileProvider also exists for prompt mentions while the explorer
  // is closed, so merely opening a session could generate dozens of background
  // directory requests. Actual tree components already request their root when
  // mounted; keep this method for callers/tests without doing hidden work.
  const prewarm = async () => {
    const runGeneration = generation
    await listDir("", { generation: runGeneration, priority: "background" })
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    generation += 1
    cancelQueued()
  }

  // Called by the consumer when the project scope changes. Saves the outgoing
  // project's tree state into the LRU, restores the incoming project's cached
  // state (or starts fresh + prewarms), and evicts cold entries.
  const switchScope = () => {
    if (disposed) return
    const next = cacheScope()
    if (next === currentScope) return
    cache.set(currentScope, snapshot())
    beginGeneration()
    currentScope = next
    inflight.clear()
    childCache.clear()
    const cached = cache.get(next)
    if (cached) {
      touch(next)
      restore(cached)
    } else {
      reset()
    }
    evict()
    recordViewChange()
  }

  // Called when the OWNING FileProvider itself is about to unmount (not just a scope
  // switch within it -- see switchScope above). Saves the current scope's tree into the
  // module cache so a future FileProvider mount for the same directory seeds warm instead
  // of starting empty.
  const persist = () => {
    if (disposed) return
    cache.set(currentScope, snapshot())
    touch(currentScope)
    evict()
  }

  // A restored snapshot carries `dir` entries whose subtree sizes were never
  // computed for this store, so seed them before anything can trim. Cold stores
  // intentionally stay idle until an actual tree consumer mounts.
  if (initialSnapshot) {
    rebuildSubtreeSizes()
    trimLiveTree()
  }

  return {
    listDir,
    expandDir,
    collapseDir,
    dirState,
    children,
    allNodes,
    // Primarily useful for diagnostics/regression tests. Consumers should use
    // allNodes(), which already tracks this signal reactively.
    nodeRevision: nodeVersion,
    viewRevision: viewVersion,
    changesSince,
    hasNode: (input: string) => {
      const key = options.normalizeDir(input)
      return tree.node[key] !== undefined
    },
    expandAll,
    collapseAll,
    beginGeneration,
    node: (path: string) => tree.node[path],
    isLoaded: (path: string) => Boolean(tree.dir[path]?.loaded && tree.dir[path]?.loadedEpoch === staleEpoch()),
    loadedDirectories,
    markAllStale,
    reset,
    prewarm,
    dispose,
    switchScope,
    persist,
    warmSnapshot,
    seedWarmSnapshot,
  }
}
