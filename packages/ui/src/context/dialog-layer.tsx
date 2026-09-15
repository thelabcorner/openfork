import { Dialog as Kobalte } from "@kobalte/core/dialog"
import type { JSX, ParentProps } from "solid-js"

export function DialogLayer(
  props: ParentProps<{
    modal: boolean
    open: boolean
    layer: number
    zIndex: number
    onOpenChange: (open: boolean) => void
    onOverlayClick: () => void
  }>,
): JSX.Element {
  return (
    <Kobalte modal={props.modal} open={props.open} onOpenChange={props.onOpenChange}>
      <Kobalte.Portal>
        <Kobalte.Overlay
          data-component="dialog-overlay"
          style={{ "z-index": String(props.zIndex) }}
          onClick={props.onOverlayClick}
        />
        <div
          data-dialog-layer={props.layer}
          style={{
            position: "fixed",
            inset: "0",
            "z-index": String(props.zIndex),
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            "pointer-events": "none",
          }}
        >
          {props.children}
        </div>
      </Kobalte.Portal>
    </Kobalte>
  )
}
