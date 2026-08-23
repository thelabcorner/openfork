import { createMemo, type ParentProps } from "solid-js"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { showToast } from "@/utils/toast"
import type { FileTreeV2Node } from "@/components/file-tree-v2-model"
import { createFileMenuModel } from "./session-menu/file-menu-model"
import { MenuSectionsRenderer } from "./session-menu/menu-renderer"

export type ProjectExplorerNodeActions = {
  favorited: boolean
  onOpen: () => void
  onMention: () => void
  onFavoriteToggle: () => void
  onRename: () => void
  onDelete: () => void
  onNewFile: () => void
  onNewFolder: () => void
}

// Right-click menu for a project-explorer row, following the established
// per-item MenuV2.Context wrapping convention (see titlebar-tab-context-menu.tsx,
// browser-tab-context-menu.tsx). File-system-mutating items (Rename/Delete/
// New File/New Folder) are always shown — they degrade gracefully today via
// FileOpsPort's NotImplementedError + a toast, and light up for real once the
// backend in AGENT_HANDOFF_file-explorer-backend.md lands, with no UI change.
export function ProjectExplorerTreeContextMenu(props: ParentProps<{ node: FileTreeV2Node; actions: ProjectExplorerNodeActions }>) {
  const language = useLanguage()
  const platform = usePlatform()

  const copyPath = async (relative: boolean) => {
    const value = relative ? props.node.originalPath : props.node.absolute || props.node.originalPath
    await navigator.clipboard.writeText(value)
    showToast({ title: language.t("projectExplorer.contextMenu.pathCopied") })
  }

  const reveal = async () => {
    if (!platform.revealPath) {
      showToast({ variant: "error", title: language.t("projectExplorer.contextMenu.revealUnavailable") })
      return
    }
    const ok = await platform.revealPath(props.node.absolute || props.node.originalPath)
    if (!ok) showToast({ variant: "error", title: language.t("projectExplorer.contextMenu.revealFailed") })
  }

  const sections = createMemo(() =>
    createFileMenuModel({
      language,
      node: props.node,
      actions: props.actions,
      system: {
        reveal: () => void reveal(),
        copyPath: (relative) => void copyPath(relative),
        hasReveal: !!platform.revealPath,
      },
    }),
  )

  return (
    <MenuV2.Context>
      <MenuV2.Context.Trigger class="block w-full min-w-0" as="div">
        {props.children}
      </MenuV2.Context.Trigger>
      <MenuV2.Context.Portal>
        <MenuV2.Context.Content>
          <MenuSectionsRenderer sections={sections()} />
        </MenuV2.Context.Content>
      </MenuV2.Context.Portal>
    </MenuV2.Context>
  )
}
