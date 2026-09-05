import { createSignal, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { debounce } from "@solid-primitives/scheduled"
import { ResizeHandle, type ResizeHandlePairSide } from "@opencode-ai/ui/resize-handle"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ProjectExplorerTree, type ProjectExplorerTreeHandle } from "@/components/project-explorer-tree"
import type { Kind } from "@/components/file-tree"
import { ProjectExplorerEditorPane, type ProjectExplorerEditorPaneHandle } from "./project-explorer-editor-pane"
import { notImplementedFileOpsPort, FileOpsNotImplementedError, type FileOpsPort } from "@/utils/file-ops-port"
import { createProjectExplorerFavorites } from "@/utils/project-explorer-favorites"
import {
  PROJECT_EXPLORER_EDITOR_WIDTH_MAX,
  PROJECT_EXPLORER_EDITOR_WIDTH_MIN,
  PROJECT_EXPLORER_TREE_WIDTH_MAX,
  PROJECT_EXPLORER_TREE_WIDTH_MIN,
  type ProjectExplorerPanelState,
} from "./project-explorer-panel-state"

/**
 * ProjectExplorerPanel — the left-docked project tree + editor pane.
 * Structural mirror of BrowserPanelV2 (packages/app/src/pages/session/v2/browser-panel-v2.tsx),
 * on the opposite edge: `edge="end"` resize handle (drag right edge to grow),
 * mounted as a `shrink-0` flex sibling before `main` in layout-new.tsx.
 *
 * File mutation (rename/delete/new file/new folder/save) goes through
 * `props.fileOps`, which defaults to `notImplementedFileOpsPort` — every
 * action here is real UI wired to a real interface, but until the backend in
 * AGENT_HANDOFF_file-explorer-backend.md lands, mutating actions fail with a
 * clear toast instead of silently doing nothing.
 */
export function ProjectExplorerPanel(props: {
  state: ProjectExplorerPanelState
  onClose: () => void
  onAddToChat?: (path: string) => void
  fileOps?: FileOpsPort
  gitStatus?: ReadonlyMap<string, Kind>
  /**
   * Dividers owned by this panel, supplied by the session row so the whole row
   * is described by one ordered pane list. `treePair` is tree|editor when the
   * editor is open and tree|session otherwise; `editorPair` is editor|session.
   */
  treePair?: { left: ResizeHandlePairSide; right: ResizeHandlePairSide }
  editorPair?: { left: ResizeHandlePairSide; right: ResizeHandlePairSide }
}) {
  const language = useLanguage()
  const favorites = createProjectExplorerFavorites()
  const fileOps = () => props.fileOps ?? notImplementedFileOpsPort

  // `input` tracks the field live; `query` is the debounced value the tree
  // filters on, so typing never blocks the main thread.
  const [search, setSearch] = createStore({ input: "", query: "" })
  const applySearch = debounce((value: string) => setSearch("query", value), 120)
  onCleanup(() => applySearch.clear())
  const clearSearch = () => {
    applySearch.clear()
    setSearch({ input: "", query: "" })
  }

  // Multi-select mirrored from the tree (for header badge / bulk bar)
  const [treeSelected, setTreeSelected] = createSignal<string[]>([])
  const treeSelectedCount = () => treeSelected().length

  let treeHandle: ProjectExplorerTreeHandle | undefined
  let editorHandle: ProjectExplorerEditorPaneHandle | undefined

  const notImplementedToast = (error: unknown) => {
    if (!(error instanceof FileOpsNotImplementedError)) {
      showToast({ variant: "error", title: language.t("common.requestFailed") })
      return
    }
    showToast({
      variant: "error",
      title: language.t("projectExplorer.contextMenu.notImplemented.title"),
      description: language.t("projectExplorer.contextMenu.notImplemented.description"),
    })
  }

  // Rename/delete/create callbacks can arrive as a synchronous burst from a
  // multi-selection or a drag operation. Keep a small amount of parallelism
  // for real backends while preventing one gesture from opening an unbounded
  // set of requests and promise continuations on the renderer's event loop.
  const MAX_MUTATION_QUEUE = 512
  const mutationQueue: Array<() => Promise<unknown>> = []
  let activeMutations = 0
  let disposed = false
  let mutationOverflowNotified = false
  const pumpMutations = () => {
    while (activeMutations < 2 && mutationQueue.length > 0) {
      const operation = mutationQueue.shift()!
      activeMutations += 1
      void Promise.resolve()
        .then(operation)
        .catch((error) => {
          // Active filesystem operations cannot be force-cancelled by every
          // backend, but a panel that has unmounted must not enqueue a late
          // toast or another renderer update when they settle.
          if (!disposed) notImplementedToast(error)
        })
        .finally(() => {
          activeMutations -= 1
          if (mutationQueue.length < MAX_MUTATION_QUEUE / 2) mutationOverflowNotified = false
          pumpMutations()
        })
    }
  }
  const enqueueMutation = (operation: () => Promise<unknown>) => {
    if (disposed) return
    if (mutationQueue.length >= MAX_MUTATION_QUEUE) {
      if (mutationOverflowNotified) return
      mutationOverflowNotified = true
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: "Too many file operations are queued; wait for the current batch to finish.",
      })
      return
    }
    mutationQueue.push(operation)
    pumpMutations()
  }
  onCleanup(() => {
    disposed = true
    mutationQueue.length = 0
  })

  const openFile = (path: string) => {
    props.state.openEditor()
    void editorHandle?.openFile(path)
  }

  const addToChat = (path: string) => {
    if (!props.onAddToChat) {
      showToast({ variant: "error", title: language.t("projectExplorer.contextMenu.noActiveChat") })
      return
    }
    props.onAddToChat(path)
    showToast({ title: language.t("projectExplorer.contextMenu.addedToChat", { name: path.split("/").pop() ?? path }) })
  }
  const addSelectedToChat = () => {
    const paths = treeSelected()
    if (paths.length === 0) return
    if (!props.onAddToChat) {
      showToast({ variant: "error", title: language.t("projectExplorer.contextMenu.noActiveChat") })
      return
    }
    void (async () => {
      for (let index = 0; index < paths.length; index++) {
        if (disposed) return
        props.onAddToChat?.(paths[index])
        // Prompt/context updates are synchronous Solid store writes. Yield
        // between small chunks so a huge selection cannot monopolize the
        // renderer task that handled the click.
        if ((index + 1) % 32 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
    })()
    showToast({
      title: language.t("projectExplorer.contextMenu.addedToChat", { name: `${paths.length} files` }),
    })
  }
  const deleteSelected = () => {
    const paths = treeSelected()
    if (paths.length === 0) return
    // Delegate to tree's bulk confirmation (shows one inline confirm)
    if (paths.length === 1) treeHandle?.startDelete(paths[0]!)
    else treeHandle?.startDelete(paths[0]!)
  }

  return (
    <div
      id="project-explorer-panel"
      // Width is the sum of the tree + editor panes, so it is left to `auto`:
      // a stored width here would be a second, lagging source of truth during
      // a drag. (`contain: strict` would zero out an auto width.)
      class="relative flex h-full min-h-0 w-auto shrink-0 flex-row overflow-hidden rounded-[8px] border border-v2-border-border-base/50 bg-v2-background-bg-base shadow-[0_1px_2px_0_var(--v2-alpha-dark-6),0_1px_3px_0_var(--v2-alpha-dark-4),0_0_0_0.5px_var(--v2-alpha-dark-8)]"
      data-project-explorer-panel
    >
      <div
        id="project-explorer-tree-pane"
        class="relative flex h-full min-h-0 shrink-0 flex-col"
        style={{ width: `${props.state.treeWidth()}px` }}
      >
        {/* ── Title bar — zinc/IDE: dense, uppercase, hairline border ── */}
        <div class="flex h-9 shrink-0 items-center gap-1.5 border-b border-v2-border-border-muted/50 px-2.5">
          <span class="min-w-0 truncate text-[10px] font-[600] uppercase leading-none tracking-[0.08em] text-v2-text-text-muted">
            {language.t("projectExplorer.title")}
          </span>
          <Show when={treeSelectedCount() > 1}>
            <span class="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-v2-background-bg-layer-03 px-1 text-[10px] font-[600] leading-none tabular-nums text-v2-text-text-muted">
              {treeSelectedCount()}
            </span>
          </Show>
          <div class="ms-auto flex items-center gap-0.5">
            <TooltipV2 value={language.t("projectExplorer.expandAll")}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                onClick={() => treeHandle?.expandAll()}
                aria-label={language.t("projectExplorer.expandAll")}
                icon={<Icon name="expand" />}
              />
            </TooltipV2>
            <TooltipV2 value={language.t("projectExplorer.collapseAll")}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                onClick={() => treeHandle?.collapseAll()}
                aria-label={language.t("projectExplorer.collapseAll")}
                icon={<Icon name="collapse" />}
              />
            </TooltipV2>
            <TooltipV2 value={language.t("projectExplorer.contextMenu.newFile")}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                onClick={() => treeHandle?.startCreate("", "file")}
                aria-label={language.t("projectExplorer.contextMenu.newFile")}
                icon={<Icon name="plus" />}
              />
            </TooltipV2>
            <TooltipV2 value={language.t("projectExplorer.contextMenu.newFolder")}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                onClick={() => treeHandle?.startCreate("", "directory")}
                aria-label={language.t("projectExplorer.contextMenu.newFolder")}
                icon={<Icon name="folder-add-left" />}
              />
            </TooltipV2>
            <TooltipV2 value={language.t("common.collapse")}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                onClick={props.onClose}
                aria-label={language.t("common.collapse")}
                icon={<Icon name="close" />}
              />
            </TooltipV2>
          </div>
        </div>
        {/* ── Search — zinc inset field: bordered, not plastic translucent ── */}
        <div class="shrink-0 bg-v2-background-bg-base px-2 pb-2 pt-2">
          <label class="flex h-[26px] w-full items-center gap-1.5 rounded-[7px] border border-v2-border-border-base/60 bg-v2-background-bg-layer-01 px-1.5 text-v2-icon-icon-muted shadow-[inset_0_1px_1px_var(--v2-alpha-dark-6),inset_0_0.5px_0.5px_var(--v2-alpha-dark-4)] transition-[border-color,background-color,box-shadow] duration-150 hover:border-v2-border-border-base hover:bg-v2-background-bg-layer-02 focus-within:border-v2-border-border-strong focus-within:bg-v2-background-bg-base focus-within:shadow-[0_0_0_2px_var(--v2-alpha-dark-8)]">
            <Icon name="magnifying-glass" size="small" class="shrink-0 opacity-80" />
            <input
              class="min-w-0 flex-1 border-0 bg-transparent text-[12px] font-[440] leading-none tracking-[-0.01em] text-v2-text-text-base outline-0 placeholder:text-v2-text-text-faint/70 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
              type="text"
              value={search.input}
              placeholder={language.t("projectExplorer.search.placeholder")}
              aria-label={language.t("projectExplorer.search.placeholder")}
              spellcheck={false}
              onInput={(event) => {
                setSearch("input", event.currentTarget.value)
                applySearch(event.currentTarget.value)
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") clearSearch()
              }}
            />
            <Show when={search.input !== ""}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                class="shrink-0"
                icon={<Icon name="close" size="large" class="text-v2-icon-icon-muted" />}
                aria-label={language.t("common.clear")}
                onClick={clearSearch}
              />
            </Show>
          </label>
        </div>
        {/* ── Bulk selection bar (IDE: appears only when >1 selected) ── */}
        <Show when={treeSelectedCount() > 1}>
          <div class="shrink-0 mx-2 mb-1.5 flex items-center gap-1.5 rounded-[7px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1">
            <span class="min-w-0 flex-1 truncate text-[11px] font-[500] leading-none tracking-[-0.01em] text-v2-text-text-muted">
              {treeSelectedCount()} selected
            </span>
            <TooltipV2 value={language.t("projectExplorer.contextMenu.addToChat")}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                onClick={addSelectedToChat}
                aria-label={language.t("projectExplorer.contextMenu.addToChat")}
                icon={<Icon name="at-sign" />}
              />
            </TooltipV2>
            <TooltipV2 value={language.t("common.clear")}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                onClick={() => treeHandle?.clearSelection()}
                aria-label={language.t("common.clear")}
                icon={<Icon name="close" />}
              />
            </TooltipV2>
            <TooltipV2 value={language.t("projectExplorer.contextMenu.delete")}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                onClick={deleteSelected}
                aria-label={language.t("projectExplorer.contextMenu.delete")}
                icon={<Icon name="trash" />}
              />
            </TooltipV2>
          </div>
        </Show>
        <ScrollView class="min-h-0 flex-1">
          <ProjectExplorerTree
            favorites={favorites}
            search={search.query}
            gitStatus={props.gitStatus}
            ref={(handle) => (treeHandle = handle)}
            onSelectionChange={setTreeSelected}
            onOpen={(node) => {
              if (node.type === "file") openFile(node.path)
            }}
            onMention={addToChat}
            onRename={(from, to) => enqueueMutation(() => fileOps().rename({ from, to }).catch(notImplementedToast))}
            onDelete={(path) => enqueueMutation(() => fileOps().delete({ path }).catch(notImplementedToast))}
            onCreate={(path, kind) => enqueueMutation(() => fileOps().mkdir({ path, kind }).catch(notImplementedToast))}
          />
        </ScrollView>
        {/* Divider on the tree's right edge: tree|editor, or tree|session. */}
        <Show when={props.treePair}>
          {(pair) => (
            <ResizeHandle
              direction="horizontal"
              edge="end"
              size={props.state.treeWidth()}
              min={PROJECT_EXPLORER_TREE_WIDTH_MIN}
              max={PROJECT_EXPLORER_TREE_WIDTH_MAX}
              onResize={props.state.resizeTree}
              pair={pair()}
            />
          )}
        </Show>
      </div>

      <Show when={props.state.editorOpened()}>
        <div
          id="project-explorer-editor-pane"
          class="relative flex h-full min-h-0 shrink-0 flex-row"
          style={{ width: `${props.state.editorWidth()}px` }}
        >
          <ProjectExplorerEditorPane
            fileOps={fileOps()}
            onCloseAll={props.state.closeEditor}
            tree={{
              reveal: (path) => treeHandle?.reveal(path),
              startCreate: (parentDir, kind) => treeHandle?.startCreate(parentDir, kind),
              startRename: (path) => treeHandle?.startRename(path),
              startDelete: (path) => treeHandle?.startDelete(path),
            }}
            onAddToChat={(path) => addToChat(path)}
            isFavorite={(path) => favorites.isFavorite(path)}
            onToggleFavorite={(path) => favorites.toggle(path)}
            ref={(handle) => (editorHandle = handle)}
          />
          {/* Divider on the editor's right edge: editor|session. */}
          <Show when={props.editorPair}>
            {(pair) => (
              <ResizeHandle
                direction="horizontal"
                edge="end"
                size={props.state.editorWidth()}
                min={PROJECT_EXPLORER_EDITOR_WIDTH_MIN}
                max={PROJECT_EXPLORER_EDITOR_WIDTH_MAX}
                onResize={props.state.resizeEditor}
                pair={pair()}
              />
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}
