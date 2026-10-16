/**
 * CPU-only Recent/Status non-updated sort projection benchmark.
 * bun scripts/bench-chat-sidebar-sort-modes.ts (from packages/app).
 * The sparse source index is built once for each sort, as in the memoized UI.
 * No actual concurrent sessions, backend, Electron or CDP are exercised.
 */
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  buildChatSidebarSections,
  chatSidebarStatusBucket,
  compareChatSidebarSessions,
  sortChatSidebarSessions,
  type ChatSidebarClusterGroup,
  type ChatSidebarRowState,
  type ChatSidebarTreeInput,
} from "../src/pages/session/v2/chat-sidebar-tree"
import { indexChatSidebarGroupedStatusSource, buildChatSidebarGroupedSparseStatusSections } from "../src/pages/session/v2/chat-sidebar-status-grouped"
import { buildChatSidebarSparseRecentSection } from "../src/pages/session/v2/chat-sidebar-recent-sparse"

const rows = Array.from({ length: 10_000 }, (_, i) => ({
  id: `s${i}`, title: `Session ${(i * 73) % 10_000}`,
  time: { created: (i * 107) % 10_000, updated: 10_000 - i },
}) as Session)
const groups = new Map<string, ChatSidebarClusterGroup>()
const rosters = new Map<string, Session[]>()
for (let i = 0; i < 1_000; i++) {
  const row = rows[(i * 37) % rows.length]!
  const id = `group-${i % 100}`
  groups.set(row.id, { id, name: `Group ${i % 100}`, kind: "user" })
  if (!rosters.has(id)) rosters.set(id, [])
  rosters.get(id)!.push(row)
}
for (const roster of rosters.values()) roster.reverse()
const titleOf = (session: Session) => session.title
const groupOf = (session: Session) => groups.get(session.id)
const states = new Map<string, ChatSidebarRowState>()
for (let i = 0; i < 100; i++) states.set(rows[(i * 89) % rows.length]!.id, "working")
for (let i = 0; i < 15; i++) states.set(rows[(i * 137) % rows.length]!.id, "attention")
const groupMembersOf = (group: ChatSidebarClusterGroup, scope: { kind: string; status?: string }) =>
  (rosters.get(group.id) ?? []).filter((session) =>
    scope.kind !== "status" || chatSidebarStatusBucket(states.get(session.id) ?? "idle") === scope.status)

const median = (fn: () => unknown) => {
  const samples: number[] = []
  for (let run = 0; run < 3; run++) {
    for (let i = 0; i < 4; i++) fn()
    const start = performance.now()
    for (let i = 0; i < 30; i++) fn()
    samples.push(performance.now() - start)
  }
  return samples.sort((a, b) => a - b)[1]!
}
const normalize = (sections: ReturnType<typeof buildChatSidebarSections>) =>
  sections.map((section) => ({
    key: section.key, total: section.total,
    visible: section.sessionCount, hidden: section.hiddenItems,
    items: section.items.map((item) => item.key),
  }))

for (const sort of ["created", "title"] as const) {
  const compare = compareChatSidebarSessions(sort, titleOf)
  const sorted = sortChatSidebarSessions(rows, sort, titleOf)
  const source = indexChatSidebarGroupedStatusSource(sorted, groupOf, compare, true)!
  const coldSource = () => indexChatSidebarGroupedStatusSource(
    sortChatSidebarSessions(rows, sort, titleOf), groupOf, compare, true,
  )
  const coldIndexMs = median(coldSource)
  const pin = (sessions: Session[]) => sessions
  const common: Omit<ChatSidebarTreeInput, "mode"> = {
    sort, recent: rows, projects: [], groupOf, groupMembersOf,
    stateOf: (session) => states.get(session.id) ?? "idle",
    titleOf, pin, limit: 50, cluster: true,
  }
  const cases = [
    {
      mode: "recent" as const,
      old: () => buildChatSidebarSections({ ...common, mode: "recent" }),
      next: () => [buildChatSidebarSparseRecentSection({
        source, working: new Set<string>(), pinWorking: pin,
        titleOf, groupMembersOf: (group) => groupMembersOf(group, { kind: "recent" }), compare, limit: 50,
      })!],
    },
    {
      mode: "status" as const,
      old: () => buildChatSidebarSections({ ...common, mode: "status" }),
      next: () => buildChatSidebarGroupedSparseStatusSections({
        source, states, compare, pin, titleOf, groupMembersOf, limit: 50,
      }),
    },
  ]
  for (const example of cases) {
    const before = example.old()
    const after = example.next()
    if (JSON.stringify(normalize(before)) !== JSON.stringify(normalize(after)))
      throw new Error(`Projection parity failure: ${sort}/${example.mode}`)
    const baselineMs = median(example.old)
    const optimizedMs = median(example.next)
    console.log(JSON.stringify({
      sort, mode: example.mode, roots: rows.length, groupMembers: 1_000,
      iterations: 30, baselineMs: +baselineMs.toFixed(2),
      sparseMs: +optimizedMs.toFixed(2),
      coldIndexMs: +coldIndexMs.toFixed(2),
      coldPlusProjectionMs: +(coldIndexMs + optimizedMs).toFixed(2),
      speedup: +(baselineMs / optimizedMs).toFixed(2),
    }))
  }
}