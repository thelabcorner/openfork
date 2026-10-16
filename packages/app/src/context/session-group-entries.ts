import type { SessionGroupDetail, SessionGroupInfo } from "@opencode-ai/sdk/v2/client"
import type { SessionGroupEntry } from "./session-groups"

/** Authoritative group metadata + compact membership projection, shared by
 * selected-server navigation and on-demand previews of inactive servers.
 */
export function projectSessionGroupEntries(
  groups: readonly SessionGroupInfo[],
  details: Readonly<Record<string, SessionGroupDetail | undefined>>,
): SessionGroupEntry[] {
  return groups.map((group) => {
    const detail = details[group.id]
    return {
      id: group.id,
      name: group.name,
      sessionIds: detail?.sessions?.map((member) => member.id) ?? [],
      position: typeof group.position === "number" ? group.position : 0,
      kind: group.kind,
      ownerPlugin: group.ownerPlugin,
      ownerRef: group.ownerRef,
      anchorSessionID: group.anchorSessionID,
      sessions: detail?.sessions ?? [],
      time: group.time,
    }
  })
}

/** The legacy per-group API may fail for a subset of requested groups.
 * Commit successful responses once per batch without discarding already
 * cached details for individual groups that were temporarily unavailable.
 */
export function mergeSessionGroupDetails(
  previous: Readonly<Record<string, SessionGroupDetail>>,
  fetched: readonly SessionGroupDetail[],
  retainedIDs?: ReadonlySet<string>,
): Record<string, SessionGroupDetail> {
  if (!fetched.length && !retainedIDs) return previous as Record<string, SessionGroupDetail>
  const merged: Record<string, SessionGroupDetail> = {}
  for (const [id, detail] of Object.entries(previous)) {
    if (!retainedIDs || retainedIDs.has(id)) merged[id] = detail
  }
  for (const detail of fetched) {
    if (!retainedIDs || retainedIDs.has(detail.group.id)) merged[detail.group.id] = detail
  }
  return merged
}