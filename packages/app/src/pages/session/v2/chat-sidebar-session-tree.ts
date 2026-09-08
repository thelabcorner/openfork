import type { Session } from "@opencode-ai/sdk/v2/client"
import type { SessionGroupEntry } from "@/context/session-groups"

export type ChatSidebarSessionTreeRow = {
  session: Session
  group?: SessionGroupEntry
  first?: boolean
  depth: number
  visibleCount?: number
  /** Shared disclosure key for structural parent→child trees. Several plugin
   * groups may share one coordinator anchor and therefore one disclosure. */
  treeKey?: string
}

/**
 * Project/sidebar lists are intentionally root-session lists. Session groups,
 * however, can contain descendants that the root query will never return.
 * Build the presentation tree by joining the root list to group membership and
 * a cheap session-info cache.
 *
 * Anchored groups are structural relationships:
 * - native subagent groups preserve real `parentID` lineage;
 * - plugin groups use their anchor as the visual parent for root worker chats.
 *
 * Several plugin groups may share one coordinator anchor, so structural groups
 * are merged per anchor for presentation while each member retains its owning
 * group for context-menu/ownership semantics.
 */
export function buildChatSidebarSessionTreeRows(input: {
  roots: Session[]
  groups: SessionGroupEntry[]
  sessionByID: (sessionID: string) => Session | undefined
}): ChatSidebarSessionTreeRow[] {
  const roots = input.roots
  if (roots.length === 0) return []

  const rootByID = new Map(roots.map((session) => [session.id, session] as const))
  const claimedRoots = new Set<string>()
  const result: ChatSidebarSessionTreeRow[] = []
  const orderedGroups = [...input.groups].sort((a, b) => a.position - b.position)

  // Structural lineage wins over cosmetic/manual grouping. A coordinator can
  // own multiple plugin groups, so aggregate by anchor before claiming rows.
  const structuralByAnchor = new Map<string, SessionGroupEntry[]>()
  for (const group of orderedGroups) {
    if (!group.anchorSessionID || (group.kind !== "subagent" && group.kind !== "plugin")) continue
    const bucket = structuralByAnchor.get(group.anchorSessionID)
    if (bucket) bucket.push(group)
    else structuralByAnchor.set(group.anchorSessionID, [group])
  }

  for (const [anchorID, structuralGroups] of structuralByAnchor) {
    const anchor = rootByID.get(anchorID)
    if (!anchor || claimedRoots.has(anchor.id)) continue

    const treeKey = `session-tree:${anchorID}`
    const sessionByID = new Map<string, Session>([[anchor.id, anchor]])
    const ownerBySession = new Map<string, SessionGroupEntry>()
    const orderBySession = new Map<string, number>()

    // Native subagent ownership wins for sessions that participate in both a
    // subagent tree and a plugin group; otherwise stable group position wins.
    const ownershipOrder = [...structuralGroups].sort((a, b) => {
      if (a.kind === "subagent" && b.kind !== "subagent") return -1
      if (b.kind === "subagent" && a.kind !== "subagent") return 1
      return a.position - b.position
    })
    let order = 0
    for (const group of ownershipOrder) {
      for (const member of group.sessions) {
        const session = rootByID.get(member.id) ?? input.sessionByID(member.id)
        if (!session || session.time?.archived != null) continue
        sessionByID.set(session.id, session)
        if (!ownerBySession.has(session.id)) ownerBySession.set(session.id, group)
        if (!orderBySession.has(session.id)) orderBySession.set(session.id, order++)
      }
    }

    const children = new Map<string, Session[]>()
    for (const session of sessionByID.values()) {
      if (session.id === anchor.id) continue
      // Preserve real ancestry when it is available inside this structural
      // cluster. Root plugin members (and partial/corrupt ancestry) hang
      // directly from the coordinator anchor.
      const parentID = session.parentID && sessionByID.has(session.parentID) ? session.parentID : anchor.id
      const bucket = children.get(parentID)
      if (bucket) bucket.push(session)
      else children.set(parentID, [session])
    }
    for (const bucket of children.values()) {
      bucket.sort(
        (a, b) =>
          (orderBySession.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (orderBySession.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      )
    }

    const rows: Array<{ session: Session; depth: number }> = []
    const visited = new Set<string>()
    const visit = (session: Session, depth: number) => {
      if (visited.has(session.id)) return
      visited.add(session.id)
      rows.push({ session, depth })
      for (const child of children.get(session.id) ?? []) visit(child, Math.min(depth + 1, 8))
    }
    visit(anchor, 0)

    const anchorGroup = ownerBySession.get(anchor.id) ?? ownershipOrder[0]
    rows.forEach((row, index) => {
      if (rootByID.has(row.session.id)) claimedRoots.add(row.session.id)
      result.push({
        session: row.session,
        group: index === 0 ? anchorGroup : ownerBySession.get(row.session.id) ?? anchorGroup,
        first: index === 0,
        depth: row.depth,
        visibleCount: index === 0 ? rows.length : undefined,
        treeKey,
      })
    })
  }

  // Unanchored groups remain ordinary visual containers.
  for (const group of orderedGroups) {
    if (group.anchorSessionID && (group.kind === "subagent" || group.kind === "plugin")) continue
    const memberIDs = new Set(group.sessions.map((member) => member.id))
    const members = roots.filter((session) => memberIDs.has(session.id) && !claimedRoots.has(session.id))
    if (members.length === 0) continue
    for (let index = 0; index < members.length; index++) {
      const session = members[index]
      claimedRoots.add(session.id)
      result.push({
        session,
        group,
        first: index === 0,
        depth: 1,
        visibleCount: index === 0 ? members.length : undefined,
      })
    }
  }

  for (const session of roots) {
    if (claimedRoots.has(session.id)) continue
    result.push({ session, depth: 0 })
  }
  return result
}
