import type { SessionGroupEntry } from "@/context/session-groups"
import type { TabPreviewGroupSession } from "./titlebar-tab-popover"

export type TabPreviewMembershipIndex = ReadonlyMap<string, readonly SessionGroupEntry[]>

/** Build session -> group membership once per group snapshot. */
export function indexTabPreviewMemberships(groups: readonly SessionGroupEntry[]): TabPreviewMembershipIndex {
  const index = new Map<string, SessionGroupEntry[]>()
  for (const group of groups) {
    for (const sessionID of group.sessionIds) {
      const memberships = index.get(sessionID)
      if (memberships) memberships.push(group)
      else index.set(sessionID, [group])
    }
  }
  return index
}

/**
 * Project a session's group memberships into the compact titlebar navigator.
 *
 * Managed groups are structural relationships, so all managed memberships are
 * merged. This is required for coordinators that intentionally anchor several
 * plugin-owned groups. Manual/user groups stay first-match-only because a
 * session may be filed into several independent collections and combining
 * those folders would imply a hierarchy that does not exist.
 */
export function groupedSessionsForTabPreview(
  groups: readonly SessionGroupEntry[],
  sessionID: string | undefined,
  membershipIndex?: TabPreviewMembershipIndex,
): TabPreviewGroupSession[] | undefined {
  if (!sessionID) return undefined
  const memberships = membershipIndex?.get(sessionID) ?? groups.filter((group) => group.sessionIds.includes(sessionID))
  if (memberships.length === 0) return undefined

  const managed = memberships.filter((group) => group.kind === "subagent" || group.kind === "plugin")
  const source = managed.length > 0 ? managed : memberships.slice(0, 1)
  const bySession = new Map<string, TabPreviewGroupSession>()
  const groupsBySession = new Map<string, Set<string>>()
  const rows: TabPreviewGroupSession[] = []

  for (const group of source) {
    for (const member of group.sessions) {
      const existing = bySession.get(member.id)
      if (existing) {
        if (source.length > 1) {
          const names = groupsBySession.get(member.id) ?? new Set<string>()
          names.add(group.name)
          groupsBySession.set(member.id, names)
          existing.group = [...names].join(" · ")
        }
        continue
      }
      const names = source.length > 1 ? new Set([group.name]) : undefined
      const row: TabPreviewGroupSession = {
        id: member.id,
        title: member.title,
        ...(source.length > 1 ? { group: group.name } : {}),
      }
      if (names) groupsBySession.set(member.id, names)
      bySession.set(member.id, row)
      rows.push(row)
    }
  }

  return rows
}
