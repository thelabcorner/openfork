import { createPromptProjectController } from "@/components/prompt-project-selector"
import { useTitlebarRightMount } from "@/components/titlebar"
import { useSettings } from "@/context/settings"
import { createEffect, on } from "solid-js"
import { createNewSessionDraftController } from "./new-session/new-session-draft-controller"
import { NewSessionExplorerRow } from "./new-session/new-session-explorer"
import { NewSessionStatus, NewSessionView } from "./new-session/new-session-view"
import { createNewSessionWorkspaceController } from "./new-session/new-session-workspace-controller"
import { useNewSessionCommands } from "./new-session/use-new-session-commands"

/** The draft-only V2 session page. Submitting promotes the draft into a real session. */
export default function NewSessionPage() {
  const settings = useSettings()
  const rightMount = useTitlebarRightMount()
  const workspace = createNewSessionWorkspaceController()
  const draft = createNewSessionDraftController({
    worktree: workspace.selection.value,
    resetWorktree: workspace.selection.reset,
  })
  const project = createPromptProjectController({
    controls: draft.project.controls,
    onDone: draft.input.restoreFocus,
  })
  useNewSessionCommands({
    restoreFocus: draft.input.restoreFocus,
    project: {
      empty: project.empty,
      open: () => project.setOpen(true),
    },
  })
  createEffect(
    on(
      () => draft.prompt.ready(),
      (ready) => {
        if (!ready) return
        draft.input.restoreFocus()
      },
      { defer: true },
    ),
  )

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      <NewSessionStatus mount={rightMount} visible={settings.visibility.status} />
      <NewSessionExplorerRow>
        <NewSessionView input={draft.input} project={project} workspace={workspace} />
      </NewSessionExplorerRow>
    </div>
  )
}
