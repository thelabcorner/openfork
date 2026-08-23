import type { useLanguage } from "@/context/language"
import type { FileTreeV2Node } from "@/components/file-tree-v2-model"
import type { ProjectExplorerNodeActions } from "@/components/project-explorer-tree-context-menu"
import type { MenuSectionDef } from "./menu-model"

export type FileMenuModelInput = {
  language: ReturnType<typeof useLanguage>
  node: FileTreeV2Node
  actions: ProjectExplorerNodeActions
  system: {
    reveal: () => void
    copyPath: (relative: boolean) => void
    hasReveal: boolean
  }
}

export function createFileMenuModel(input: FileMenuModelInput): MenuSectionDef[] {
  const t = input.language.t.bind(input.language)
  const isFile = input.node.type === "file"

  const sections: MenuSectionDef[] = []

  if (isFile) {
    sections.push({
      id: "file-open",
      items: [
        { kind: "item", id: "open", label: t("projectExplorer.contextMenu.open"), onSelect: input.actions.onOpen },
        { kind: "item", id: "addToChat", label: t("projectExplorer.contextMenu.addToChat"), onSelect: input.actions.onMention },
      ],
    })
  }

  sections.push({
    id: "favorite",
    items: [
      {
        kind: "item",
        id: "favorite",
        label: input.actions.favorited ? t("model.favorite.remove") : t("model.favorite.add"),
        onSelect: input.actions.onFavoriteToggle,
      },
    ],
  })

  sections.push({
    id: "create",
    items: [
      { kind: "item", id: "newFile", label: t("projectExplorer.contextMenu.newFile"), onSelect: input.actions.onNewFile },
      { kind: "item", id: "newFolder", label: t("projectExplorer.contextMenu.newFolder"), onSelect: input.actions.onNewFolder },
      { kind: "item", id: "rename", label: t("projectExplorer.contextMenu.rename"), onSelect: input.actions.onRename },
      { kind: "item", id: "delete", label: t("projectExplorer.contextMenu.delete"), onSelect: input.actions.onDelete, variant: "danger" },
    ],
  })

  sections.push({
    id: "system",
    items: [
      { kind: "item", id: "reveal", label: t("projectExplorer.contextMenu.reveal"), disabled: !input.system.hasReveal, onSelect: input.system.reveal },
      { kind: "item", id: "copyPath", label: t("projectExplorer.contextMenu.copyPath"), onSelect: () => input.system.copyPath(true) },
      {
        kind: "item",
        id: "copyAbsolutePath",
        label: t("projectExplorer.contextMenu.copyAbsolutePath"),
        onSelect: () => input.system.copyPath(false),
      },
    ],
  })

  return sections
}
