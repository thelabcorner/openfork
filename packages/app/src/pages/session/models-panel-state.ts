import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { useLayout } from "@/context/layout"

export const MODELS_PANEL_WIDTH_DEFAULT = 540
export const MODELS_PANEL_WIDTH_MIN = 380
export const MODELS_PANEL_WIDTH_MAX = 980

export function createModelsPanelState() {
  const layout = useLayout()
  const [store, setStore, , ready] = persisted(
    Persist.global("models-panel"),
    createStore({
      sidebarWidth: MODELS_PANEL_WIDTH_DEFAULT,
    }),
  )

  const opened = layout.models.opened

  const visible = createMemo(() => opened())

  return {
    opened,
    visible,
    sidebarWidth: () => store.sidebarWidth,
    sidebarTransition: ready,
    resizeSidebar: (width: number) =>
      setStore(
        "sidebarWidth",
        Math.min(MODELS_PANEL_WIDTH_MAX, Math.max(MODELS_PANEL_WIDTH_MIN, width)),
      ),
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
