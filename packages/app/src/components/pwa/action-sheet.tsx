import { ActionSheet, ActionSheetItem } from "@opencode-ai/ui/v2/action-sheet-v2"
import { For, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"

export interface PwaActionSheetItem {
  label: string
  destructive?: boolean
  disabled?: boolean
  onSelect?: () => void
}

export interface PwaActionSheetSpec {
  title?: string
  description?: string
  items: PwaActionSheetItem[]
}

export function createPwaActionSheetHost() {
  const [state, setState] = createStore({ open: false, spec: null as PwaActionSheetSpec | null })
  return {
    state,
    open(spec: PwaActionSheetSpec) {
      setState({ open: true, spec })
    },
    close() {
      setState("open", false)
    },
  }
}

export type PwaActionSheetHost = ReturnType<typeof createPwaActionSheetHost>

export const PwaActionSheetHost: Component<{ host: PwaActionSheetHost }> = (props) => {
  const onOpenChange = (open: boolean) => {
    if (!open) props.host.close()
  }

  return (
    <Show when={props.host.state.spec} keyed>
      {(spec) => (
        <ActionSheet
          open={props.host.state.open}
          onOpenChange={onOpenChange}
          title={spec.title}
          description={spec.description}
        >
          <For each={spec.items}>
            {(item) => (
              <ActionSheetItem destructive={item.destructive} disabled={item.disabled} onSelect={item.onSelect}>
                {item.label}
              </ActionSheetItem>
            )}
          </For>
        </ActionSheet>
      )}
    </Show>
  )
}
