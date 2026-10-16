import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  CHAT_SIDEBAR_STATUS_BUCKETS,
  chatSidebarStatusBucket,
  type ChatSidebarRowState,
  type ChatSidebarSection,
  type ChatSidebarStatusBucket,
} from "./chat-sidebar-tree"
import { compareChatSidebarSessionTime } from "./chat-sidebar-session-merge"

/**
 * Verify and index canonical root rows once, when the root index changes.
 * Duplicate IDs or an out-of-order legacy input fall back to the full
 * projection rather than relying on unproven sorted/unique preconditions.
 */
export function indexChatSidebarSparseSource(
  rows: readonly Session[],
  compare: (a: Session, b: Session) => number = compareChatSidebarSessionTime,
  sortedByTrustedComparator = false,
): {
  rows: readonly Session[]
  byID: ReadonlyMap<string, Session>
} | undefined {
  const byID = new Map<string, Session>()
  let previous: Session | undefined
  for (const session of rows) {
    if (byID.has(session.id)) return undefined
    if (!sortedByTrustedComparator && previous && compare(previous, session) > 0) return undefined
    byID.set(session.id, session)
    previous = session
  }
  return { rows, byID }
}

/**
 * O(K log K + visibleIdle) Status projection for an already sorted, ungrouped
 * root index, where K is the number of non-idle session identities.
 *
 * The common idle case does not traverse or instantiate thousands of rows.
 * Preserve complete non-idle buckets, status precedence, exact idle count,
 * working-first arrival ordering, and the existing Show More semantics.
 */
export function buildChatSidebarSparseStatusSections(input: {
  source: NonNullable<ReturnType<typeof indexChatSidebarSparseSource>>
  states: ReadonlyMap<string, ChatSidebarRowState>
  limit: number
  pin: (rows: Session[]) => Session[]
}): ChatSidebarSection[] {
  const buckets = new Map<ChatSidebarStatusBucket, Session[]>()
  let nonIdleCount = 0
  for (const [id, state] of input.states) {
    if (state === "idle") continue
    const session = input.source.byID.get(id)
    if (!session) continue
    const bucket = chatSidebarStatusBucket(state)
    const rows = buckets.get(bucket)
    if (rows) rows.push(session)
    else buckets.set(bucket, [session])
    nonIdleCount++
  }

  const sections: ChatSidebarSection[] = []
  for (const bucket of CHAT_SIDEBAR_STATUS_BUCKETS) {
    if (bucket === "idle") {
      const total = input.source.rows.length - nonIdleCount
      if (total <= 0) continue
      const cap = Math.max(0, Number.isNaN(input.limit) ? 0 : Math.trunc(input.limit))
      const visible: Session[] = []
      for (const session of input.source.rows) {
        if (visible.length >= cap) break
        if (input.states.has(session.id) && input.states.get(session.id) !== "idle") continue
        visible.push(session)
      }
      sections.push({
        key: "status:idle",
        kind: "status",
        status: "idle",
        items: visible.map((session) => ({ type: "session", key: `s:${session.id}`, session })),
        total,
        sessionCount: visible.length,
        hiddenItems: total - visible.length,
      })
      continue
    }
    const rows = buckets.get(bucket)
    if (!rows?.length) continue
    const ordered = input.pin(rows.sort(compareChatSidebarSessionTime))
    sections.push({
      key: `status:${bucket}`,
      kind: "status",
      status: bucket,
      items: ordered.map((session) => ({ type: "session", key: `s:${session.id}`, session })),
      total: rows.length,
      sessionCount: ordered.length,
      hiddenItems: 0,
    })
  }
  return sections
}