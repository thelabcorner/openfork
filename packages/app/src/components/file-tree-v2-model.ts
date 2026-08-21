import type { FileNode } from "@opencode-ai/sdk/v2"

export type FileTreeV2Model = {
  children: ReadonlyMap<string, readonly FileTreeV2Node[]>
  total: number
}

export type FileTreeV2Node = FileNode & { originalPath: string }

export type FileTreeV2Row = {
  node: FileTreeV2Node
  level: number
}

export function normalizeFileTreeV2Path(value: string) {
  return value
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
}

export function buildFileTreeV2Model(paths: readonly string[]): FileTreeV2Model {
  const nodes = new Map<string, FileTreeV2Node>()

  paths.forEach((value) => {
    const file = normalizeFileTreeV2Path(value)
    if (!file) return

    const parts = file.split("/")
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join("/")
      if (nodes.has(path)) return
      nodes.set(path, {
        name,
        path,
        absolute: path,
        type: index === parts.length - 1 ? "file" : "directory",
        ignored: false,
        originalPath: index === parts.length - 1 ? value : path,
      })
    })
  })

  const children = new Map<string, FileTreeV2Node[]>()
  nodes.forEach((node) => {
    const index = node.path.lastIndexOf("/")
    const parent = index === -1 ? "" : node.path.slice(0, index)
    const list = children.get(parent)
    if (list) list.push(node)
    else children.set(parent, [node])
  })
  children.forEach((nodes) =>
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name)
    }),
  )

  return { children, total: nodes.size }
}

export function flattenFileTreeV2(model: FileTreeV2Model, expanded: (path: string) => boolean) {
  const rows: FileTreeV2Row[] = []
  const stack = (model.children.get("") ?? []).toReversed().map((node) => ({ node, level: 0 }))

  while (stack.length > 0) {
    const row = stack.pop()!
    rows.push(row)
    if (row.node.type !== "directory" || !expanded(row.node.path)) continue
    const children = model.children.get(row.node.path) ?? []
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ node: children[index]!, level: row.level + 1 })
    }
  }

  return rows
}

export function flattenLiveFileTreeV2(
  children: (path: string) => readonly FileNode[],
  expanded: (path: string) => boolean,
) {
  const rows: FileTreeV2Row[] = []
  const stack = children("")
    .toReversed()
    .map((node) => ({ node: toLiveNode(node), level: 0 }))

  while (stack.length > 0) {
    const row = stack.pop()!
    rows.push(row)
    if (row.node.type !== "directory" || !expanded(row.node.path)) continue
    const nested = children(row.node.originalPath)
    for (let index = nested.length - 1; index >= 0; index--) {
      stack.push({ node: toLiveNode(nested[index]!), level: row.level + 1 })
    }
  }

  return rows
}

function toLiveNode(node: FileNode): FileTreeV2Node {
  const cached = liveNodeCache.get(node)
  if (cached) return cached
  const live = {
    ...node,
    path: normalizeFileTreeV2Path(node.path),
    originalPath: node.path,
  }
  liveNodeCache.set(node, live)
  return live
}

// Derived live nodes are a pure function of the *source* FileNode identity.
// Solid's store hands us proxy objects that keep a stable reference until the
// backing data is actually replaced (produce/set/reconcile), so caching by
// source identity turns the per-row O(n) spread allocation during every tree
// re-flatten (triggered by any watcher refresh or expand) into an O(changed)
// pass. WeakMap so evicted store nodes don't pin memory.
const liveNodeCache = new WeakMap<FileNode, FileTreeV2Node>()
