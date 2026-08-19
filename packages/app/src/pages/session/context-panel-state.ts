import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { useLayout } from "@/context/layout"

export const CONTEXT_PANEL_WIDTH_DEFAULT = 480
export const CONTEXT_PANEL_WIDTH_MIN = 320
export const CONTEXT_PANEL_WIDTH_MAX = 960

export function createContextPanelState() {
  const layout = useLayout()
  const [store, setStore, , ready] = persisted(
    Persist.global("context-panel"),
    createStore({
      sidebarWidth: CONTEXT_PANEL_WIDTH_DEFAULT,
    }),
  )

  const opened = layout.sessionContext.opened

  const visible = createMemo(() => opened())

  return {
    opened,
    visible,
    sidebarWidth: () => store.sidebarWidth,
    sidebarTransition: ready,
    resizeSidebar: (width: number) =>
      setStore(
        "sidebarWidth",
        Math.min(CONTEXT_PANEL_WIDTH_MAX, Math.max(CONTEXT_PANEL_WIDTH_MIN, width)),
      ),
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
