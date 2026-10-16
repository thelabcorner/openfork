import { createEffect, createMemo, createSignal, For, lazy, onCleanup, Show, Suspense, untrack, type Accessor } from "solid-js"
import { createVirtualizer, defaultRangeExtractor } from "@tanstack/solid-virtual"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useFile } from "@/context/file"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { virtualScrollElement } from "@/components/virtual-scroll-element"
import { pathToFileUrl, withFileDragImage, type Kind } from "@/components/file-tree"
import { buildFileDragTransfer } from "@opencode-ai/core/util/file-drag-transfer"
import {
  normalizeFileTreeV2Path,
  type FileTreeV2Node,
  type FileTreeV2Row,
  type FileTreeV2Model,
} from "@/components/file-tree-v2-model"
import { createIndexedLiveFileTreeV2 } from "@/components/project-explorer-indexed-live"
import { createIndexedSearchFileTreeRows } from "@/components/project-explorer-indexed-search"
import { createProjectExplorerKeyResolver } from "@/components/project-explorer-virtualizer-keys"
import type { ProjectExplorerFavorites } from "@/utils/project-explorer-favorites"
import type { ProjectExplorerNodeActions } from "@/components/project-explorer-tree-context-menu"
import { startProjectExplorerSearchTree } from "@/components/project-explorer-search-tree"
import { startProjectExplorerSearchTreeDelta } from "@/components/project-explorer-search-incremental"
import { dispatchProjectExplorerBulk } from "@/components/project-explorer-bulk-dispatch"
import {
  appendedProjectExplorerSearchPaths,
  createProjectExplorerSearchAccumulator,
  startProjectExplorerSearch,
  type ProjectExplorerSearchResult,
} from "@/components/project-explorer-search-runner"
import {
  formatAbsoluteTime,
  formatFileSize,
  formatFolderCount,
  formatLineCount,
  formatRelativeTime,
} from "@/components/prompt-input/at-row-meta"
import { startupMark, startupTransportDiagnostic } from "@/utils/startup-perf"
import "./project-explorer-tree.css"

const ProjectExplorerTreeContextMenu = lazy(() =>
  import("@/components/project-explorer-tree-context-menu").then((m) => ({ default: m.ProjectExplorerTreeContextMenu })),
)

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
  onRename: (from: string, to: string) => void | boolean | Promise<void | boolean>
  onDelete: (path: string) => void | boolean | Promise<void | boolean>
  onCreate: (path: string, kind: "file" | "directory") => void
  onRevealClearSearch?: () => void
  onSelectionChange?: (paths: string[]) => void
  ref?: (handle: ProjectExplorerTreeHandle) => void
}) {
  const file = useFile()
  const sdk = useSDK()
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
        <Show when={isSearch() && searchHasMore() && !searchBusy()}>
          <button
            type="button"
            disabled={searchLoadingMore()}
            class="rounded bg-v2-background-bg-hover px-2 py-1 text-11-regular text-v2-text-text-base hover:bg-v2-background-bg-active disabled:opacity-50"
            onClick={() => loadMoreSearch?.()}
          >
            {language.t("common.loadMore")}
          </button>
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
    const aIdx = a ? visibleIndexOf(a) : -1
    const tIdx = visibleIndexOf(target)
    if (aIdx === -1 || tIdx === -1) {
      selectSingle(target)
      return
    }
    const lo = Math.min(aIdx, tIdx)
    const hi = Math.max(aIdx, tIdx)
    // The indexed projection already supports O(log chunks) positional
    // reads. A short Shift+Arrow range must not flatten all 50k visible rows
    // before selecting its two or three members.
    const view = visibleView()
    const range: string[] = []
    for (let index = lo; index <= hi; index++) {
      const path = view.at(index)?.node.path
      if (path) range.push(path)
    }
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

  // Bulk actions are backpressured by *settlement*, not merely by a timer:
  // 10k selected files previously overflowed the panel's bounded mutation
  // queue and silently lost the remainder after item 512.
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const dispatchInChunks = <A,>(
    items: readonly A[],
    dispatch: (item: A) => void | boolean | Promise<void | boolean>,
  ) => {
    void dispatchProjectExplorerBulk(items, dispatch, { cancelled: () => disposed })
  }

  // Provide project-explorer-tree equivalent of `select(path)` for backwards-compat
  const select = selectSingle

  const [renaming, setRenaming] = createSignal<string>()
  const [deleting, setDeleting] = createSignal<string>()
  const [creating, setCreating] = createSignal<PendingCreate>()

  createEffect(() => {
    const state = file.tree.state("")
    // A rejected initial listing must not retrigger itself as loading flips
    // false. Without this guard an unavailable workspace starts an unbounded
    // request/toast loop; the error state already renders an explicit Retry.
    if (state?.loaded || state?.loading || state?.error) return
    untrack(() => void file.tree.list(""))
  })

  createEffect(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return
    const rows = file.tree.children("").length
    startupMark("project-explorer.first-root", { rows })
    startupTransportDiagnostic("project-explorer.first-root.transport")
  })

  const filesystemExpanded = (path: string) => file.tree.state(path)?.expanded ?? false
  const expanded = (path: string) =>
    searching() ? !searchCollapsed().has(path) : filesystemExpanded(path)

  let liveProjection: ReturnType<typeof createIndexedLiveFileTreeV2> | undefined
  let projectedRevision = -1
  let liveScope = ""
  let liveInstance = 0
  const liveView = createMemo(() => {
    const revision = file.tree.viewRevision()
    const scope = sdk().directory
    if (!liveProjection || liveScope !== scope) {
      liveScope = scope
      liveInstance++
      liveProjection = untrack(() => createIndexedLiveFileTreeV2(
        (path) => file.tree.children(path), filesystemExpanded, (path) => file.tree.node(path),
      ))
      projectedRevision = revision
    } else if (revision !== projectedRevision) {
      const changes = file.tree.changesSince(projectedRevision)
      untrack(() => {
        if (!changes) liveProjection!.rebuild()
        else {
          const affected = new Set(changes.directories)
          // Changes are replayed against the *final* authoritative store.
          // When both parent and child changed in the same reactive batch,
          // refreshing the parent subsumes its descendants. Repeated watcher
          // events for the same directory likewise need only one projection.
          if (affected.has("")) {
            // Root order and all visible child-subtree positions can change.
            // Rebuilding once is preferable to repeated O(log N) repositioning
            // for tens of thousands of root siblings.
            liveProjection!.rebuild()
          }
          else for (const directory of affected) {
            let parent = directory
            let subsumed = false
            while (parent.includes("/")) {
              parent = parent.slice(0, parent.lastIndexOf("/"))
              if (affected.has(parent)) { subsumed = true; break }
            }
            if (!subsumed) liveProjection!.update(directory)
          }
        }
      })

      projectedRevision = revision
    }
    // This wrapper changes identity only when the domain revision/scope does.
    // Consumers can access count/key/viewport rows without calling rows().
    return { projection: liveProjection!, revision, scope, instance: liveInstance }
  })

  const searching = createMemo(() => Boolean(props.search?.trim()))
  const searchQuery = createMemo(() => props.search?.trim().toLowerCase() ?? "")
  const [searchResult, setSearchResult] = createSignal<ProjectExplorerSearchResult>()
  const [searchBusy, setSearchBusy] = createSignal(false)
  const [searchHasMore, setSearchHasMore] = createSignal(false)
  const [searchLoadingMore, setSearchLoadingMore] = createSignal(false)
  // Search owns a lightweight path projection. Never expand filesystem
  // directories merely to render results the workspace index already knows.
  const [searchCollapsed, setSearchCollapsed] = createSignal<Set<string>>(new Set())
  let searchGeneration = 0
  let cancelSearch: (() => void) | undefined
  let loadMoreSearch: (() => void) | undefined
  let refreshLocalSearch: (() => void) | undefined

  createEffect(() => {
    const query = searchQuery()
    // A workspace switch must invalidate the old search even if the user
    // leaves the query text unchanged.
    sdk().directory
    setSearchCollapsed(new Set<string>())
    // Snapshot the currently loaded corpus once per query generation. Search-
    // owned expansions below load more nodes; tracking nodeVersion here would
    // otherwise restart/abort the same search for every ancestor listing.
    const nodes = query ? untrack(() => file.tree.allNodes()) : undefined
    const generation = ++searchGeneration
    cancelSearch?.()
    refreshLocalSearch = undefined
    cancelSearch = undefined
    loadMoreSearch = undefined
    setSearchHasMore(false)
    setSearchLoadingMore(false)
    if (!query || !nodes) {
      setSearchBusy(false)
      setSearchResult(undefined)
      return
    }

    setSearchBusy(true)
    setSearchResult(undefined)
    const abort = new AbortController()
    // Keep an immutable published snapshot for the cooperative projector.
    // Only replay *new* page paths; replaying every historical server page on
    // each Load More made the cumulative ranking/ancestry merge quadratic.
    const accumulator = createProjectExplorerSearchAccumulator(query)
    const pendingRemote: string[] = []
    const pendingDirectories: string[] = []
    let localDone = false
    let remoteDone = false
    const publish = () => {
      if (generation !== searchGeneration) return
      if (pendingRemote.length > 0 || pendingDirectories.length > 0) {
        accumulator.page(pendingRemote, pendingDirectories)
        pendingRemote.length = 0
        pendingDirectories.length = 0
      }
      setSearchResult(accumulator.snapshot())
      if (localDone && remoteDone) setSearchBusy(false)
    }

    // Let the input event/paint settle before beginning even the first local
    // slice. This preserves every loaded-tree substring match immediately.
    let cancelLocalRebase: (() => void) | undefined
    let stopLocal = startProjectExplorerSearch({
      query,
      nodes,
      root: () => file.tree.children(""),
      children: (path) => file.tree.children(path),
      projectRows: false,
      cancelled: () => generation !== searchGeneration,
      complete: (result) => {
        if (generation !== searchGeneration) return
        cancelLocalRebase?.()
        // Local search itself is cooperative, but ingesting its 50k matches
        // synchronously still caused a long input-blocking commit. Reuse the
        // same time-sliced accumulator for initial and watcher scans.
        cancelLocalRebase = accumulator.refreshLocalCooperatively(result, {
          cancelled: () => generation !== searchGeneration,
          complete: () => {
            if (generation !== searchGeneration) return
            localDone = true
            publish()
          },
        })
      },
    })

    // The loaded-file index may change while the same search query remains
    // active. Debounce watcher bursts and recompute only the local contribution
    // to the result set, leaving the remote server page cursor untouched.
    let scannedRevision = untrack(() => file.tree.nodeRevision())
    let scannedViewRevision = untrack(() => file.tree.viewRevision())
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    refreshLocalSearch = () => {
      const revision = file.tree.nodeRevision()
      if (revision === scannedRevision) return
      scannedRevision = revision
      const changes = file.tree.changesSince(scannedViewRevision)
      scannedViewRevision = file.tree.viewRevision()
      if (changes?.removedRoots.length) accumulator.invalidateRemoteRoots(changes.removedRoots)
      if (changes?.convertedDirectories.length) {
        accumulator.invalidateRemoteDescendants(changes.convertedDirectories)
      }
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined
        if (generation !== searchGeneration) return
        stopLocal()
        cancelLocalRebase?.()
        stopLocal = startProjectExplorerSearch({
          query,
          nodes: file.tree.allNodes(),
          root: () => file.tree.children(""),
          children: (path) => file.tree.children(path),
          projectRows: false,
          cancelled: () => generation !== searchGeneration,
          complete: (result) => {
            if (generation !== searchGeneration) return
            cancelLocalRebase?.()
            cancelLocalRebase = accumulator.refreshLocalCooperatively(result, {
              cancelled: () => generation !== searchGeneration,
              complete: () => {
                if (generation !== searchGeneration) return
                localDone = true
                publish()
              },
            })
          },
        })
      }, 140)
    }

    // Add full-workspace candidates from the server without broadening Explorer
    // semantics: /find/search may be fuzzy, so retain only paths satisfying the
    // existing case-insensitive substring rule. The local result remains the
    // fallback and source of truth for every already-loaded node.
    let nextOffset = 0
    let fetching = false
    const fetchPage = (initial: boolean) => {
      if (fetching || abort.signal.aborted || generation !== searchGeneration) return
      fetching = true
      if (!initial) setSearchLoadingMore(true)
      void file.searchMentions(query, {
        limit: 1000,
        offset: nextOffset,
        symbols: false,
        signal: abort.signal,
      }).then(
        (page) => {
          if (generation !== searchGeneration) return
          // The endpoint is a ranked fuzzy search. Pagination must advance by
          // UNFILTERED results or substring filtering can re-request pages
          // indefinitely and silently omit valid later matches.
          nextOffset += page.results.length
          for (const item of page.results) {
            if (item.kind !== "file") continue
            const path = normalizeFileTreeV2Path(item.path)
            if (!path.toLowerCase().includes(query)) continue
            // Preserve original rootedness until the accumulator validates
            // the raw path. The generic normalizer strips leading slashes.
            pendingRemote.push(item.path)
            if (item.type === "directory") pendingDirectories.push(item.path)
          }
          setSearchHasMore(page.hasMore && page.results.length > 0)
          publish()
        },
        () => {
          if (generation !== searchGeneration) return
          if (initial) {
            setSearchHasMore(false)
            publish()
          }
          // A subsequent page failure preserves the previous results and
          // the Load More affordance so the user may retry.
        },
      ).finally(() => {
        if (generation !== searchGeneration) return
        fetching = false
        if (initial) {
          remoteDone = true
          publish()
        } else setSearchLoadingMore(false)
      })
    }
    if (query.length < 2) {
      remoteDone = true
    } else {
      loadMoreSearch = () => fetchPage(false)
      fetchPage(true)
    }

    cancelSearch = () => {
      stopLocal()
      cancelLocalRebase?.()
      if (refreshTimer !== undefined) clearTimeout(refreshTimer)
      refreshLocalSearch = undefined
      abort.abort()
    }
  })

  createEffect(() => {
    // Keep the watcher subscription out of the query's effect: tracking this
    // revision there would cancel the remote generation after every mutation.
    if (!searchQuery()) return
    sdk().directory
    file.tree.nodeRevision()
    untrack(() => refreshLocalSearch?.())
  })

  onCleanup(() => {
    searchGeneration++
    cancelSearch?.()
  })

  const [searchModel, setSearchModel] = createSignal<FileTreeV2Model>()
  const [searchProjectionBusy, setSearchProjectionBusy] = createSignal(false)
  let projectedQuery = ""
  let projectedRoot = ""
  let committedSearch: ProjectExplorerSearchResult | undefined
  let committedModel: FileTreeV2Model | undefined
  createEffect(() => {
    const query = searchQuery()
    const result = searchResult()
    const root = sdk().directory
    if (query !== projectedQuery || root !== projectedRoot) {
      setSearchModel(undefined)
      committedSearch = undefined
      committedModel = undefined
      projectedQuery = query
      projectedRoot = root
    }
    if (!query || result?.query !== query) {
      setSearchProjectionBusy(false)
      return
    }
    setSearchProjectionBusy(true)
    const complete = (model: FileTreeV2Model) => {
      committedSearch = result
      committedModel = model
      setSearchModel(model)
      setSearchProjectionBusy(false)
    }
    // Only the newly appended paths are projected on ordinary search pages.
    // Existing sorted buckets and immutable model snapshots are preserved.
    // A scope switch, invalid snapshot, very large local search burst, or
    // bounded persistent-index rebase uses the full cooperative reference.
    const addedMatches = committedSearch &&
      appendedProjectExplorerSearchPaths(committedSearch.matches, result.matches)
    const addedAncestors = committedSearch &&
      appendedProjectExplorerSearchPaths(committedSearch.ancestors, result.ancestors)
    const stop = (committedModel && addedMatches && addedAncestors
      ? startProjectExplorerSearchTreeDelta({
          previous: committedModel,
          addedMatches,
          addedAncestors,
          root,
          lookup: (path) => file.tree.node(path),
          complete,
        })
      : undefined) ?? startProjectExplorerSearchTree({
        matches: result.matches,
        ancestors: result.ancestors,
        root,
        lookup: (path) => file.tree.node(path),
        complete,
      })
    onCleanup(stop)
  })

  let searchRowProjection: {
    model: FileTreeV2Model
    view: ReturnType<typeof createIndexedSearchFileTreeRows>
    instance: number
  } | undefined
  type VisibleProjection = {
    readonly length: number
    readonly keySignature: string
    at: (index: number) => FileTreeV2Row | undefined
    indexOfPath: (path: string) => number
    rowForPath: (path: string) => FileTreeV2Row | undefined
    rows: () => FileTreeV2Row[]
  }
  const emptyRows: FileTreeV2Row[] = []
  const emptyProjection: VisibleProjection = {
    keySignature: "empty",
    length: 0, at: () => undefined, indexOfPath: () => -1,
    rowForPath: () => undefined, rows: () => emptyRows,
  }
  let searchKeyEpoch = 0
  const visibleView = createMemo<VisibleProjection>(() => {
    const query = searchQuery()
    let base: VisibleProjection
    if (!query) {
      const { projection, instance } = liveView()
      base = {
        keySignature: `live:${instance}:${projection.keysVersion}`,
        length: projection.length,
        at: projection.at,
        indexOfPath: projection.indexOfPath,
        rowForPath: projection.rowForPath,
        rows: projection.rows,
      }
    } else {
      const model = searchModel()
      if (!model) return emptyProjection
      const collapsed = searchCollapsed()
      if (!searchRowProjection || searchRowProjection.model !== model) {
        searchRowProjection = { model, view: createIndexedSearchFileTreeRows(model, collapsed), instance: ++searchKeyEpoch }
      } else searchRowProjection.view.update(collapsed)
      const projection = searchRowProjection.view
      base = {
        keySignature: `search:${searchRowProjection.instance}:${projection.keysVersion}`,
        length: projection.length,
        at: projection.at,
        indexOfPath: projection.indexOfPath,
        rowForPath: projection.rowForPath,
        rows: projection.rows,
      }
    }
    const pending = creating()
    if (!pending) return base
    const parent = base.indexOfPath(pending.parentDir)
    const index = pending.parentDir ? Math.max(0, parent + 1) : 0
    const level = pending.parentDir ? (base.at(parent)?.level ?? 0) + 1 : 0
    const synthetic: FileTreeV2Row = {
      node: { name: "", path: `__creating__:${pending.parentDir}`, absolute: "", type: pending.kind, ignored: false, originalPath: "" },
      level,
    }
    return {
      keySignature: `${base.keySignature}:create:${pending.parentDir}:${pending.kind}`,
      length: base.length + 1,
      at: (position: number) =>
        position === index ? synthetic : base.at(position > index ? position - 1 : position),
      indexOfPath: (path: string) => {
        if (path === synthetic.node.path) return index
        const found = base.indexOfPath(path)
        return found < 0 ? -1 : found >= index ? found + 1 : found
      },
      rowForPath: (path: string) => path === synthetic.node.path ? synthetic : base.rowForPath(path),
      rows: () => {
        const list = base.rows()
        return list.slice(0, index).concat(synthetic, list.slice(index))
      },
    }
  })
  // Deliberately not a Solid memo: an array is materialized only for global
  // operations such as Select All / keyboard ranges, never to render the
  // virtualized viewport or process an ordinary watcher update.
  const visibleRows = () => visibleView().rows()
  const visibleRowAt = (index: number) => visibleView().at(index)
  const visibleCount = () => visibleView().length

  const empty = createMemo(() => visibleCount() === 0)

  // The virtualizer normally needs the position of ONE focused path, not a
  // complete 50k-entry path→index map. A tracked memo computes that position
  // once per focus/visible-tree revision, never on every scroll notification.
  // Shift selection makes two bounded scans, avoiding the O(N) map allocation
  // that each watcher-triggered projection formerly caused.
  const visibleIndexOf = (path: string) => visibleView().indexOfPath(path)
  const pinnedIndex = createMemo(() => {
    const path = focused()
    return path ? visibleIndexOf(path) : -1
  })
  // Both the live and search projections now have their own path index.
  // Building a separate 50k-entry Map during a bulk rename/drop would be
  // redundant allocation; the existing index remains authoritative.
  const rowForPath = (path: string, _bulk = false) => visibleView().rowForPath(path)

  // A metadata-only watcher commit changes visible row wrappers, but NOT the
  // ordered virtualizer keys. Avoid 50k full-key remeasurement in TanStack.
  // The resolver reads the latest view when invoked, while its identity only
  // changes when a structural edit/order/selection-creation changes keys.
  const itemKeyResolver = createProjectExplorerKeyResolver(visibleView)
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return visibleCount()
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
      return itemKeyResolver()
    },
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range)
      const index = pinnedIndex()
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

  // Keys are unique normalized paths (flattenLiveFileTreeV2 enforces this,
  // including across duplicate watcher listings). Iterate *keys*, not the
  // VirtualItem objects that tanstack recreates during scrolling. Solid's For
  // would otherwise remount unchanged row DOM whenever item measurements
  // change, losing inline editor/focus state and wasting render work.
  const virtualItems = createMemo(() => virtualizer.getVirtualItems())
  const virtualItemKeys = createMemo(() => virtualItems().map((item) => item.key))
  const virtualItemByKey = createMemo(() => new Map(virtualItems().map((item) => [item.key, item] as const)))

  const toggleDir = (node: FileTreeV2Node) => {
    if (searching()) {
      setSearchCollapsed((previous) => {
        const next = new Set(previous)
        if (next.has(node.path)) next.delete(node.path)
        else next.add(node.path)
        return next
      })
      return
    }
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
  const beginCreate = (parentDir: string, kind: PendingCreate["kind"]) => {
    if (searching()) {
      // Search is a read-only path projection. Opening an inline editor must
      // not schedule a separate filesystem listing of every search ancestor.
      // Open its collapsed ancestors locally, even after Collapse All.
      const normalized = normalizeFileTreeV2Path(parentDir)
      setSearchCollapsed((previous) => {
        const next = new Set(previous)
        let path = normalized
        while (path) {
          next.delete(path)
          const cut = path.lastIndexOf("/")
          path = cut === -1 ? "" : path.slice(0, cut)
        }
        return next
      })
    } else file.tree.expand(parentDir || "")
    setCreating({ parentDir, kind })
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
  const [contextMenuRequest, setContextMenuRequest] = createSignal<{
    x: number
    y: number
    node: FileTreeV2Node
    actions: ProjectExplorerNodeActions
  }>()

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
  const handleRowContextMenu = (event: MouseEvent, node: FileTreeV2Node, actions: ProjectExplorerNodeActions) => {
    const path = node.path
    if (path.startsWith("__creating__:")) return
    // If right-clicked row is already in a multi-selection, keep it (bulk menu).
    // Otherwise make it the sole selection — mirrors Finder / VS Code.
    if (!isSelected(path)) selectSingle(path)
    else setFocused(path)
    event.preventDefault()
    setContextMenuRequest({ x: event.clientX, y: event.clientY, node, actions })
  }
  const handleRowDragStart = (event: DragEvent, node: FileTreeV2Node) => {
    const path = node.path
    const selected = selectedSet()
    const multi = selected.has(path) && selected.size > 1
    const dragPaths: Iterable<string> = multi ? selected : [node.originalPath || path]
    const transfer = buildFileDragTransfer(dragPaths, pathToFileUrl, { total: multi ? selected.size : 1 })
    setIsDragging(true)
    pendingSinglePath = null
    event.dataTransfer?.setData("text/plain", transfer.plainText)
    event.dataTransfer?.setData("text/uri-list", transfer.uriList)
    if (transfer.truncated) {
      event.dataTransfer?.setData("application/x-opencode-file-count", `${transfer.included}/${transfer.total}`)
    }
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
      const srcNode = rowForPath(src, sources.length >= 16)?.node ?? ({ originalPath: src } as FileTreeV2Node)
      const from = (srcNode as FileTreeV2Node).originalPath || src
      moves.push({ from, to: dest })
    }
    dispatchInChunks(moves, (move) => props.onRename(move.from, move.to))
  }

  const moveSelection = (delta: number, extend: boolean) => {
    const count = visibleCount()
    if (count === 0) return
    // `focused` is the keyboard cursor; if nothing focused, anchor or first item.
    const cursor =
      focused() ?? anchor() ?? (selectedSet().size === 1 ? [...selectedSet()][0] : undefined) ?? visibleRowAt(0)!.node.path
    const located = visibleIndexOf(cursor)
    const curIdx = located < 0 ? 0 : located
    const nextIdx = Math.min(count - 1, Math.max(0, curIdx + delta))
    const path = visibleRowAt(nextIdx)!.node.path
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
    const index = visibleIndexOf(path)
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
    // Reveal is an explicit navigation gesture, not a query result. Remove
    // the search filter before expanding the real filesystem ancestry.
    if (searching()) props.onRevealClearSearch?.()
    const normalized = normalizeFileTreeV2Path(path)
    for (let parent = normalized.lastIndexOf("/"); parent !== -1; parent = normalized.lastIndexOf("/", parent - 1)) {
      const dir = normalized.slice(0, parent)
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

  // The loaded directory tree is NOT an existence oracle: search can select
  // files discovered by the server index that have never been listed locally.
  // A query change or closing search must not silently erase that selection.
  // Only an explicit workspace switch can confidently invalidate these paths.
  let selectionScope = sdk().directory
  createEffect(() => {
    const scope = sdk().directory
    if (scope === selectionScope) return
    selectionScope = scope
    clearSelection()
    setFocused(undefined)
    setCreating(undefined)
    setRenaming(undefined)
    setDeleting(undefined)
  })

  props.ref?.({
    startRename: (path) => setRenaming(path),
    startCreate: beginCreate,
    startDelete: (path) => {
      // Bulk: if the requested path is part of a multi-selection, confirm all.
      if (isSelected(path) && selectedSet().size > 1) return setDeleting("__bulk__")
      setDeleting(path)
    },
    expandAll: () => {
      if (searching()) {
        setSearchCollapsed(new Set<string>())
        return
      }
      void file.tree.expandAll()
    },
    collapseAll: () => {
      if (searching()) {
        setSearchCollapsed(new Set(Array.from(searchModel()?.children.keys() ?? []).filter(Boolean)))
        return
      }
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
    const current = cursor ? rowForPath(cursor) : undefined
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
          const n = rowForPath(p)?.node
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
          const srcNode = rowForPath(src, sources.length >= 16)?.node ?? ({ originalPath: src } as FileTreeV2Node)
          const from = (srcNode as FileTreeV2Node).originalPath || src
          // Skip if already at root
          if (from === base) continue
          moves.push({ from, to: base })
        }
        dispatchInChunks(moves, (move) => props.onRename(move.from, move.to))
      }}
      style={{
        position: "relative",
        // A search with no visible matches still needs enough height for its
        // empty state and Load More control. The old 36px minimum clipped
        // those controls into an effectively unclickable area.
        height: `${Math.max(
          virtualizer.getTotalSize(),
          searching() ? (searchBusy() || searchProjectionBusy() ? 36 : empty() ? 140 : 0) : loading() && empty() ? 220 : empty() ? 140 : 0,
        )}px`,
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
             when={visibleCount() > 0}
             fallback={
               <div data-slot="project-explorer-empty" class="absolute inset-0">
                 <Show
                    when={!searchBusy() && !searchProjectionBusy()}
                   fallback={
                     <div class="flex h-9 items-center justify-center gap-2 text-11-regular text-v2-text-text-faint">
                       <Spinner class="size-3" />
                       <span>{language.t("common.loading")}</span>
                     </div>
                   }
                 >
                   <EmptyState />
                 </Show>
               </div>
             }
          >
            <For each={virtualItemKeys()}>
              {(key) => (
                <div
                  style={{
                    position: "absolute",
                    top: "0",
                    "inset-inline-start": "0",
                    width: "100%",
                    height: `${virtualItemByKey().get(key)?.size ?? 22}px`,
                    transform: `translateY(${virtualItemByKey().get(key)?.start ?? 0}px)`,
                    overflow: "hidden",
                  }}
                >
                  <Show when={visibleRowAt(virtualItemByKey().get(key)?.index ?? -1)}>
                    {(row) => {
                      const isBulkDelete = () => deleting() === "__bulk__" && isSelected(row().node.path)
                      const rowElement = (
                        <ProjectExplorerRow
                          row={row}
                          searchMode={searching()}
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
                                 // `onDelete` expects originalPath; retain native spellings
                                 const n = rowForPath(p)?.node ?? ({ originalPath: p } as FileTreeV2Node)
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
                      const actions: ProjectExplorerNodeActions = {
                        favorited: node.originalPath ? props.favorites.isFavorite(node.originalPath) : false,
                        onOpen: () => openRow(node),
                        onMention: () => {
                          if (isSelected(node.path) && selectedSet().size > 1) {
                            const mentions: string[] = []
                            for (const p of selectedSet()) {
                               const n = rowForPath(p)?.node
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
                        onNewFile: () => beginCreate(parentDirFor, "file"),
                        onNewFolder: () => beginCreate(parentDirFor, "directory"),
                      }
                      return (
                        <div class="block w-full min-w-0" onContextMenu={(event) => handleRowContextMenu(event, node, actions)}>
                          {rowElement}
                        </div>
                      )
                    }}
                  </Show>
                </div>
              )}
            </For>
            <Show when={contextMenuRequest()} keyed>
              {(request) => (
                <Suspense>
                  <ProjectExplorerTreeContextMenu
                    request={request}
                    open
                    onOpenChange={(open) => {
                      if (!open) setContextMenuRequest(undefined)
                    }}
                  />
                </Suspense>
              )}
            </Show>
            <Show when={loading() && visibleCount() > 0 && !searching()}>
              <div class="pointer-events-none sticky bottom-0 flex items-center gap-2 border-t border-v2-border-border-base bg-v2-background-bg-base/80 px-3 py-1.5 text-11-regular text-v2-text-text-faint backdrop-blur">
                <Spinner class="size-3 shrink-0" />
                <span>Loading {visibleCount().toLocaleString()} files…</span>
              </div>
            </Show>
            <Show when={searching() && searchHasMore() && !empty()}>
              <div class="sticky bottom-0 flex items-center justify-center border-t border-v2-border-border-muted bg-v2-background-bg-base py-1.5">
                <button
                  type="button"
                  disabled={searchLoadingMore() || searchProjectionBusy()}
                  class="rounded bg-v2-background-bg-hover px-2 py-1 text-11-regular text-v2-text-text-base hover:bg-v2-background-bg-active disabled:opacity-50"
                  onClick={() => loadMoreSearch?.()}
                >
                  {language.t("common.loadMore")}
                </button>
              </div>
            </Show>
            {/* A warm snapshot can leave rows visible when revalidation fails.
                Keep those rows usable but expose a retry instead of trapping
                the user behind the automatic-retry error guard. */}
            <Show when={rootError() && !empty() && !searching()}>
              <div class="sticky bottom-0 flex items-center gap-2 border-t border-v2-border-border-base bg-v2-background-bg-base px-3 py-1.5 text-11-regular text-v2-text-text-muted">
                <span class="min-w-0 flex-1 truncate">{language.t("toast.file.listFailed.title")}</span>
                <button
                  type="button"
                  class="shrink-0 rounded bg-v2-background-bg-hover px-2 py-1 text-v2-text-text-base hover:bg-v2-background-bg-active"
                  onClick={() => void file.tree.list("", { force: true })}
                >
                  {language.t("common.retry")}
                </button>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

function ProjectExplorerRow(props: {
  row: Accessor<{ node: FileTreeV2Node; level: number }>
  searchMode?: boolean
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
  const file = useFile()
  const node = createMemo(() => {
    const snapshot = props.row().node
    if (!props.searchMode || snapshot.path.startsWith("__creating__:")) return snapshot
    // The workspace-wide search projection intentionally freezes metadata
    // while it builds in cooperative slices. Subscribe only the ~viewport
    // rows to live node metadata, never every one of the 50k search hits.
    const latest = file.tree.node(snapshot.originalPath)
    if (!latest || latest.type !== snapshot.type) return snapshot
    return { ...snapshot, ...latest, path: snapshot.path, originalPath: snapshot.originalPath }
  })
  const level = () => props.row().level
  const isSynthetic = () => node().path.startsWith("__creating__:")
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
    // A listing owns its ordered child IDs; their count is already available
    // in O(1). Calling children() here revalidates the whole child-node array
    // on each visible directory badge, potentially O(width) per row.
    return state.children?.length
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
