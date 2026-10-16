import type { FileNode } from "@opencode-ai/sdk/v2"
import { normalizeFileTreeV2Path, safeWorkspaceRelativeFilePath, type FileTreeV2Node, type FileTreeV2Row } from "./file-tree-v2-model"

export type ProjectExplorerSearchResult = {
  query: string
  matches: SearchPathSet
  ancestors: SearchPathSet
  rows: FileTreeV2Row[]
}

// An immutable search result needs only lookup, iteration and count. The
// latest ECMAScript ReadonlySet interface includes mutating-copy algebra
// helpers (union/intersection/etc.), which would force a snapshot view to
// materialize sets even though no explorer consumer invokes those methods.
export type SearchPathSet = Iterable<string> & {
  readonly size: number
  has(path: string): boolean
}

export type ProjectExplorerSearchMetrics = {
  slices: number
  maxSliceMs: number
  totalMs: number
}

const entryCache = new WeakMap<FileNode, { path: string; lower: string }>()

function entry(node: FileNode) {
  const cached = entryCache.get(node)
  if (cached) return cached
  const path = normalizeFileTreeV2Path(node.path)
  const next = { path, lower: path.toLowerCase() }
  entryCache.set(node, next)
  return next
}

function live(node: FileNode): FileTreeV2Node {
  return {
    ...node,
    path: normalizeFileTreeV2Path(node.path),
    originalPath: node.path,
  }
}

function addPath(matches: Set<string>, ancestors: Set<string>, input: string) {
  const path = safeWorkspaceRelativeFilePath(input)
  if (!path) return
  matches.add(path)
  let current = path
  while (true) {
    const parent = current.lastIndexOf("/")
    if (parent === -1) break
    current = current.slice(0, parent)
    if (!current || ancestors.has(current)) break
    ancestors.add(current)
  }
}

export function mergeProjectExplorerSearchPaths(
  result: ProjectExplorerSearchResult,
  paths: Iterable<string>,
): ProjectExplorerSearchResult {
  const matches = new Set(result.matches)
  const ancestors = new Set(result.ancestors)
  for (const path of paths) addPath(matches, ancestors, path)
  return { ...result, matches, ancestors }
}

/**
 * A frozen-length view of a monotonic set. An immutable search snapshot must
 * remain stable while later pages arrive, even if an async projector is only
 * halfway through iterating it. Instead of cloning 50k existing paths for the
 * next 1k results, retain the append-only sequence and snapshot its length.
 *
 * has() checks the first-insertion ordinal; subsequent appends cannot become
 * visible in an older version. Neither new snapshot creation nor iteration
 * initialization copies accumulated paths.
 */
class SearchPathIndex {
  readonly positions = new Map<string, number>()
  readonly items: string[] = []
  add(path: string) {
    if (this.positions.has(path)) return false
    this.positions.set(path, this.items.length)
    this.items.push(path)
    return true
  }
  snapshot(): SearchPathSet {
    return new SearchPathSnapshot(this, this.items.length)
  }
}

class SearchPathSnapshot implements SearchPathSet {
  readonly [Symbol.toStringTag] = "Set"
  constructor(private readonly index: SearchPathIndex, readonly size: number) {}
  additionsAfter(previous: SearchPathSet): string[] | undefined {
    if (!(previous instanceof SearchPathSnapshot) ||
      previous.index !== this.index || previous.size > this.size) return
    return this.index.items.slice(previous.size, this.size)
  }
  has(value: string) {
    const position = this.index.positions.get(value)
    return position !== undefined && position < this.size
  }
  *values(): SetIterator<string> {
    for (let i = 0; i < this.size; i++) yield this.index.items[i]!
  }
  keys() { return this.values() }
  *entries(): SetIterator<[string, string]> {
    for (const value of this) yield [value, value]
  }
  forEach(callbackfn: (value: string, value2: string, set: SearchPathSet) => void, thisArg?: unknown) {
    for (const value of this) callbackfn.call(thisArg, value, value, this)
  }
  [Symbol.iterator]() { return this.values() }
}

// A true O(delta) extension of a previously published search snapshot. A
// different query/index, a replacement/removal, or an older result racing a
// newer one cannot be safely treated as append-only.
export function appendedProjectExplorerSearchPaths(previous: SearchPathSet, current: SearchPathSet) {
  return current instanceof SearchPathSnapshot ? current.additionsAfter(previous) : undefined
}

/**
 * Immutable snapshots with incremental server-page ingestion. The old
 * explorer re-merged ALL prior server matches for every new page, an O(P²)
 * cumulative ancestry walk over P paginated results. A local search can
 * complete before or after the first server page; both races yield the same
 * union without changing a snapshot already being projected asynchronously.
 */
export function createProjectExplorerSearchAccumulator(query: string) {
  let matches = new SearchPathIndex()
  let ancestors = new SearchPathIndex()
  let localMatches = new Set<string>()
  const remoteMatches = new Set<string>()
  const remoteDirectories = new Set<string>()
  // Deleted roots are authoritative completed directory-listing evidence,
  // not inferences from a missing client cache entry.
  const remoteRemovedRoots = new Set<string>()
  const remoteConvertedDirectories = new Set<string>()
  let remoteInvalidated = false
  const isRemoved = (path: string) => {
    let cursor = path
    while (cursor) {
      if (remoteRemovedRoots.has(cursor)) return true
      const cut = cursor.lastIndexOf("/")
      cursor = cut < 0 ? "" : cursor.slice(0, cut)
      if (cursor && remoteConvertedDirectories.has(cursor)) return true
    }
    return false
  }
  let activeRebase: { files: string[]; directories: string[]; stop: () => void } | undefined
  let current: ProjectExplorerSearchResult = {
    query,
    matches: matches.snapshot(),
    ancestors: ancestors.snapshot(),
    rows: [],
  }
  let localDone = false
  const validPaths = (paths: Iterable<string>) => {
    const next = new Set<string>()
    for (const input of paths) {
      const path = safeWorkspaceRelativeFilePath(input)
      if (path) next.add(path)
    }
    return next
  }
  const addNormalizedDirectory = (value: string) => {
    let cursor = value
    while (cursor) {
      // Closure invariant: if an ancestor is already present, every parent
      // above it must also be present. Directory-only server hits used to
      // add just the leaf directory, breaking that invariant and causing a
      // later matching file to stop its ascent prematurely.
      if (!ancestors.add(cursor)) break
      const slash = cursor.lastIndexOf("/")
      cursor = slash < 0 ? "" : cursor.slice(0, slash)
    }
  }
  const addNormalized = (path: string) => {
    matches.add(path)
    const slash = path.lastIndexOf("/")
    if (slash >= 0) addNormalizedDirectory(path.slice(0, slash))
  }
  const add = (value: string) => {
    const path = safeWorkspaceRelativeFilePath(value)
    if (path) addNormalized(path)
  }
  const addDirectory = (value: string) => {
    const path = safeWorkspaceRelativeFilePath(value)
    if (path) addNormalizedDirectory(path)
  }
  const publish = (beforeMatches: number, beforeAncestors: number) => {
    if (beforeMatches === matches.items.length && beforeAncestors === ancestors.items.length) return current
    current = { ...current, matches: matches.snapshot(), ancestors: ancestors.snapshot() }
    return current
  }
  return {
    snapshot: () => current,
    invalidateRemoteRoots: (roots: readonly string[]) => {
      let changed = false
      for (const value of roots) {
        const path = safeWorkspaceRelativeFilePath(value)
        if (!path || remoteRemovedRoots.has(path)) continue
        remoteRemovedRoots.add(path)
        changed = true
      }
      if (changed) {
        remoteInvalidated = true
        activeRebase?.stop()
      }
      return changed
    },
    invalidateRemoteDescendants: (roots: readonly string[]) => {
      let changed = false
      for (const value of roots) {
        const path = safeWorkspaceRelativeFilePath(value)
        if (!path || remoteConvertedDirectories.has(path)) continue
        remoteConvertedDirectories.add(path)
        changed = true
      }
      if (changed) {
        remoteInvalidated = true
        activeRebase?.stop()
      }
      return changed
    },
    local: (result: ProjectExplorerSearchResult) => {
      if (localDone) return current
      localDone = true
      const previousMatches = matches.items.length
      const previousAncestors = ancestors.items.length
      for (const path of result.matches) {
        const safe = safeWorkspaceRelativeFilePath(path)
        if (!safe) continue
        localMatches.add(safe)
        addNormalized(safe)
      }
      return publish(previousMatches, previousAncestors)
    },
    // A watcher may add or remove loaded-file matches while the same query is
    // still active. Keep the independently discovered remote hit set intact.
    // Pure additions preserve append-only snapshots and take O(new matches).
    // Removals rebase onto a new immutable index, so old snapshots remain
    // valid and the UI falls back to its cancellation-aware full projector.
    refreshLocal: (result: ProjectExplorerSearchResult) => {
      if (!localDone) {
        localDone = true
      }
      const next = validPaths(result.matches)
      if (!remoteInvalidated && next.size === localMatches.size && [...next].every((path) => localMatches.has(path))) return current
      let removed = remoteInvalidated
      for (const path of localMatches) {
        if (!next.has(path)) { removed = true; break }
      }
      localMatches.clear()
      for (const path of next) localMatches.add(path)
      if (!removed) {
        const previousMatches = matches.items.length
        const previousAncestors = ancestors.items.length
        for (const path of next) add(path)
        return publish(previousMatches, previousAncestors)
      }
      matches = new SearchPathIndex()
      ancestors = new SearchPathIndex()
      for (const path of remoteMatches) {
        if (isRemoved(path)) remoteMatches.delete(path)
        else addNormalized(path)
      }
      for (const dir of remoteDirectories) {
        if (isRemoved(dir) || remoteConvertedDirectories.has(dir)) remoteDirectories.delete(dir)
        else addNormalizedDirectory(dir)
      }
      for (const path of localMatches) add(path)
      current = { ...current, matches: matches.snapshot(), ancestors: ancestors.snapshot() }
      remoteInvalidated = false
      return current
    },
    /**
     * Watcher reconciliation must never synchronously rebuild 50k remote
     * paths on the renderer thread. Capture and compare the loaded matches,
     * then apply additions or stage a replacement index cooperatively.
     * Remote pages accepted during the rebase are replayed before publish.
     */
    refreshLocalCooperatively: (result: ProjectExplorerSearchResult, options: {
      complete: (snapshot: ProjectExplorerSearchResult) => void
      cancelled?: () => boolean
      sliceMs?: number
      now?: () => number
      schedule?: (run: () => void) => ReturnType<typeof setTimeout>
    }) => {
      activeRebase?.stop()
      const now = options.now ?? (() => performance.now())
      const schedule = options.schedule ?? ((run: () => void) => setTimeout(run, 0))
      const budget = options.sliceMs ?? 3
      const newLocal = new Set<string>()
      let nextMatches = new SearchPathIndex()
      let nextAncestors = new SearchPathIndex()
      const addNextDirectory = (value: string) => {
        let path = value
        while (path) {
          if (!nextAncestors.add(path)) break
          const cut = path.lastIndexOf("/")
          path = cut < 0 ? "" : path.slice(0, cut)
        }
      }
      const addNext = (path: string) => {
        nextMatches.add(path)
        const cut = path.lastIndexOf("/")
        if (cut >= 0) addNextDirectory(path.slice(0, cut))
      }
      type Phase = "capture" | "compare" | "append" | "remote" | "directories" | "local" | "catchup"
      let phase: Phase = "capture"
      let iterator: Iterator<string> = result.matches[Symbol.iterator]()
      let removed = remoteInvalidated
      let appendedBefore = 0
      let ancestorsBefore = 0
      const buffered = { files: [] as string[], directories: [] as string[], stop: () => {} }
      let replayFiles = 0
      let replayDirectories = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      let stopped = false
      const cancelled = () => stopped || options.cancelled?.() === true
      const stop = () => {
        stopped = true
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        if (activeRebase === buffered) activeRebase = undefined
      }
      buffered.stop = stop
      activeRebase = buffered
      const finish = (replacement: boolean) => {
        if (cancelled()) { stop(); return }
        localDone = true
        localMatches = newLocal
        if (replacement) {
          matches = nextMatches
          ancestors = nextAncestors
          current = { ...current, matches: matches.snapshot(), ancestors: ancestors.snapshot() }
          remoteInvalidated = false
        } else publish(appendedBefore, ancestorsBefore)
        if (activeRebase === buffered) activeRebase = undefined
        stopped = true
        options.complete(current)
      }
      const queue = () => {
        if (cancelled() || timer !== undefined) return
        timer = schedule(run)
      }
      const run = () => {
        timer = undefined
        if (cancelled()) { stop(); return }
        const began = now()
        let iterations = 0
        while (!cancelled()) {
          if (phase === "catchup") {
            // A concurrent Load More may append multiple pages while the
            // rebase is yielding. Replaying them in an unbounded final while
            // loop would recreate exactly the long task we are avoiding.
            if (replayFiles < buffered.files.length) addNext(buffered.files[replayFiles++]!)
            else if (replayDirectories < buffered.directories.length) {
              addNextDirectory(buffered.directories[replayDirectories++]!)
            } else {
              finish(true)
              return
            }
            if ((++iterations & 31) === 0 && now() - began >= budget) {
              queue()
              return
            }
            continue
          }
          const value = iterator.next()
          if (value.done) {
            if (phase === "capture") {
              phase = "compare"
              iterator = localMatches.values()
            } else if (phase === "compare") {
              if (!removed) {
                phase = "append"
                iterator = newLocal.values()
                appendedBefore = matches.items.length
                ancestorsBefore = ancestors.items.length
              } else {
                phase = "remote"
                iterator = remoteMatches.values()
              }
            } else if (phase === "append") {
              finish(false)
              return
            } else if (phase === "remote") {
              phase = "directories"
              iterator = remoteDirectories.values()
            } else if (phase === "directories") {
              phase = "local"
              iterator = newLocal.values()
            } else if (phase === "local") {
              phase = "catchup"
            }
            continue
          }
          if (phase === "capture") {
            const safe = safeWorkspaceRelativeFilePath(value.value)
            if (safe) newLocal.add(safe)
          } else if (phase === "compare") {
            if (!newLocal.has(value.value)) {
              removed = true
              phase = "remote"
              iterator = remoteMatches.values()
            }
          } else if (phase === "append") {
            if (!localMatches.has(value.value)) addNormalized(value.value)
          } else if (phase === "remote") {
            if (isRemoved(value.value)) remoteMatches.delete(value.value)
            else addNext(value.value)
          }
            else if (phase === "directories") {
              if (isRemoved(value.value) || remoteConvertedDirectories.has(value.value)) remoteDirectories.delete(value.value)
              else addNextDirectory(value.value)
            }
          else if (phase === "local") addNext(value.value)
          if ((++iterations & 31) === 0 && now() - began >= budget) {
            queue()
            return
          }
        }
      }
      queue()
      return stop
    },
    page: (paths: readonly string[], directories: readonly string[] = []) => {
      const previousMatches = matches.items.length
      const previousAncestors = ancestors.items.length
      for (const path of paths) {
        const safe = safeWorkspaceRelativeFilePath(path)
        if (!safe || isRemoved(safe)) continue
        if (!remoteMatches.has(safe)) {
          remoteMatches.add(safe)
          activeRebase?.files.push(safe)
        }
        addNormalized(safe)
      }
      for (const value of directories) {
        const dir = safeWorkspaceRelativeFilePath(value)
        if (!dir || isRemoved(dir) || remoteConvertedDirectories.has(dir)) continue
        if (!remoteDirectories.has(dir)) {
          remoteDirectories.add(dir)
          activeRebase?.directories.push(dir)
        }
        addNormalizedDirectory(dir)
      }
      return publish(previousMatches, previousAncestors)
    },
  }
}

export function projectProjectExplorerSearchRows(
  rows: readonly FileTreeV2Row[],
  result: ProjectExplorerSearchResult,
  query: string,
): FileTreeV2Row[] {
  // Search publishes a snapshot asynchronously. Keep already-loaded nodes
  // immediately searchable when a listing arrives between query generations,
  // without copying its (potentially 50k-entry) match/ancestor sets on every
  // tree reflatten. Only the newly observed matches need a local overlay.
  let additions: Set<string> | undefined
  let extraAncestors: Set<string> | undefined
  for (const row of rows) {
    const path = row.node.path
    if (result.matches.has(path) || !path.toLowerCase().includes(query)) continue
    additions ??= new Set<string>()
    extraAncestors ??= new Set<string>()
    addPath(additions, extraAncestors, path)
  }
  if (!additions) {
    return rows.filter((row) => result.matches.has(row.node.path) || result.ancestors.has(row.node.path))
  }
  return rows.filter((row) => {
    const path = row.node.path
    return result.matches.has(path) || result.ancestors.has(path) ||
      additions.has(path) || extraAncestors!.has(path)
  })
}

export function startProjectExplorerSearch(input: {
  query: string
  nodes: readonly FileNode[]
  root: () => readonly FileNode[]
  children: (originalPath: string) => readonly FileNode[]
  /** Build only match/ancestor sets; the caller projects them against a live tree. */
  projectRows?: boolean
  sliceMs?: number
  cancelled?: () => boolean
  schedule?: (run: () => void) => ReturnType<typeof setTimeout>
  now?: () => number
  complete: (result: ProjectExplorerSearchResult, metrics: ProjectExplorerSearchMetrics) => void
}) {
  const sliceMs = input.sliceMs ?? 4
  const now = input.now ?? (() => performance.now())
  const schedule = input.schedule ?? ((run: () => void) => setTimeout(run, 0))
  const matches = new Set<string>()
  const ancestors = new Set<string>()
  const rows: FileTreeV2Row[] = []
  const totalStarted = now()
  let slices = 0
  let maxSliceMs = 0
  let nodeIndex = 0
  // A traversal frame refers to an existing child array. Building 50k
  // wrappers through root().toReversed().map(...) in one task previously
  // exceeded a frame budget *before* the cooperative yield check could run.
  type Frame = { nodes: readonly FileNode[]; next: number; level: number }
  let frames: Frame[] | undefined
  const visited = new Set<string>()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const cancelled = () => stopped || input.cancelled?.() === true
  const queue = () => {
    if (cancelled() || timer !== undefined) return
    timer = schedule(run)
  }
  const finishSlice = (started: number) => {
    const elapsed = now() - started
    maxSliceMs = Math.max(maxSliceMs, elapsed)
    slices++
    return elapsed
  }
  const run = () => {
    timer = undefined
    if (cancelled()) return
    const started = now()
    let iterations = 0

    while (nodeIndex < input.nodes.length) {
      const item = entry(input.nodes[nodeIndex++]!)
      if (item.lower.includes(input.query)) {
        addPath(matches, ancestors, item.path)
      }
      if ((++iterations & 63) === 0 && now() - started >= sliceMs) {
        finishSlice(started)
        queue()
        return
      }
    }

    if (input.projectRows === false) {
      finishSlice(started)
      if (cancelled()) return
      input.complete(
        { query: input.query, matches, ancestors, rows },
        { slices, maxSliceMs, totalMs: now() - totalStarted },
      )
      return
    }

    if (!frames) frames = [{ nodes: input.root(), next: 0, level: 0 }]
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!
      if (frame.next >= frame.nodes.length) {
        frames.pop()
        continue
      }
      const node = live(frame.nodes[frame.next++]!)
      if (visited.has(node.path)) continue
      visited.add(node.path)
      const row = { node, level: frame.level }
      if (matches.has(row.node.path) || ancestors.has(row.node.path)) {
        rows.push(row)
        if (row.node.type === "directory" && ancestors.has(row.node.path)) {
          frames.push({ nodes: input.children(row.node.originalPath), next: 0, level: frame.level + 1 })
        }
      }
      if ((++iterations & 63) === 0 && now() - started >= sliceMs) {
        finishSlice(started)
        queue()
        return
      }
    }

    finishSlice(started)
    if (cancelled()) return
    input.complete(
      { query: input.query, matches, ancestors, rows },
      { slices, maxSliceMs, totalMs: now() - totalStarted },
    )
  }

  queue()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
}
