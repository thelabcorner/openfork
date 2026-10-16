/**
 * A compact group roster is global to the selected server, but a sidebar pane
 * is scoped to its currently opened project/root index. Do not project the
 * server's OTHER project members as Recent rows or warm their telemetry.
 *
 * Keep the same anchoring rules used by the existing visibleMemberGroups
 * selector: regular groups need a visible member; structural subagents and
 * plugin groups can also be linked by an explicit visible root anchor.
 */
export function visibleChatSidebarGroups<
  T extends {
    kind: string
    anchorSessionID?: string
    sessions: readonly { id: string }[]
  },
>(roots: ReadonlySet<string>, groups: readonly T[]): T[] {
  const visible: T[] = []
  for (const group of groups) {
    if ((group.kind === "subagent" || group.kind === "plugin") &&
      group.anchorSessionID && roots.has(group.anchorSessionID)) {
      visible.push(group)
      continue
    }
    if (group.kind === "subagent") continue
    for (const member of group.sessions) {
      if (!roots.has(member.id)) continue
      visible.push(group)
      break
    }
  }
  return visible
}