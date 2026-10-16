import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  CHAT_SIDEBAR_STATUS_BUCKETS,
  chatSidebarStatusBucket,
  clusterChatSidebarRowsWindow,
  type ChatSidebarClusterGroup,
  type ChatSidebarClusterScope,
  type ChatSidebarItem,
  type ChatSidebarRowState,
  type ChatSidebarSection,
  type ChatSidebarStatusBucket,
} from "./chat-sidebar-tree"
import { compareChatSidebarSessionTime } from "./chat-sidebar-session-merge"
import { indexChatSidebarSparseSource } from "./chat-sidebar-status-sparse"

type Group = { group: ChatSidebarClusterGroup; members: Session[] }
export type GroupedStatusSource = {
  rows: readonly Session[]
  byID: ReadonlyMap<string, Session>
  byGroup: ReadonlyMap<string, Group>
  groupBySession: ReadonlyMap<string, string>
  savedItems: number
}

/** Index structural group membership when the canonical sorted roster changes,
 * not on every live status event. An inconsistent legacy index uses the exact
 * pre-existing full builder. */
export function indexChatSidebarGroupedStatusSource(
  rows: readonly Session[],
  groupOf: (session: Session) => ChatSidebarClusterGroup | undefined,
  compare: (a: Session, b: Session) => number = compareChatSidebarSessionTime,
  sortedByTrustedComparator = false,
): GroupedStatusSource | undefined {
  const source = indexChatSidebarSparseSource(rows, compare, sortedByTrustedComparator)
  if (!source) return undefined
  const byGroup = new Map<string, Group>()
  const groupBySession = new Map<string, string>()
  for (const row of rows) {
    const group = groupOf(row)
    if (!group) continue
    groupBySession.set(row.id, group.id)
    const existing = byGroup.get(group.id)
    if (existing) {
      // A group ID's metadata must be stable across its rows. If a concurrent
      // roster edit has mixed identities, reuse the original full projection
      // rather than picking the metadata of an unrelated bucket's first row.
      if (existing.group.name !== group.name || existing.group.kind !== group.kind) return undefined
      existing.members.push(row)
    }
    else byGroup.set(group.id, { group, members: [row] })
  }
  let savedItems = 0
  for (const group of byGroup.values()) savedItems += group.members.length - 1
  return { ...source, byGroup, groupBySession, savedItems }
}

const countSessions = (items: readonly ChatSidebarItem[]) =>
  items.reduce((total, item) => total + (item.type === "cluster" ? item.members.length : 1), 0)

/** The group roster's other ordering is deliberately delegated to the same
 * cluster builder as the general path. Only the candidate rows and idle
 * bookkeeping change; display semantics and labels remain unchanged. */
export function buildChatSidebarGroupedSparseStatusSections(input: {
  source: GroupedStatusSource
  states: ReadonlyMap<string, ChatSidebarRowState>
  limit: number
  pin: (rows: Session[]) => Session[]
  compare?: (a: Session, b: Session) => number
  titleOf: (session: Session) => string
  groupMembersOf?: (group: ChatSidebarClusterGroup, scope: ChatSidebarClusterScope) => readonly Session[]
}): ChatSidebarSection[] {
  const { source, states } = input
  const compare = input.compare ?? compareChatSidebarSessionTime
  const buckets = new Map<ChatSidebarStatusBucket, Session[]>()
  const removedByGroup = new Map<string, number>()
  let nonIdleCount = 0
  for (const [id, state] of states) {
    if (state === "idle") continue
    const session = source.byID.get(id)
    if (!session) continue
    const bucket = chatSidebarStatusBucket(state)
    const target = buckets.get(bucket)
    if (target) target.push(session)
    else buckets.set(bucket, [session])
    nonIdleCount++
    const group = source.groupBySession.get(id)
    if (group) removedByGroup.set(group, (removedByGroup.get(group) ?? 0) + 1)
  }

  let returnedItems = source.rows.length - nonIdleCount - source.savedItems
  for (const [id, removed] of removedByGroup) {
    const size = source.byGroup.get(id)!.members.length
    returnedItems += Math.min(removed, size - 1)
  }
  const clusterInput = {
    cluster: true,
    titleOf: input.titleOf,
    groupOf: (session: Session) => {
      const id = source.groupBySession.get(session.id)
      return id ? source.byGroup.get(id)?.group : undefined
    },
    groupMembersOf: input.groupMembersOf,
  }
  const sections: ChatSidebarSection[] = []
  for (const bucket of CHAT_SIDEBAR_STATUS_BUCKETS) {
    const scope: ChatSidebarClusterScope = { kind: "status", status: bucket }
    if (bucket !== "idle") {
      const rows = buckets.get(bucket)
      if (!rows?.length) continue
      const ordered = input.pin(rows.sort(compare))
      const { items } = clusterChatSidebarRowsWindow(ordered, clusterInput, `status:${bucket}`, scope)
      sections.push({
        key: `status:${bucket}`, kind: "status", status: bucket,
        total: rows.length, items, hiddenItems: 0, sessionCount: countSessions(items),
      })
      continue
    }

    const total = source.rows.length - nonIdleCount
    if (total === 0) continue
    const cap = Math.max(0, Number.isNaN(input.limit) ? 0 : Math.trunc(input.limit))
    const chosen = new Map<string, Session>()
    const visited = new Set<string>()
    let topLevel = 0
    for (const row of source.rows) {
      if (topLevel >= cap) break
      if (states.get(row.id) && states.get(row.id) !== "idle") continue
      const groupID = source.groupBySession.get(row.id)
      if (!groupID) {
        chosen.set(row.id, row)
        topLevel++
        continue
      }
      if (visited.has(groupID)) continue
      visited.add(groupID)
      for (const member of source.byGroup.get(groupID)!.members) {
        if (states.get(member.id) && states.get(member.id) !== "idle") continue
        chosen.set(member.id, member)
      }
      topLevel++
    }
    const ordered = [...chosen.values()].sort(compare)
    const { items } = clusterChatSidebarRowsWindow(ordered, clusterInput, "status:idle", scope)
    sections.push({
      key: "status:idle", kind: "status", status: "idle",
      total, items, sessionCount: countSessions(items),
      hiddenItems: Math.max(0, returnedItems - items.length),
    })
  }
  return sections
}