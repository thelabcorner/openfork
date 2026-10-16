import type { FileNode } from "@opencode-ai/sdk/v2"
import { flattenLiveFileTreeV2, normalizeFileTreeV2Path, toLiveRow, type FileTreeV2Row } from "./file-tree-v2-model"
import { IndexedRowSequence } from "./project-explorer-indexed-rows"

/**
 * The same authoritative directory graph as flattenLiveFileTreeV2, projected
 * to a weighted indexed sequence. A local directory change costs roughly
 * O(log visible + changed descendant rows) instead of copying all visible
 * siblings; rowAt and indexOf never construct a dense row array.
 *
 * A full array is materialized lazily only for deliberately global interactions
 * such as Select All. No filesystem requests originate here.
 */
export function createIndexedLiveFileTreeV2(
  children: (directory: string) => readonly FileNode[],
  expanded: (directory: string) => boolean,
  lookup: (path: string) => FileNode | undefined,
) {
  let ambiguous = false
  const collect = () => {
    ambiguous = false
    return flattenLiveFileTreeV2(children, expanded, () => { ambiguous = true })
  }
  let cached: FileTreeV2Row[] | undefined = collect()
  let index = new IndexedRowSequence(cached)
  let previousRootOrder = children("").map((node) => normalizeFileTreeV2Path(node.path))
  let keysVersion = 0
  const rebuild = () => {
    cached = collect()
    index = new IndexedRowSequence(cached)
    previousRootOrder = children("").map((node) => normalizeFileTreeV2Path(node.path))
    keysVersion++
  }
  const markDirty = () => { cached = undefined }
  const splice = (position: number, remove: number, replacement: readonly FileTreeV2Row[]) => {
    const before = index.keysVersion
    index.splice(position, remove, replacement)
    if (index.keysVersion !== before) keysVersion++
    markDirty()
  }
  const refreshRoot = () => {
    if (ambiguous) { rebuild(); return }
    const currentRoots = children("")
    if (currentRoots.length !== previousRootOrder.length) { rebuild(); return }
    for (let i = 0; i < currentRoots.length; i++) {
      if (normalizeFileTreeV2Path(currentRoots[i]!.path) !== previousRootOrder[i]) {
        // Root reorder/add/remove requires moving entire expanded spans, not
        // only updating row metadata. Preserve exact canonical order.
        rebuild()
        return
      }
    }
    for (const node of currentRoots) {
      const path = normalizeFileTreeV2Path(node.path)
      const previous = index.row(path)
      if (!previous || previous.level !== 0) { rebuild(); return }
      const current = toLiveRow(node, 0)
      if (current === previous) continue
      // Root-only metadata updates do not imply that its 49k descendants
      // changed. Replace only the root row, preserving existing descendant
      // chunks and their index keys. Type/origin transitions need a subtree
      // reconciliation and use the ordinary indexed update below.
      if (current.node.type === previous.node.type &&
          current.node.originalPath === previous.node.originalPath) {
        splice(index.indexOf(path), 1, [current])
      } else update(path)
    }
  }
  const update = (input: string) => {
    if (ambiguous) { rebuild(); return }
    const directory = normalizeFileTreeV2Path(input)
    if (!directory) { refreshRoot(); return }
    const position = index.indexOf(directory)
    if (position === -1) return
    const previous = index.get(position)!
    const authoritative = lookup(previous.node.originalPath)
    if (!authoritative) { rebuild(); return }
    const current = toLiveRow(authoritative, previous.level)
    if (current.node.path !== directory) { rebuild(); return }
    let end = position + 1
    while (end < index.length && index.get(end)!.level > previous.level) end++
    if (end === position + 1 && (current.node.type !== "directory" || !expanded(current.node.originalPath))) {
      if (current !== previous) {
        splice(position, 1, [current])
      }
      return
    }

    const previouslyInside = new Set<string>()
    for (let i = position; i < end; i++) previouslyInside.add(index.get(i)!.node.path)
    const next: FileTreeV2Row[] = [current]
    const localSeen = new Set<string>([current.node.path])
    if (current.node.type === "directory" && expanded(current.node.originalPath)) {
      const stack: FileTreeV2Row[] = []
      const direct = children(current.node.originalPath)
      for (let i = direct.length - 1; i >= 0; i--) {
        stack.push(toLiveRow(direct[i]!, previous.level + 1))
      }
      while (stack.length) {
        const row = stack.pop()!
        const path = row.node.path
        if (localSeen.has(path) || (index.indexOf(path) >= 0 && !previouslyInside.has(path))) {
          // Malformed watcher source or cyclic listing: preserve canonical
          // first-seen semantics with a full authoritative rebuild.
          ambiguous = true
          rebuild()
          return
        }
        localSeen.add(path)
        next.push(row)
        if (row.node.type !== "directory" || !expanded(row.node.originalPath)) continue
        const nested = children(row.node.originalPath)
        for (let i = nested.length - 1; i >= 0; i--) {
          stack.push(toLiveRow(nested[i]!, row.level + 1))
        }
      }
    }
    splice(position, end - position, next)
  }
  return {
    rebuild,
    update,
    get length() { return index.length },
    get keysVersion() { return keysVersion },
    at: (position: number) => index.get(position),
    indexOfPath: (path: string) => index.indexOf(path),
    rowForPath: (path: string) => index.row(path),
    rows: () => cached ?? (cached = index.toArray()),
    get depth() { return index.maxDepth() },
  }
}
