import DrawerPrimitive from "@corvu/drawer"
import { children, Show, splitProps, type JSXElement, type ParentProps } from "solid-js"
import { useI18n } from "../../context/i18n"
import { BottomSheet, BottomSheetDescription, BottomSheetHeader, BottomSheetTitle, type BottomSheetProps } from "./bottom-sheet-v2"
import "./action-sheet-v2.css"

export interface ActionSheetProps extends Omit<BottomSheetProps, "children"> {
  title?: JSXElement
  description?: JSXElement
  children?: JSXElement
}

/**
 * Opinionated bottom sheet for action menus (dropdown-menu pattern-swap on
 * coarse pointers, docs/pwa-mobile/02-design-system.md §5.2). Renders a cancel
 * row automatically; items dismiss the sheet when selected.
 */
export function ActionSheet(props: ActionSheetProps) {
  const [local, rest] = splitProps(props, ["title", "description", "children"])

  return (
    <BottomSheet {...rest}>
      <Show when={local.title || local.description}>
        <BottomSheetHeader>
          <Show when={local.title}>
            <BottomSheetTitle>{local.title}</BottomSheetTitle>
          </Show>
          <Show when={local.description}>
            <BottomSheetDescription>{local.description}</BottomSheetDescription>
          </Show>
        </BottomSheetHeader>
      </Show>
      <div data-component="action-sheet-v2">
        <div data-slot="action-sheet-items" role="group">
          {local.children}
        </div>
        <ActionSheetCancel />
      </div>
    </BottomSheet>
  )
}

export interface ActionSheetItemProps {
  destructive?: boolean
  disabled?: boolean
  onSelect?: () => void
  class?: string
  children?: JSXElement
}

export function ActionSheetItem(props: ActionSheetItemProps) {
  const dialog = DrawerPrimitive.useDialogContext()

  return (
    <button
      type="button"
      data-component="action-sheet-v2"
      data-slot="action-sheet-item"
      data-destructive={props.destructive ? "" : undefined}
      disabled={props.disabled}
      class={props.class}
      onClick={() => {
        dialog.setOpen(false)
        props.onSelect?.()
      }}
    >
      {props.children}
    </button>
  )
}

export function ActionSheetCancel(props: ParentProps & { class?: string }) {
  const i18n = useI18n()
  const label = children(() => props.children)

  return (
    <DrawerPrimitive.Close
      data-component="action-sheet-v2"
      data-slot="action-sheet-cancel"
      class={props.class}
    >
      {label() || i18n.t("ui.common.cancel")}
    </DrawerPrimitive.Close>
  )
}
