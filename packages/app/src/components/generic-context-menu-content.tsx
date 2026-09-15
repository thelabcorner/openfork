import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { ContextMenuCursorTrigger } from "./context-menu-cursor-trigger"
import {
  copyContextMenuSelection,
  cutContextMenuSelection,
  pasteContextMenuClipboard,
  selectAllContextMenuTarget,
} from "./context-menu-actions"
import {
  contextMenuHasSelection,
  type ContextMenuSelectionSnapshot,
} from "./context-menu-selection"

export function GenericContextMenuContent(props: {
  request: { x: number; y: number; selection: ContextMenuSelectionSnapshot }
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const language = useLanguage()
  const snapshot = props.request.selection
  const selectable = contextMenuHasSelection(snapshot)
  const editable = !!snapshot.editable

  return (
    <MenuV2 open={props.open} onOpenChange={props.onOpenChange} placement="right-start" gutter={2} shift={2} flip overflowPadding={8}>
      <ContextMenuCursorTrigger x={props.request.x} y={props.request.y} />
      <MenuV2.Portal>
        <MenuV2.Content>
          <MenuV2.Item disabled={!selectable} onSelect={() => void copyContextMenuSelection(snapshot)}>
            <span class="flex items-center gap-2 w-full">
              <span data-slot="menu-v2-item-icon"><Icon name="outline-copy" size="small" /></span>
              {language.t("common.copy")}
            </span>
          </MenuV2.Item>
          <MenuV2.Item disabled={!editable || !selectable} onSelect={() => void cutContextMenuSelection(snapshot)}>
            <span class="flex items-center gap-2 w-full">
              <span data-slot="menu-v2-item-icon"><Icon name="edit" size="small" /></span>
              {language.t("common.cut")}
            </span>
          </MenuV2.Item>
          <MenuV2.Item disabled={!editable} onSelect={() => void pasteContextMenuClipboard(snapshot)}>
            <span class="flex items-center gap-2 w-full">
              <span data-slot="menu-v2-item-icon"><Icon name="outline-copy" size="small" /></span>
              {language.t("common.paste")}
            </span>
          </MenuV2.Item>
          <MenuV2.Separator />
          <MenuV2.Item onSelect={() => selectAllContextMenuTarget(snapshot)}>
            <span class="flex items-center gap-2 w-full">
              <span data-slot="menu-v2-item-icon"><Icon name="expand" size="small" /></span>
              {language.t("common.selectAll")}
            </span>
          </MenuV2.Item>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}
