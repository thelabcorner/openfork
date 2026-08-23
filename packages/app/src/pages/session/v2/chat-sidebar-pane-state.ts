import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { clampSize } from "@/utils/resizable-size"

export const CHAT_SIDEBAR_PANE_WIDTH_DEFAULT = 280
export const CHAT_SIDEBAR_PANE_WIDTH_MIN = 200
export const CHAT_SIDEBAR_PANE_WIDTH_MAX = 420

export const CHAT_SIDEBAR_RECENT_LIMIT_MIN = 5
const CHAT_SIDEBAR_RECENT_LIMIT_STEP = 5

export function createChatSidebarPaneState() {
  const [store, setStore, , ready] = persisted(
    Persist.global("chat-sidebar-panel"),
    createStore({
      sidebarWidth: CHAT_SIDEBAR_PANE_WIDTH_DEFAULT,
      recentLimit: CHAT_SIDEBAR_RECENT_LIMIT_MIN,
      collapsedGroups: {} as Record<string, boolean>,
    }),
  )

  return {
    ready,
    sidebarWidth: () => store.sidebarWidth,
    resizeSidebar: (width: number) =>
      setStore("sidebarWidth", clampSize(width, CHAT_SIDEBAR_PANE_WIDTH_MIN, CHAT_SIDEBAR_PANE_WIDTH_MAX)),
    recentLimit: () => Math.max(CHAT_SIDEBAR_RECENT_LIMIT_MIN, store.recentLimit),
    showMoreRecent: () =>
      setStore("recentLimit", (value) => Math.max(CHAT_SIDEBAR_RECENT_LIMIT_MIN, value) + CHAT_SIDEBAR_RECENT_LIMIT_STEP),
    showLessRecent: () =>
      setStore(
        "recentLimit",
        (value) => Math.max(CHAT_SIDEBAR_RECENT_LIMIT_MIN, Math.max(CHAT_SIDEBAR_RECENT_LIMIT_MIN, value) - CHAT_SIDEBAR_RECENT_LIMIT_STEP),
      ),
    isGroupCollapsed: (key: string) => store.collapsedGroups[key] === true,
    toggleGroup: (key: string) => setStore("collapsedGroups", key, (prev) => !prev),
    revealGroup: (key: string) => setStore("collapsedGroups", key, false),
  }
}

export type ChatSidebarPaneState = ReturnType<typeof createChatSidebarPaneState>
