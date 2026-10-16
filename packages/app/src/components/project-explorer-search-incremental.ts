import type { FileNode } from "@opencode-ai/sdk/v2"
import { safeWorkspaceRelativeFilePath, type FileTreeV2Model, type FileTreeV2Node } from "./file-tree-v2-model"
import { projectExplorerNodeIndex, registerProjectExplorerNodeIndex } from "./project-explorer-search-tree"

/**
 * Applies an append-only search-page delta without reprocessing all historical
 * matches or sorting untouched directory buckets. The base model is immutable:
 * children are copy-on-write arrays and its node index is a private persistent
 * overlay. A periodic full-build fallback bounds both retained versions and
 * the length of indexed parent chains.
 *
 * Incoming delta is at most one remote page (or a small local append). Larger
 * transitions fall back to the canonical cooperative full projector.
 */
export function startProjectExplorerSearchTreeDelta(input: {
  previous: FileTreeV2Model
  addedMatches: readonly string[]
  addedAncestors: readonly string[]
  lookup: (path: string) => FileNode | undefined
  root: string
  sliceMs?: number
  now?: () => number
  schedule?: (callback: () => void) => ReturnType<typeof setTimeout>
  cancelled?: () => boolean
  complete: (model: FileTreeV2Model, metrics: { slices: number; maxSliceMs: number; totalMs: number }) => void
}): (() => void) | undefined {
  const inherited = projectExplorerNodeIndex(input.previous)
  if (!inherited || (inherited.depth ?? 0) >= 12 ||
    input.addedMatches.length + input.addedAncestors.length > 2_048) return

  const now = input.now ?? (() => performance.now())
  const schedule = input.schedule ?? ((callback: () => void) => setTimeout(callback, 0))
  const budget = input.sliceMs ?? 3
  const started = now()
  const raw = function* (): Generator<[string, boolean]> {
    for (const path of input.addedAncestors) yield [path, true]
    for (const path of input.addedMatches) yield [path, false]
  }
  const inputPaths = raw()
  const added = new Set<string>()
  const promoted = new Set<string>()
  const overrides = new Map<string, FileTreeV2Node>()
  const getNode = (path: string) => overrides.get(path) ?? inherited.get(path)
  const changed = new Map<string, FileTreeV2Node[]>()
  const children = new Map<string, readonly FileTreeV2Node[]>()
  const root = input.root
  const slash = root.includes("\\") ? "\\" : "/"
  const prefix = root ? root.endsWith("/") || root.endsWith("\\") ? root : root + slash : ""
  const compare = (a: FileTreeV2Node, b: FileTreeV2Node) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1

  // A path is a directory if this delta supplies it as one or an incoming
  // descendant forces it to become an ancestor. Propagate that semantic type
  // change to its original sorted parent bucket.
  const include = (value: string, directory: boolean) => {
    let path = safeWorkspaceRelativeFilePath(value)
    if (!path) return
    if (!getNode(path)) added.add(path)
    if (directory && getNode(path)?.type !== "directory") promoted.add(path)
    while (path.includes("/")) {
      path = path.slice(0, path.lastIndexOf("/"))
      if (!getNode(path)) added.add(path)
      if (getNode(path)?.type !== "directory") promoted.add(path)
      // Above an existing, correctly typed directory, every ancestor was
      // already present in the previous full hierarchy.
      else break
    }
  }

  let stage: "collect" | "copy" | "nodes" | "buckets" = "collect"
  let cursor: Iterator<[string, readonly FileTreeV2Node[]]> | undefined
  let nodeCursor: Iterator<string> | undefined
  let bucketCursor: Iterator<[string, FileTreeV2Node[]]> | undefined
  type Merge = {
    key: string
    old: readonly FileTreeV2Node[]
    fresh: FileTreeV2Node[]
    replacementPaths: Set<string>
    output: FileTreeV2Node[]
    a: number
    b: number
  }
  let merge: Merge | undefined
  let newCount = 0
  let slices = 0
  let maxSliceMs = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const cancelled = () => stopped || input.cancelled?.() === true
  const queue = () => {
    if (cancelled() || timer !== undefined) return
    timer = schedule(run)
  }
  const run = () => {
    timer = undefined
    if (cancelled()) return
    const sliceStarted = now()
    let operations = 0
    const shouldYield = () => (++operations & 31) === 0 && now() - sliceStarted >= budget
    const yieldSlice = () => {
      maxSliceMs = Math.max(maxSliceMs, now() - sliceStarted)
      slices++
      queue()
    }
    while (!cancelled()) {
      if (stage === "collect") {
        const next = inputPaths.next()
        if (next.done) {
          stage = "copy"
          cursor = input.previous.children.entries()
          continue
        }
        include(...next.value)
      } else if (stage === "copy") {
        const next = cursor!.next()
        if (next.done) {
          stage = "nodes"
          nodeCursor = new Set([...added, ...promoted]).values()
          continue
        }
        children.set(next.value[0], next.value[1])
      } else if (stage === "nodes") {
        const next = nodeCursor!.next()
        if (next.done) {
          stage = "buckets"
          bucketCursor = changed.entries()
          continue
        }
        const path = next.value
        const prior = inherited.get(path)
        const isDir = promoted.has(path) || prior?.type === "directory"
        if (prior && prior.type === (isDir ? "directory" : "file")) continue
        const cut = path.lastIndexOf("/")
        const parent = cut < 0 ? "" : path.slice(0, cut)
        const loaded = input.lookup(path)
        const node: FileTreeV2Node = prior
          ? { ...prior, type: isDir ? "directory" : prior.type }
          : loaded
            ? { ...loaded, path, originalPath: loaded.path, name: loaded.name || path.slice(cut + 1),
                type: isDir ? "directory" : loaded.type }
            : { path, originalPath: path, name: path.slice(cut + 1),
                absolute: prefix ? prefix + path.replaceAll("/", slash) : "",
                ignored: false, type: isDir ? "directory" : "file" }
        if (!prior) newCount++
        overrides.set(path, node)
        const group = changed.get(parent)
        if (group) group.push(node)
        else changed.set(parent, [node])
      } else {
        if (!merge) {
          const next = bucketCursor!.next()
          if (next.done) {
            maxSliceMs = Math.max(maxSliceMs, now() - sliceStarted)
            slices++
            if (!cancelled()) {
              const model: FileTreeV2Model = { children, total: input.previous.total + newCount }
              registerProjectExplorerNodeIndex(model, {
                depth: (inherited.depth ?? 0) + 1,
                get: (path) => overrides.get(path) ?? inherited.get(path),
              })
              input.complete(model, { slices, maxSliceMs, totalMs: now() - started })
            }
            return
          }
          const [key, fresh] = next.value
          fresh.sort(compare)
          merge = {
            key, old: input.previous.children.get(key) ?? [], fresh,
            replacementPaths: new Set(fresh.map((node) => node.path)),
            output: [], a: 0, b: 0,
          }
        }
        const task = merge
        if (task.a === task.old.length && task.b === task.fresh.length) {
          children.set(task.key, task.output)
          merge = undefined
          continue
        }
        const current = task.old[task.a]
        if (current && task.replacementPaths.has(current.path)) {
          task.a++
          continue
        }
        const candidate = task.fresh[task.b]
        if (!current || (candidate && compare(candidate, current) <= 0)) {
          task.output.push(candidate!)
          task.b++
        } else {
          task.output.push(current)
          task.a++
        }
      }
      if (shouldYield()) { yieldSlice(); return }
    }
  }
  queue()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
}
