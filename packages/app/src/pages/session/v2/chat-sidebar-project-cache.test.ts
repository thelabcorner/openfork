import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  buildChatSidebarSections,
  type ChatSidebarClusterGroup,
  type ChatSidebarTreeInput,
} from "./chat-sidebar-tree"
import {
  chatSidebarIndexedProjectGroupRevisions,
  chatSidebarProjectGroupRevisions,
  createChatSidebarProjectSectionCache,
  indexChatSidebarProjectMembership,
  reuseChatSidebarProjectMemberLists,
  workingChatSidebarProjects,
} from "./chat-sidebar-project-cache"

const session = (id: string, updated: number) =>
  ({ id, title: id, time: { created: updated, updated } }) as Session

describe("sidebar Project section-level work avoidance", () => {
  test("sparse indexed project group signatures match reference invalidation under mutations", () => {
    let seed = 209887
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    for (let trial = 0; trial < 150; trial++) {
      const projects = new Map(Array.from({ length: 2 + random(12) }, (_, p) => [
        `p${p}`, { sessions: Array.from({ length: 15 + random(25) }, (_, i) =>
          session(`p${p}-s${i}`, 100 - i)) },
      ] as const))
      const metadata = Array.from({ length: 5 + random(12) }, (_, i) => ({
        id: `g${i}`, name: `Group ${i}`, kind: "delegation",
      }))
      const mapped = new Map<string, ChatSidebarClusterGroup>()
      const byGroup = new Map<string, Session[]>()
      for (const project of projects.values()) for (const row of project.sessions) {
        if (random(3) === 0) continue
        const group = metadata[random(metadata.length)]!
        mapped.set(row.id, group)
        if (!byGroup.has(group.id)) byGroup.set(group.id, [])
        byGroup.get(group.id)!.push(row)
      }
      const supplement = new Map<string, Session[]>()
      const rootMembership = indexChatSidebarProjectMembership(
        [...projects].map(([key, value]) => ({ key, total: value.sessions.length, sessions: value.sessions })),
        new Map(),
      )
      const exact = () => chatSidebarProjectGroupRevisions(projects, supplement, mapped, byGroup)
      const indexed = () => chatSidebarIndexedProjectGroupRevisions(
        projects.keys(), rootMembership, supplement, mapped, byGroup)
      const before = exact()
      const baseline = indexed()
      const group = metadata[random(metadata.length)]!
      const groupRows = byGroup.get(group.id) ?? []
      if (groupRows.length > 1) groupRows.reverse()
      else group.name += " renamed"
      if (groupRows.length && random(2) === 0) groupRows[0]!.title += " updated"
      const afterExact = exact()
      const afterIndexed = indexed()
      for (const key of projects.keys()) {
        expect(afterIndexed.get(key) !== baseline.get(key))
          .toBe(afterExact.get(key) !== before.get(key))
      }
    }
  })
  test("group member reordering and in-place title updates invalidate only linked project signatures", () => {
    const a = session("a", 3)
    const b = session("b", 2)
    const unrelated = session("other", 1)
    const projects = new Map([
      ["/a", { sessions: [a, b] }],
      ["/other", { sessions: [unrelated] }],
    ])
    const group: ChatSidebarClusterGroup = { id: "g", name: "Workers", kind: "delegation" }
    const memberships = new Map([["a", group], ["b", group]])
    const byGroup = new Map([["g", [a, b]]])
    const revisions = () => chatSidebarProjectGroupRevisions(projects, new Map(), memberships, byGroup)
    const before = revisions()
    byGroup.set("g", [b, a])
    const reordered = revisions()
    expect(reordered.get("/a")).not.toBe(before.get("/a"))
    expect(reordered.get("/other")).toBe(before.get("/other"))
    a.title = "Renamed in place"
    const renamed = revisions()
    expect(renamed.get("/a")).not.toBe(reordered.get("/a"))
    expect(renamed.get("/other")).toBe(reordered.get("/other"))
    a.time.updated = 100
    const refreshed = revisions()
    expect(refreshed.get("/a")).not.toBe(renamed.get("/a"))
    group.name = "New group name"
    expect(revisions().get("/a")).not.toBe(refreshed.get("/a"))
  })
  test("stable member-list identities survive an unrelated project's roster churn", () => {
    const a = [session("a", 3), session("b", 2)]
    const b = [session("c", 1)]
    const initial = new Map([["/a", a], ["/b", b]])
    const changed = reuseChatSidebarProjectMemberLists(initial, new Map([
      ["/a", [...a]], ["/b", [session("new", 10), ...b]],
    ]))
    expect(changed.get("/a")).toBe(a)
    expect(changed.get("/b")).not.toBe(b)
    const unchanged = reuseChatSidebarProjectMemberLists(initial, new Map([
      ["/a", [...a]], ["/b", [...b]],
    ]))
    expect(unchanged.get("/a")).toBe(a)
    expect(unchanged.get("/b")).toBe(b)
  })

  test("per-project group revisions do not rebuild unrelated project sections", () => {
    const projects = [
      { key: "/a", total: 2, project: { id: "a" }, sessions: [session("a", 3)] },
      { key: "/b", total: 2, project: { id: "b" }, sessions: [session("b", 2)] },
      { key: "/c", total: 2, project: { id: "c" }, sessions: [session("c", 1)] },
    ]
    const cache = createChatSidebarProjectSectionCache()
    const members = new Map<string, Session[]>()
    const groupRevisions = new Map([["/a", "group-a"], ["/b", "group-b"], ["/c", "group-c"]])
    const group: ChatSidebarClusterGroup = { id: "g", name: "before", kind: "user" }
    const build = () => cache.build({
      projects, supplemental: members,
      working: new Map(), sort: "updated", groupRevision: groupRevisions,
      groupOf: (row) => row.id === "a" ? group : undefined,
      groupMembersOf: () => [], titleOf: (row) => row.title,
      pin: (rows) => rows,
    })
    const before = build()
    const repeated = build()
    expect(repeated[0]).toBe(before[0])
    expect(repeated[1]).toBe(before[1])
    group.name = "after"
    groupRevisions.set("/a", "group-a:renamed")
    const after = build()
    expect(after[0]).not.toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(after[2]).toBe(before[2])
  })
  test("the same section reference is retained when a foreign project's working IDs change", () => {
    const a = [session("a", 5), session("a2", 1)]
    const b = [session("b", 4), session("b2", 2)]
    const projects = [
      { key: "/a", total: 20, sessions: a, project: { id: "a" } },
      { key: "/b", total: 10, sessions: b, project: { id: "b" } },
    ]
    const supplemental = new Map<string, Session[]>()
    const lookup = indexChatSidebarProjectMembership(projects, supplemental)
    const cache = createChatSidebarProjectSectionCache()
    let working = new Set<string>()
    const pin = (rows: Session[]) => [
      ...rows.filter((row) => working.has(row.id)), ...rows.filter((row) => !working.has(row.id)),
    ]
    const build = () => cache.build({
      projects, supplemental,
      working: workingChatSidebarProjects(working, lookup),
      sort: "updated", groupRevision: null,
      groupOf: () => undefined,
      groupMembersOf: () => [],
      titleOf: (row) => row.title, pin,
    })
    const before = build()
    working = new Set(["a2"])
    const after = build()
    expect(after[0]).not.toBe(before[0])
    expect(after[1]).toBe(before[1])
    expect(after[0]!.items.map((item) => item.key)).toEqual(["s:a2", "s:a"])
    expect(build()[0]).toBe(after[0])
    expect(build()[1]).toBe(after[1])
    expect(workingChatSidebarProjects(new Set(["foreign"]), lookup).size).toBe(0)
    cache.clear()
    expect(build()[1]).not.toBe(after[1])
  })

  test("randomized parity with the full multi-project builder under working churn", () => {
    let seed = 734829
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    for (let trial = 0; trial < 200; trial++) {
      const projects = Array.from({ length: 2 + random(12) }, (_, index) => ({
        key: `project-${index}`,
        total: 10,
        project: { id: String(index) },
        sessions: Array.from({ length: random(45) }, (_, i) =>
          session(`p${index}-s${i}`, random(110))),
      }))
      const supplemental = new Map<string, Session[]>()
      const allRows = projects.flatMap((project) => project.sessions)
      const lookup = indexChatSidebarProjectMembership(projects, supplemental)
      const cache = createChatSidebarProjectSectionCache()
      const groups = new Map<string, ChatSidebarClusterGroup>()
      for (const project of projects) {
        const group = { id: `g-${project.key}`, name: project.key, kind: "user" }
        for (const row of project.sessions) if (random(3) === 0) groups.set(row.id, group)
      }
      let working = new Set<string>()
      const groupOf = (row: Session) => groups.get(row.id)
      const pin = (rows: Session[]) => [
        ...rows.filter((row) => working.has(row.id)).reverse(),
        ...rows.filter((row) => !working.has(row.id)),
      ]
      let revision: object = {}
      const compute = () => cache.build({
        projects, supplemental,
        working: workingChatSidebarProjects(working, lookup),
        sort: "updated", groupRevision: revision,
        groupOf, groupMembersOf: () => [],
        titleOf: (row) => row.title, pin,
      })
      for (let update = 0; update < 7; update++) {
        working = new Set(allRows.filter(() => random(8) === 0).map((row) => row.id))
        if (random(4) === 0) revision = {}
        const cached = compute()
        const fullInput: ChatSidebarTreeInput = {
          mode: "projects", sort: "updated", recent: [], projects,
          groupOf, groupMembersOf: () => [], stateOf: () => "idle",
          titleOf: (row) => row.title, pin, cluster: true,
          limit: Number.POSITIVE_INFINITY,
          sessionsForScope: () => [],
        }
        const expected = buildChatSidebarSections(fullInput)
        expect(cached).toEqual(expected)
      }
    }
  })

  test("supplemental group members share project scope and invalidate only affected section", () => {
    const projects = [
      { key: "/a", total: 1, sessions: [session("a", 10)] },
      { key: "/b", total: 1, sessions: [session("b", 9)] },
    ]
    const members = new Map<string, Session[]>([["/a", [session("worker", 8)]]])
    const membership = indexChatSidebarProjectMembership(projects, members)
    expect(membership.get("worker")).toEqual(["/a"])
    const cache = createChatSidebarProjectSectionCache()
    const input = (working: Set<string>) => cache.build({
      projects, supplemental: members,
      working: workingChatSidebarProjects(working, membership),
      sort: "updated", groupRevision: {},
      groupOf: () => undefined,
      groupMembersOf: () => [],
      titleOf: (row) => row.title,
      pin: (rows) => [...rows.filter((row) => working.has(row.id)), ...rows.filter((row) => !working.has(row.id))],
    })
    expect(input(new Set(["worker"]))[0]!.items[0]?.key).toBe("s:worker")
  })

  test("group roster updates invalidate only the affected cluster's project projection", () => {
    const parent = session("root", 9)
    const member = session("worker", 10)
    const projects = [{ key: "/a", total: 2, project: { id: "a" }, sessions: [parent] }]
    const supplemental = new Map<string, Session[]>([["/a", [member]]])
    const membership = indexChatSidebarProjectMembership(projects, supplemental)
    let group = { id: "batch", name: "Before", kind: "delegation" }
    let groupRevision = {}
    const cache = createChatSidebarProjectSectionCache()
    const build = () => cache.build({
      projects, supplemental,
      working: workingChatSidebarProjects(new Set(["worker"]), membership),
      sort: "updated", groupRevision,
      groupOf: () => group,
      groupMembersOf: () => [member, parent],
      titleOf: (row) => row.title,
      pin: (rows) => rows,
    })
    const before = build()
    expect(before[0]!.items[0]?.type).toBe("cluster")
    expect(build()[0]).toBe(before[0])
    group = { id: "batch", name: "After", kind: "delegation" }
    groupRevision = {}
    const after = build()
    expect(after[0]).not.toBe(before[0])
    const first = after[0]!.items[0]
    expect(first?.type).toBe("cluster")
    if (first?.type === "cluster") expect(first.group.name).toBe("After")
  })
})