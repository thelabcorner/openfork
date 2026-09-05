import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack, type Accessor } from "solid-js"
import { createVirtualizer, defaultRangeExtractor } from "@tanstack/solid-virtual"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { virtualScrollElement } from "@/components/virtual-scroll-element"
import { pathToFileUrl, withFileDragImage, type Kind } from "@/components/file-tree"
import {
  flattenLiveFileTreeV2,
  normalizeFileTreeV2Path,
  type FileTreeV2Node,
  type FileTreeV2Row,
} from "@/components/file-tree-v2-model"
import type { ProjectExplorerFavorites } from "@/utils/project-explorer-favorites"
import { ProjectExplorerTreeContextMenu } from "@/components/project-explorer-tree-context-menu"
import { createProjectExplorerSearchExpansion } from "@/components/project-explorer-search"
import {
  formatAbsoluteTime,
  formatFileSize,
  formatFolderCount,
  formatLineCount,
  formatRelativeTime,
} from "@/components/prompt-input/at-row-meta"
import "./project-explorer-tree.css"

type PendingCreate = { parentDir: string; kind: "file" | "directory" }

export type ProjectExplorerTreeHandle = {
  startRename: (path: string) => void
  startCreate: (parentDir: string, kind: "file" | "directory") => void
  startDelete: (path: string) => void
  expandAll: () => void
  collapseAll: () => void
  /** Select a file in the tree, expanding its ancestors and scrolling it into
   * view (used by "reveal in explorer" from the editor tab menu). */
  reveal: (path: string) => void
  // ── Multi-select ───────────────────────────────────────
  getSelectedPaths: () => string[]
  clearSelection: () => void
  selectAll: () => void
  /** The current anchor (shift-range origin) — null when nothing selected. */
  getAnchor?: () => string | undefined
  /** Number of selected items (convenience for toolbar badge). */
  getSelectedCount?: () => number
}

export function ProjectExplorerTree(props: {
  active?: string
  gitStatus?: ReadonlyMap<string, Kind>
  favorites: ProjectExplorerFavorites
  search?: string
  onOpen: (node: { path: string; type: "file" | "directory" }) => void
  onMention: (path: string) => void
  onRename: (from: string, to: string) => void
  onDelete: (path: string) => void
  onCreate: (path: string, kind: "file" | "directory") => void
  onSelectionChange?: (paths: string[]) => void
  ref?: (handle: ProjectExplorerTreeHandle) => void
}) {
  const file = useFile()
  const language = useLanguage()

  const loading = createMemo(() => {
    const state = file.tree.state("")
    if (!state) return false
    return !state.loaded && state.loading !== false
  })
  const rootError = createMemo(() => file.tree.state("")?.error)

  // Live clock for relative timestamps — updates every minute so "5m ago"
  // rolls without requiring a file watcher event.
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    onCleanup(() => clearInterval(id))
  })

  function TreeSkeleton() {
    const rows = [
      { w: "62%", indent: 0 },
      { w: "48%", indent: 14 },
      { w: "55%", indent: 14 },
      { w: "38%", indent: 28 },
      { w: "58%", indent: 0 },
      { w: "44%", indent: 18 },
      { w: "52%", indent: 14 },
      { w: "36%", indent: 0 },
    ] as const
    return (
      <div class="flex flex-col gap-1 px-2 py-2" aria-busy="true" aria-label={language.t("common.loading")}>
        <For each={rows}>
          {(r) => (
            <div class="flex items-center gap-2" style={{ "padding-inline-start": `${r.indent}px` }}>
              <div class="size-3.5 shrink-0 rounded-[3px] bg-v2-background-bg-layer-02 animate-pulse" />
              <div
                class="h-3.5 shrink-0 rounded-[5px] bg-v2-background-bg-layer-02 animate-pulse"
                style={{ width: r.w }}
              />
            </div>
          )}
        </For>
      </div>
    )
  }

  function EmptyState() {
    const isSearch = () => searching()
    return (
      <div class="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
        <div class="flex size-8 items-center justify-center rounded-full bg-v2-background-bg-layer-02">
          <Icon name={isSearch() ? "magnifying-glass" : "folder"} size="small" />
        </div>
        <div class="text-12-medium text-v2-text-text-muted">
          {isSearch() ? language.t("projectExplorer.search.noResults") : "No files yet"}
        </div>
        <Show when={!isSearch()}>
          <div class="max-w-44 text-11-regular text-v2-text-text-faint">
            This directory is empty — create a file to get started.
          </div>
        </Show>
      </div>
    )
  }

  const [root, setRoot] = createSignal<HTMLDivElement>()
  const [focused, setFocused] = createSignal<string>()
  // ── Multi-selection (shift / ctrl) ────────────────────────
  // `selectedSet` is the source-of-truth for all selected paths (normalized).
  // `anchor` remembers the last non-shift click / Ctrl-toggle, which Shift-range
  // extends from. Mirrors VS Code / Finder / Explorer semantics at 60fps
  // without re-allocating huge arrays on every click.
  const initialSelected = props.active ? new Set([normalizeFileTreeV2Path(props.active)]) : new Set<string>()
  const [selectedSet, setSelectedSet] = createSignal<Set<string>>(initialSelected)
  const [anchor, setAnchor] = createSignal<string | undefined>(
    props.active ? normalizeFileTreeV2Path(props.active) : undefined,
  )
  const isSelected = (path: string) => selectedSet().has(path)
  const selectedArray = () => [...selectedSet()]
  const selectedCount = () => selectedSet().size
  const clearSelection = () => {
    setSelectedSet(new Set<string>())
    setAnchor(undefined)
  }
  const selectSingle = (path: string) => {
    if (path.startsWith("__creating__:")) return
    setSelectedSet(new Set([path]))
    setAnchor(path)
    setFocused(path)
  }
  const toggleSingle = (path: string) => {
    if (path.startsWith("__creating__:")) return
    const next = new Set(selectedSet())
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setSelectedSet(next)
    setAnchor(path)
    setFocused(path)
  }

  const selectRange = (target: string, additive: boolean) => {
    if (target.startsWith("__creating__:")) return
    const a = anchor()
    const list = visibleRows()
    const idx = visibleIndex()
    const aIdx = a ? (idx.get(a) ?? -1) : -1
    const tIdx = idx.get(target) ?? -1
    if (aIdx === -1 || tIdx === -1) {
      selectSingle(target)
      return
    }
    const lo = Math.min(aIdx, tIdx)
    const hi = Math.max(aIdx, tIdx)
    const range = list.slice(lo, hi + 1).map((r) => r.node.path)
    if (additive) {
      const next = new Set(selectedSet())
      for (const p of range) if (!p.startsWith("__creating__:")) next.add(p)
      setSelectedSet(next)
    } else {
      setSelectedSet(new Set(range.filter((p) => !p.startsWith("__creating__:"))))
    }
    setFocused(target)
  }
  const selectAllVisible = () => {
    const all = visibleRows()
      .map((r) => r.node.path)
      .filter((p) => !p.startsWith("__creating__:"))
    setSelectedSet(new Set(all))
    if (all.length > 0) setAnchor(all[0]!)
  }

  // Bulk actions eventually call network-backed parent callbacks. Dispatch a
  // small synchronous slice, then yield with a timer so a 10k-file selection
  // cannot monopolize the renderer while still preserving action order.
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const dispatchInChunks = <A,>(items: readonly A[], dispatch: (item: A) => void) => {
    let cursor = 0
    const drain = () => {
      if (disposed) return
      const end = Math.min(items.length, cursor + 32)
      while (cursor < end) dispatch(items[cursor++])
      if (cursor < items.length) setTimeout(drain, 0)
    }
    drain()
  }

  // Provide project-explorer-tree equivalent of `select(path)` for backwards-compat
  const select = selectSingle

  const [renaming, setRenaming] = createSignal<string>()
  const [deleting, setDeleting] = createSignal<string>()
  const [creating, setCreating] = createSignal<PendingCreate>()

  createEffect(() => {
    const state = file.tree.state("")
    if (state?.loaded || state?.loading) return
    untrack(() => void file.tree.list(""))
  })

  const expanded = (path: string) => file.tree.state(path)?.expanded ?? false

  const rows = createMemo(() => {
    const base = flattenLiveFileTreeV2((path) => file.tree.children(path), expanded)
    const pending = creating()
    if (!pending) return base
    const insertAt = pending.parentDir === "" ? 0 : base.findIndex((row) => row.node.path === pending.parentDir) + 1
    const level =
      pending.parentDir === "" ? 0 : (base.find((row) => row.node.path === pending.parentDir)?.level ?? 0) + 1
    const synthetic = {
      node: {
        name: "",
        path: `__creating__:${pending.parentDir}`,
        absolute: "",
        type: pending.kind,
        ignored: false,
        originalPath: "",
      } as FileTreeV2Node,
      level,
    }
    return [...base.slice(0, insertAt), synthetic, ...base.slice(insertAt)]
  })

  const searchIndex = createMemo(() => {
    const index: { path: string; lower: string }[] = []
    for (const node of file.tree.allNodes()) {
      const path = normalizeFileTreeV2Path(node.path)
      index.push({ path, lower: path.toLowerCase() })
    }
    return index
  })

  const searching = createMemo(() => Boolean(props.search?.trim()))
  const searchQuery = createMemo(() => props.search?.trim().toLowerCase() ?? "")

  const searchExpansion = createProjectExplorerSearchExpansion({
    isExpanded: (path) => file.tree.state(path)?.expanded ?? false,
    expand: (path, options) => file.tree.expand(path, options),
    collapse: (path) => file.tree.collapse(path),
    beginGeneration: file.tree.beginGeneration,
  })

  const searchMatches = createMemo(() => {
    const query = props.search?.trim().toLowerCase()
    if (!query) return undefined
    const matches = new Set<string>()
    for (const entry of searchIndex()) {
      if (entry.lower.includes(query)) matches.add(entry.path)
    }
    return matches
  })

  const searchAncestors = createMemo(() => {
    const matches = searchMatches()
    if (!matches) return undefined
    const ancestors = new Set<string>()
    for (const path of matches) {
      for (let parent = path.lastIndexOf("/"); parent !== -1; parent = path.lastIndexOf("/", parent - 1)) {
        ancestors.add(path.slice(0, parent))
      }
    }
    return ancestors
  })

  createEffect(() => {
    const ancestors = searchAncestors()
    const query = searchQuery()
    untrack(() => searchExpansion.sync(ancestors, query))
  })

  onCleanup(searchExpansion.dispose)

  const visibleRows = createMemo(() => {
    const matches = searchMatches()
    if (!matches) return rows()
    const ancestors = searchAncestors()!
    const out: FileTreeV2Row[] = []
    const stack = file.tree
      .children("")
      .toReversed()
      .map((node) => ({ node: toLive(node), level: 0 }))
    while (stack.length > 0) {
      const row = stack.pop()!
      if (!matches.has(row.node.path) && !ancestors.has(row.node.path)) continue
      out.push(row)
      if (row.node.type !== "directory" || !ancestors.has(row.node.path)) continue
      const nested = file.tree.children(row.node.originalPath)
      for (let index = nested.length - 1; index >= 0; index--) {
        stack.push({ node: toLive(nested[index]!), level: row.level + 1 })
      }
    }
    return out
  })

  const empty = createMemo(() => visibleRows().length === 0)

  const visibleIndex = createMemo(() => {
    const index = new Map<string, number>()
    let i = 0
    for (const row of visibleRows()) index.set(row.node.path, i++)
    return index
  })

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return visibleRows().length
    },
    getScrollElement: () => virtualScrollElement(root()),
    initialRect: { width: 0, height: 600 },
    estimateSize: () => 22,
    // The tree owns row spacing. Keeping the virtualizer gap at zero prevents
    // a stale/default gap from being applied between absolutely-positioned
    // rows when the explorer is mounted after another virtualized surface.
    gap: 0,
    overscan: 12,
    get getItemKey() {
      const current = visibleRows()
      return (index: number) => current[index]?.node.path ?? index
    },
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range)
      const path = focused()
      const index = path ? (visibleIndex().get(path) ?? -1) : -1
      if (index < 0 || indexes.includes(index)) return indexes
      return [...indexes, index].sort((a, b) => a - b)
    },
  })

  // The explorer mounts inside a panel that can still be collapsed (zero-height
  // scroll viewport). virtual-core returns a NULL range whenever outerSize is 0,
  // so the container sizes correctly from getTotalSize() — which is derived from
  // `measurements` and never consults the viewport rect — while getVirtualItems()
  // comes back empty. The visible result is a full-height tree with no rows.
  //
  // Nothing recovers from that on its own: the Solid adapter only calls
  // `_willUpdate()` (which re-resolves getScrollElement and re-attaches the rect
  // observer) from its `createComputed`, and that re-runs only when a tracked
  // option getter — `count` or `getItemKey` — changes. Once the tree data has
  // settled, the zero rect is never revisited, so neither scrolling nor a window
  // resize brings the rows back; only remounting the component does.
  //
  // Observing our own root and nudging the virtualizer when it is in exactly that
  // broken state (sized, but with nothing to show) re-binds it to the real
  // viewport. `measure()` routes through notify -> onChange -> _willUpdate.
  createEffect(() => {
    const el = root()
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === 0) return
      if (virtualizer.getVirtualItems().length > 0) return
      if (virtualizer.getTotalSize() <= 0) return
      virtualizer.measure()
    })
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  })

  const rowByKey = createMemo(() => new Map(visibleRows().map((row) => [row.node.path, row] as const)))
  // Iterate the virtual items themselves rather than a list of their `key`s.
  // `getItemKey` returns `node.path`, and a tree can legitimately surface the
  // same normalized path more than once in `visibleRows()` (an expanded
  // directory re-listing a child that is already present upstream). `<For>` is
  // keyed by value, so duplicate string keys made it render one row several
  // times and silently drop the others — the rendered rows collapsed onto a few
  // shared offsets, leaving 22px-multiple voids where the dropped rows should
  // have been. Expanding `docs` in this repo produced 71 elements at 46 distinct
  // positions. `index` is unique by construction, so it cannot collide.
  const virtualItems = createMemo(() => virtualizer.getVirtualItems())

  const toggleDir = (node: FileTreeV2Node) => {
    searchExpansion.userToggled(node.path)
    if (expanded(node.path)) {
      file.tree.collapse(node.originalPath)
      return
    }
    file.tree.expand(node.originalPath)
  }

  const openRow = (node: FileTreeV2Node) => {
    if (node.type === "directory") {
      toggleDir(node)
      return
    }
    props.onOpen({ path: node.originalPath, type: "file" })
  }

  const commitRename = (node: FileTreeV2Node, next: string) => {
    setRenaming(undefined)
    const trimmed = next.trim()
    if (!trimmed || trimmed === node.name) return
    const parent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : ""
    const to = parent ? `${parent}/${trimmed}` : trimmed
    props.onRename(node.originalPath, to)
  }

  const commitCreate = (pending: PendingCreate, name: string) => {
    setCreating(undefined)
    const trimmed = name.trim()
    if (!trimmed) return
    const path = pending.parentDir ? `${pending.parentDir}/${trimmed}` : trimmed
    props.onCreate(path, pending.kind)
  }

  // ── click / keyboard selection helpers (IDE semantics) ──
  const isToggleMod = (e: MouseEvent | KeyboardEvent) => e.ctrlKey || (e as MouseEvent).metaKey

  const handleRowClick = (event: MouseEvent, path: string) => {
    if (path.startsWith("__creating__:")) return
    const toggle = isToggleMod(event)
    const shift = event.shiftKey
    // Ctrl+Shift: additive range, Shift: replace range, Ctrl: toggle, plain: single
    if (shift && toggle) {
      selectRange(path, true)
    } else if (shift) {
      selectRange(path, false)
    } else if (toggle) {
      toggleSingle(path)
    } else {
      selectSingle(path)
    }
  }
  // Defer plain single-select on already-multi-selected rows until mouseUp so
  // a drag of the whole selection isn't collapsed to one item on mouseDown
  // (Finder / VS Code / JetBrains parity). Ctrl / Shift stay immediate.
  let pendingSinglePath: string | null = null
  const [isDragging, setIsDragging] = createSignal(false)
  const [dragOverPath, setDragOverPath] = createSignal<string | undefined>(undefined)

  // Plain clicks on an already-multi-selected row must stay multi through
  // mousedown so a drag can carry the whole set. Collapse to single happens
  // on click (or is cancelled by drag). Ctrl/Shift remain immediate but we
  // handle them on click so a blocked mousedown (menu Trigger) still works.
  const handleRowMouseDown = (event: MouseEvent, path: string) => {
    if (path.startsWith("__creating__:")) return
    const toggle = isToggleMod(event)
    const shift = event.shiftKey
    if (toggle || shift) return // let click handle toggle/range (mousedown may be swallowed)
    if (isSelected(path) && selectedSet().size > 1) {
      pendingSinglePath = path
      setFocused(path)
      event.preventDefault()
    }
  }
  const handleRowMouseUp = (_event: MouseEvent, _path: string) => {
    // Collapse is handled on click so we keep pending alive through mouseUp
    // until click fires; drag start will clear it.
  }
  const handleRowContextMenu = (path: string) => {
    if (path.startsWith("__creating__:")) return
    // If right-clicked row is already in a multi-selection, keep it (bulk menu).
    // Otherwise make it the sole selection — mirrors Finder / VS Code.
    if (!isSelected(path)) selectSingle(path)
    else setFocused(path)
  }
  const handleRowDragStart = (event: DragEvent, node: FileTreeV2Node) => {
    const path = node.path
    const selected = selectedSet()
    const dragPaths = selected.has(path) && selected.size > 1 ? [...selected] : [node.originalPath || path]
    const first = dragPaths[0] ?? node.originalPath
    setIsDragging(true)
    pendingSinglePath = null
    event.dataTransfer?.setData("text/plain", dragPaths.map((p) => `file:${p}`).join("\n"))
    // Provide file URIs for external drops; first URI is primary.
    event.dataTransfer?.setData("text/uri-list", dragPaths.map((p) => pathToFileUrl(p)).join("\r\n"))
    // Fallback single entry for consumers expecting `text/uri-list` with one item.
    if (dragPaths.length === 1) event.dataTransfer?.setData("text/uri-list", pathToFileUrl(first))
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
    withFileDragImage(event)
  }
  const handleRowDragEnd = () => {
    // Defer clearing so the follow-up click (which fires after dragEnd) is
    // suppressed — otherwise it would collapse the multi-selection.
    setTimeout(() => setIsDragging(false), 0)
  }
  const handleRowDragOver = (event: DragEvent, targetPath: string, isDir: boolean) => {
    if (!isDir) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
    setDragOverPath(targetPath)
  }
  const handleRowDrop = (event: DragEvent, targetNode: FileTreeV2Node) => {
    event.preventDefault()
    event.stopPropagation()
    const targetDir = targetNode.type === "directory" ? targetNode.path : ""
    setDragOverPath(undefined)
    // Prefer in-app multi-selection over external dataTransfer
    let sources: string[] = []
    const sel = [...selectedSet()]
    // If the drop target itself was selected, ignore (drag onto self)
    if (targetDir && sel.includes(targetDir)) return
    if (sel.length > 1) {
      // Drag originated from this tree — use selection
      sources = sel
    } else {
      const raw = event.dataTransfer?.getData("text/plain") ?? ""
      const lines = raw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (s.startsWith("file:") ? s.slice(5) : s))
      sources = lines.length > 0 ? lines : sel.length === 1 ? sel : []
    }
    if (sources.length === 0) return
    const moves: Array<{ from: string; to: string }> = []
    for (const src of sources) {
      if (!src || src === targetDir) continue
      // Don't move a parent into its own child
      if (targetDir && (targetDir === src || targetDir.startsWith(src + "/"))) continue
      const base = src.includes("/") ? src.slice(src.lastIndexOf("/") + 1) : src
      const dest = targetDir ? `${targetDir}/${base}` : base
      if (dest === src) continue
      // originalPath may be needed for correct server path, but tree stores
      // normalized; map back via rowByKey when possible
      const srcNode = rowByKey().get(src)?.node ?? ({ originalPath: src } as FileTreeV2Node)
      const from = (srcNode as FileTreeV2Node).originalPath || src
      moves.push({ from, to: dest })
    }
    dispatchInChunks(moves, (move) => props.onRename(move.from, move.to))
  }

  const moveSelection = (delta: number, extend: boolean) => {
    const list = visibleRows()
    if (list.length === 0) return
    // `focused` is the keyboard cursor; if nothing focused, anchor or first item.
    const cursor =
      focused() ?? anchor() ?? (selectedSet().size === 1 ? [...selectedSet()][0] : undefined) ?? list[0]!.node.path
    const curIdx = visibleIndex().get(cursor) ?? 0
    const nextIdx = Math.min(list.length - 1, Math.max(0, curIdx + delta))
    const path = list[nextIdx]!.node.path
    if (extend) {
      // Shift+Arrow extends from anchor, leaving existing selection additive (like VS Code)
      if (!anchor()) setAnchor(cursor)
      selectRange(path, true)
    } else {
      selectSingle(path)
    }
    setFocused(path)
    virtualizer.scrollToIndex(nextIdx, { align: "auto" })
  }

  const [revealTarget, setRevealTarget] = createSignal<string>()
  createEffect(() => {
    const path = revealTarget()
    if (!path) return
    const scroller = virtualScrollElement(root())
    if (!scroller) return
    const index = visibleIndex().get(path) ?? -1
    if (index < 0) return
    setRevealTarget(undefined)
    const item = virtualizer.getVirtualItems().find((entry) => entry.key === path)
    const start = item ? item.start : index * 22
    const end = start + (item ? item.size : 22)
    if (start < scroller.scrollTop) {
      scroller.scrollTop = start
    } else if (end > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = end - scroller.clientHeight
    }
  })

  const reveal = (path: string) => {
    const normalized = normalizeFileTreeV2Path(path)
    for (let parent = normalized.lastIndexOf("/"); parent !== -1; parent = normalized.lastIndexOf("/", parent - 1)) {
      const dir = normalized.slice(0, parent)
      searchExpansion.userToggled(dir)
      if (!file.tree.state(dir)?.expanded) file.tree.expand(dir)
    }
    selectSingle(normalized)
    setRevealTarget(normalized)
  }

  // Notify panel of selection changes (toolbar badge / bulk actions)
  createEffect(() => {
    const paths = [...selectedSet()]
    // untracked to avoid loop if parent writes back
    untrack(() => props.onSelectionChange?.(paths))
  })

  // Prune stale selections only when files actually vanish from the *filesystem*
  // (not when a collapsed folder hides them). Check the maintained tree index
  // for each selected path instead of rebuilding a Set of every loaded node on
  // every watcher refresh; a 50k-node tree now costs O(selected) here.
  createEffect(() => {
    const current = selectedSet()
    let changed = false
    const pruned = new Set<string>()
    for (const p of current) {
      if (file.tree.hasNode(p) || p.startsWith("__creating__:")) pruned.add(p)
      else changed = true
    }
    if (changed) setSelectedSet(pruned)
    const a = anchor()
    if (a && !file.tree.hasNode(a)) setAnchor([...pruned][0])
  })

  props.ref?.({
    startRename: (path) => setRenaming(path),
    startCreate: (parentDir, kind) => {
      searchExpansion.userToggled(normalizeFileTreeV2Path(parentDir))
      file.tree.expand(parentDir || "")
      setCreating({ parentDir, kind })
    },
    startDelete: (path) => {
      // Bulk: if the requested path is part of a multi-selection, confirm all.
      if (isSelected(path) && selectedSet().size > 1) return setDeleting("__bulk__")
      setDeleting(path)
    },
    expandAll: () => {
      searchExpansion.releaseAll(searchQuery())
      void file.tree.expandAll()
    },
    collapseAll: () => {
      searchExpansion.releaseAll(searchQuery())
      file.tree.collapseAll()
    },
    reveal,
    // Multi-select surface for the panel (bulk actions, toolbar)
    getSelectedPaths: () => [...selectedSet()],
    clearSelection,
    selectAll: selectAllVisible,
  } as ProjectExplorerTreeHandle)

  const onKeyDown = (event: KeyboardEvent) => {
    if (renaming() || deleting() || creating()) return
    // ── Multi-select keyboard ──────────────────────────
    const mod = isToggleMod(event)
    const shift = event.shiftKey
    // Ctrl/Cmd+A — select all visible
    if ((event.key === "a" || event.key === "A") && mod && !shift) {
      event.preventDefault()
      selectAllVisible()
      return
    }
    // Escape — clear down to single focus (or clear entirely)
    if (event.key === "Escape") {
      if (selectedSet().size > 1) {
        event.preventDefault()
        const f = focused() ?? anchor()
        if (f) selectSingle(f)
        else clearSelection()
        return
      }
    }
    if (event.key === "ArrowDown") {
      event.preventDefault()
      moveSelection(1, shift)
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      moveSelection(-1, shift)
      return
    }
    // Delete / Backspace — bulk delete (confirm once)
    if ((event.key === "Delete" || event.key === "Backspace") && selectedSet().size > 0) {
      // Let the panel handle bulk; keep intra-row inline delete for single.
      // Prevent browser nav on Backspace.
      if (selectedSet().size > 1) {
        event.preventDefault()
        setDeleting("__bulk__")
        return
      }
    }
    const cursor = focused() ?? anchor() ?? (selectedSet().size === 1 ? [...selectedSet()][0]! : undefined)
    const current = cursor ? rowByKey().get(cursor) : undefined
    if (!current) return
    if (event.key === "ArrowRight" && current.node.type === "directory" && !expanded(current.node.path)) {
      event.preventDefault()
      toggleDir(current.node)
      return
    }
    if (event.key === "ArrowLeft" && current.node.type === "directory" && expanded(current.node.path)) {
      event.preventDefault()
      toggleDir(current.node)
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      // Enter on multi-selection opens all files (bulk add to chat / open)
      if (selectedSet().size > 1) {
        const files: Array<{ path: string; type: "file" }> = []
        for (const p of selectedSet()) {
          const n = rowByKey().get(p)?.node
          if (n?.type === "file") files.push({ path: n.originalPath, type: "file" })
        }
        dispatchInChunks(files, (file) => props.onOpen(file))
      } else openRow(current.node)
      return
    }
    if (event.key === "F2" && selectedSet().size === 1) {
      event.preventDefault()
      setRenaming(current.node.path)
    }
  }

  return (
    <div
      ref={setRoot}
      data-component="project-explorer-tree"
      role="tree"
      aria-multiselectable="true"
      aria-label={language.t("projectExplorer.title")}
      tabIndex={0}
      onKeyDown={onKeyDown}
      // Click on empty canvas clears selection (IDE parity: click gutter deselects)
      onClick={(event) => {
        if (event.target === event.currentTarget) clearSelection()
      }}
      onDragOver={(event: DragEvent) => {
        // Allow dropping onto empty canvas (root) — move selection to project root.
        const types = [...(event.dataTransfer?.types ?? [])]
        if (types.includes("text/plain") || types.includes("text/uri-list")) {
          event.preventDefault()
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
        }
      }}
      onDrop={(event: DragEvent) => {
        // Only handle drops on the canvas itself; row drops are handled per-row.
        if ((event.target as HTMLElement)?.closest("[data-slot='project-explorer-row']")) return
        event.preventDefault()
        let sources: string[] = []
        const sel = [...selectedSet()]
        if (sel.length > 1) sources = sel
        else {
          const raw = event.dataTransfer?.getData("text/plain") ?? ""
          const lines = raw
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => (s.startsWith("file:") ? s.slice(5) : s))
          sources = lines.length > 0 ? lines : sel.length === 1 ? sel : []
        }
        if (sources.length === 0) return
        const moves: Array<{ from: string; to: string }> = []
        for (const src of sources) {
          if (!src) continue
          const base = src.includes("/") ? src.slice(src.lastIndexOf("/") + 1) : src
          if (src === base) continue // already at root
          if (base.includes("/")) continue
          const srcNode = rowByKey().get(src)?.node ?? ({ originalPath: src } as FileTreeV2Node)
          const from = (srcNode as FileTreeV2Node).originalPath || src
          // Skip if already at root
          if (from === base) continue
          moves.push({ from, to: base })
        }
        dispatchInChunks(moves, (move) => props.onRename(move.from, move.to))
      }}
      style={{
        position: "relative",
        height: `${Math.max(virtualizer.getTotalSize(), searching() ? 36 : loading() && empty() && !searching() ? 220 : empty() && !searching() ? 140 : 0)}px`,
      }}
    >
      <Show
        when={!(rootError() && empty() && !searching())}
        fallback={
          <div
            data-slot="project-explorer-error"
            class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center"
          >
            <span class="text-12-regular text-v2-text-text-muted">{language.t("toast.file.listFailed.title")}</span>
            <span class="max-w-48 truncate text-11-regular text-v2-text-text-faint">{rootError()}</span>
            <button
              type="button"
              class="rounded bg-v2-background-bg-hover px-2 py-1 text-11-regular text-v2-text-text-base hover:bg-v2-background-bg-active"
              onClick={() => void file.tree.list("", { force: true })}
            >
              {language.t("common.retry")}
            </button>
          </div>
        }
      >
        <Show
          when={!loading() || !empty() || searching()}
          fallback={
            <div data-slot="project-explorer-loading" class="absolute inset-0 overflow-hidden">
              <TreeSkeleton />
            </div>
          }
        >
          <Show
            when={visibleRows().length > 0}
            fallback={
              <div data-slot="project-explorer-empty" class="absolute inset-0">
                <EmptyState />
              </div>
            }
          >
            <For each={virtualItems()}>
              {(item) => (
                <div
                  style={{
                    position: "absolute",
                    top: "0",
                    "inset-inline-start": "0",
                    width: "100%",
                    height: `${item.size}px`,
                    transform: `translateY(${item.start}px)`,
                    overflow: "hidden",
                  }}
                >
                  <Show when={visibleRows()[item.index]}>
                    {(row) => {
                      const isBulkDelete = () => deleting() === "__bulk__" && isSelected(row().node.path)
                      const rowElement = (
                        <ProjectExplorerRow
                          row={row}
                          selected={isSelected(row().node.path)}
                          focused={focused() === row().node.path}
                          expanded={expanded(row().node.path)}
                          dragOver={dragOverPath() === row().node.path}
                          status={props.gitStatus?.get(row().node.path)}
                          favorited={
                            row().node.originalPath ? props.favorites.isFavorite(row().node.originalPath) : false
                          }
                          renaming={renaming() === row().node.path}
                          deleting={deleting() === row().node.path || isBulkDelete()}
                          creating={creating()}
                          now={now()}
                          onFocus={() => setFocused(row().node.path)}
                          onBlur={() => setFocused(undefined)}
                          onMouseDown={(e: MouseEvent) => handleRowMouseDown(e, row().node.path)}
                          onMouseUp={(e: MouseEvent) => handleRowMouseUp(e, row().node.path)}
                          onClick={(e: MouseEvent) => {
                            if (isDragging()) {
                              e.preventDefault()
                              e.stopPropagation()
                              return
                            }
                            if (pendingSinglePath === row().node.path) {
                              // Deferred plain collapse (mousedown on multi-selected)
                              pendingSinglePath = null
                              handleRowClick(e, row().node.path)
                              return
                            }
                            handleRowClick(e, row().node.path)
                          }}
                          onContextMenu={() => handleRowContextMenu(row().node.path)}
                          onDragStart={(e: DragEvent) => handleRowDragStart(e, row().node)}
                          onDragEnd={handleRowDragEnd}
                          onDragOver={(e: DragEvent) =>
                            handleRowDragOver(e, row().node.path, row().node.type === "directory")
                          }
                          onDragLeave={() => {
                            if (dragOverPath() === row().node.path) setDragOverPath(undefined)
                          }}
                          onDrop={(e: DragEvent) => handleRowDrop(e, row().node)}
                          onToggle={() => toggleDir(row().node)}
                          onDoubleClick={() => openRow(row().node)}
                          onFavorite={() => props.favorites.toggle(row().node.originalPath)}
                          onCommitRename={(value) => commitRename(row().node, value)}
                          onCancelRename={() => setRenaming(undefined)}
                          onCommitDelete={() => {
                            if (deleting() === "__bulk__") {
                              const paths = [...selectedSet()]
                              setDeleting(undefined)
                              const deletions = paths.map((p) => {
                                // `onDelete` expects originalPath; map back via rowByKey
                                const n = rowByKey().get(p)?.node ?? ({ originalPath: p } as FileTreeV2Node)
                                return (n as FileTreeV2Node).originalPath || p
                              })
                              dispatchInChunks(deletions, (path) => props.onDelete(path))
                              clearSelection()
                            } else {
                              setDeleting(undefined)
                              props.onDelete(row().node.originalPath)
                            }
                          }}
                          onCancelDelete={() => setDeleting(undefined)}
                          onCommitCreate={(value) => {
                            const pending = creating()
                            if (pending) commitCreate(pending, value)
                          }}
                          onCancelCreate={() => setCreating(undefined)}
                          language={language}
                        />
                      )
                      if (row().node.path.startsWith("__creating__:")) return rowElement
                      const node = row().node
                      const parentDirFor =
                        node.type === "directory"
                          ? node.path
                          : node.path.includes("/")
                            ? node.path.slice(0, node.path.lastIndexOf("/"))
                            : ""
                      return (
                        <ProjectExplorerTreeContextMenu
                          node={node}
                          actions={{
                            favorited: node.originalPath ? props.favorites.isFavorite(node.originalPath) : false,
                            onOpen: () => openRow(node),
                            onMention: () => {
                              // Bulk: if node is part of multi-selection, mention all
                              if (isSelected(node.path) && selectedSet().size > 1) {
                                const mentions: string[] = []
                                for (const p of selectedSet()) {
                                  const n = rowByKey().get(p)?.node
                                  if (n) mentions.push(n.originalPath)
                                }
                                dispatchInChunks(mentions, (path) => props.onMention(path))
                              } else props.onMention(node.originalPath)
                            },
                            onFavoriteToggle: () => props.favorites.toggle(node.originalPath),
                            onRename: () => setRenaming(node.path),
                            onDelete: () => {
                              if (isSelected(node.path) && selectedSet().size > 1) setDeleting("__bulk__")
                              else setDeleting(node.path)
                            },
                            onNewFile: () => {
                              if (node.type === "directory") file.tree.expand(node.originalPath)
                              setCreating({ parentDir: parentDirFor, kind: "file" })
                            },
                            onNewFolder: () => {
                              if (node.type === "directory") file.tree.expand(node.originalPath)
                              setCreating({ parentDir: parentDirFor, kind: "directory" })
                            },
                          }}
                        >
                          {rowElement}
                        </ProjectExplorerTreeContextMenu>
                      )
                    }}
                  </Show>
                </div>
              )}
            </For>
            <Show when={loading() && visibleRows().length > 0 && !searching()}>
              <div class="pointer-events-none sticky bottom-0 flex items-center gap-2 border-t border-v2-border-border-base bg-v2-background-bg-base/80 px-3 py-1.5 text-11-regular text-v2-text-text-faint backdrop-blur">
                <Spinner class="size-3 shrink-0" />
                <span>Loading {visibleRows().length.toLocaleString()} files…</span>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

function toLive(node: FileNode): FileTreeV2Node {
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

// FileTreeV2Node is a derived view of a FileNode. File watcher refreshes often
// return fresh directory arrays containing the same store node identities; a
// WeakMap keeps those refreshes from allocating one spread object per row.
const liveNodeCache = new WeakMap<FileNode, FileTreeV2Node>()

function ProjectExplorerRow(props: {
  row: Accessor<{ node: FileTreeV2Node; level: number }>
  selected: boolean
  focused: boolean
  expanded: boolean
  dragOver?: boolean
  status?: Kind
  favorited: boolean
  renaming: boolean
  deleting: boolean
  creating: PendingCreate | undefined
  now: number
  onFocus: () => void
  onBlur: () => void
  onClick: (e: MouseEvent) => void
  onMouseDown?: (e: MouseEvent) => void
  onMouseUp?: (e: MouseEvent) => void
  onContextMenu?: () => void
  onDragStart?: (e: DragEvent) => void
  onDragEnd?: () => void
  onDragOver?: (e: DragEvent) => void
  onDragLeave?: () => void
  onDrop?: (e: DragEvent) => void
  onToggle: () => void
  onDoubleClick: () => void
  onFavorite: () => void
  onCommitRename: (value: string) => void
  onCancelRename: () => void
  onCommitDelete: () => void
  onCancelDelete: () => void
  onCommitCreate: (value: string) => void
  onCancelCreate: () => void
  language: ReturnType<typeof useLanguage>
}) {
  const node = () => props.row().node
  const level = () => props.row().level
  const isSynthetic = () => node().path.startsWith("__creating__:")
  const file = useFile()
  let inputRef: HTMLInputElement | undefined
  let settled = false

  createEffect(() => {
    if (props.renaming || isSynthetic()) {
      settled = false
      queueMicrotask(() => inputRef?.select())
    }
  })

  const inputKeyDown = (event: KeyboardEvent, commit: (value: string) => void, cancel: () => void) => {
    event.stopPropagation()
    if (event.key === "Enter") {
      event.preventDefault()
      settled = true
      commit((event.currentTarget as HTMLInputElement).value)
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      settled = true
      cancel()
    }
  }

  const isDirectory = () => node().type === "directory"
  const folderCount = createMemo(() => {
    if (isSynthetic() || props.renaming || props.deleting) return undefined
    if (!isDirectory()) return undefined
    const dir = node().originalPath || node().path
    const state = file.tree.state(dir)
    if (!state?.loaded) return undefined
    const count = file.tree.children(dir).length
    return count
  })

  const rawSize = () => (node() as unknown as { size?: number | string }).size
  const rawMtime = () => (node() as unknown as { mtime?: number | string }).mtime
  const rawLineCount = () => (node() as unknown as { lineCount?: number | string }).lineCount
  const size = createMemo(() => {
    const v = rawSize()
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v
    if (typeof v === "string") {
      const n = Number(v)
      if (Number.isFinite(n) && n >= 0) return n
    }
    return undefined
  })
  const mtime = createMemo(() => {
    const v = rawMtime()
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v
    if (typeof v === "string") {
      const n = Number(v)
      if (Number.isFinite(n) && n > 0) return n
    }
    return undefined
  })
  const lineCount = createMemo(() => {
    const v = rawLineCount()
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v)
    if (typeof v === "string") {
      const n = Number(v)
      if (Number.isFinite(n) && n >= 0) return Math.round(n)
    }
    return undefined
  })
  const relativeTime = createMemo(() => {
    const t = mtime()
    if (t === undefined) return ""
    return formatRelativeTime(t, props.now)
  })
  const absoluteTime = createMemo(() => {
    const t = mtime()
    if (t === undefined) return ""
    try {
      return formatAbsoluteTime(t, props.language.intl())
    } catch {
      return ""
    }
  })

  return (
    <div
      data-slot="project-explorer-row"
      data-selected={props.selected ? "" : undefined}
      data-focused={props.focused ? "" : undefined}
      data-ignored={node().ignored ? "" : undefined}
      data-drag-over={props.dragOver ? "" : undefined}
      role="treeitem"
      aria-selected={props.selected}
      aria-level={level() + 1}
      style={{ "padding-inline-start": `${6 + level() * 14}px` }}
      draggable={!props.renaming && !isSynthetic()}
      onDragStart={(event: DragEvent) => {
        if (props.onDragStart) props.onDragStart(event)
        else {
          event.dataTransfer?.setData("text/plain", `file:${node().originalPath}`)
          event.dataTransfer?.setData("text/uri-list", pathToFileUrl(node().originalPath))
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy"
          withFileDragImage(event)
        }
      }}
      onDragEnd={() => props.onDragEnd?.()}
      onDragOver={(e: DragEvent) => props.onDragOver?.(e)}
      onDragLeave={() => props.onDragLeave?.()}
      onDrop={(e: DragEvent) => props.onDrop?.(e)}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      onMouseDown={(e: MouseEvent) => props.onMouseDown?.(e)}
      onMouseUp={(e: MouseEvent) => props.onMouseUp?.(e)}
      onClick={props.onClick as unknown as (e: Event) => void}
      onContextMenu={() => props.onContextMenu?.()}
      onDblClick={props.onDoubleClick}
    >
      <Show when={node().type === "directory"} fallback={<div style={{ width: "14px", "flex-shrink": "0" }} />}>
        <div
          data-slot="project-explorer-chevron"
          data-expanded={props.expanded ? "" : undefined}
          onClick={(event) => {
            event.stopPropagation()
            props.onToggle()
          }}
        >
          <Show when={!isSynthetic()}>
            <Icon name="chevron-down" size="small" />
          </Show>
        </div>
      </Show>

      <Show
        when={!isSynthetic()}
        fallback={<Icon name={props.creating?.kind === "directory" ? "folder" : "edit"} size="small" />}
      >
        <FileIcon
          node={{ path: node().path, type: node().type }}
          expanded={props.expanded}
          data-slot="project-explorer-icon"
        />
      </Show>

      <Show
        when={props.deleting}
        fallback={
          <Show
            when={props.renaming || isSynthetic()}
            fallback={
              <span data-slot="project-explorer-name" data-status={props.status}>
                <bdi dir="auto">{node().name}</bdi>
              </span>
            }
          >
            <input
              ref={inputRef}
              data-slot="project-explorer-inline-input"
              value={isSynthetic() ? "" : node().name}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) =>
                inputKeyDown(
                  event,
                  isSynthetic() ? props.onCommitCreate : props.onCommitRename,
                  isSynthetic() ? props.onCancelCreate : props.onCancelRename,
                )
              }
              onBlur={(event) => {
                if (settled) return
                settled = true
                ;(isSynthetic() ? props.onCommitCreate : props.onCommitRename)(event.currentTarget.value)
              }}
            />
          </Show>
        }
      >
        <span data-slot="project-explorer-confirm">
          {props.language.t("projectExplorer.tree.deleteConfirm", { name: node().name })}
          <span data-slot="project-explorer-confirm-actions">
            <button
              type="button"
              data-variant="danger"
              onClick={(event) => {
                event.stopPropagation()
                props.onCommitDelete()
              }}
            >
              {props.language.t("common.delete")}
            </button>
            <button
              type="button"
              data-variant="neutral"
              onClick={(event) => {
                event.stopPropagation()
                props.onCancelDelete()
              }}
            >
              {props.language.t("common.cancel")}
            </button>
          </span>
        </span>
      </Show>

      <Show
        when={
          !isSynthetic() &&
          !props.renaming &&
          !props.deleting &&
          (folderCount() !== undefined || size() !== undefined || lineCount() !== undefined || relativeTime() !== "")
        }
      >
        <span data-slot="project-explorer-meta">
          <Show when={folderCount() !== undefined}>
            <span
              data-slot="project-explorer-count"
              data-empty={folderCount() === 0 ? "" : undefined}
              title={
                folderCount() === 0
                  ? props.language.t("projectExplorer.folder.empty")
                  : props.language.t("projectExplorer.folder.count.tooltip", { count: folderCount()! })
              }
              aria-label={
                folderCount() === 0
                  ? props.language.t("projectExplorer.folder.empty")
                  : props.language.plural("projectExplorer.folder.count", folderCount()!, {
                      count: folderCount()!,
                    })
              }
            >
              {formatFolderCount(folderCount()!)}
            </span>
          </Show>
          <Show when={size() !== undefined}>
            <span
              data-slot="project-explorer-size"
              title={size() !== undefined ? `${formatFileSize(size()!)}` : undefined}
            >
              {formatFileSize(size()!)}
            </span>
          </Show>
          <Show when={lineCount() !== undefined}>
            <span data-slot="project-explorer-lines" title={formatLineCount(lineCount()!)}>
              {formatLineCount(lineCount()!)}
            </span>
          </Show>
          <Show when={relativeTime() !== ""}>
            <span
              data-slot="project-explorer-time"
              title={absoluteTime() || relativeTime()}
              aria-label={props.language.t("projectExplorer.meta.modifiedAbsolute", {
                date: absoluteTime() || relativeTime(),
              })}
            >
              {relativeTime()}
            </span>
          </Show>
        </span>
      </Show>

      <Show when={!isSynthetic() && !props.renaming && !props.deleting}>
        <button
          type="button"
          data-slot="project-explorer-favorite"
          data-favorited={props.favorited ? "" : undefined}
          aria-label={
            props.favorited ? props.language.t("model.favorite.remove") : props.language.t("model.favorite.add")
          }
          onClick={(event) => {
            event.stopPropagation()
            props.onFavorite()
          }}
        >
          <Icon name={props.favorited ? "star-filled" : "star"} size="small" />
        </button>
      </Show>
    </div>
  )
}
