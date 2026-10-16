import type { Session } from "@opencode-ai/sdk/v2/client"
import { mergeChatSidebarRecent, sortChatSidebarSessions, type ChatSidebarSortMode } from "./chat-sidebar-tree"

/**
 * Pane-lifetime source reuse. Recent and Status are mutually exclusive views
 * over the SAME sorted root+group roster, not separate data owners. Preserve
 * their source identity across tab/view switches, but release it when Projects
 * is selected or the pane/server is disposed.
 *
 * A structural root/member revision or sort-policy change rebuilds exactly
 * one source. Status events don't affect this cache (the server owns status).
 */
export function createChatSidebarSourceCache() {
  let merged: {
    roots: readonly Session[]
    members: readonly Session[]
    result: readonly Session[]
  } | undefined
  let sorted: {
    source: readonly Session[]
    sort: ChatSidebarSortMode
    titleOf: (session: Session) => string
    result: readonly Session[]
  } | undefined

  return {
    merge(roots: readonly Session[], members: readonly Session[]) {
      if (merged?.roots === roots && merged.members === members) return merged.result
      const result = mergeChatSidebarRecent(roots, members)
      merged = { roots, members, result }
      sorted = undefined
      return result
    },
    sort(source: readonly Session[], sort: ChatSidebarSortMode, titleOf: (session: Session) => string) {
      if (sorted?.source === source && sorted.sort === sort && sorted.titleOf === titleOf) return sorted.result
      const result = sort === "updated" ? source : sortChatSidebarSessions(source, sort, titleOf)
      sorted = { source, sort, titleOf, result }
      return result
    },
    clearSorted() { sorted = undefined },
    clear() {
      sorted = undefined
      merged = undefined
    },
  }
}