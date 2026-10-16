import {
  flattenFileTreeV2, viewRow,
  type FileTreeV2Model, type FileTreeV2Row,
} from "./file-tree-v2-model"
import { IndexedRowSequence } from "./project-explorer-indexed-rows"

/**
 * Search hierarchy is an immutable, sorted projection of the index service.
 * This view alone owns collapsed state, and never triggers a filesystem list.
 *
 * Small single-folder changes splice only visible descendants into a weighted
 * indexed row sequence. Project-level Collapse/Expand All takes the canonical
 * full-flatten path once. Hidden folder changes have zero row/key churn.
 */
export function createIndexedSearchFileTreeRows(model: FileTreeV2Model, initialCollapsed: ReadonlySet<string>) {
  let collapsed = new Set(initialCollapsed)
  let index = new IndexedRowSequence(flattenFileTreeV2(model, (path) => !collapsed.has(path)))
  let cached: FileTreeV2Row[] | undefined
  let keyGeneration = 0
  const rebuild = (next: ReadonlySet<string>) => {
    collapsed = new Set(next)
    index = new IndexedRowSequence(flattenFileTreeV2(model, (path) => !collapsed.has(path)))
    cached = undefined
    keyGeneration++
  }
  const update = (next: ReadonlySet<string>) => {
    let changed: string | undefined
    for (const path of collapsed) {
      if (next.has(path)) continue
      if (changed !== undefined) { rebuild(next); return }
      changed = path
    }
    for (const path of next) {
      if (collapsed.has(path)) continue
      if (changed !== undefined) { rebuild(next); return }
      changed = path
    }
    if (!changed) return
    collapsed = new Set(next)
    const position = index.indexOf(changed)
    if (position < 0) return // a collapsed ancestor hides this directory
    const parent = index.get(position)!
    const from = position + 1
    let end = from
    while (end < index.length && index.get(end)!.level > parent.level) end++
    const incoming: FileTreeV2Row[] = []
    if (parent.node.type === "directory" && !collapsed.has(changed)) {
      const stack: FileTreeV2Row[] = []
      const direct = model.children.get(changed) ?? []
      for (let i = direct.length - 1; i >= 0; i--) stack.push(viewRow(direct[i]!, parent.level + 1))
      while (stack.length) {
        const row = stack.pop()!
        incoming.push(row)
        if (row.node.type !== "directory" || collapsed.has(row.node.path)) continue
        const nested = model.children.get(row.node.path) ?? []
        for (let i = nested.length - 1; i >= 0; i--) stack.push(viewRow(nested[i]!, row.level + 1))
      }
    }
    if (end === from && incoming.length === 0) return
    index.splice(from, end - from, incoming)
    cached = undefined
    keyGeneration++
  }
  return {
    update,
    rebuild,
    get length() { return index.length },
    get keysVersion() { return keyGeneration },
    at: (position: number) => index.get(position),
    indexOfPath: (path: string) => index.indexOf(path),
    rowForPath: (path: string) => index.row(path),
    rows: () => cached ?? (cached = index.toArray()),
    get chunkCount() { return index.chunkCount },
  }
}
