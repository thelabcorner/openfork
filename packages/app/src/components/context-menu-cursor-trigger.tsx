import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Portal } from "solid-js/web"

export function ContextMenuCursorTrigger(props: { x: number; y: number }) {
  return (
    <Portal>
      <MenuV2.Trigger
        data-context-menu-cursor-trigger
        style={
          {
            position: "fixed",
            left: `${props.x}px`,
            top: `${props.y}px`,
            width: "1px",
            height: "1px",
            opacity: "0",
            "pointer-events": "none",
            padding: "0",
            border: "0",
          } as any
        }
        aria-hidden="true"
        tabIndex={-1}
      />
    </Portal>
  )
}
