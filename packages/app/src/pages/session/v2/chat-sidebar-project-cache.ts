import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  buildChatSidebarSections,
  type ChatSidebarClusterGroup,
  type ChatSidebarClusterScope,
  type ChatSidebarSection,
  type ChatSidebarSortMode,
} from "./chat-sidebar-tree"
import { sameChatSidebarIDSet } from "./chat-sidebar-scope-equality"

type Project = {
  key: string
  total: number
  sessions: Session[]
  project?: { id?: string }
}
const noMembers: readonly Session[] = []

/**
 * An unchanged group ID/name/member SET is not enough for section reuse:
 * SessionGroup's authoritative roster may reorder its members, and an
 * expanded cluster displays that roster order. Include each scoped group's
 * ordered roster and projected title/timestamp while limiting invalidation
 * to projects that actually reference that group.
 */
export function chatSidebarProjectGroupRevisions(
  projects: ReadonlyMap<string, { sessions: readonly Session[] }>,
  supplemental: ReadonlyMap<string, readonly Session[]>,
  groupBySession: ReadonlyMap<string, ChatSidebarClusterGroup>,
  byGroup: ReadonlyMap<string, readonly Session[]>,
): ReadonlyMap<string, string> {
  const rosterVersions = new Map<string, string>()
  const revisions = new Map<string, string>()
  for (const [key, project] of projects) {
    const linked: Array<[string, string, string, string]> = []
    const groupIDs = new Set<string>()
    const seen = new Set<string>()
    for (const source of [project.sessions, supplemental.get(key) ?? noMembers]) {
      for (const session of source) {
        if (seen.has(session.id)) continue
        seen.add(session.id)
        const group = groupBySession.get(session.id)
        if (!group) continue
        linked.push([session.id, group.id, group.kind, group.name])
        groupIDs.add(group.id)
      }
    }
    const rosters = [...groupIDs].sort().map((groupID) => {
      let version = rosterVersions.get(groupID)
      if (version === undefined) {
        version = JSON.stringify((byGroup.get(groupID) ?? noMembers).map((member) => [
          member.id, member.title, member.time?.updated, member.time?.archived,
        ]))
        rosterVersions.set(groupID, version)
      }
      return [groupID, version]
    })
    revisions.set(key, JSON.stringify([linked, rosters]))
  }
  return revisions
}

/**
 * Fast equivalent of the per-project group revision signatures above.
 * Root membership is indexed ONCE when project roots change; a group-only
 * mutation then visits the sparse groupBySession Map (not all 10k idle roots)
 * plus the compact supplemental group roster. Sorting identity tuples makes
 * the signature invariant to irrelevant global Map insertion order.
 */
export function chatSidebarIndexedProjectGroupRevisions(
  projectKeys: Iterable<string>,
  rootMembership: ReadonlyMap<string, readonly string[]>,
  supplemental: ReadonlyMap<string, readonly Session[]>,
  groupBySession: ReadonlyMap<string, ChatSidebarClusterGroup>,
  byGroup: ReadonlyMap<string, readonly Session[]>,
): ReadonlyMap<string, string> {
  const linked = new Map<string, Map<string, ChatSidebarClusterGroup>>()
  for (const key of projectKeys) linked.set(key, new Map())
  for (const [id, group] of groupBySession) {
    for (const key of rootMembership.get(id) ?? []) linked.get(key)?.set(id, group)
  }
  for (const [key, sessions] of supplemental) {
    const section = linked.get(key)
    if (!section) continue
    for (const session of sessions) {
      const group = groupBySession.get(session.id)
      if (group) section.set(session.id, group)
    }
  }
  const rosterVersions = new Map<string, string>()
  const revisions = new Map<string, string>()
  for (const [key, section] of linked) {
    const groupIDs = new Set<string>()
    const memberships = [...section].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([id, group]) => {
        groupIDs.add(group.id)
        return [id, group.id, group.kind, group.name]
      })
    const rosters = [...groupIDs].sort().map((id) => {
      let version = rosterVersions.get(id)
      if (version === undefined) {
        version = JSON.stringify((byGroup.get(id) ?? noMembers).map((member) => [
          member.id, member.title, member.time?.updated, member.time?.archived,
        ]))
        rosterVersions.set(id, version)
      }
      return [id, version]
    })
    revisions.set(key, JSON.stringify([memberships, rosters]))
  }
  return revisions
}

/** Reuse unaffected Project member-list arrays when a SessionGroup in another
 * project changes. Their stable Session snapshot references are owned by the
 * group projection, so a sibling group update does not need to invalidate
 * all 25–100 project section caches. */
export function reuseChatSidebarProjectMemberLists(
  previous: ReadonlyMap<string, readonly Session[]> | undefined,
  next: Map<string, Session[]>,
): Map<string, Session[]> {
  if (!previous) return next
  for (const [key, members] of next) {
    const old = previous.get(key)
    if (!old || old.length !== members.length) continue
    let same = true
    for (let i = 0; i < members.length; i++) {
      if (members[i] === old[i]) continue
      same = false
      break
    }
    if (same) next.set(key, old as Session[])
  }
  return next
}

export function indexChatSidebarProjectMembership(
  projects: readonly Project[],
  supplemental: ReadonlyMap<string, readonly Session[]>,
): ReadonlyMap<string, readonly string[]> {
  const keysBySession = new Map<string, readonly string[]>()
  for (const project of projects) {
    // Most sessions belong to exactly one project. Share its singleton key
    // array rather than allocating a new tiny array for every historical row
    // (10k sessions = 10k otherwise-retained little arrays).
    const singleton = [project.key] as const
    for (const source of [project.sessions, supplemental.get(project.key) ?? []]) {
      for (const session of source) {
        const keys = keysBySession.get(session.id)
        if (!keys) keysBySession.set(session.id, singleton)
        else if (!keys.includes(project.key)) keysBySession.set(session.id, [...keys, project.key])
      }
    }
  }
  return keysBySession
}

export function workingChatSidebarProjects(
  working: ReadonlySet<string>,
  membership: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const byProject = new Map<string, Set<string>>()
  for (const id of working) {
    for (const key of membership.get(id) ?? []) {
      let rows = byProject.get(key)
      if (!rows) {
        rows = new Set<string>()
        byProject.set(key, rows)
      }
      rows.add(id)
    }
  }
  return byProject
}

/**
 * Preserve unchanged project sections when a worker in another project flips
 * execution state. The old builder re-sorted / re-clustered EVERY project on
 * every change; this index rebuilds only affected project sections while
 * keeping exactly the same unbounded project-row pagination behavior.
 */
export function createChatSidebarProjectSectionCache() {
  type Entry = {
    source: Session[]
    supplemental: readonly Session[]
    total: number
    projectID?: string
    sort: ChatSidebarSortMode
    groupRevision: unknown
    working: ReadonlySet<string>
    section: ChatSidebarSection
  }
  const cache = new Map<string, Entry>()
  return {
    clear() { cache.clear() },
    build(input: {
      projects: readonly Project[]
      supplemental: ReadonlyMap<string, readonly Session[]>
      working: ReadonlyMap<string, ReadonlySet<string>>
      sort: ChatSidebarSortMode
      groupRevision: unknown | ReadonlyMap<string, unknown>
      groupOf: (session: Session) => ChatSidebarClusterGroup | undefined
      groupMembersOf: (group: ChatSidebarClusterGroup, scope: ChatSidebarClusterScope) => readonly Session[]
      titleOf: (session: Session) => string
      pin: (rows: Session[]) => Session[]
    }): ChatSidebarSection[] {
      const prepared = input.projects.map((project) => {
        const supplemental = input.supplemental.get(project.key) ?? noMembers
        const working = input.working.get(project.key) ?? new Set<string>()
        const groupRevision = input.groupRevision instanceof Map
          ? input.groupRevision.get(project.key)
          : input.groupRevision
        const prior = cache.get(project.key)
        const unchanged = !!prior &&
          prior.source === project.sessions &&
          prior.supplemental === supplemental &&
          prior.total === project.total &&
          prior.projectID === project.project?.id &&
          prior.sort === input.sort &&
          prior.groupRevision === groupRevision &&
          sameChatSidebarIDSet(prior.working, working)
        return { project, supplemental, working, groupRevision, prior, unchanged }
      })
      const dirty = prepared.reduce((sum, row) => sum + Number(!row.unchanged), 0)
      const remember = (
        row: (typeof prepared)[number],
        section: ChatSidebarSection,
      ) => cache.set(row.project.key, {
        source: row.project.sessions,
        supplemental: row.supplemental,
        total: row.project.total,
        projectID: row.project.project?.id,
        sort: input.sort,
        groupRevision: row.groupRevision,
        working: new Set(row.working),
        section,
      })
      // Initial paint, a group-roster revision, or a broad project-index
      // refresh often dirties MOST sections. One batched global builder is
      // measurably less expensive than starting N separate tree builders.
      if (dirty >= Math.max(2, Math.ceil(prepared.length / 3))) {
        const sections = buildChatSidebarSections({
          mode: "projects",
          sort: input.sort,
          recent: [],
          projects: input.projects,
          groupOf: input.groupOf,
          groupMembersOf: input.groupMembersOf,
          stateOf: () => "idle",
          titleOf: input.titleOf,
          pin: input.pin,
          limit: Number.POSITIVE_INFINITY,
          cluster: true,
          sessionsForScope: (scope) => scope.kind === "project"
            ? input.supplemental.get(scope.projectKey) ?? noMembers
            : noMembers,
        })
        cache.clear()
        prepared.forEach((row, i) => remember(row, sections[i]!))
        return sections
      }
      const sections: ChatSidebarSection[] = []
      const remaining = new Set(cache.keys())
      for (const row of prepared) {
        const { project, supplemental: extras, working, prior, unchanged } = row
        remaining.delete(project.key)
        if (unchanged && prior) {
          sections.push(prior.section)
          continue
        }
        const section = buildChatSidebarSections({
          mode: "projects",
          sort: input.sort,
          recent: [],
          projects: [project],
          groupOf: input.groupOf,
          groupMembersOf: input.groupMembersOf,
          stateOf: () => "idle",
          titleOf: input.titleOf,
          pin: input.pin,
          limit: Number.POSITIVE_INFINITY,
          cluster: true,
          sessionsForScope: (scope) => scope.kind === "project" ? extras : [],
        })[0]!
        sections.push(section)
        remember(row, section)
      }
      for (const key of remaining) cache.delete(key)
      return sections
    },
  }
}