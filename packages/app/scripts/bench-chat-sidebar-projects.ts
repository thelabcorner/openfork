/**
 * Deterministic CPU-only per-project Status churn benchmark.
 * Run from packages/app: bun scripts/bench-chat-sidebar-projects.ts
 * This models work-state changes; it does not run concurrent sessions.
 */
import type { Session } from "@opencode-ai/sdk/v2/client"
import { buildChatSidebarSections, type ChatSidebarTreeInput } from "../src/pages/session/v2/chat-sidebar-tree"
import {
  createChatSidebarProjectSectionCache,
  indexChatSidebarProjectMembership,
  workingChatSidebarProjects,
} from "../src/pages/session/v2/chat-sidebar-project-cache"

const projects = Array.from({ length: 25 }, (_, index) => ({
  key: `project-${index}`,
  total: 400,
  project: { id: String(index) },
  sessions: Array.from({ length: 400 }, (_, i) => ({
    id: `p${index}-s${i}`, title: `Session ${i}`,
    time: { created: 400 - i, updated: 400 - i },
  }) as Session),
}))
const supplemental = new Map<string, Session[]>()
const membership = indexChatSidebarProjectMembership(projects, supplemental)
const groups = {}
const samples: number[] = []
for (const activeCount of [25, 50, 100]) {
  const foreignWorking = new Set(
    Array.from({ length: activeCount }, (_, index) => projects[1 + index % 24]!.sessions[index % 400]!.id),
  )
  const transitions = Array.from({ length: 100 }, (_, i) => {
    const working = new Set(foreignWorking)
    working.add(projects[0]!.sessions[i % 400]!.id)
    return working
  })
  let current = transitions[0]!
  const pin = (rows: Session[]) => [
    ...rows.filter((row) => current.has(row.id)),
    ...rows.filter((row) => !current.has(row.id)),
  ]
  const groupOf = () => undefined
  const groupMembersOf = () => []
  const baseInput: ChatSidebarTreeInput = {
    mode: "projects", sort: "updated", recent: [],
    projects, groupOf, groupMembersOf, stateOf: () => "idle",
    titleOf: (row) => row.title, pin, limit: Number.POSITIVE_INFINITY,
    cluster: true, sessionsForScope: () => [],
  }
  const cache = createChatSidebarProjectSectionCache()
  const baseline = (working: Set<string>) => {
    current = working
    return buildChatSidebarSections(baseInput)
  }
  const cached = (working: Set<string>) => {
    current = working
    return cache.build({
      projects, supplemental,
      working: workingChatSidebarProjects(working, membership),
      sort: "updated", groupRevision: groups,
      groupOf, groupMembersOf, titleOf: (row) => row.title, pin,
    })
  }
  const digest = (sections: ReturnType<typeof baseline>) =>
    sections.map((section) => ({
      key: section.key, total: section.total, hidden: section.hiddenItems,
      items: section.items.map((item) => item.key),
    }))
  for (const working of transitions.slice(0, 10)) {
    if (JSON.stringify(digest(baseline(working))) !== JSON.stringify(digest(cached(working))))
      throw new Error(`Project section parity failed at ${activeCount} working`)
  }
  const bench = (fn: typeof baseline) => {
    const runs: number[] = []
    for (let repeat = 0; repeat < 3; repeat++) {
      for (let warm = 0; warm < 5; warm++) fn(transitions[warm]!)
      const start = performance.now()
      for (const working of transitions) fn(working)
      runs.push(performance.now() - start)
    }
    return runs.sort((a, b) => a - b)[1]!
  }
  const before = bench(baseline)
  const after = bench(cached)
  // A pessimistic initialization proxy: drop the cache and rebuild reverse
  // membership for EVERY transition. Real UI initializes these once per
  // project/index revision, not every worker status update.
  const coldEquivalent = bench((working) => {
    cache.clear()
    return cache.build({
      projects, supplemental,
      working: workingChatSidebarProjects(working, indexChatSidebarProjectMembership(projects, supplemental)),
      sort: "updated", groupRevision: groups,
      groupOf, groupMembersOf, titleOf: (row) => row.title, pin,
    })
  })
  samples.push(before / after)
  console.log(JSON.stringify({
    rows: 10_000, projects: 25, modeledWorking: activeCount, transitions: transitions.length,
    baselineMs: +before.toFixed(2), cachedMs: +after.toFixed(2),
    speedup: +(before / after).toFixed(2),
    reindexEachPassMs: +coldEquivalent.toFixed(2),
    reindexSpeedup: +(before / coldEquivalent).toFixed(2),
  }))
}