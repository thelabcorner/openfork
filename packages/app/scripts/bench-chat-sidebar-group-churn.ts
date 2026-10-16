/**
 * CPU-only group-roster churn benchmark, with zero active sessions.
 * bun scripts/bench-chat-sidebar-group-churn.ts (from packages/app)
 * Models one group metadata revision per update across 25 projects / 10k rows.
 * This deliberately measures projection work, not Electron frame time.
 */
import type { Session } from "@opencode-ai/sdk/v2/client"
import { chatSidebarIndexedProjectGroupRevisions, createChatSidebarProjectSectionCache, indexChatSidebarProjectMembership } from "../src/pages/session/v2/chat-sidebar-project-cache"

const projectCount = 25
const rowsPerProject = 400
const projects = Array.from({ length: projectCount }, (_, p) => ({
  key: `p${p}`, total: rowsPerProject, project: { id: `p${p}` },
  sessions: Array.from({ length: rowsPerProject }, (_, i) => ({
    id: `p${p}-s${i}`, title: `row ${i}`,
    time: { created: rowsPerProject - i, updated: rowsPerProject - i },
  }) as Session),
}))
const metadata = new Map(projects.map((project) => [
  project.key,
  { id: `group-${project.key}`, name: "initial", kind: "delegation" },
] as const))
const membership = new Map(
  projects.flatMap((project) => project.sessions.slice(0, 30)
    .map((session) => [session.id, project.key] as const)),
)
const members = new Map(
  projects.map((project) => [metadata.get(project.key)!.id, project.sessions.slice(0, 30)] as const),
)
const projectHeads = new Map(projects.map((project) =>
  [project.key, { sessions: project.sessions }] as const))
const groupBySession = new Map([...membership].map(([id, key]) =>
  [id, metadata.get(key)!] as const))
const emptySupplemental = new Map<string, Session[]>()
const rootMembership = indexChatSidebarProjectMembership(projects, emptySupplemental)
const liveGroupRevisions = () => chatSidebarIndexedProjectGroupRevisions(
  projectHeads.keys(), rootMembership, emptySupplemental, groupBySession, members,
)
const buildInput = (revision: unknown) => ({
  projects,
  supplemental: new Map<string, Session[]>(),
  working: new Map<string, Set<string>>(),
  sort: "updated" as const,
  groupRevision: revision,
  groupOf: (session: Session) => {
    const key = membership.get(session.id)
    return key ? metadata.get(key) : undefined
  },
  groupMembersOf: (group: { id: string }) => members.get(group.id) ?? [],
  titleOf: (session: Session) => session.title,
  pin: (rows: Session[]) => rows,
})
const normalize = (rows: ReturnType<ReturnType<typeof createChatSidebarProjectSectionCache>["build"]>) =>
  rows.map((section) => [
    section.key, section.items.length,
    section.items.map((item) => item.type === "cluster" ? item.group.name : item.key).join(";"),
  ])

const run = (targeted: boolean) => {
  const cache = createChatSidebarProjectSectionCache()
  let globalRevision = {}
  cache.build(buildInput(targeted ? liveGroupRevisions() : globalRevision))
  const start = performance.now()
  let count = 0
  for (let i = 0; i < 150; i++) {
    const key = projects[i % projectCount]!.key
    metadata.get(key)!.name = `v${i}`
    if (!targeted) globalRevision = {}
    // This now INCLUDES the real production per-project signature construction
    // on every group mutation, not an unrealistically free manual version tick.
    const output = cache.build(buildInput(targeted ? liveGroupRevisions() : globalRevision))
    count += output.reduce((sum, section) => sum + section.items.length, 0)
    if (i === 0 || i === 149) {
      const one = output[i % projectCount]!.items.find((item) => item.type === "cluster")
      if (one?.type !== "cluster" || one.group.name !== `v${i}`)
        throw new Error(`Stale grouped projection: ${key}, revision ${i}`)
    }
  }
  return { ms: performance.now() - start, count }
}

for (let trial = 0; trial < 3; trial++) {
  const full = run(false)
  const targeted = run(true)
  if (full.count !== targeted.count) throw new Error("Structural row-count regression")
  console.log(JSON.stringify({
    trial, projects: projectCount, sessions: projectCount * rowsPerProject,
    metadataRevisions: 150,
    globalMs: +full.ms.toFixed(2),
    targetedMs: +targeted.ms.toFixed(2),
    ratio: +(full.ms / targeted.ms).toFixed(2),
  }))
}