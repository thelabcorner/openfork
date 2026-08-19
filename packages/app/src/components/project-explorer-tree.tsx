import { createEffect, createMemo, createSignal, For, Show, untrack, type Accessor } from "solid-js"
import { createVirtualizer, defaultRangeExtractor } from "@tanstack/solid-virtual"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/v2/icon"
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
  ref?: (handle: ProjectExplorerTreeHandle) => void
}) {
  const file = useFile()
  const language = useLanguage()

  const [root, setRoot] = createSignal<HTMLDivElement>()
  const [focused, setFocused] = createSignal<string>()
  const [selected, setSelected] = createSignal(props.active ?? "")
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
    // Synthetic row for an in-progress "new file/folder" input. Spliced in
    // right after its parent directory (or at the top for the project root)
    // so it renders inline through the same virtualized list, not as a
    // separate overlay.
    const insertAt = pending.parentDir === "" ? 0 : base.findIndex((row) => row.node.path === pending.parentDir) + 1
    const level = pending.parentDir === "" ? 0 : (base.find((row) => row.node.path === pending.parentDir)?.level ?? 0) + 1
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

  // Flat index of every loaded node with precomputed lowercase paths, so each
  // keystroke is a single O(loaded) scan over ready strings — no re-lowercasing.
  const searchIndex = createMemo(() => {
    const index: { path: string; lower: string }[] = []
    for (const node of file.tree.allNodes()) {
      const path = normalizeFileTreeV2Path(node.path)
      index.push({ path, lower: path.toLowerCase() })
    }
    return index
  })

  const searching = createMemo(() => Boolean(props.search?.trim()))

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

  // Keep ancestor directories of matches expanded so results stay visible
  // after the search is cleared.
  createEffect(() => {
    const ancestors = searchAncestors()
    if (!ancestors) return
    for (const dir of ancestors) {
      if (!file.tree.state(dir)?.expanded) file.tree.expand(dir)
    }
  })

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

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return visibleRows().length
    },
    getScrollElement: () => virtualScrollElement(root()),
    initialRect: { width: 0, height: 600 },
    estimateSize: () => 22,
    overscan: 12,
    get getItemKey() {
      const current = visibleRows()
      return (index: number) => current[index]?.node.path ?? index
    },
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range)
      const path = focused()
      const index = path ? visibleRows().findIndex((row) => row.node.path === path) : -1
      if (index < 0 || indexes.includes(index)) return indexes
      return [...indexes, index].sort((a, b) => a - b)
    },
  })

  const rowByKey = createMemo(() => new Map(visibleRows().map((row) => [row.node.path, row] as const)))
  const virtualItemByKey = createMemo(() => new Map(virtualizer.getVirtualItems().map((item) => [item.key, item] as const)))
  const virtualRowKeys = createMemo(() => virtualizer.getVirtualItems().map((item) => item.key))

  const select = (path: string) => setSelected(path)
  const toggleDir = (node: FileTreeV2Node) => {
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

  const moveSelection = (delta: number) => {
    const list = visibleRows()
    if (list.length === 0) return
    const index = list.findIndex((row) => row.node.path === selected())
    const next = Math.min(list.length - 1, Math.max(0, (index === -1 ? 0 : index) + delta))
    const path = list[next]!.node.path
    setSelected(path)
    setFocused(path)
    virtualizer.scrollToIndex(next, { align: "auto" })
  }

  // A path pending "reveal in explorer": select + scroll to it once its row
  // exists. The target's ancestors may still be listing asynchronously when
  // reveal() runs, so this effect retries reactively until the row appears.
  // Scroll with direct offset math on the viewport instead of
  // virtualizer.scrollToIndex — that API silently no-ops when the freshly
  // listed row has no measurement-cache entry yet (getOffsetForIndex returns
  // undefined for unmeasured items), which left the tree unscrolled.
  const [revealTarget, setRevealTarget] = createSignal<string>()
  createEffect(() => {
    const path = revealTarget()
    if (!path) return
    const scroller = virtualScrollElement(root())
    if (!scroller) return
    const index = visibleRows().findIndex((row) => row.node.path === path)
    if (index < 0) return
    setRevealTarget(undefined)
    // Rows are fixed-height (estimateSize 22); use the rendered item's start
    // when available, otherwise the estimate.
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
    // Ensure every ancestor is listed and expanded so the node exists.
    for (let parent = normalized.lastIndexOf("/"); parent !== -1; parent = normalized.lastIndexOf("/", parent - 1)) {
      const dir = normalized.slice(0, parent)
      if (!file.tree.state(dir)?.expanded) file.tree.expand(dir)
    }
    setSelected(normalized)
    setFocused(normalized)
    setRevealTarget(normalized)
  }

  props.ref?.({
    startRename: (path) => setRenaming(path),
    startCreate: (parentDir, kind) => {
      file.tree.expand(parentDir || "")
      setCreating({ parentDir, kind })
    },
    startDelete: (path) => setDeleting(path),
    expandAll: () => file.tree.expandAll(),
    collapseAll: () => file.tree.collapseAll(),
    reveal,
  })

  const onKeyDown = (event: KeyboardEvent) => {
    if (renaming() || deleting() || creating()) return
    if (event.key === "ArrowDown") {
      event.preventDefault()
      moveSelection(1)
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      moveSelection(-1)
      return
    }
    const current = rowByKey().get(selected())
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
      openRow(current.node)
      return
    }
    if (event.key === "F2") {
      event.preventDefault()
      setRenaming(current.node.path)
    }
  }

  return (
    <div
      ref={setRoot}
      data-component="project-explorer-tree"
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{
        position: "relative",
        height: `${Math.max(virtualizer.getTotalSize(), searching() ? 36 : 0)}px`,
      }}
    >
      <Show
        when={!searching() || visibleRows().length > 0}
        fallback={
          <div data-slot="project-explorer-search-empty">{language.t("projectExplorer.search.noResults")}</div>
        }
      >
        <For each={virtualRowKeys()}>
        {(key) => (
          <Show when={virtualItemByKey().get(key)}>
            {(item) => (
              <div
                style={{
                  position: "absolute",
                  top: "0",
                  "inset-inline-start": "0",
                  width: "100%",
                  height: `${item().size}px`,
                  transform: `translateY(${item().start}px)`,
                }}
              >
                <Show when={rowByKey().get(key as string)}>
                  {(row) => {
                    const rowElement = (
                      <ProjectExplorerRow
                      row={row}
                      selected={selected() === row().node.path}
                      focused={focused() === row().node.path}
                      expanded={expanded(row().node.path)}
                      status={props.gitStatus?.get(row().node.path)}
                      favorited={row().node.originalPath ? props.favorites.isFavorite(row().node.originalPath) : false}
                      renaming={renaming() === row().node.path}
                      deleting={deleting() === row().node.path}
                      creating={creating()}
                      onFocus={() => setFocused(row().node.path)}
                      onBlur={() => setFocused(undefined)}
                      onClick={() => select(row().node.path)}
                      onToggle={() => toggleDir(row().node)}
                      onDoubleClick={() => openRow(row().node)}
                      onFavorite={() => props.favorites.toggle(row().node.originalPath)}
                      onCommitRename={(value) => commitRename(row().node, value)}
                      onCancelRename={() => setRenaming(undefined)}
                      onCommitDelete={() => {
                        setDeleting(undefined)
                        props.onDelete(row().node.originalPath)
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
                    const parentDirFor = node.type === "directory" ? node.path : node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : ""
                    return (
                      <ProjectExplorerTreeContextMenu
                        node={node}
                        actions={{
                          favorited: node.originalPath ? props.favorites.isFavorite(node.originalPath) : false,
                          onOpen: () => openRow(node),
                          onMention: () => props.onMention(node.originalPath),
                          onFavoriteToggle: () => props.favorites.toggle(node.originalPath),
                          onRename: () => setRenaming(node.path),
                          onDelete: () => setDeleting(node.path),
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
          </Show>
        )}
        </For>
      </Show>
    </div>
  )
}

function toLive(node: FileNode): FileTreeV2Node {
  return {
    ...node,
    path: normalizeFileTreeV2Path(node.path),
    originalPath: node.path,
  }
}

function ProjectExplorerRow(props: {
  row: Accessor<{ node: FileTreeV2Node; level: number }>
  selected: boolean
  focused: boolean
  expanded: boolean
  status?: Kind
  favorited: boolean
  renaming: boolean
  deleting: boolean
  creating: PendingCreate | undefined
  onFocus: () => void
  onBlur: () => void
  onClick: () => void
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
  let inputRef: HTMLInputElement | undefined
  // Escape cancels and the input unmounts shortly after — without this guard
  // the resulting blur would still fire the commit handler with the (now
  // irrelevant) input value, silently overriding the cancel.
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

  return (
    <div
      data-slot="project-explorer-row"
      data-selected={props.selected ? "" : undefined}
      data-focused={props.focused ? "" : undefined}
      data-ignored={node().ignored ? "" : undefined}
      style={{ "padding-inline-start": `${6 + level() * 14}px` }}
      draggable={!props.renaming && !isSynthetic()}
      onDragStart={(event: DragEvent) => {
        event.dataTransfer?.setData("text/plain", `file:${node().originalPath}`)
        event.dataTransfer?.setData("text/uri-list", pathToFileUrl(node().originalPath))
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy"
        withFileDragImage(event)
      }}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      onClick={props.onClick}
      onDblClick={props.onDoubleClick}
    >
      <Show
        when={node().type === "directory"}
        fallback={<div style={{ width: "14px", "flex-shrink": "0" }} />}
      >
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

      <Show when={!isSynthetic() && !props.renaming && !props.deleting}>
        <button
          type="button"
          data-slot="project-explorer-favorite"
          data-favorited={props.favorited ? "" : undefined}
          aria-label={
            props.favorited
              ? props.language.t("model.favorite.remove")
              : props.language.t("model.favorite.add")
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
