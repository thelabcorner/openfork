import { createMemo } from "solid-js"
import { useLayout, type SessionContextTab } from "@/context/layout"
import { createResizableSize } from "@/utils/resizable-size"

export const CONTEXT_PANEL_WIDTH_DEFAULT = 480
export const CONTEXT_PANEL_WIDTH_MIN = 320
export const CONTEXT_PANEL_WIDTH_MAX = 960

export type ContextTab = SessionContextTab

export function createContextPanelState() {
  const layout = useLayout()
  const width = createResizableSize("context-panel", "sidebarWidth", {
    min: CONTEXT_PANEL_WIDTH_MIN,
    max: CONTEXT_PANEL_WIDTH_MAX,
    default: CONTEXT_PANEL_WIDTH_DEFAULT,
  })

  const opened = layout.sessionContext.opened
  const tab = layout.sessionContext.tab

  const visible = createMemo(() => opened())

  return {
    opened,
    tab,
    visible,
    sidebarWidth: width.size,
    sidebarTransition: width.ready,
    resizeSidebar: width.resize,
    setTab(tab: SessionContextTab) {
      layout.sessionContext.setTab(tab)
    },
    selectTab(tab: SessionContextTab) {
      layout.sessionContext.selectTab(tab)
    },
    open() {
      layout.sessionContext.open()
    },
    close() {
      layout.sessionContext.close()
    },
    toggle() {
      layout.sessionContext.toggle()
    },
  }
}

export type ContextPanelState = ReturnType<typeof createContextPanelState>
