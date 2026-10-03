import type { Session, SessionGroupMember } from "@opencode-ai/sdk/v2/client"
import { sessionGroupMemberSession, type SessionGroupEntry } from "@/context/session-groups"

/** Known producer-owned special-agent kinds, per `SpecialAgentSession.Kind` in
 * core. Unknown future strings still classify as a special agent (generic
 * label) — this list only selects a nicer localized label. */
export const KNOWN_SPECIAL_AGENT_KINDS = [
  "goal_auditor",
  "goal_revisor",
  "prompt_revisor",
  "session_title",
  "spad_auditor",
] as const

export interface SessionPreviewRow {
  id: string
  title: string
  /** Owning-group label. Only set when a section merges several managed
   * groups sharing one anchor (for example a coordinator anchoring several
   * plugin groups). */
  group?: string
  parentID?: string
  /** Last activity from the group-member projection; epoch ms. */
  updated?: number
  /** Ephemeral structural session carried by the group-detail projection.
   * Used for context menus and project attribution without a per-row fetch;
   * never inserted into the shared session cache. */
  session?: Session
  /** Producer-owned special-agent kind, when this row is classified as one. */
  specialAgent?: string
  locked: boolean
  origin: SessionGroupMember["origin"]
}

export interface SessionPreviewTreeRow {
  row: SessionPreviewRow
  depth: number
  /** Last child of its parent; draws an elbow instead of a through-line. */
  last: boolean
}

export type SessionPreviewSectionKind = "subagent" | "delegation" | "plugin" | "manual" | "swarm"

export interface SessionPreviewSection {
  kind: SessionPreviewSectionKind
  name: string
  rows: SessionPreviewTreeRow[]
}

export interface SessionPreviewSpecialAgentRow {
  row: SessionPreviewRow
  /** Title of the structural ancestor whose anchored group this agent lives
   * in — lets the card show which nested worker owns it. */
  parentTitle?: string
}

export interface SessionPreviewRelationships {
  sections: SessionPreviewSection[]
  specialAgents: SessionPreviewSpecialAgentRow[]
}

export interface SessionPreviewIndex {
  /** sessionID -> every group it is a direct member of. */
  membership: ReadonlyMap<string, readonly SessionGroupEntry[]>
  /** anchorSessionID -> the subagent/plugin groups anchored there. Powers
   * nested traversal: an ordinary subagent can itself anchor another group. */
  anchoredBy: ReadonlyMap<string, readonly SessionGroupEntry[]>
}

const STRUCTURAL_ANCHOR_KINDS = new Set(["subagent", "plugin"])

/** Build both indexes once per SessionGroup snapshot. O(groups + members). */
export function buildSessionPreviewIndex(groups: readonly SessionGroupEntry[]): SessionPreviewIndex {
  const membership = new Map<string, SessionGroupEntry[]>()
  const anchoredBy = new Map<string, SessionGroupEntry[]>()
  for (const group of groups) {
    for (const sessionID of group.sessionIds) {
      const list = membership.get(sessionID)
      if (list) list.push(group)
      else membership.set(sessionID, [group])
    }
    if (group.anchorSessionID && STRUCTURAL_ANCHOR_KINDS.has(group.kind)) {
      const list = anchoredBy.get(group.anchorSessionID)
      if (list) list.push(group)
      else anchoredBy.set(group.anchorSessionID, [group])
    }
  }
  return { membership, anchoredBy }
}

/** Project one group-detail member into the preview row shape. O(1). */
export function sessionPreviewRow(member: SessionGroupMember, group?: string): SessionPreviewRow {
  const session = sessionGroupMemberSession(member)
  const updated = member.time?.updated ?? member.time?.created
  return {
    id: member.id,
    title: member.title,
    ...(group ? { group } : {}),
    ...(member.parentID ? { parentID: member.parentID } : {}),
    ...(updated ? { updated } : {}),
    ...(session ? { session } : {}),
    ...(member.specialAgent ? { specialAgent: member.specialAgent } : {}),
    locked: member.locked,
    origin: member.origin,
  }
}

function notArchived(member: SessionGroupMember) {
  return member.time?.archived == null
}

/**
 * Order rows as a parent -> children tree using each row's parentID. A parent
 * outside the row set makes the row a local root. Siblings keep their source
 * order; depth is capped so deep delegation chains stay readable. Single O(n)
 * pass over the row list, computed once per open preview.
 */
export function sessionPreviewTree(rows: readonly SessionPreviewRow[], maxDepth = 3): SessionPreviewTreeRow[] {
  const ids = new Set(rows.map((row) => row.id))
  const children = new Map<string | undefined, SessionPreviewRow[]>()
  for (const row of rows) {
    const parent = row.parentID && row.parentID !== row.id && ids.has(row.parentID) ? row.parentID : undefined
    const list = children.get(parent)
    if (list) list.push(row)
    else children.set(parent, [row])
  }

  const result: SessionPreviewTreeRow[] = []
  const visited = new Set<string>()
  const walk = (parent: string | undefined, depth: number) => {
    const list = children.get(parent) ?? []
    list.forEach((row, index) => {
      if (visited.has(row.id)) return
      visited.add(row.id)
      result.push({ row, depth: Math.min(depth, maxDepth), last: index === list.length - 1 })
      walk(row.id, depth + 1)
    })
  }
  walk(undefined, 0)
  // Parent cycles have no root; keep those rows reachable, flat.
  for (const row of rows) {
    if (visited.has(row.id)) continue
    visited.add(row.id)
    result.push({ row, depth: 0, last: true })
  }
  return result
}

/**
 * Merge one or more anchored groups of the same structural kind sharing one
 * anchor into a single tree section. Mirrors the previous titlebar merge rule
 * for coordinators that anchor several plugin groups.
 */
function buildStructuralSection(kind: "subagent" | "plugin", groups: readonly SessionGroupEntry[]): SessionPreviewSection {
  const merged = groups.length > 1
  const bySession = new Map<string, SessionPreviewRow>()
  const namesBySession = new Map<string, Set<string>>()
  const rows: SessionPreviewRow[] = []
  for (const group of groups) {
    for (const member of group.sessions) {
      if (!notArchived(member)) continue
      const existing = bySession.get(member.id)
      if (existing) {
        if (merged) {
          const names = namesBySession.get(member.id) ?? new Set<string>()
          names.add(group.name)
          namesBySession.set(member.id, names)
          existing.group = [...names].join(" · ")
        }
        continue
      }
      const row = sessionPreviewRow(member, merged ? group.name : undefined)
      if (merged) namesBySession.set(member.id, new Set([group.name]))
      bySession.set(member.id, row)
      rows.push(row)
    }
  }
  return {
    kind,
    name: groups.map((group) => group.name).join(" · "),
    rows: sessionPreviewTree(rows),
  }
}

/** Flat (non-structural) section: delegation batches, manual folders, Swarms. */
function buildFlatSection(kind: SessionPreviewSectionKind, group: SessionGroupEntry): SessionPreviewSection {
  return {
    kind,
    name: group.name,
    rows: group.sessions
      .filter(notArchived)
      .map((member) => ({ row: sessionPreviewRow(member), depth: 0, last: true })),
  }
}

function classifySpecialAgent(member: SessionGroupMember): { kind?: string } | undefined {
  if (member.specialAgent) return { kind: member.specialAgent }
  if (member.origin === "goal_auditor") return { kind: "goal_auditor" }
  // Old servers only carry the generic membership origin; still surface it as
  // a special agent (unknown kind) rather than letting it masquerade as an
  // ordinary worker.
  if (member.origin === "special_agent") return {}
  return undefined
}

/**
 * Walk the reachable structural graph from `sessionID` — including groups
 * anchored by its own subagents/plugin workers, recursively — collecting
 * every member classified as a special agent. Bounded and cycle-safe: no
 * group is visited twice, and both depth and total visited members are
 * capped. Entirely derived from the already-loaded SessionGroup snapshot; no
 * network calls.
 */
function collectSpecialAgents(input: {
  sessionID: string
  index: SessionPreviewIndex
  maxDepth: number
  maxNodes: number
}): SessionPreviewSpecialAgentRow[] {
  const { index, maxDepth, maxNodes } = input
  const visitedAnchors = new Set<string>([input.sessionID])
  const visitedGroups = new Set<string>()
  const seen = new Set<string>()
  const result: SessionPreviewSpecialAgentRow[] = []
  let frontier: Array<{ id: string; depth: number }> = [{ id: input.sessionID, depth: 0 }]
  let visitedNodes = 0

  while (frontier.length > 0 && visitedNodes < maxNodes) {
    const next: typeof frontier = []
    for (const { id, depth } of frontier) {
      if (depth >= maxDepth) continue
      for (const group of index.anchoredBy.get(id) ?? []) {
        if (visitedGroups.has(group.id)) continue
        visitedGroups.add(group.id)
        const anchorTitle = group.sessions.find((member) => member.id === id)?.title
        for (const member of group.sessions) {
          if (!notArchived(member)) continue
          visitedNodes += 1
          if (visitedNodes > maxNodes) break
          const classification = classifySpecialAgent(member)
          if (classification && !seen.has(member.id)) {
            seen.add(member.id)
            result.push({
              row: { ...sessionPreviewRow(member), specialAgent: classification.kind },
              parentTitle: anchorTitle,
            })
          }
          if (member.id !== id && !visitedAnchors.has(member.id)) {
            visitedAnchors.add(member.id)
            next.push({ id: member.id, depth: depth + 1 })
          }
        }
      }
    }
    frontier = next
  }
  return result
}

/**
 * Classify one Session's SessionGroup memberships into the canonical preview
 * relationship sections, plus a flat, deduped Special Agents list gathered by
 * walking the whole reachable structural graph. Everything here reads only
 * the already-loaded SessionGroup[] snapshot — zero network calls.
 *
 * - Ordinary subagent/plugin memberships render as structural trees (real
 *   parentID lineage), merged only when multiple groups of the same kind
 *   share one anchor.
 * - Unanchored delegation batches never get a manufactured hierarchy.
 * - Manual (user) groups never merge across different groups.
 * - Native Swarms render one section per Swarm; a Session may legitimately
 *   appear in several.
 * - Any member classified as a special agent (known kind, unknown future
 *   kind, or legacy origin-only fallback) is excluded from its ordinary
 *   section and surfaced once in `specialAgents` instead.
 */
export function sessionPreviewRelationships(input: {
  sessionID: string
  groups: readonly SessionGroupEntry[]
  index?: SessionPreviewIndex
  maxDepth?: number
  maxNodes?: number
}): SessionPreviewRelationships {
  const { sessionID } = input
  const index = input.index ?? buildSessionPreviewIndex(input.groups)
  const maxDepth = input.maxDepth ?? 4
  const maxNodes = input.maxNodes ?? 200
  const direct = index.membership.get(sessionID) ?? []
  const specialAgents = collectSpecialAgents({ sessionID, index, maxDepth, maxNodes })
  const specialAgentIDs = new Set(specialAgents.map((entry) => entry.row.id))

  const withoutSpecialAgents = (group: SessionGroupEntry): SessionGroupEntry =>
    group.sessions.some((member) => specialAgentIDs.has(member.id))
      ? { ...group, sessions: group.sessions.filter((member) => !specialAgentIDs.has(member.id)) }
      : group

  const sections: SessionPreviewSection[] = []

  const byAnchor = (kind: "subagent" | "plugin") => {
    const grouped = new Map<string, SessionGroupEntry[]>()
    for (const group of direct) {
      if (group.kind !== kind) continue
      const anchor = group.anchorSessionID ?? sessionID
      const list = grouped.get(anchor)
      if (list) list.push(withoutSpecialAgents(group))
      else grouped.set(anchor, [withoutSpecialAgents(group)])
    }
    for (const groupsForAnchor of grouped.values()) sections.push(buildStructuralSection(kind, groupsForAnchor))
  }
  byAnchor("subagent")
  byAnchor("plugin")

  for (const group of direct) if (group.kind === "delegation") sections.push(buildFlatSection("delegation", withoutSpecialAgents(group)))
  for (const group of direct) if (group.kind === "user") sections.push(buildFlatSection("manual", withoutSpecialAgents(group)))
  for (const group of direct) if (group.kind === "swarm") sections.push(buildFlatSection("swarm", withoutSpecialAgents(group)))

  return {
    sections: sections.filter((section) => section.rows.length > 0),
    specialAgents,
  }
}

/** Preview a raw group (no anchor Session) — used by group tabs, which
 * describe a SessionGroup directly rather than one Session's memberships. */
export function sessionPreviewGroupOnly(group: SessionGroupEntry): SessionPreviewSection {
  const kind: SessionPreviewSectionKind =
    group.kind === "plugin" || group.kind === "subagent" || group.kind === "swarm" ? group.kind : "manual"
  return {
    kind,
    name: group.name,
    rows: sessionPreviewTree(group.sessions.filter(notArchived).map((member) => sessionPreviewRow(member))),
  }
}
