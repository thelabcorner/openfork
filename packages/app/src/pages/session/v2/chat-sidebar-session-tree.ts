import type { Session } from "@opencode-ai/sdk/v2/client"
import { sessionGroupMemberSession, type SessionGroupEntry } from "@/context/session-groups"

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
 * - generic plugin groups may use their anchor as the visual parent.
 *
 * Native Swarms are intentionally different: one Session may belong to several
 * Swarms, so every virtual `kind="swarm"` group is rendered as its own
 * collection and membership is never collapsed by Session identity. The same
 * ordinary Session row/chat surface is reused beneath each Swarm collection.
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

  // Native Swarm groups are first-party many-to-many navigation projections,
  // not plugin-style structural lineage. Render one collection per Swarm and
  // deliberately allow a Session to appear in more than one Swarm collection.
  // Only groups intersecting this root slice are emitted, which prevents a
  // project/Recent slice from painting unrelated Swarms.
  const swarmClaimedRoots = new Set<string>()
  for (const group of orderedGroups) {
    if (group.kind !== "swarm") continue
    if (!group.sessions.some((member) => rootByID.has(member.id))) continue
    const members: Session[] = []
    const seen = new Set<string>()
    for (const member of [...group.sessions].sort((a, b) => {
      const left = typeof a.position === "number" && Number.isFinite(a.position) ? a.position : Number.MAX_SAFE_INTEGER
      const right = typeof b.position === "number" && Number.isFinite(b.position) ? b.position : Number.MAX_SAFE_INTEGER
      return left - right
    })) {
      const session = rootByID.get(member.id) ?? input.sessionByID(member.id) ?? sessionGroupMemberSession(member)
      if (!session || session.time?.archived != null || seen.has(session.id)) continue
      seen.add(session.id)
      members.push(session)
      if (rootByID.has(session.id)) swarmClaimedRoots.add(session.id)
    }
    members.forEach((session, index) => {
      result.push({
        session,
        group,
        first: index === 0,
        depth: 1,
        visibleCount: index === 0 ? members.length : undefined,
      })
    })
  }

  // Structural lineage wins over cosmetic/manual grouping. A coordinator can
  // own multiple generic plugin groups, so aggregate those by anchor before
  // claiming rows. Native Swarms never enter this merge.
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
        const session = rootByID.get(member.id) ?? input.sessionByID(member.id) ?? sessionGroupMemberSession(member)
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

  // Suppress a third standalone/manual copy of roots already represented by a
  // native Swarm, while preserving deliberate duplicates across Swarms and any
  // independent structural lineage rendered above.
  for (const sessionID of swarmClaimedRoots) claimedRoots.add(sessionID)

  // Unanchored groups remain ordinary visual containers. Index the first
  // owning group once, then walk the root list once to preserve root ordering.
  // The previous implementation filtered the entire root array for every
  // group, turning large sidebars into O(groups * roots) work on each memo
  // recomputation.
  const ordinaryOwner = new Map<string, SessionGroupEntry>()
  for (const group of orderedGroups) {
    if (group.kind === "swarm") continue
    if (group.anchorSessionID && (group.kind === "subagent" || group.kind === "plugin")) continue
    for (const member of group.sessions) {
      if (!ordinaryOwner.has(member.id)) ordinaryOwner.set(member.id, group)
    }
  }
  const ordinaryMembers = new Map<SessionGroupEntry, Session[]>()
  for (const session of roots) {
    if (claimedRoots.has(session.id)) continue
    const group = ordinaryOwner.get(session.id)
    if (!group) continue
    const bucket = ordinaryMembers.get(group)
    if (bucket) bucket.push(session)
    else ordinaryMembers.set(group, [session])
  }
  for (const group of orderedGroups) {
    const members = ordinaryMembers.get(group)
    if (!members) continue
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
