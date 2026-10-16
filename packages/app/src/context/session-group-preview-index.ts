import type { SessionGroupEntry } from "./session-groups"
import type { ServerConnection } from "./server"

/** SessionGroupsProvider currently owns only the selected server's group
 * snapshot. Never reuse that group graph for a tab on a different server:
 * session/group identifiers are not globally unique across connections.
 */
export function previewGroupScopeMatches(
  tabServer: ServerConnection.Key | undefined,
  selectedServer: ServerConnection.Key,
) {
  return !tabServer || tabServer === selectedServer
}

/** Structural navigation index, scoped to one reactive group-detail snapshot.
 * Shared by tab hover and Chat Sidebar hover rather than rebuilding the same
 * O(groups + members) maps for every preview instance or hovered row.
 */
export interface SessionPreviewIndex {
  /** sessionID -> every group it directly belongs to (source order retained). */
  membership: ReadonlyMap<string, readonly SessionGroupEntry[]>
  /** anchorSessionID -> structural groups anchored to that session. */
  anchoredBy: ReadonlyMap<string, readonly SessionGroupEntry[]>
}

export function buildSessionPreviewIndex(groups: readonly SessionGroupEntry[]): SessionPreviewIndex {
  const membership = new Map<string, SessionGroupEntry[]>()
  const anchoredBy = new Map<string, SessionGroupEntry[]>()
  for (const group of groups) {
    for (const id of group.sessionIds) {
      const existing = membership.get(id)
      if (existing) existing.push(group)
      else membership.set(id, [group])
    }
    if (group.anchorSessionID && (group.kind === "subagent" || group.kind === "plugin")) {
      const existing = anchoredBy.get(group.anchorSessionID)
      if (existing) existing.push(group)
      else anchoredBy.set(group.anchorSessionID, [group])
    }
  }
  return { membership, anchoredBy }
}

/**
 * Identity-keyed, weak snapshot cache. It is deliberately NOT a permanent
 * reactive memo: when no inspector is mounted, group changes must not wake an
 * otherwise idle O(members) index derivation. Weak keys also avoid retaining
 * old group-detail arrays (and all their members) after their last consumer
 * releases them. Reading get(groups()) from an active Solid computation still
 * tracks the provider's list() normally.
 */
export function createSessionPreviewIndexCache() {
  const indexes = new WeakMap<readonly SessionGroupEntry[], SessionPreviewIndex>()
  return {
    get(groups: readonly SessionGroupEntry[]): SessionPreviewIndex {
      const cached = indexes.get(groups)
      if (cached) return cached
      const index = buildSessionPreviewIndex(groups)
      indexes.set(groups, index)
      return index
    },
  }
}