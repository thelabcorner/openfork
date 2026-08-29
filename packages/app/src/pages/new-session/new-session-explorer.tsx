import { createMediaQuery } from "@solid-primitives/media"
import { createMemo, lazy, Show, Suspense, type JSX } from "solid-js"
import { RouteLoadingFallback } from "@/components/route-loading-fallback"
import { useFile } from "@/context/file"
import { useLayout } from "@/context/layout"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { createFileOpsPort } from "@/utils/file-ops-port"
import {
  PROJECT_EXPLORER_EDITOR_WIDTH_MAX,
  PROJECT_EXPLORER_EDITOR_WIDTH_MIN,
  PROJECT_EXPLORER_TREE_WIDTH_MAX,
  PROJECT_EXPLORER_TREE_WIDTH_MIN,
  createProjectExplorerPanelState,
} from "@/pages/session/v2/project-explorer-panel-state"
import type { ResizeHandlePairSide } from "@opencode-ai/ui/resize-handle"

const ProjectExplorerPanel = lazy(() =>
  import("@/pages/session/v2/project-explorer-panel").then((m) => ({ default: m.ProjectExplorerPanel })),
)

const NEW_SESSION_PANE_MIN = 320

interface RowPane {
  id: string
  size: () => number
  min: number
  max?: number
  resize: (width: number) => void
  el: () => HTMLElement | null
  absorb?: boolean
}

export function NewSessionExplorerRow(props: { children: JSX.Element }) {
  const layout = useLayout()
  const isDesktop = createMediaQuery("(min-width: 768px)")
  const opened = createMemo(() => isDesktop() && layout.projectExplorer.opened())

  return (
    <div class="flex-1 min-h-0 flex flex-col md:flex-row gap-2 p-2 overflow-hidden">
      <Show when={opened()}>
        <Suspense fallback={<RouteLoadingFallback />}>
          <NewSessionExplorerPanel />
        </Suspense>
      </Show>
      <div data-new-session-panel class="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
        {props.children}
      </div>
    </div>
  )
}

function NewSessionExplorerPanel() {
  const layout = useLayout()
  const file = useFile()
  const prompt = usePrompt()
  const sdk = useSDK()
  const state = createProjectExplorerPanelState()
  const fileOps = createMemo(() => createFileOpsPort(sdk().client))

  const byId = (id: string) => () => document.getElementById(id)
  const toPairSide = (pane: RowPane): ResizeHandlePairSide => ({
    size: pane.size(),
    min: pane.min,
    max: pane.max,
    onResize: pane.resize,
    el: pane.el,
    absorb: pane.absorb,
  })

  const orderedPanes = createMemo<RowPane[]>(() => {
    const list: RowPane[] = [
      {
        id: "explorerTree",
        size: () => state.treeWidth(),
        min: PROJECT_EXPLORER_TREE_WIDTH_MIN,
        max: PROJECT_EXPLORER_TREE_WIDTH_MAX,
        resize: state.resizeTree,
        el: byId("project-explorer-tree-pane"),
      },
    ]
    if (state.editorOpened()) {
      list.push({
        id: "explorerEditor",
        size: () => state.editorWidth(),
        min: PROJECT_EXPLORER_EDITOR_WIDTH_MIN,
        max: PROJECT_EXPLORER_EDITOR_WIDTH_MAX,
        resize: state.resizeEditor,
        el: byId("project-explorer-editor-pane"),
      })
    }
    list.push({
      id: "newSession",
      size: () => 0,
      min: NEW_SESSION_PANE_MIN,
      resize: () => {},
      el: () => document.querySelector<HTMLElement>("[data-new-session-panel]"),
      absorb: true,
    })
    return list
  })

  const dividerAfter = (paneId: string) => {
    const list = orderedPanes()
    const idx = list.findIndex((p) => p.id === paneId)
    if (idx < 0 || idx >= list.length - 1) return undefined
    return { left: toPairSide(list[idx]), right: toPairSide(list[idx + 1]) }
  }

  return (
    <ProjectExplorerPanel
      state={state}
      onClose={layout.projectExplorer.close}
      onAddToChat={(path) => prompt.context.add({ type: "file", path })}
      fileOps={fileOps()}
      gitStatus={file.gitStatus()}
      treePair={dividerAfter("explorerTree")}
      editorPair={dividerAfter("explorerEditor")}
    />
  )
}
