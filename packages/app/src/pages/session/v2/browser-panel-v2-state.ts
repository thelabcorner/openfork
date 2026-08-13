import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"

export const BROWSER_PANEL_V2_WIDTH_DEFAULT = 480
export const BROWSER_PANEL_V2_WIDTH_MIN = 320
export const BROWSER_PANEL_V2_WIDTH_MAX = 960

export type BrowserPanelExpandMode = "collapse" | "expand"

export function createBrowserPanelV2State() {
  const [store, setStore, , ready] = persisted(
    Persist.global("browser-panel-v2"),
    createStore({
      sidebarOpened: true,
      sidebarWidth: BROWSER_PANEL_V2_WIDTH_DEFAULT,
      expandMode: "collapse" as BrowserPanelExpandMode,
    }),
  )

  return {
    sidebarOpened: () => store.sidebarOpened,
    sidebarWidth: () => store.sidebarWidth,
    sidebarTransition: ready,
    expandMode: () => store.expandMode,
    setExpandMode: (mode: BrowserPanelExpandMode) => setStore("expandMode", mode),
    resizeSidebar: (width: number) =>
      setStore(
        "sidebarWidth",
        Math.min(BROWSER_PANEL_V2_WIDTH_MAX, Math.max(BROWSER_PANEL_V2_WIDTH_MIN, width)),
      ),
    toggleSidebar: () => setStore("sidebarOpened", (opened) => !opened),
  }
}

export type BrowserPanelV2State = ReturnType<typeof createBrowserPanelV2State>
