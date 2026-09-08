export type PersistentSessionGroupProjection<T> = {
  id: string
  title: string
  kind: "user" | "subagent" | "plugin"
  sessions: T[]
}

/**
 * Project a global/cross-project group definition onto the sessions visible in
 * the current Home scope. A project filter is therefore an intersection over
 * membership, not an ownership lookup: the same group can span projects while
 * an irrelevant project never gets an empty group shell.
 */
export function projectPersistentSessionGroups<T extends { session: { id: string } }>(
  records: T[],
  groups: Array<{
    id: string
    name: string
    kind: "user" | "subagent" | "plugin"
    sessionIds: string[]
  }>,
) {
  const sessionByID = new Map(records.map((record) => [record.session.id, record] as const))
  const groupedSessionIDs = new Set<string>()
  const projected: PersistentSessionGroupProjection<T>[] = []

  for (const group of groups) {
    const sessions = group.sessionIds
      .map((sessionID) => sessionByID.get(sessionID))
      .filter((record): record is T => record !== undefined)
    if (sessions.length === 0) continue
    for (const record of sessions) groupedSessionIDs.add(record.session.id)
    projected.push({ id: group.id, title: group.name, kind: group.kind, sessions })
  }

  return { groups: projected, groupedSessionIDs }
}
