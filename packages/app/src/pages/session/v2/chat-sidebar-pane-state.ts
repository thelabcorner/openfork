import { createStore } from "solid-js/store"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { Persist, persisted } from "@/utils/persist"
import { clampSize } from "@/utils/resizable-size"
import { pathKey } from "@/utils/path-key"

export const CHAT_SIDEBAR_PANE_WIDTH_DEFAULT = 280
export const CHAT_SIDEBAR_PANE_WIDTH_MIN = 200
export const CHAT_SIDEBAR_PANE_WIDTH_MAX = 420

export const CHAT_SIDEBAR_RECENT_LIMIT_MIN = 5
const CHAT_SIDEBAR_RECENT_LIMIT_STEP = 5

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
