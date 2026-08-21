import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"
import { createResizableSize } from "@/utils/resizable-size"

export const MODELS_PANEL_WIDTH_DEFAULT = 540
export const MODELS_PANEL_WIDTH_MIN = 380
export const MODELS_PANEL_WIDTH_MAX = 980

export function createModelsPanelState() {
  const layout = useLayout()
  const width = createResizableSize("models-panel", "sidebarWidth", {
    min: MODELS_PANEL_WIDTH_MIN,
    max: MODELS_PANEL_WIDTH_MAX,
    default: MODELS_PANEL_WIDTH_DEFAULT,
  })

  const opened = layout.models.opened

  const visible = createMemo(() => opened())

  return {
    opened,
    visible,
    sidebarWidth: width.size,
    sidebarTransition: width.ready,
    resizeSidebar: width.resize,
    open() {
      layout.models.open()
    },
    close() {
      layout.models.close()
    },
    toggle() {
      layout.models.toggle()
    },
  }
}

export type ModelsPanelState = ReturnType<typeof createModelsPanelState>
