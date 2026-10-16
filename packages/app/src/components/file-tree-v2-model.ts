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

// File watcher updates and folder toggles often reflatten 10k-50k unchanged
// rows. Cache immutable row wrappers by their node identity and tree depth,
// avoiding both large transient allocations and unnecessary row-level reactive
// invalidations. Weak keys preserve the existing subtree eviction semantics.
const rowCache = new WeakMap<FileTreeV2Node, { level: number; row: FileTreeV2Row }>()
export function viewRow(node: FileTreeV2Node, level: number): FileTreeV2Row {
  const cached = rowCache.get(node)
  if (cached?.level === level) return cached.row
  const row = { node, level }
  rowCache.set(node, { level, row })
  return row
}

export function normalizeFileTreeV2Path(value: string) {
  return value
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/")
}

/**
 * Reject unsafe index/search paths before converting separators. The generic
 * key normalizer strips leading slashes; using it first would accidentally
 * launder "/etc/passwd" into a plausible relative workspace path.
 */
export function safeWorkspaceRelativeFilePath(value: string): string | undefined {
  if (!value || /^[\\/]/.test(value) || /^[a-z]:/i.test(value) || value.includes("\0")) return
  const path = normalizeFileTreeV2Path(value)
  // Check segment boundaries without allocating an array per indexed hit.
  // File suffixes like ".ts" and names like ".gitignore" remain legal.
  if (!path || /(?:^|\/)\.{1,2}(?=\/|$)/.test(path)) return
  return path
}

export function buildFileTreeV2Model(paths: readonly string[]): FileTreeV2Model {
  const nodes = new Map<string, FileTreeV2Node>()

  paths.forEach((value) => {
    const file = normalizeFileTreeV2Path(value)
    if (!file) return

    const parts = file.split("/")
    let path = ""
    parts.forEach((name, index) => {
      path = path ? `${path}/${name}` : name
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
  const stack = (model.children.get("") ?? []).toReversed().map((node) => viewRow(node, 0))

  while (stack.length > 0) {
    const row = stack.pop()!
    rows.push(row)
    if (row.node.type !== "directory" || !expanded(row.node.path)) continue
    const children = model.children.get(row.node.path) ?? []
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push(viewRow(children[index]!, row.level + 1))
    }
  }

  return rows
}

/**
 * Search hierarchy rows are immutable and path-sorted. Collapsing/expanding
 * one directory should splice only that visible subtree, not walk the entire
 * search projection again. Batch collapse-all and multi-dir changes retain a
 * full canonical flatten fallback to preserve preorder.
 */
export function createIncrementalSearchFileTreeRows(model: FileTreeV2Model, initialCollapsed: ReadonlySet<string>) {
  let collapsed = new Set(initialCollapsed)
  let rows = flattenFileTreeV2(model, (path) => !collapsed.has(path))
  const rebuild = (next: ReadonlySet<string>) => {
    collapsed = new Set(next)
    rows = flattenFileTreeV2(model, (path) => !collapsed.has(path))
    return rows
  }
  const update = (next: ReadonlySet<string>) => {
    let changed: string | undefined
    for (const path of collapsed) {
      if (next.has(path)) continue
      if (changed !== undefined) return rebuild(next)
      changed = path
    }
    for (const path of next) {
      if (collapsed.has(path)) continue
      if (changed !== undefined) return rebuild(next)
      changed = path
    }
    if (!changed) return rows
    collapsed = new Set(next)
    const index = rows.findIndex((row) => row.node.path === changed)
    if (index < 0) return rows // hidden underneath a collapsed ancestor
    const parent = rows[index]!
    const start = index + 1
    let end = start
    while (end < rows.length && rows[end]!.level > parent.level) end++
    const replacement: FileTreeV2Row[] = []
    if (parent.node.type === "directory" && !collapsed.has(changed)) {
      const children = model.children.get(changed) ?? []
      const stack: FileTreeV2Row[] = []
      for (let i = children.length - 1; i >= 0; i--) stack.push(viewRow(children[i]!, parent.level + 1))
      while (stack.length > 0) {
        const item = stack.pop()!
        replacement.push(item)
        if (item.node.type !== "directory" || collapsed.has(item.node.path)) continue
        const nested = model.children.get(item.node.path) ?? []
        for (let i = nested.length - 1; i >= 0; i--) stack.push(viewRow(nested[i]!, item.level + 1))
      }
    }
    rows = rows.slice(0, start).concat(replacement, rows.slice(end))
    return rows
  }
  return { rows: () => rows, update, rebuild }
}

export function flattenLiveFileTreeV2(
  children: (path: string) => readonly FileNode[],
  expanded: (path: string) => boolean,
  onDuplicate?: (path: string) => void,
) {
  const rows: FileTreeV2Row[] = []
  // Re-listing can expose the same path under multiple parents. Duplicate
  // path keys violate virtualizer identity and keyboard selection semantics.
  // The guard also terminates malformed self-referential directory listings.
  const seen = new Set<string>()
  const stack = children("")
    .toReversed()
    .map((node) => toLiveRow(node, 0))

  while (stack.length > 0) {
    const row = stack.pop()!
    if (seen.has(row.node.path)) {
      onDuplicate?.(row.node.path)
      continue
    }
    seen.add(row.node.path)
    rows.push(row)
    if (row.node.type !== "directory" || !expanded(row.node.path)) continue
    const nested = children(row.node.originalPath)
    for (let index = nested.length - 1; index >= 0; index--) {
      stack.push(toLiveRow(nested[index]!, row.level + 1))
    }
  }

  return rows
}

/**
 * Presentation-only incremental projection driven by store-owned directory
 * changes. Unaffected branches preserve row identities and need no traversal.
 * Fall back to a full rebuild for resets and root-wide changes.
 */
export function createIncrementalLiveFileTreeV2(
  children: (path: string) => readonly FileNode[],
  expanded: (path: string) => boolean,
  lookup?: (path: string) => FileNode | undefined,
) {
  let ambiguous = false
  const collect = () => {
    ambiguous = false
    return flattenLiveFileTreeV2(children, expanded, () => { ambiguous = true })
  }
  let rows = collect()
  let visiblePaths = new Set(rows.map((row) => row.node.path))
  const rebuild = () => {
    rows = collect()
    visiblePaths = new Set(rows.map((row) => row.node.path))
    return rows
  }
  // A root-directory listing can update a single top-level file while tens
  // of thousands of files remain open underneath unchanged sibling folders.
  // Reuse their existing contiguous preorder spans rather than re-querying
  // each expanded directory. Callers must use rebuild() when root and nested
  // directories changed together in the same journal batch.
  const refreshRoot = () => {
    if (ambiguous) return rebuild()
    const spans = new Map<string, { first: FileTreeV2Row; from: number; to: number }>()
    let cursor = 0
    while (cursor < rows.length) {
      const first = rows[cursor]!
      if (first.level !== 0) return rebuild()
      let to = cursor + 1
      while (to < rows.length && rows[to]!.level > 0) to++
      spans.set(first.node.path, { first, from: cursor + 1, to })
      cursor = to
    }
    const next: FileTreeV2Row[] = []
    const seen = new Set<string>()
    const append = (row: FileTreeV2Row) => {
      if (seen.has(row.node.path)) return false
      seen.add(row.node.path)
      next.push(row)
      return true
    }
    for (const child of children("")) {
      const head = toLiveRow(child, 0)
      if (!append(head)) return rebuild()
      if (head.node.type !== "directory" || !expanded(head.node.originalPath)) continue
      const old = spans.get(head.node.path)
      if (old?.first.node.type === "directory" && old.to > old.from) {
        for (let i = old.from; i < old.to; i++) {
          if (!append(rows[i]!)) return rebuild()
        }
        continue
      }
      const stack = children(head.node.originalPath).toReversed().map((node) => toLiveRow(node, 1))
      while (stack.length > 0) {
        const row = stack.pop()!
        if (!append(row)) return rebuild()
        if (row.node.type !== "directory" || !expanded(row.node.originalPath)) continue
        const nested = children(row.node.originalPath)
        for (let i = nested.length - 1; i >= 0; i--) stack.push(toLiveRow(nested[i]!, row.level + 1))
      }
    }
    rows = next
    visiblePaths = seen
    return rows
  }
  const update = (input: string) => {
    // If a malformed listing contained cross-parent duplicate paths, the
    // earlier winner may disappear and expose a previously suppressed row.
    // Only a full traversal can decide which parent now owns that path.
    if (ambiguous) return rebuild()
    const directory = normalizeFileTreeV2Path(input)
    if (!directory) return refreshRoot()
    const index = rows.findIndex((row) => row.node.path === directory)
    if (index < 0) return rows
    const parent = rows[index]!
    // Directory metadata (name, ignored, mtime, type) is owned by the file
    // store's node index, not its child listing. A watcher can update a
    // collapsed directory's own metadata without changing any descendants.
    // Reading the authoritative node by key avoids scanning the parent's
    // entire sibling array just to refresh this one visible row.
    const authoritative = lookup?.(parent.node.originalPath)
    if (lookup && !authoritative) return rebuild()
    const refreshed = authoritative ? toLiveRow(authoritative, parent.level) : parent
    if (refreshed.node.type !== "directory") {
      // A directory may become a file (or vice versa) after an external rename.
      // A full traversal is the only correct answer if its identity/parent
      // relation also changed.
      if (refreshed.node.path !== directory) return rebuild()
    }
    const start = index + 1
    let end = start
    while (end < rows.length && rows[end]!.level > parent.level) end++
    if (end === start && (refreshed.node.type !== "directory" || !expanded(refreshed.node.originalPath))) {
      if (refreshed === parent) return rows
      rows = rows.slice()
      rows[index] = refreshed
      return rows
    }
    for (let i = start; i < end; i++) visiblePaths.delete(rows[i]!.node.path)
    const replacement: FileTreeV2Row[] = []
    if (refreshed.node.type === "directory" && expanded(refreshed.node.originalPath)) {
      const stack: FileTreeV2Row[] = []
      const roots = children(refreshed.node.originalPath)
      for (let i = roots.length - 1; i >= 0; i--) stack.push(toLiveRow(roots[i]!, parent.level + 1))
      while (stack.length > 0) {
        const row = stack.pop()!
        if (visiblePaths.has(row.node.path)) {
          ambiguous = true
          continue
        }
        visiblePaths.add(row.node.path)
        replacement.push(row)
        if (row.node.type !== "directory" || !expanded(row.node.originalPath)) continue
        const nested = children(row.node.originalPath)
        for (let i = nested.length - 1; i >= 0; i--) stack.push(toLiveRow(nested[i]!, row.level + 1))
      }
    }
    // Avoid argument-count exceptions from splice(...50k children).
    rows = rows.slice(0, index).concat(refreshed, replacement, rows.slice(end))
    if (ambiguous) return rebuild()
    return rows
  }
  return { rows: () => rows, rebuild, update }
}

export function toLiveRow(node: FileNode, level: number): FileTreeV2Row {
  const cached = liveNodeCache.get(node)
  if (cached?.level === level) return cached.row
  const live = cached?.node ?? {
    ...node,
    path: normalizeFileTreeV2Path(node.path),
    originalPath: node.path,
  }
  const row = { node: live, level }
  liveNodeCache.set(node, { node: live, level, row })
  return row
}

// Derived live nodes are a pure function of the *source* FileNode identity.
// Solid's store hands us proxy objects that keep a stable reference until the
// backing data is actually replaced (produce/set/reconcile), so caching by
// source identity turns the per-row O(n) spread allocation during every tree
// re-flatten (triggered by any watcher refresh or expand) into an O(changed)
// pass. WeakMap so evicted store nodes don't pin memory.
const liveNodeCache = new WeakMap<FileNode, { node: FileTreeV2Node; level: number; row: FileTreeV2Row }>()
