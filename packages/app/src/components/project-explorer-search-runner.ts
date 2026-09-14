import type { FileNode } from "@opencode-ai/sdk/v2"
import { normalizeFileTreeV2Path, type FileTreeV2Node, type FileTreeV2Row } from "./file-tree-v2-model"

export type ProjectExplorerSearchResult = {
  query: string
  matches: Set<string>
  ancestors: Set<string>
  rows: FileTreeV2Row[]
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

export function startProjectExplorerSearch(input: {
  query: string
  nodes: readonly FileNode[]
  root: () => readonly FileNode[]
  children: (originalPath: string) => readonly FileNode[]
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
  let stack: Array<{ node: FileTreeV2Node; level: number }> | undefined
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
        matches.add(item.path)
        let current = item.path
        while (true) {
          const parent = current.lastIndexOf("/")
          if (parent === -1) break
          current = current.slice(0, parent)
          if (!current || ancestors.has(current)) break
          ancestors.add(current)
        }
      }
      if ((++iterations & 255) === 0 && now() - started >= sliceMs) {
        finishSlice(started)
        queue()
        return
      }
    }

    if (!stack) stack = input.root().toReversed().map((node) => ({ node: live(node), level: 0 }))
    while (stack.length > 0) {
      const row = stack.pop()!
      if (matches.has(row.node.path) || ancestors.has(row.node.path)) {
        rows.push(row)
        if (row.node.type === "directory" && ancestors.has(row.node.path)) {
          const nested = input.children(row.node.originalPath)
          for (let index = nested.length - 1; index >= 0; index--) {
            stack.push({ node: live(nested[index]!), level: row.level + 1 })
          }
        }
      }
      if ((++iterations & 255) === 0 && now() - started >= sliceMs) {
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
