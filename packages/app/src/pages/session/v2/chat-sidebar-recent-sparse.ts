import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  clusterChatSidebarRowsWindow,
  type ChatSidebarClusterGroup,
  type ChatSidebarSection,
} from "./chat-sidebar-tree"
import type { GroupedStatusSource } from "./chat-sidebar-status-grouped"
import { compareChatSidebarSessionTime } from "./chat-sidebar-session-merge"

/**
 * Updated-time Recent projection: choose the first LIMIT *top-level* items
 * without materializing and grouping every hidden history row. The canonical
 * sorted membership index is owned by the server/root projection and reused
 * across status transitions. Pinned working rows remain in arrival order.
 *
 * Only call with the pane's exact working-first pin function; the unbounded
 * full-tree builder handles custom sort modes and inconsistent indexes.
 */
export function buildChatSidebarSparseRecentSection(input: {
  source: GroupedStatusSource
  working: ReadonlySet<string>
  limit: number
  pinWorking: (rows: Session[]) => Session[]
  compare?: (a: Session, b: Session) => number
  titleOf: (session: Session) => string
  groupMembersOf?: (group: ChatSidebarClusterGroup) => readonly Session[]
}): ChatSidebarSection | undefined {
  const { source } = input
  const compare = input.compare ?? compareChatSidebarSessionTime
  if (source.rows.length === 0) return undefined
  const cap = Math.max(0, Number.isNaN(input.limit) ? 0 : Math.trunc(input.limit))
  const busy: Session[] = []
  for (const id of input.working) {
    const session = source.byID.get(id)
    if (session) busy.push(session)
  }
  const pinned = input.pinWorking(busy.sort(compare))
  // Pin only rearranges the working set. If a custom integration inserts,
  // removes or duplicates sessions, choose the general Recent projection.
  if (pinned.length !== busy.length) return undefined
  const rank = new Map<string, number>()
  for (let i = 0; i < pinned.length; i++) {
    const session = pinned[i]!
    if (!source.byID.has(session.id) || !input.working.has(session.id) || rank.has(session.id)) return undefined
    rank.set(session.id, i)
  }

  const chosen = new Map<string, Session>()
  const encountered = new Set<string>()
  let topLevel = 0
  const visit = (session: Session) => {
    const groupID = source.groupBySession.get(session.id)
    if (groupID) {
      if (encountered.has(groupID)) return
      encountered.add(groupID)
      for (const member of source.byGroup.get(groupID)!.members) chosen.set(member.id, member)
    } else chosen.set(session.id, session)
    topLevel++
  }
  for (const session of pinned) {
    if (topLevel >= cap) break
    visit(session)
  }
  for (const session of source.rows) {
    if (topLevel >= cap) break
    if (rank.has(session.id)) continue
    visit(session)
  }

  const ordered = [...chosen.values()].sort((left, right) => {
    const a = rank.get(left.id)
    const b = rank.get(right.id)
    if (a !== undefined && b !== undefined) return a - b
    if (a !== undefined) return -1
    if (b !== undefined) return 1
    return compare(left, right)
  })
  const projection = clusterChatSidebarRowsWindow(
    ordered,
    {
      cluster: true,
      titleOf: input.titleOf,
      groupOf: (session) => {
        const id = source.groupBySession.get(session.id)
        return id ? source.byGroup.get(id)?.group : undefined
      },
      groupMembersOf: input.groupMembersOf
        ? (group) => input.groupMembersOf!(group)
        : undefined,
    },
    "recent",
    { kind: "recent" },
  )
  const items = projection.items
  const totalItems = source.rows.length - source.savedItems
  return {
    key: "recent", kind: "recent", total: source.rows.length,
    items,
    sessionCount: items.reduce((sum, item) => sum + (item.type === "cluster" ? item.members.length : 1), 0),
    hiddenItems: Math.max(0, totalItems - items.length),
  }
}