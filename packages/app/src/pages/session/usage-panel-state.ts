import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { useLayout } from "@/context/layout"

export const USAGE_PANEL_WIDTH_DEFAULT = 540
export const USAGE_PANEL_WIDTH_MIN = 380
export const USAGE_PANEL_WIDTH_MAX = 980

export function createUsagePanelState() {
  const layout = useLayout()
  const [store, setStore, , ready] = persisted(
    Persist.global("usage-panel"),
    createStore({
      sidebarWidth: USAGE_PANEL_WIDTH_DEFAULT,
    }),
  )

  const opened = layout.usage.opened

  const visible = createMemo(() => opened())

  return {
    opened,
    visible,
    sidebarWidth: () => store.sidebarWidth,
    sidebarTransition: ready,
    resizeSidebar: (width: number) =>
      setStore(
        "sidebarWidth",
        Math.min(USAGE_PANEL_WIDTH_MAX, Math.max(USAGE_PANEL_WIDTH_MIN, width)),
      ),
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
