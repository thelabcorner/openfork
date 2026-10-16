import { createStore } from "solid-js/store"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { Persist, persisted } from "@/utils/persist"
import { clampSize } from "@/utils/resizable-size"
import { pathKey } from "@/utils/path-key"
import {
  CHAT_SIDEBAR_SORT_MODES,
  CHAT_SIDEBAR_VIEW_MODES,
  type ChatSidebarDensity,
  type ChatSidebarSortMode,
  type ChatSidebarViewMode,
} from "./chat-sidebar-tree"

export const CHAT_SIDEBAR_PANE_WIDTH_DEFAULT = 280
export const CHAT_SIDEBAR_PANE_WIDTH_MIN = 200
export const CHAT_SIDEBAR_PANE_WIDTH_MAX = 420

// Recent is a whole view now (not a 5-row teaser above duplicated project
// groups), and a folded SessionGroup counts as one item, so page in larger steps.
export const CHAT_SIDEBAR_RECENT_LIMIT_MIN = 15
const CHAT_SIDEBAR_RECENT_LIMIT_STEP = 15

export const CHAT_SIDEBAR_ARCHIVED_LIMIT_MIN = 5
const CHAT_SIDEBAR_ARCHIVED_LIMIT_STEP = 5

export type ChatSidebarAggregateMetrics = {
  cost?: number
  cacheHitPercent?: number | null
  model?: { modelID: string; variant?: string }
}

/**
 * Metrics already materialized on the session row by the server projector.
 * These are full-history aggregates and therefore both cheaper and more
 * authoritative than re-aggregating a bounded client-side message prefetch.
 */
export function chatSidebarAggregateMetrics(
  session: Pick<Session, "cost" | "tokens" | "model">,
): ChatSidebarAggregateMetrics {
  const tokens = session.tokens
  const denominator = tokens ? tokens.cache.read + tokens.input : undefined
  return {
    cost: session.cost,
    cacheHitPercent:
      denominator === undefined ? undefined : denominator <= 0 ? null : Math.round((tokens!.cache.read / denominator) * 1000) / 10,
    model: session.model ? { modelID: session.model.id, variant: session.model.variant } : undefined,
  }
}

export const shouldAutoHydrateChatSidebarMetrics = (input: { selected?: boolean; working: boolean }) =>
  !!input.selected || input.working

/** The Recent row is the sole animated slot; project/group duplicates stay static. */
export const chatSidebarWorkingIndicatorAnimated = (recent: boolean, primary: boolean, visible: boolean) =>
  recent && primary && visible

/**
 * Hard ceiling on concurrently animated working indicators in one pane. Every
 * animated dot is its own compositor layer (opacity animation), and Layerize
 * cost scales with the layer count, not with how cheap each animation is. A
 * static accent dot already conveys "working"; the pulse is garnish, so it is
 * rationed. Grants are FIFO and handed to the next waiter on release.
 */
export const CHAT_SIDEBAR_ANIMATED_INDICATOR_MAX = 6

export function createChatSidebarIndicatorBudget(max: number = CHAT_SIDEBAR_ANIMATED_INDICATOR_MAX) {
  type Waiter = { notify: (granted: boolean) => void; granted: boolean }
  const queue: Waiter[] = []
  let granted = 0
  const pump = () => {
    for (const waiter of queue) {
      if (granted >= max) return
      if (waiter.granted) continue
      waiter.granted = true
      granted += 1
      waiter.notify(true)
    }
  }
  return {
    /** Request an animation slot. `notify` reports grant/revocation; call the result to give it back. */
    acquire(notify: (granted: boolean) => void) {
      const waiter: Waiter = { notify, granted: false }
      queue.push(waiter)
      pump()
      return () => {
        const index = queue.indexOf(waiter)
        if (index < 0) return
        queue.splice(index, 1)
        if (waiter.granted) {
          waiter.granted = false
          granted -= 1
        }
        pump()
      }
    },
    granted: () => granted,
    waiting: () => queue.length - granted,
  }
}

export function uniqueSidebarSessions<T extends { id: string }>(sessions: T[]): T[] {
  return [...new Map(sessions.map((session) => [session.id, session])).values()]
}

/**
 * A canonical project root owns sessions associated with that project even
 * when their physical working directory is intentionally project-local (for
 * example generated Chat scratch directories). Sandbox slices do not pass a
 * projectID and therefore remain exact-directory scoped.
 */
export function chatSidebarRootSessionVisible(session: Session, directory: string, projectID?: string) {
  if (session.parentID || session.time?.archived) return false
  if (pathKey(session.directory) === pathKey(directory)) return true
  return !!projectID && session.projectID === projectID
}

export function createChatSidebarPaneState() {
  const [store, setStore, , ready] = persisted(
    Persist.global("chat-sidebar-panel"),
    createStore({
      sidebarWidth: CHAT_SIDEBAR_PANE_WIDTH_DEFAULT,
      recentLimit: CHAT_SIDEBAR_RECENT_LIMIT_MIN,
      archivedLimit: CHAT_SIDEBAR_ARCHIVED_LIMIT_MIN,
      collapsedGroups: {} as Record<string, boolean>,
      view: "recent" as ChatSidebarViewMode,
      sort: "updated" as ChatSidebarSortMode,
      density: "detailed" as ChatSidebarDensity,
      // Folded SessionGroups default to collapsed; true = expanded. Keyed by
      // group id so a group keeps its state across views.
      expandedClusters: {} as Record<string, boolean>,
    }),
  )

  return {
    ready,
    view: (): ChatSidebarViewMode => (CHAT_SIDEBAR_VIEW_MODES.includes(store.view) ? store.view : "recent"),
    setView: (view: ChatSidebarViewMode) => setStore("view", view),
    sort: (): ChatSidebarSortMode => (CHAT_SIDEBAR_SORT_MODES.includes(store.sort) ? store.sort : "updated"),
    setSort: (sort: ChatSidebarSortMode) => setStore("sort", sort),
    density: (): ChatSidebarDensity => (store.density === "compact" ? "compact" : "detailed"),
    setDensity: (density: ChatSidebarDensity) => setStore("density", density),
    isClusterExpanded: (groupID: string) => store.expandedClusters?.[groupID] === true,
    toggleCluster: (groupID: string) => setStore("expandedClusters", groupID, (prev) => !prev),
    revealCluster: (groupID: string) => setStore("expandedClusters", groupID, true),
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
    // Archived inverts the group default: absent entry means collapsed, so the
    // group stays out of the way until the user opts in (persisted thereafter).
    isArchivedExpanded: () => store.collapsedGroups.archived === true,
    toggleArchived: () => setStore("collapsedGroups", "archived", (prev) => !prev),
    archivedLimit: () => Math.max(CHAT_SIDEBAR_ARCHIVED_LIMIT_MIN, store.archivedLimit),
    showMoreArchived: () =>
      setStore(
        "archivedLimit",
        (value) => Math.max(CHAT_SIDEBAR_ARCHIVED_LIMIT_MIN, value) + CHAT_SIDEBAR_ARCHIVED_LIMIT_STEP,
      ),
    showLessArchived: () =>
      setStore(
        "archivedLimit",
        (value) =>
          Math.max(
            CHAT_SIDEBAR_ARCHIVED_LIMIT_MIN,
            Math.max(CHAT_SIDEBAR_ARCHIVED_LIMIT_MIN, value) - CHAT_SIDEBAR_ARCHIVED_LIMIT_STEP,
          ),
      ),
  }
}

export type ChatSidebarPaneState = ReturnType<typeof createChatSidebarPaneState>
