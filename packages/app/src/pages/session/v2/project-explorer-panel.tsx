import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { debounce } from "@solid-primitives/scheduled"
import { ResizeHandle, type ResizeHandlePairSide } from "@opencode-ai/ui/resize-handle"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
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
  const clearSearch = () => {
    applySearch.clear()
    setSearch({ input: "", query: "" })
  }

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

  return (
    <div
      id="project-explorer-panel"
      // Width is the sum of the tree + editor panes, so it is left to `auto`:
      // a stored width here would be a second, lagging source of truth during
      // a drag. (`contain: strict` would zero out an auto width.)
      class="relative flex h-full min-h-0 w-auto shrink-0 flex-row overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
      data-project-explorer-panel
    >
      <div
        id="project-explorer-tree-pane"
        class="relative flex h-full min-h-0 shrink-0 flex-col"
        style={{ width: `${props.state.treeWidth()}px` }}
      >
        <div class="flex h-8 shrink-0 items-center gap-1 border-b border-v2-border-border-base px-2">
          <span class="min-w-0 max-w-24 truncate text-[11px] font-[560] uppercase tracking-[0.04px] text-v2-text-text-muted">
            {language.t("projectExplorer.title")}
          </span>
          <TextInputV2
            type="search"
            value={search.input}
            placeholder={language.t("projectExplorer.search.placeholder")}
            aria-label={language.t("projectExplorer.search.placeholder")}
            leadingIcon={<Icon name="magnifying-glass" size="small" />}
            showClearButton={search.input !== ""}
            clearLabel={language.t("common.clear")}
            spellcheck={false}
            onClearClick={clearSearch}
            onInput={(event) => {
              setSearch("input", event.currentTarget.value)
              applySearch(event.currentTarget.value)
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") clearSearch()
            }}
          />
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
        <ScrollView class="min-h-0 flex-1">
          <ProjectExplorerTree
            favorites={favorites}
            search={search.query}
            gitStatus={props.gitStatus}
            ref={(handle) => (treeHandle = handle)}
            onOpen={(node) => {
              if (node.type === "file") openFile(node.path)
            }}
            onMention={addToChat}
            onRename={(from, to) => void fileOps().rename({ from, to }).catch(notImplementedToast)}
            onDelete={(path) => void fileOps().delete({ path }).catch(notImplementedToast)}
            onCreate={(path, kind) => void fileOps().mkdir({ path, kind }).catch(notImplementedToast)}
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
