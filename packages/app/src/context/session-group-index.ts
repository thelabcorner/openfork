import type { SessionGroupEntry } from "./session-groups"

/** One cheap lookup projection for every group tab and group-preview consumer.
 * Keep the first duplicate ID, matching the former `list().find()` contract. */
export function indexSessionGroupsByID<T extends Pick<SessionGroupEntry, "id">>(groups: readonly T[]) {
  const byID = new Map<string, T>()
  for (const group of groups) {
    if (!byID.has(group.id)) byID.set(group.id, group)
  }
  return byID
}