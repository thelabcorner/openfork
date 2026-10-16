import type { FileNode } from "@opencode-ai/sdk/v2"
import { safeWorkspaceRelativeFilePath, type FileTreeV2Model, type FileTreeV2Node } from "./file-tree-v2-model"

// Private structural index. Published models remain immutable; incremental
// page projection layers sparse node overrides over an earlier version.
export type ProjectExplorerNodeIndex = { get(path: string): FileTreeV2Node | undefined; depth?: number }
const indices = new WeakMap<FileTreeV2Model, ProjectExplorerNodeIndex>()
export const projectExplorerNodeIndex = (model: FileTreeV2Model) => indices.get(model)
export const registerProjectExplorerNodeIndex = (model: FileTreeV2Model, index: ProjectExplorerNodeIndex) => {
  indices.set(model, index)
}

/**
 * Search results are already a workspace-wide PATH projection. Building a
 * presentation-only tree from those paths avoids fetching every matching
 * ancestor directory just to discover children the search index already knows.
 *
 * This index never claims directories are filesystem-loaded. It is recreated
 * only when a query publishes a new result, not on scroll or expand/collapse.
 */
export function buildProjectExplorerSearchTree(
  matches: Iterable<string>,
  ancestors: Iterable<string>,
  lookup: (path: string) => FileNode | undefined,
  root = "",
): FileTreeV2Model {
  const directories = new Set<string>()
  const paths = new Set<string>()
  const separator = root.includes("\\") ? "\\" : "/"
  const prefix = root ? (root.endsWith("/") || root.endsWith("\\") ? root : root + separator) : ""

  const include = (input: string, directory: boolean) => {
    const path = safeWorkspaceRelativeFilePath(input)
    if (!path) return
    paths.add(path)
    if (directory) directories.add(path)
    let cut = path.lastIndexOf("/")
    while (cut > 0) {
      const ancestor = path.slice(0, cut)
      paths.add(ancestor)
      if (!directories.add(ancestor)) break
      cut = ancestor.lastIndexOf("/")
    }
  }

  for (const path of ancestors) include(path, true)
  for (const path of matches) include(path, false)

  const children = new Map<string, FileTreeV2Node[]>()
  const nodeIndex = new Map<string, FileTreeV2Node>()
  for (const path of paths) {
    const original = lookup(path)
    const cut = path.lastIndexOf("/")
    const parent = cut === -1 ? "" : path.slice(0, cut)
    const node: FileTreeV2Node = original
      ? {
          ...original,
          name: original.name || path.slice(cut + 1),
          path,
          originalPath: original.path,
          type: directories.has(path) ? "directory" : original.type,
        }
      : {
          path,
          originalPath: path,
          name: path.slice(cut + 1),
          absolute: prefix ? prefix + path.replaceAll("/", separator) : "",
          type: directories.has(path) ? "directory" : "file",
          ignored: false,
        }
    nodeIndex.set(path, node)
    const list = children.get(parent)
    if (list) list.push(node)
    else children.set(parent, [node])
  }
  for (const list of children.values()) {
    list.sort((a, b) =>
      a.type !== b.type
        ? a.type === "directory" ? -1 : 1
        : a.name.localeCompare(b.name),
    )
  }
  const model = { children, total: paths.size }
  registerProjectExplorerNodeIndex(model, nodeIndex)
  return model
}

export type ProjectExplorerProjectionMetrics = {
  slices: number
  maxSliceMs: number
  totalMs: number
}

/**
 * Cooperative, cancellation-aware counterpart to buildProjectExplorerSearchTree.
 *
 * Each stage (path normalization/ancestry, metadata projection, sorting) is
 * scheduled in bounded slices. Wide directories use sorted 256-node runs and
 * interruptible merges instead of one unbounded Array.sort(50_000). No partial
 * maps escape until they are completely sorted, and cancellation never commits
 * stale results.
 */
export function startProjectExplorerSearchTree(input: {
  matches: Iterable<string>
  ancestors: Iterable<string>
  lookup: (path: string) => FileNode | undefined
  root?: string
  cancelled?: () => boolean
  sliceMs?: number
  now?: () => number
  schedule?: (run: () => void) => ReturnType<typeof setTimeout>
  complete: (model: FileTreeV2Model, metrics: ProjectExplorerProjectionMetrics) => void
}) {
  const now = input.now ?? (() => performance.now())
  const schedule = input.schedule ?? ((run: () => void) => setTimeout(run, 0))
  const sliceMs = input.sliceMs ?? 3
  const started = now()
  const paths = new Set<string>()
  const directories = new Set<string>()
  const children = new Map<string, FileTreeV2Node[]>()
  const nodeIndex = new Map<string, FileTreeV2Node>()
  const separator = input.root?.includes("\\") ? "\\" : "/"
  const root = input.root ?? ""
  const prefix = root ? root.endsWith("/") || root.endsWith("\\") ? root : root + separator : ""
  const compare = (a: FileTreeV2Node, b: FileTreeV2Node) =>
    a.type !== b.type ? a.type === "directory" ? -1 : 1 : a.name.localeCompare(b.name)
  const includes = (value: string, directory: boolean) => {
    const path = safeWorkspaceRelativeFilePath(value)
    if (!path) return
    paths.add(path)
    if (directory) directories.add(path)
    let cut = path.lastIndexOf("/")
    while (cut > 0) {
      const ancestor = path.slice(0, cut)
      paths.add(ancestor)
      if (!directories.add(ancestor)) break
      cut = ancestor.lastIndexOf("/")
    }
  }

  let stage: "ancestors" | "matches" | "nodes" | "sort" = "ancestors"
  let iterator: Iterator<string> = input.ancestors[Symbol.iterator]()
  let sortIterator: Iterator<[string, FileTreeV2Node[]]> | undefined
  type MergeTask = {
    left: FileTreeV2Node[]
    right: FileTreeV2Node[]
    merged: FileTreeV2Node[]
    i: number
    j: number
  }
  type SortTask = {
    key: string
    nodes: FileTreeV2Node[]
    offset: number
    runs: FileTreeV2Node[][]
    next: FileTreeV2Node[][]
    pair: number
    merge?: MergeTask
  }
  let sortTask: SortTask | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let slices = 0
  let maxSliceMs = 0
  const cancelled = () => stopped || input.cancelled?.() === true
  const queue = () => {
    if (cancelled() || timer !== undefined) return
    timer = schedule(run)
  }
  const run = () => {
    timer = undefined
    if (cancelled()) return
    const sliceStarted = now()
    let steps = 0
    // Check after 32 processed nodes/merge elements rather than 128. Large
    // batches can create visible long tasks despite a small nominal budget;
    // the smaller checkpoint bounds our own compute between time checks.
    const yieldIfNeeded = () => (++steps & 31) === 0 && now() - sliceStarted >= sliceMs
    const yieldSlice = () => {
      maxSliceMs = Math.max(maxSliceMs, now() - sliceStarted)
      slices++
      queue()
    }
    while (!cancelled()) {
      if (stage === "ancestors" || stage === "matches") {
        const next = iterator.next()
        if (next.done) {
          if (stage === "ancestors") {
            stage = "matches"
            iterator = input.matches[Symbol.iterator]()
          } else {
            stage = "nodes"
            iterator = paths.values()
          }
          continue
        }
        includes(next.value, stage === "ancestors")
      } else if (stage === "nodes") {
        const next = iterator.next()
        if (next.done) {
          stage = "sort"
          sortIterator = children.entries()
          continue
        }
        const path = next.value
        const original = input.lookup(path)
        const cut = path.lastIndexOf("/")
        const parent = cut === -1 ? "" : path.slice(0, cut)
        const node: FileTreeV2Node = original
          ? {
              ...original,
              name: original.name || path.slice(cut + 1),
              path,
              originalPath: original.path,
              type: directories.has(path) ? "directory" : original.type,
            }
          : {
              path,
              originalPath: path,
              name: path.slice(cut + 1),
              absolute: prefix ? prefix + path.replaceAll("/", separator) : "",
              type: directories.has(path) ? "directory" : "file",
              ignored: false,
            }
        nodeIndex.set(path, node)
        const list = children.get(parent)
        if (list) list.push(node)
        else children.set(parent, [node])
      } else {
        if (!sortTask) {
          const next = sortIterator!.next()
          if (next.done) {
            maxSliceMs = Math.max(maxSliceMs, now() - sliceStarted)
            slices++
            if (!cancelled()) {
              const model = { children, total: paths.size }
              registerProjectExplorerNodeIndex(model, nodeIndex)
              input.complete(model, { slices, maxSliceMs, totalMs: now() - started })
            }
            return
          }
          const [key, nodes] = next.value
          if (nodes.length <= 512) {
            nodes.sort(compare)
            if (yieldIfNeeded()) { yieldSlice(); return }
            continue
          }
          sortTask = { key, nodes, offset: 0, runs: [], next: [], pair: 0 }
        }
        const task = sortTask
        if (task.offset < task.nodes.length) {
          task.runs.push(task.nodes.slice(task.offset, task.offset + 256).sort(compare))
          task.offset += 256
          if (now() - sliceStarted >= sliceMs) { yieldSlice(); return }
          continue
        }
        if (task.runs.length === 1) {
          children.set(task.key, task.runs[0]!)
          sortTask = undefined
          continue
        }
        if (!task.merge) {
          if (task.pair >= task.runs.length) {
            task.runs = task.next
            task.next = []
            task.pair = 0
            continue
          }
          const left = task.runs[task.pair++]!
          const right = task.runs[task.pair++]
          if (!right) {
            task.next.push(left)
            continue
          }
          task.merge = { left, right, merged: [], i: 0, j: 0 }
        }
        const merge = task.merge!
        if (merge.i === merge.left.length && merge.j === merge.right.length) {
          task.next.push(merge.merged)
          task.merge = undefined
          continue
        }
        if (merge.i === merge.left.length ||
          (merge.j < merge.right.length && compare(merge.left[merge.i]!, merge.right[merge.j]!) > 0)) {
          merge.merged.push(merge.right[merge.j++]!)
        } else {
          merge.merged.push(merge.left[merge.i++]!)
        }
      }
      if (yieldIfNeeded()) { yieldSlice(); return }
    }
  }
  queue()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
}
