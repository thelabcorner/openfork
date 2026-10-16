import type { Session } from "@opencode-ai/sdk/v2/client"

/**
 * Pure projection from the pane's already-loaded root Session slices into the
 * one tree the sidebar renders. The pane owns every reactive read (working
 * state, attention, notifications, group membership); this module only orders,
 * buckets, and folds rows, so it stays O(rows) and fully unit-testable.
 *
 * Exactly one view renders at a time. Earlier revisions drew every root twice
 * (once in Recent, once in its project), which doubled DOM, row runtimes, and
 * working indicators while adding no information.
 */

export type ChatSidebarViewMode = "recent" | "projects" | "status"
export type ChatSidebarSortMode = "updated" | "created" | "title"
export type ChatSidebarDensity = "compact" | "detailed"

export const CHAT_SIDEBAR_VIEW_MODES: readonly ChatSidebarViewMode[] = ["recent", "projects", "status"]
export const CHAT_SIDEBAR_SORT_MODES: readonly ChatSidebarSortMode[] = ["updated", "created", "title"]

/** Per-row state, most urgent first. `error` is an unseen failed turn. */
export type ChatSidebarRowState = "attention" | "error" | "working" | "unread" | "idle"

/** Status view buckets. Errors share the attention bucket: both need the user. */
export const CHAT_SIDEBAR_STATUS_BUCKETS = ["attention", "working", "unread", "idle"] as const
export type ChatSidebarStatusBucket = (typeof CHAT_SIDEBAR_STATUS_BUCKETS)[number]

export const chatSidebarStatusBucket = (state: ChatSidebarRowState): ChatSidebarStatusBucket =>
  state === "error" ? "attention" : state

/** Minimal SessionGroup identity needed to fold members into one node. */
export type ChatSidebarClusterGroup = { id: string; name: string; kind: string }

export type ChatSidebarClusterScope =
  | { kind: "recent" }
  | { kind: "project"; projectKey: string }
  | { kind: "status"; status: ChatSidebarStatusBucket }

export type ChatSidebarClusterCounts = Record<ChatSidebarRowState, number> & { total: number }

export type ChatSidebarSessionItem = { type: "session"; key: string; session: Session }

export type ChatSidebarClusterItem = {
  type: "cluster"
  key: string
  group: ChatSidebarClusterGroup
  /** Scoped members from root rows and the compact SessionGroup roster. */
  members: Session[]
  /** Member titles with the shared group prefix removed, parallel to `members`. */
  labels: string[]
  /**
   * Most relevant member (first in section order): the cluster's hover/open target.
   * Member STATE counts are deliberately not part of the item: a state flip must not
   * mint a new item (which would remount the node and every expanded member row).
   * The node derives them reactively via countChatSidebarClusterStates.
   */
  lead: Session
}

export type ChatSidebarItem = ChatSidebarSessionItem | ChatSidebarClusterItem

/**
 * Both cluster and session slots are identity-stable. A Session with the same
 * ID can change title, timestamps, directory or metrics without tearing down
 * its mounted row / IntersectionObserver / runtime lease. The row consumes
 * the slot's live Session accessor; only a type/identity replacement remounts.
 */
export const canReuseChatSidebarItemSlot = (previous: ChatSidebarItem, next: ChatSidebarItem): boolean =>
  previous.type === "cluster"
    ? next.type === "cluster"
    : next.type === "session" && previous.session.id === next.session.id

export type ChatSidebarSection = {
  key: string
  kind: "recent" | "project" | "status"
  status?: ChatSidebarStatusBucket
  /** Consumer-supplied project identity (pathKey of its worktree). */
  projectKey?: string
  items: ChatSidebarItem[]
  /** Sessions represented by `items`, clusters counted by member. */
  sessionCount: number
  /** Root sessions the section knows about (server estimate for projects). */
  total: number
  /** Top-level items withheld by a client-side limit. */
  hiddenItems: number
}

export type ChatSidebarTreeInput = {
  mode: ChatSidebarViewMode
  sort: ChatSidebarSortMode
  /** Unique root pool across every opened project, any order. */
  recent: readonly Session[]
  projects: ReadonlyArray<{ key: string; sessions: readonly Session[]; total: number }>
  /** Folding group for a session, or undefined. */
  groupOf: (session: Session) => ChatSidebarClusterGroup | undefined
  /** Complete, lightweight group members for the current sidebar scope. */
  groupMembersOf?: (group: ChatSidebarClusterGroup, scope: ChatSidebarClusterScope) => readonly Session[]
  /** Additional compact group-member sessions eligible for the current scope. */
  sessionsForScope?: (scope: ChatSidebarClusterScope) => readonly Session[]
  stateOf: (session: Session) => ChatSidebarRowState
  titleOf: (session: Session) => string
  /** Stable working-first pinning (pane-owned arrival order). Applied to activity sort only. */
  pin: (rows: Session[]) => Session[]
  /** Client-side item limit for Recent and the Status idle bucket. */
  limit: number
  cluster: boolean
}

const updatedAt = (session: Session) => session.time?.updated ?? session.time?.created ?? 0
const createdAt = (session: Session) => session.time?.created ?? session.time?.updated ?? 0
const byID = (a: Session, b: Session) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
let titleCollator: Intl.Collator | undefined

/** Single comparator authority for the general tree and the sparse,
 * preindexed projection. Exact numeric-collation and timestamp tie rules
 * matter when a group is folded by its first sorted member. */
export function compareChatSidebarSessions(
  sort: ChatSidebarSortMode,
  titleOf: (session: Session) => string,
): (a: Session, b: Session) => number {
  if (sort === "title") {
    const collator = (titleCollator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }))
    return (a, b) => collator.compare(titleOf(a), titleOf(b)) || byID(a, b)
  }
  const time = sort === "created" ? createdAt : updatedAt
  return (a, b) => time(b) - time(a) || byID(a, b)
}

export function sortChatSidebarSessions(
  rows: readonly Session[],
  sort: ChatSidebarSortMode,
  titleOf: (session: Session) => string,
): Session[] {
  return [...rows].sort(compareChatSidebarSessions(sort, titleOf))
}

const PREFIX_SEPARATOR = /^[\s/:|·\-–—]+/

/**
 * Swarm and manual group members usually share the group name as a title
 * prefix ("workmark-e2e / capture-pipeline"). Inside the expanded group that
 * prefix is pure noise, so drop it — but never down to an empty label.
 */
export function clusterMemberLabel(title: string, groupName: string): string {
  const name = groupName.trim()
  if (!name || title.length <= name.length) return title
  if (title.slice(0, name.length).toLocaleLowerCase() !== name.toLocaleLowerCase()) return title
  const rest = title.slice(name.length)
  const stripped = rest.replace(PREFIX_SEPARATOR, "")
  // Require a real separator so "build" does not strip "builder-…".
  if (stripped === rest || !stripped.trim()) return title
  return stripped
}

const emptyCounts = (): ChatSidebarClusterCounts => ({
  attention: 0,
  error: 0,
  working: 0,
  unread: 0,
  idle: 0,
  total: 0,
})

/** Per-state member tally for a cluster node; the node memoizes it so only the head bar updates. */
export function countChatSidebarClusterStates(
  members: readonly Session[],
  stateOf: (session: Session) => ChatSidebarRowState,
): ChatSidebarClusterCounts {
  const counts = emptyCounts()
  for (const member of members) {
    counts[stateOf(member)] += 1
    counts.total += 1
  }
  return counts
}

export const sameChatSidebarClusterCounts = (a: ChatSidebarClusterCounts, b: ChatSidebarClusterCounts) =>
  a.attention === b.attention &&
  a.error === b.error &&
  a.working === b.working &&
  a.unread === b.unread &&
  a.idle === b.idle &&
  a.total === b.total

/**
 * Fold rows that share a SessionGroup into one cluster node positioned at its
 * first member. Two passes, O(rows + scoped members). Groups with a single
 * scoped member stay ordinary rows: a one-member fold only adds a click.
 */
export function clusterChatSidebarRowsWindow(
  rows: readonly Session[],
  input: Pick<ChatSidebarTreeInput, "groupOf" | "titleOf" | "cluster" | "groupMembersOf">,
  sectionKey: string,
  scope?: ChatSidebarClusterScope,
  limit = Number.POSITIVE_INFINITY,
): { items: ChatSidebarItem[]; hiddenItems: number } {
  // Most Recent/idle sections show only 50 rows. Do not allocate, label, or
  // resolve complete group rosters for the thousands of hidden rows. We still
  // count their top-level groups exactly for the Show More indicator.
  const cap = Math.max(0, Number.isNaN(limit) ? 0 : Math.trunc(limit))
  if (!input.cluster) {
    const visible = Math.min(rows.length, cap)
    return {
      items: rows.slice(0, visible).map((session) => ({ type: "session", key: `s:${session.id}`, session })),
      hiddenItems: rows.length - visible,
    }
  }
  const groups = new Map<string, { group: ChatSidebarClusterGroup; members: Session[] }>()
  const groupBySession = new Map<string, string>()
  for (const session of rows) {
    const group = input.groupOf(session)
    if (!group) continue
    groupBySession.set(session.id, group.id)
    const entry = groups.get(group.id)
    if (entry) entry.members.push(session)
    else groups.set(group.id, { group, members: [session] })
  }
  const items: ChatSidebarItem[] = []
  const emitted = new Set<string>()
  let hiddenItems = 0
  for (const session of rows) {
    const groupID = groupBySession.get(session.id)
    const entry = groupID ? groups.get(groupID) : undefined
    if (!entry) {
      if (items.length >= cap) hiddenItems++
      else items.push({ type: "session", key: `s:${session.id}`, session })
      continue
    }
    if (emitted.has(entry.group.id)) continue
    // This group always occupies exactly one top-level item, including when
    // the scoped roster has only one member. Mark before the window check.
    emitted.add(entry.group.id)
    if (items.length >= cap) {
      hiddenItems++
      continue
    }
    const scopedMembers = scope && input.groupMembersOf ? input.groupMembersOf(entry.group, scope) : entry.members
    const currentByID = new Map(entry.members.map((member) => [member.id, member] as const))
    const seen = new Set<string>()
    const members: Session[] = []
    for (const member of scopedMembers) {
      if (seen.has(member.id)) continue
      seen.add(member.id)
      // Prefer the currently loaded row when available; group detail snapshots
      // supply every other member without hydrating session history.
      members.push(currentByID.get(member.id) ?? member)
    }
    for (const member of entry.members) {
      if (seen.has(member.id)) continue
      seen.add(member.id)
      members.push(member)
    }
    if (members.length < 2) {
      items.push({ type: "session", key: `s:${session.id}`, session })
      continue
    }
    items.push({
      type: "cluster",
      key: `c:${sectionKey}:${entry.group.id}`,
      group: entry.group,
      members,
      labels: members.map((member) => clusterMemberLabel(input.titleOf(member), entry.group.name)),
      lead: entry.members[0]!,
    })
  }
  return { items, hiddenItems }
}

/** Backwards-compatible complete projection used by unbounded project/status
 * sections and by consumers that need every cluster member. */
export function clusterChatSidebarRows(
  rows: readonly Session[],
  input: Pick<ChatSidebarTreeInput, "groupOf" | "titleOf" | "cluster" | "groupMembersOf">,
  sectionKey: string,
  scope?: ChatSidebarClusterScope,
): ChatSidebarItem[] {
  return clusterChatSidebarRowsWindow(rows, input, sectionKey, scope).items
}

const sessionCount = (items: readonly ChatSidebarItem[]) =>
  items.reduce((sum, item) => sum + (item.type === "cluster" ? item.members.length : 1), 0)

function ordered(rows: readonly Session[], input: ChatSidebarTreeInput) {
  // Per-session working/status transitions rebuild the projection, but do not
  // change the timestamps of the already-ordered session index. Avoid another
  // O(N log N) sort on each transition. The linear check also preserves the
  // public helper's behavior for unsorted/foreign callers and equal-time ties.
  let sorted: Session[] | undefined
  if (input.sort === "updated") {
    let inOrder = true
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]!
      const b = rows[i]!
      const delta = updatedAt(b) - updatedAt(a)
      if (delta > 0 || (delta === 0 && byID(a, b) > 0)) {
        inOrder = false
        break
      }
    }
    if (inOrder) sorted = [...rows]
  }
  sorted ??= sortChatSidebarSessions(rows, input.sort, input.titleOf)
  return input.sort === "updated" ? input.pin(sorted) : sorted
}

/**
 * Merge the already-timestamp-sorted canonical root index with lightweight
 * SessionGroup-only members. Root rows win on duplicate ID (freshest metadata);
 * the supplemental sort is bounded by member count, not the entire root pool.
 * Does not mutate either source or depend on working status.
 */
export function mergeChatSidebarRecent(roots: readonly Session[], members: readonly Session[]): readonly Session[] {
  if (!members.length) return roots
  const seen = new Set(roots.map((session) => session.id))
  const supplemental: Session[] = []
  for (const member of members) {
    if (seen.has(member.id)) continue
    seen.add(member.id)
    supplemental.push(member)
  }
  if (!supplemental.length) return roots
  supplemental.sort((a, b) => updatedAt(b) - updatedAt(a) || byID(a, b))
  const merged: Session[] = []
  let i = 0
  let j = 0
  while (i < roots.length && j < supplemental.length) {
    const root = roots[i]!
    const member = supplemental[j]!
    if (updatedAt(root) > updatedAt(member) || (updatedAt(root) === updatedAt(member) && byID(root, member) <= 0)) {
      merged.push(root)
      i++
    } else {
      merged.push(member)
      j++
    }
  }
  while (i < roots.length) merged.push(roots[i++]!)
  while (j < supplemental.length) merged.push(supplemental[j++]!)
  return merged
}

function limitedSection(
  base: Omit<ChatSidebarSection, "items" | "sessionCount" | "hiddenItems">,
  items: ChatSidebarItem[],
  limit: number | undefined,
): ChatSidebarSection {
  const visible = limit === undefined ? items : items.slice(0, Math.max(0, limit))
  return { ...base, items: visible, sessionCount: sessionCount(visible), hiddenItems: items.length - visible.length }
}

export function buildChatSidebarSections(input: ChatSidebarTreeInput): ChatSidebarSection[] {
  // Preserve root precedence and source order without materializing a
  // potentially huge [...roots, ...groupRoster] intermediate allocation on
  // each live status transition. Most supplemental rows are already present
  // in Recent; discard their duplicates while appending.
  const uniqueSessions = (rows: readonly Session[], supplemental: readonly Session[] = []) => {
    const seen = new Set<string>()
    const unique: Session[] = []
    for (const source of [rows, supplemental]) {
      for (const session of source) {
        if (seen.has(session.id)) continue
        seen.add(session.id)
        unique.push(session)
      }
    }
    return unique
  }

  if (input.mode === "recent") {
    const scope: ChatSidebarClusterScope = { kind: "recent" }
    const rows = uniqueSessions(input.recent, input.sessionsForScope?.(scope))
    if (rows.length === 0) return []
    const { items, hiddenItems } = clusterChatSidebarRowsWindow(ordered(rows, input), input, "recent", scope, input.limit)
    return [{ key: "recent", kind: "recent", total: rows.length, items, hiddenItems, sessionCount: sessionCount(items) }]
  }

  if (input.mode === "projects") {
    return input.projects.map((project) => {
      const key = `project:${project.key}`
      const scope: ChatSidebarClusterScope = { kind: "project", projectKey: project.key }
      const rows = uniqueSessions(project.sessions, input.sessionsForScope?.(scope))
      const items = clusterChatSidebarRows(ordered(rows, input), input, key, scope)
      // Project rows page through the server (store limit), not a client slice.
      return limitedSection(
        { key, kind: "project", projectKey: project.key, total: Math.max(project.total, rows.length) },
        items,
        undefined,
      )
    })
  }

  const buckets = new Map<ChatSidebarStatusBucket, Session[]>()
  const statusRows = uniqueSessions(input.recent, input.sessionsForScope?.({ kind: "recent" }))
  for (const session of statusRows) {
    const bucket = chatSidebarStatusBucket(input.stateOf(session))
    const rows = buckets.get(bucket)
    if (rows) rows.push(session)
    else buckets.set(bucket, [session])
  }
  const sections: ChatSidebarSection[] = []
  for (const bucket of CHAT_SIDEBAR_STATUS_BUCKETS) {
    const rows = buckets.get(bucket)
    if (!rows?.length) continue
    const key = `status:${bucket}`
    const scope: ChatSidebarClusterScope = { kind: "status", status: bucket }
    const scopedGroupRows = input.sessionsForScope?.(scope) ?? []
    const expandedRows = uniqueSessions(rows, scopedGroupRows)
    const page = clusterChatSidebarRowsWindow(
      ordered(expandedRows, input),
      input,
      key,
      scope,
      bucket === "idle" ? input.limit : undefined,
    )
    // Only the unbounded idle tail is paged; anything live or unseen is always shown.
    sections.push(
      { key, kind: "status", status: bucket, total: rows.length, ...page, sessionCount: sessionCount(page.items) },
    )
  }
  return sections
}

const sameRefs = <T>(a: readonly T[], b: readonly T[]) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function sameItem(a: ChatSidebarItem, b: ChatSidebarItem) {
  if (a.type === "session" || b.type === "session") {
    return a.type === "session" && b.type === "session" && a.session === b.session
  }
  if (a.group.id !== b.group.id || a.group.name !== b.group.name || a.group.kind !== b.group.kind) return false
  if (a.lead !== b.lead) return false
  return sameRefs(a.members, b.members) && sameRefs(a.labels, b.labels)
}

/**
 * <For> keys by reference. Without this pass every recompute (a working flag
 * flipping anywhere) would mint fresh item/section objects and remount every
 * row subtree, its runtime lease, and its IntersectionObserver registration.
 */
export function reuseChatSidebarSections(
  previous: readonly ChatSidebarSection[] | undefined,
  next: ChatSidebarSection[],
): ChatSidebarSection[] {
  if (!previous) return next
  const oldSections = new Map(previous.map((section) => [section.key, section] as const))
  const reconciled = next.map((section) => {
    const old = oldSections.get(section.key)
    if (!old) return section
    const oldItems = new Map(old.items.map((item) => [item.key, item] as const))
    const items = section.items.map((item) => {
      const prior = oldItems.get(item.key)
      return prior && sameItem(prior, item) ? prior : item
    })
    if (
      old.kind === section.kind &&
      old.status === section.status &&
      old.projectKey === section.projectKey &&
      old.total === section.total &&
      old.sessionCount === section.sessionCount &&
      old.hiddenItems === section.hiddenItems &&
      sameRefs(old.items, items)
    ) {
      return old
    }
    return { ...section, items }
  })
  // No structural/metadata change means the whole sections accessor can keep
  // its prior array identity. That prevents the entire virtual-block flattening
  // and range-measurement graph from waking on a foreign session's state event.
  return sameRefs(previous, reconciled) ? previous as ChatSidebarSection[] : reconciled
}

/**
 * Session ids whose compact telemetry the pane should warm: only rows that are
 * actually mounted. Collapsed sections render nothing; a collapsed cluster
 * renders only its head, which anchors on the lead. Pure so the negative
 * invariant (folded members are never warmed) is testable.
 */
export function collectChatSidebarWarmIDs(
  sections: readonly ChatSidebarSection[],
  expanded: { section: (key: string) => boolean; cluster: (groupID: string) => boolean },
): Set<string> {
  const ids = new Set<string>()
  for (const section of sections) {
    if (!expanded.section(section.key)) continue
    for (const item of section.items) {
      if (item.type === "session") {
        ids.add(item.session.id)
        continue
      }
      ids.add(item.lead.id)
      if (expanded.cluster(item.group.id)) for (const member of item.members) ids.add(member.id)
    }
  }
  return ids
}

/**
 * A render slot that outlives the immutable value it presents. <For> keys by
 * reference, so a section/cluster whose object is re-minted (a count changed,
 * a member reordered) would otherwise remount its whole subtree. Slots are keyed
 * by identity-string instead; the value is read through `get`, which the
 * consumer backs with a signal.
 */
export type ChatSidebarSlot<T> = { key: string; get: () => T; set: (value: T) => void }

export type ChatSidebarSlotState<T> = { slots: ChatSidebarSlot<T>[]; byKey: Map<string, ChatSidebarSlot<T>> }

/**
 * Reconcile `items` onto existing slots. A slot is updated in place when
 * `canUpdate` allows it, otherwise replaced (so consumers that capture the value
 * non-reactively still remount). The previous array is returned untouched when
 * nothing structural changed, so downstream <For> does no work.
 */
export function reconcileChatSidebarSlots<T>(
  previous: ChatSidebarSlotState<T> | undefined,
  items: readonly T[],
  keyOf: (item: T) => string,
  canUpdate: (previous: T, next: T) => boolean,
  create: (key: string, item: T) => ChatSidebarSlot<T>,
): ChatSidebarSlotState<T> {
  // Working/status signals can replay an otherwise unchanged section. Its
  // cached slot set already owns every same-identity item: skip the replacement
  // Map, slot array and reactive setter calls altogether. This is the common
  // case in large Recent/Projects views, and avoids O(N) allocations per tick.
  if (previous && previous.slots.length === items.length) {
    let same = true
    for (let i = 0; i < items.length; i++) {
      const slot = previous.slots[i]!
      const item = items[i]!
      if (slot.key === keyOf(item) && slot.get() === item) continue
      same = false
      break
    }
    if (same) return previous
  }
  const byKey = new Map<string, ChatSidebarSlot<T>>()
  const slots: ChatSidebarSlot<T>[] = []
  for (const item of items) {
    const key = keyOf(item)
    let slot = byKey.has(key) ? undefined : previous?.byKey.get(key)
    if (slot) {
      const current = slot.get()
      if (current !== item) {
        if (canUpdate(current, item)) slot.set(item)
        else slot = undefined
      }
    }
    slot ??= create(key, item)
    byKey.set(key, slot)
    slots.push(slot)
  }
  if (previous && sameRefs(previous.slots, slots)) return previous
  return { slots, byKey }
}
