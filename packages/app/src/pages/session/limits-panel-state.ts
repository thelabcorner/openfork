import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"
import { createResizableSize } from "@/utils/resizable-size"

export const LIMITS_PANEL_WIDTH_DEFAULT = 480
export const LIMITS_PANEL_WIDTH_MIN = 320
export const LIMITS_PANEL_WIDTH_MAX = 960

export function createLimitsPanelState() {
  const layout = useLayout()
  const width = createResizableSize("limits-panel", "sidebarWidth", {
    min: LIMITS_PANEL_WIDTH_MIN,
    max: LIMITS_PANEL_WIDTH_MAX,
    default: LIMITS_PANEL_WIDTH_DEFAULT,
  })
  const opened = layout.limits.opened
  const visible = createMemo(() => opened())
  return {
    opened,
    visible,
    sidebarWidth: width.size,
    sidebarTransition: width.ready,
    resizeSidebar: width.resize,
    open() {
      layout.limits.open()
    },
    close() {
      layout.limits.close()
    },
    toggle() {
      layout.limits.toggle()
    },
  }
}

export type LimitsPanelState = ReturnType<typeof createLimitsPanelState>
