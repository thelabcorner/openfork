/**
 * CPU-only Recent projection benchmark; no running app/backend interaction.
 * Run from packages/app: bun scripts/bench-chat-sidebar-recent.ts
 */
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  buildChatSidebarSections,
  type ChatSidebarClusterGroup,
  type ChatSidebarTreeInput,
} from "../src/pages/session/v2/chat-sidebar-tree"
import { indexChatSidebarGroupedStatusSource } from "../src/pages/session/v2/chat-sidebar-status-grouped"
import { buildChatSidebarSparseRecentSection } from "../src/pages/session/v2/chat-sidebar-recent-sparse"

function sample(fn: () => unknown) {
  const results: number[] = []
  for (let repetition = 0; repetition < 5; repetition++) {
    for (let i = 0; i < 5; i++) fn()
    const start = performance.now()
    for (let i = 0; i < 70; i++) fn()
    results.push(performance.now() - start)
  }
  return results.sort((a, b) => a - b)[2]!
}

for (const count of [5_000, 10_000]) {
  const rows = Array.from({ length: count }, (_, i) =>
    ({ id: `s${i}`, title: `Session ${i}`, time: { created: count - i, updated: count - i } }) as Session)
  const groups = new Map<string, ChatSidebarClusterGroup>()
  const rosters = new Map<string, Session[]>()
  for (let i = 0; i < 1_000; i++) {
    const row = rows[(i * 37) % count]!
    const key = `g${i % 100}`
    groups.set(row.id, { id: key, name: key, kind: "delegation" })
    const found = rosters.get(key)
    if (found) found.push(row)
    else rosters.set(key, [row])
  }
  for (const roster of rosters.values()) roster.reverse()
  const source = indexChatSidebarGroupedStatusSource(rows, (row) => groups.get(row.id))!
  for (const workingCount of [25, 50, 100]) {
    const working = new Set(Array.from({ length: workingCount }, (_, i) => rows[(i * 83) % count]!.id))
    const pin = (list: Session[]) =>
      [...list.filter((row) => working.has(row.id)).reverse(), ...list.filter((row) => !working.has(row.id))]
    const groupMembersOf = (group: ChatSidebarClusterGroup) => rosters.get(group.id) ?? []
    const input: ChatSidebarTreeInput = {
      mode: "recent", sort: "updated", recent: rows, projects: [],
      groupOf: (row) => groups.get(row.id), groupMembersOf,
      stateOf: () => "idle", titleOf: (row) => row.title, pin,
      limit: 50, cluster: true,
    }
    const old = () => buildChatSidebarSections(input)[0]!
    const next = () => buildChatSidebarSparseRecentSection({
      source, working, pinWorking: pin, limit: 50,
      titleOf: (row) => row.title, groupMembersOf,
    })!
    const rebuildIndexAndProject = () => buildChatSidebarSparseRecentSection({
      source: indexChatSidebarGroupedStatusSource(rows, (row) => groups.get(row.id))!,
      working, pinWorking: pin, limit: 50,
      titleOf: (row) => row.title, groupMembersOf,
    })!
    const normalize = (section: ReturnType<typeof old>) => ({
      total: section.total, count: section.sessionCount, hidden: section.hiddenItems,
      items: section.items.map((item) => item.key),
    })
    if (JSON.stringify(normalize(old())) !== JSON.stringify(normalize(next())))
      throw new Error(`Recent parity violation: ${count}/${workingCount}`)
    const before = sample(old)
    const after = sample(next)
    // This deliberately rebuilds the source EVERY pass, unlike the live
    // memoized update path. It approximates cold initialization cost rather
    // than asserting a real Electron first-frame measurement.
    const withIndex = sample(rebuildIndexAndProject)
    console.log(JSON.stringify({
      roots: count, groupedSessions: 1_000, groups: 100, modeledWorking: workingCount,
      iterations: 70, beforeMs: +before.toFixed(2), afterMs: +after.toFixed(2),
      speedup: +(before / after).toFixed(2),
      reindexEachPassMs: +withIndex.toFixed(2),
      reindexSpeedup: +(before / withIndex).toFixed(2),
    }))
  }
}