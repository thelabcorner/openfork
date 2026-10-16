/**
 * Deterministic CPU-only grouped Status benchmark:
 *   bun scripts/bench-chat-sidebar-grouped-status.ts
 * Does not execute or interact with real sessions, Electron or backend.
 */
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  buildChatSidebarSections,
  chatSidebarStatusBucket,
  type ChatSidebarClusterGroup,
  type ChatSidebarRowState,
  type ChatSidebarTreeInput,
} from "../src/pages/session/v2/chat-sidebar-tree"
import {
  buildChatSidebarGroupedSparseStatusSections,
  indexChatSidebarGroupedStatusSource,
} from "../src/pages/session/v2/chat-sidebar-status-grouped"

const measure = (fn: () => unknown) => {
  const samples: number[] = []
  for (let r = 0; r < 4; r++) {
    for (let i = 0; i < 5; i++) fn()
    const start = performance.now()
    for (let i = 0; i < 50; i++) fn()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return (samples[1]! + samples[2]!) / 2
}

for (const count of [5_000, 10_000]) {
  const sessions = Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    title: `session ${i}`,
    time: { updated: count - i, created: count - i },
  }) as Session)
  const groupOf = new Map<string, ChatSidebarClusterGroup>()
  const roster = new Map<string, Session[]>()
  const groups = 100
  // Grouped sessions are scattered throughout the source (not a conveniently
  // contiguous synthetic batch); the roster order reverses their time order.
  for (let i = 0; i < 1_000; i++) {
    const row = sessions[(i * 37) % count]!
    const group: ChatSidebarClusterGroup = { id: `g${i % groups}`, name: `Workers ${i % groups}`, kind: "user" }
    groupOf.set(row.id, group)
    const found = roster.get(group.id)
    if (found) found.push(row)
    else roster.set(group.id, [row])
  }
  for (const members of roster.values()) members.reverse()
  const source = indexChatSidebarGroupedStatusSource(sessions, (row) => groupOf.get(row.id))!
  for (const active of [25, 50, 100]) {
    const states = new Map<string, ChatSidebarRowState>()
    for (let i = 0; i < active; i++) states.set(sessions[(i * 79) % count]!.id, "working")
    for (let i = 0; i < 12; i++) states.set(sessions[(i * 137) % count]!.id, "attention")
    for (let i = 0; i < 15; i++) states.set(sessions[(i * 269) % count]!.id, "unread")
    const groupMembersOf = (group: ChatSidebarClusterGroup, scope: { kind: string; status?: string }) =>
      (roster.get(group.id) ?? []).filter((row) =>
        scope.kind !== "status" || chatSidebarStatusBucket(states.get(row.id) ?? "idle") === scope.status)
    const pin = (rows: Session[]) => rows
    const common: ChatSidebarTreeInput = {
      mode: "status", sort: "updated", recent: sessions, projects: [],
      groupOf: (row) => groupOf.get(row.id),
      groupMembersOf, stateOf: (row) => states.get(row.id) ?? "idle",
      titleOf: (row) => row.title, pin, limit: 50, cluster: true,
    }
    const old = () => buildChatSidebarSections(common)
    const next = () => buildChatSidebarGroupedSparseStatusSections({
      source, states, limit: 50, titleOf: (row) => row.title, pin, groupMembersOf,
    })
    const reindexed = () => buildChatSidebarGroupedSparseStatusSections({
      source: indexChatSidebarGroupedStatusSource(sessions, (row) => groupOf.get(row.id))!,
      states, limit: 50, titleOf: (row) => row.title, pin, groupMembersOf,
    })
    const normalize = (sections: ReturnType<typeof old>) =>
      sections.map((section) => ({
        key: section.key,
        total: section.total,
        count: section.sessionCount,
        hidden: section.hiddenItems,
        rows: section.items.map((item) => item.key),
      }))
    if (JSON.stringify(normalize(old())) !== JSON.stringify(normalize(next())))
      throw new Error(`Grouped Status projection parity failed (${count} rows; ${active} active)`)
    const baseline = measure(old)
    const grouped = measure(next)
    const coldEquivalent = measure(reindexed)
    console.log(JSON.stringify({
      rows: count, groupedSessions: 1_000, groups, modeledWorking: active,
      iterations: 50, beforeMs: +baseline.toFixed(2), afterMs: +grouped.toFixed(2),
      speedup: +(baseline / grouped).toFixed(2),
      reindexEachPassMs: +coldEquivalent.toFixed(2),
      reindexSpeedup: +(baseline / coldEquivalent).toFixed(2),
    }))
  }
}