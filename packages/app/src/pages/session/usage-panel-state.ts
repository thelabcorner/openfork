import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"
import { createResizableSize } from "@/utils/resizable-size"

export const USAGE_PANEL_WIDTH_DEFAULT = 540
export const USAGE_PANEL_WIDTH_MIN = 380
export const USAGE_PANEL_WIDTH_MAX = 980

export function createUsagePanelState() {
  const layout = useLayout()
  const width = createResizableSize("usage-panel", "sidebarWidth", {
    min: USAGE_PANEL_WIDTH_MIN,
    max: USAGE_PANEL_WIDTH_MAX,
    default: USAGE_PANEL_WIDTH_DEFAULT,
  })

  const opened = layout.usage.opened

  const visible = createMemo(() => opened())

  return {
    opened,
    visible,
    sidebarWidth: width.size,
    sidebarTransition: width.ready,
    resizeSidebar: width.resize,
    open() {
      layout.usage.open()
    },
    close() {
      layout.usage.close()
    },
    toggle() {
      layout.usage.toggle()
    },
  }
}

export type UsagePanelState = ReturnType<typeof createUsagePanelState>
