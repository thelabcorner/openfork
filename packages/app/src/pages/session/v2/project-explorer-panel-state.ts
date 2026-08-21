import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { clampSize } from "@/utils/resizable-size"

export const PROJECT_EXPLORER_TREE_WIDTH_DEFAULT = 280
export const PROJECT_EXPLORER_TREE_WIDTH_MIN = 200
export const PROJECT_EXPLORER_TREE_WIDTH_MAX = 560

export const PROJECT_EXPLORER_EDITOR_WIDTH_DEFAULT = 560
export const PROJECT_EXPLORER_EDITOR_WIDTH_MIN = 320
export const PROJECT_EXPLORER_EDITOR_WIDTH_MAX = 1200

// App-shell scoped (mirrors browser-panel-v2-state.ts) for size only. Open/
// close (`panelOpened`) deliberately lives in the shared layout context
// (`layout.projectExplorer`, context/layout.tsx) instead — mirroring how
// BrowserPanelV2's open state lives in `layout.browser` while its width lives
// in this sibling module (browser-panel-v2-state.ts) — because the titlebar
// toggle button needs to read/flip the same open state this panel reads,
// and they're mounted as separate component instances that don't share a
// local Solid store unless it's centralized in the shared context.
export function createProjectExplorerPanelState() {
  const [store, setStore, , ready] = persisted(
    Persist.global("project-explorer-panel"),
    createStore({
      treeWidth: PROJECT_EXPLORER_TREE_WIDTH_DEFAULT,
      editorOpened: false,
      editorWidth: PROJECT_EXPLORER_EDITOR_WIDTH_DEFAULT,
    }),
  )

  return {
    ready,
    panelWidth: () => store.treeWidth + (store.editorOpened ? store.editorWidth : 0),
    treeWidth: () => store.treeWidth,
    resizeTree: (width: number) =>
      setStore("treeWidth", clampSize(width, PROJECT_EXPLORER_TREE_WIDTH_MIN, PROJECT_EXPLORER_TREE_WIDTH_MAX)),

    editorOpened: () => store.editorOpened,
    openEditor: () => setStore("editorOpened", true),
    closeEditor: () => setStore("editorOpened", false),
    editorWidth: () => store.editorWidth,
    resizeEditor: (width: number) =>
      setStore("editorWidth", clampSize(width, PROJECT_EXPLORER_EDITOR_WIDTH_MIN, PROJECT_EXPLORER_EDITOR_WIDTH_MAX)),
  }
}

export type ProjectExplorerPanelState = ReturnType<typeof createProjectExplorerPanelState>
