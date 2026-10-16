/**
 * CPU-only projection benchmark. Run from packages/app:
 *   bun scripts/bench-chat-sidebar-state.ts
 *
 * No backend, Electron renderer, shared database, or running user sessions
 * are touched. The "active" parameter models concurrent-looking status
 * entries; it does NOT execute concurrent sessions.
 */
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { buildChatSidebarSections, type ChatSidebarRowState, type ChatSidebarTreeInput } from "../src/pages/session/v2/chat-sidebar-tree"
import { indexChatSidebarRowStates } from "../src/pages/session/v2/chat-sidebar-state-index"
import { buildChatSidebarSparseStatusSections, indexChatSidebarSparseSource } from "../src/pages/session/v2/chat-sidebar-status-sparse"

const ITERATIONS = 50
const REPETITIONS = 3

function measure(fn: () => unknown) {
  for (let i = 0; i < 6; i++) fn()
  const samples: number[] = []
  for (let repetition = 0; repetition < REPETITIONS; repetition++) {
    const start = performance.now()
    for (let iteration = 0; iteration < ITERATIONS; iteration++) fn()
    samples.push(performance.now() - start)
  }
  return samples.sort((a, b) => a - b)[1]!
}

for (const size of [5_000, 10_000]) {
  const rows: Session[] = Array.from({ length: size }, (_, i) => ({
    id: `s${i}`,
    title: `session ${i}`,
    time: { created: size - i, updated: size - i },
  }) as Session)
  const directoryByID = new Map(rows.map((row) => [row.id, "/repo"]))
  for (const active of [25, 50, 100]) {
    const statuses: Record<string, SessionStatus> = {}
    const questions: Record<string, number[]> = {}
    const permissions: Record<string, number[]> = {}
    const unseenCounts: Record<string, number> = {}
    const unseenErrors: Record<string, boolean> = {}
    const paused: Record<string, boolean> = {}
    for (let i = 0; i < active; i++) statuses[rows[(i * 97) % size]!.id] = { type: "busy" }
    for (let i = 0; i < 12; i++) questions[rows[(i * 131) % size]!.id] = [i]
    for (let i = 0; i < 8; i++) permissions[rows[(i * 191) % size]!.id] = [i]
    for (let i = 0; i < 35; i++) unseenCounts[rows[(i * 173) % size]!.id] = 2
    for (let i = 0; i < 7; i++) unseenErrors[rows[(i * 337) % size]!.id] = true

    const stateOf = (session: Session): ChatSidebarRowState => {
      const id = session.id
      if (questions[id]?.length || permissions[id]?.length) return "attention"
      if (unseenErrors[id]) return "error"
      if ((statuses[id]?.type === "busy" || statuses[id]?.type === "retry") && paused[id] !== true) return "working"
      if ((unseenCounts[id] ?? 0) > 0) return "unread"
      return "idle"
    }
    const common = {
      mode: "status" as const,
      sort: "updated" as const,
      recent: rows,
      projects: [],
      groupOf: () => undefined,
      titleOf: (session: Session) => session.title,
      pin: (items: Session[]) => items,
      limit: 50,
      cluster: true,
    }
    const baseline = () => buildChatSidebarSections({ ...common, stateOf })
    const projected = () => {
      const stateIndex = indexChatSidebarRowStates({
        statuses, paused, questions, permissions, unseenCounts, unseenErrors,
        directoryByID, autoResponds: () => false,
      })
      return buildChatSidebarSections({
        ...common,
        stateOf: (session: Session) => stateIndex.get(session.id) ?? "idle",
      })
    }
    const source = indexChatSidebarSparseSource(rows)!
    const sparse = () => {
      const stateIndex = indexChatSidebarRowStates({
        statuses, paused, questions, permissions, unseenCounts, unseenErrors,
        directoryByID, autoResponds: () => false,
      })
      return buildChatSidebarSparseStatusSections({
        source,
        states: stateIndex,
        limit: common.limit,
        pin: common.pin,
      })
    }
    const summarize = (sections: ReturnType<typeof baseline>) =>
      sections.map((section) => ({
        key: section.key,
        total: section.total,
        hiddenItems: section.hiddenItems,
        sessionCount: section.sessionCount,
        items: section.items.map((item) => item.key),
      }))
    if (JSON.stringify(summarize(baseline())) !== JSON.stringify(summarize(projected()))) {
      throw new Error(`Sidebar projection parity failure for ${size} roots / ${active} active`)
    }
    if (JSON.stringify(summarize(baseline())) !== JSON.stringify(summarize(sparse()))) {
      throw new Error(`Sparse Status parity failure for ${size} roots / ${active} active`)
    }
    // Alternate measurement ordering to limit warmup/GC ordering bias.
    const before = active === 50 ? (measure(projected), measure(baseline)) : measure(baseline)
    const after = measure(projected)
    const sparseMs = measure(sparse)
    console.log(JSON.stringify({
      roots: size,
      modeledWorking: active,
      iterations: ITERATIONS,
      baselineMedianMs: Number(before.toFixed(2)),
      indexedMedianMs: Number(after.toFixed(2)),
      sparseMedianMs: Number(sparseMs.toFixed(2)),
      indexSpeedup: Number((before / after).toFixed(2)),
      sparseSpeedup: Number((before / sparseMs).toFixed(2)),
    }))
  }
}