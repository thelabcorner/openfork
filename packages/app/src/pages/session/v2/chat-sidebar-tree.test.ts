import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  buildChatSidebarSections,
  chatSidebarStatusBucket,
  clusterChatSidebarRows,
  clusterMemberLabel,
  collectChatSidebarWarmIDs,
  countChatSidebarClusterStates,
  mergeChatSidebarRecent,
  reconcileChatSidebarSlots,
  reuseChatSidebarSections,
  sameChatSidebarClusterCounts,
  sortChatSidebarSessions,
  type ChatSidebarClusterGroup,
  type ChatSidebarClusterItem,
  type ChatSidebarRowState,
  type ChatSidebarSection,
  type ChatSidebarTreeInput,
} from "./chat-sidebar-tree"

const s = (id: string, title = id, updated = 0, created = updated): Session =>
  ({ id, title, time: { created, updated } }) as unknown as Session

const ids = (rows: readonly Session[]) => rows.map((r) => r.id)
const grp = (id: string, name = id): ChatSidebarClusterGroup => ({ id, name, kind: "manual" })

function makeInput(
  over: Partial<ChatSidebarTreeInput> & {
    groups?: Record<string, ChatSidebarClusterGroup>
    states?: Record<string, ChatSidebarRowState>
  } = {},
): ChatSidebarTreeInput {
  const { groups = {}, states = {}, ...rest } = over
  return {
    mode: "recent",
    sort: "updated",
    recent: [],
    projects: [],
    groupOf: (x) => groups[x.id],
    stateOf: (x) => states[x.id] ?? "idle",
    titleOf: (x) => x.title,
    pin: (rows) => rows,
    limit: 100,
    cluster: true,
    ...rest,
  }
}

const cluster = (item: unknown) => item as ChatSidebarClusterItem

describe("chatSidebarStatusBucket", () => {
  test("error shares attention, others map to themselves", () => {
    expect(chatSidebarStatusBucket("error")).toBe("attention")
    expect(chatSidebarStatusBucket("attention")).toBe("attention")
    expect(chatSidebarStatusBucket("working")).toBe("working")
    expect(chatSidebarStatusBucket("unread")).toBe("unread")
    expect(chatSidebarStatusBucket("idle")).toBe("idle")
  })
})

describe("sortChatSidebarSessions", () => {
  test("updated desc", () => {
    const rows = [s("a", "a", 1), s("b", "b", 3), s("c", "c", 2)]
    expect(ids(sortChatSidebarSessions(rows, "updated", (x) => x.title))).toEqual(["b", "c", "a"])
  })
  test("created desc", () => {
    const rows = [s("a", "a", 9, 1), s("b", "b", 1, 3), s("c", "c", 5, 2)]
    expect(ids(sortChatSidebarSessions(rows, "created", (x) => x.title))).toEqual(["b", "c", "a"])
  })
  test("title uses numeric collation", () => {
    const rows = [s("1", "task 10"), s("2", "task 2"), s("3", "Task 1")]
    expect(ids(sortChatSidebarSessions(rows, "title", (x) => x.title))).toEqual(["3", "2", "1"])
  })
  test("title uses titleOf, not session.title", () => {
    const rows = [s("a", "z"), s("b", "a")]
    const map: Record<string, string> = { a: "alpha", b: "beta" }
    expect(ids(sortChatSidebarSessions(rows, "title", (x) => map[x.id]!))).toEqual(["a", "b"])
  })
  test("title is case-insensitive then id tie-break", () => {
    const rows = [s("b", "Same"), s("a", "same"), s("c", "SAME")]
    expect(ids(sortChatSidebarSessions(rows, "title", (x) => x.title))).toEqual(["a", "b", "c"])
  })
  test("stable id tie-break for equal times", () => {
    const rows = [s("c", "x", 5), s("a", "x", 5), s("b", "x", 5)]
    expect(ids(sortChatSidebarSessions(rows, "updated", (x) => x.title))).toEqual(["a", "b", "c"])
    expect(ids(sortChatSidebarSessions(rows, "created", (x) => x.title))).toEqual(["a", "b", "c"])
  })
  test("does not mutate input", () => {
    const rows = [s("a", "a", 1), s("b", "b", 2)]
    const out = sortChatSidebarSessions(rows, "updated", (x) => x.title)
    expect(out).not.toBe(rows)
    expect(ids(rows)).toEqual(["a", "b"])
    expect(ids(out)).toEqual(["b", "a"])
  })
  test("missing times fall back to the other timestamp or 0", () => {
    const noUpdated = { id: "n", title: "n", time: { created: 7 } } as unknown as Session
    const none = { id: "z", title: "z" } as unknown as Session
    const out = sortChatSidebarSessions([none, s("a", "a", 3), noUpdated], "updated", (x) => x.title)
    expect(ids(out)).toEqual(["n", "a", "z"])
  })
})

describe("mergeChatSidebarRecent", () => {
  test("adds missing roster members in canonical updated-time and ID order", () => {
    const roots = [s("a", "root a", 9), s("c", "root c", 5), s("e", "root e", 1)]
    const members = [s("f", "f", 1), s("b", "b", 9), s("d", "d", 5), s("c", "old duplicate", 100), s("b", "repeated", 80)]
    const merged = mergeChatSidebarRecent(roots, members)
    expect(ids(merged)).toEqual(["a", "b", "c", "d", "e", "f"])
    expect(merged[2]).toBe(roots[1])
    expect(merged[1]).toBe(members[1])
    expect(ids(roots)).toEqual(["a", "c", "e"])
    expect(ids(members)).toEqual(["f", "b", "d", "c", "b"])
  })

  test("reuses the root array when the roster contains no new IDs", () => {
    const roots = [s("a", "a", 2), s("b", "b", 1)]
    expect(mergeChatSidebarRecent(roots, [])).toBe(roots)
    expect(mergeChatSidebarRecent(roots, [s("a", "older", 10)])).toBe(roots)
  })

  test("already-sorted and foreign-unsorted updated-time inputs project identically", () => {
    const rows = [s("a", "a", 5), s("b", "b", 4), s("c", "c", 3)]
    const sorted = buildChatSidebarSections(makeInput({ recent: rows }))
    const reordered = buildChatSidebarSections(makeInput({ recent: [...rows].reverse() }))
    expect(sorted[0]!.items.map((item) => item.key)).toEqual(reordered[0]!.items.map((item) => item.key))
  })

  test("differential merge agrees with root-first sort across duplicate IDs and tied timestamps", () => {
    let seed = 0x1ad0beef
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    const compare = (a: Session, b: Session) =>
      (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    for (let trial = 0; trial < 150; trial++) {
      const roots = Array.from({ length: random(65) }, (_, index) =>
        s(`r${index}`, `r${index}`, random(10)),
      ).sort(compare)
      const members = Array.from({ length: random(90) }, (_, index) =>
        s(random(4) === 0 ? `r${random(65)}` : `m${random(45)}`, `member${index}`, random(10)),
      )
      const expected = new Map<string, Session>()
      for (const session of [...roots, ...members]) if (!expected.has(session.id)) expected.set(session.id, session)
      const output = mergeChatSidebarRecent(roots, members)
      const reference = [...expected.values()].sort(compare)
      expect(ids(output)).toEqual(ids(reference))
      expect(output).toEqual(reference)
    }
  })
})

describe("clusterMemberLabel", () => {
  test("strips separators", () => {
    expect(clusterMemberLabel("group / x", "group")).toBe("x")
    expect(clusterMemberLabel("group: x", "group")).toBe("x")
    expect(clusterMemberLabel("group — x", "group")).toBe("x")
    expect(clusterMemberLabel("group - x", "group")).toBe("x")
    expect(clusterMemberLabel("group | x", "group")).toBe("x")
    expect(clusterMemberLabel("group·x", "group")).toBe("x")
    expect(clusterMemberLabel("group x", "group")).toBe("x")
  })
  test("case-insensitive prefix match preserves the remainder's case", () => {
    expect(clusterMemberLabel("GROUP / Capture", "group")).toBe("Capture")
    expect(clusterMemberLabel("group / x", "GROUP")).toBe("x")
  })
  test("does not strip without a separator", () => {
    expect(clusterMemberLabel("builder-x", "build")).toBe("builder-x")
    expect(clusterMemberLabel("buildx", "build")).toBe("buildx")
  })
  test("returns original when remainder is empty or only separators", () => {
    expect(clusterMemberLabel("group", "group")).toBe("group")
    expect(clusterMemberLabel("group / ", "group")).toBe("group / ")
    expect(clusterMemberLabel("group -- ", "group")).toBe("group -- ")
  })
  test("returns original when title does not start with the name", () => {
    expect(clusterMemberLabel("other / x", "group")).toBe("other / x")
    expect(clusterMemberLabel("my group / x", "group")).toBe("my group / x")
  })
  test("empty or whitespace group name", () => {
    expect(clusterMemberLabel("anything / x", "")).toBe("anything / x")
    expect(clusterMemberLabel("anything / x", "   ")).toBe("anything / x")
  })
  test("group name is trimmed before matching", () => {
    expect(clusterMemberLabel("group / x", "  group  ")).toBe("x")
  })
})

describe("clusterChatSidebarRows", () => {
  const G = grp("g1", "alpha")
  const base = (over: Parameters<typeof makeInput>[0] = {}) => makeInput(over)

  test("folds >=2 members at first member index, others stay put", () => {
    const rows = [s("a"), s("m1", "alpha / one"), s("b"), s("m2", "alpha / two"), s("c")]
    const items = clusterChatSidebarRows(rows, base({ groups: { m1: G, m2: G } }), "recent")
    expect(items.map((i) => i.key)).toEqual(["s:a", "c:recent:g1", "s:b", "s:c"])
    const c = cluster(items[1])
    expect(c.type).toBe("cluster")
    expect(ids(c.members)).toEqual(["m1", "m2"])
    expect(c.lead).toBe(rows[1]!)
    expect(c.labels).toEqual(["one", "two"])
    expect(c.group).toBe(G)
  })
  test("single-member groups stay session items", () => {
    const rows = [s("a"), s("m1")]
    const items = clusterChatSidebarRows(rows, base({ groups: { m1: G } }), "recent")
    expect(items.map((i) => i.type)).toEqual(["session", "session"])
    expect(items.map((i) => i.key)).toEqual(["s:a", "s:m1"])
  })
  test("members keep section order and lead is first", () => {
    const rows = [s("z"), s("m3"), s("m1"), s("m2")]
    const items = clusterChatSidebarRows(rows, base({ groups: { m1: G, m2: G, m3: G } }), "k")
    const c = cluster(items[1])
    expect(ids(c.members)).toEqual(["m3", "m1", "m2"])
    expect(c.lead.id).toBe("m3")
    expect(c.labels.length).toBe(c.members.length)
  })
  test("counts per state and total", () => {
    const rows = [s("m1"), s("m2"), s("m3"), s("m4"), s("m5")]
    const states: Record<string, ChatSidebarRowState> = {
      m1: "working",
      m2: "working",
      m3: "error",
      m4: "unread",
      m5: "idle",
    }
    const groups = Object.fromEntries(rows.map((r) => [r.id, G]))
    const c = cluster(clusterChatSidebarRows(rows, base({ groups, states }), "x")[0])
    expect(countChatSidebarClusterStates(c.members, (m) => states[m.id] ?? "idle")).toEqual({ attention: 0, error: 1, working: 2, unread: 1, idle: 1, total: 5 })
  })
  test("multiple groups fold independently", () => {
    const H = grp("g2", "beta")
    const rows = [s("a1"), s("b1"), s("a2"), s("b2")]
    const items = clusterChatSidebarRows(rows, base({ groups: { a1: G, a2: G, b1: H, b2: H } }), "r")
    expect(items.map((i) => i.key)).toEqual(["c:r:g1", "c:r:g2"])
  })
  test("cluster:false yields only session items even with groups", () => {
    const rows = [s("m1"), s("m2")]
    const items = clusterChatSidebarRows(rows, base({ groups: { m1: G, m2: G }, cluster: false }), "r")
    expect(items).toEqual([
      { type: "session", key: "s:m1", session: rows[0] },
      { type: "session", key: "s:m2", session: rows[1] },
    ])
  })
  test("cluster key includes the section key", () => {
    const rows = [s("m1"), s("m2")]
    const groups = { m1: G, m2: G }
    expect(clusterChatSidebarRows(rows, base({ groups }), "project:p")[0]!.key).toBe("c:project:p:g1")
    expect(clusterChatSidebarRows(rows, base({ groups }), "status:idle")[0]!.key).toBe("c:status:idle:g1")
  })
  test("empty rows", () => {
    expect(clusterChatSidebarRows([], base(), "r")).toEqual([])
  })
})

describe("buildChatSidebarSections: recent", () => {
  test("empty pool yields no sections", () => {
    expect(buildChatSidebarSections(makeInput())).toEqual([])
  })
  test("basic recent section", () => {
    const recent = [s("a", "a", 1), s("b", "b", 2), s("c", "c", 3)]
    const secs = buildChatSidebarSections(makeInput({ recent }))
    expect(secs.length).toBe(1)
    const sec = secs[0]!
    expect(sec.key).toBe("recent")
    expect(sec.kind).toBe("recent")
    expect(sec.items.map((i) => i.key)).toEqual(["s:c", "s:b", "s:a"])
    expect(sec.sessionCount).toBe(3)
    expect(sec.total).toBe(3)
    expect(sec.hiddenItems).toBe(0)
  })
  test("limit applies to items, hiddenItems/sessionCount/total", () => {
    const recent = [1, 2, 3, 4, 5].map((n) => s(`s${n}`, `s${n}`, n))
    const sec = buildChatSidebarSections(makeInput({ recent, limit: 2 }))[0]!
    expect(sec.items.length).toBe(2)
    expect(sec.hiddenItems).toBe(3)
    expect(sec.sessionCount).toBe(2)
    expect(sec.total).toBe(5)
  })
  test("limit 0 hides everything; negative clamps to 0", () => {
    const recent = [s("a", "a", 1), s("b", "b", 2)]
    for (const limit of [0, -5]) {
      const sec = buildChatSidebarSections(makeInput({ recent, limit }))[0]!
      expect(sec.items).toEqual([])
      expect(sec.hiddenItems).toBe(2)
      expect(sec.sessionCount).toBe(0)
    }
  })
  test("a 30-member cluster counts as one item toward the limit", () => {
    const G = grp("big", "big")
    const members = Array.from({ length: 30 }, (_, i) => s(`m${String(i).padStart(2, "0")}`, `big / ${i}`, 1000 - i))
    const others = [s("x", "x", 10), s("y", "y", 5), s("z", "z", 1)]
    const groups = Object.fromEntries(members.map((m) => [m.id, G]))
    const sec = buildChatSidebarSections(makeInput({ recent: [...others, ...members], groups, limit: 2 }))[0]!
    expect(sec.items.map((i) => i.key)).toEqual(["c:recent:big", "s:x"])
    expect(sec.sessionCount).toBe(31)
    expect(sec.hiddenItems).toBe(2)
    expect(sec.total).toBe(33)
  })
  test("pin applies only for sort updated", () => {
    const recent = [s("a", "a", 1, 3), s("b", "b", 2, 2), s("c", "c", 3, 1)]
    const calls: string[][] = []
    const pin = (rows: Session[]) => {
      calls.push(ids(rows))
      return [...rows].reverse()
    }
    const upd = buildChatSidebarSections(makeInput({ recent, sort: "updated", pin }))[0]!
    expect(calls).toEqual([["c", "b", "a"]])
    expect(upd.items.map((i) => i.key)).toEqual(["s:a", "s:b", "s:c"])

    calls.length = 0
    const cre = buildChatSidebarSections(makeInput({ recent, sort: "created", pin }))[0]!
    const tit = buildChatSidebarSections(makeInput({ recent, sort: "title", pin }))[0]!
    expect(calls).toEqual([])
    expect(cre.items.map((i) => i.key)).toEqual(["s:a", "s:b", "s:c"])
    expect(tit.items.map((i) => i.key)).toEqual(["s:a", "s:b", "s:c"])
  })
  test("pin moving a specific id first is honored", () => {
    const recent = [s("a", "a", 3), s("b", "b", 2), s("c", "c", 1)]
    const pin = (rows: Session[]) => [...rows.filter((r) => r.id === "c"), ...rows.filter((r) => r.id !== "c")]
    const sec = buildChatSidebarSections(makeInput({ recent, pin }))[0]!
    expect(sec.items.map((i) => i.key)).toEqual(["s:c", "s:a", "s:b"])
  })
  test("recent mode ignores projects input", () => {
    const sec = buildChatSidebarSections(
      makeInput({ recent: [s("a")], projects: [{ key: "p", sessions: [s("p1")], total: 9 }] }),
    )
    expect(sec.map((x) => x.key)).toEqual(["recent"])
  })
})

describe("buildChatSidebarSections: projects", () => {
  test("one section per project, no client limit, total passes through", () => {
    const projects = [
      { key: "/a", sessions: [1, 2, 3, 4].map((n) => s(`a${n}`, `a${n}`, n)), total: 40 },
      { key: "/b", sessions: [], total: 0 },
    ]
    const secs = buildChatSidebarSections(makeInput({ mode: "projects", projects, limit: 1 }))
    expect(secs.map((x) => x.key)).toEqual(["project:/a", "project:/b"])
    expect(secs.map((x) => x.projectKey)).toEqual(["/a", "/b"])
    expect(secs.every((x) => x.kind === "project")).toBe(true)
    expect(secs[0]!.items.length).toBe(4)
    expect(secs[0]!.hiddenItems).toBe(0)
    expect(secs[0]!.sessionCount).toBe(4)
    expect(secs[0]!.total).toBe(40)
    expect(secs[1]!.items).toEqual([])
    expect(secs[1]!.total).toBe(0)
  })
  test("project items are sorted and clustered with a project-scoped key", () => {
    const G = grp("g", "g")
    const projects = [{ key: "p", sessions: [s("m1", "g / a", 1), s("m2", "g / b", 2), s("o", "o", 3)], total: 3 }]
    const sec = buildChatSidebarSections(makeInput({ mode: "projects", projects, groups: { m1: G, m2: G } }))[0]!
    expect(sec.items.map((i) => i.key)).toEqual(["s:o", "c:project:p:g"])
    expect(sec.sessionCount).toBe(3)
  })
  test("no projects yields []", () => {
    expect(buildChatSidebarSections(makeInput({ mode: "projects" }))).toEqual([])
  })
})

describe("buildChatSidebarSections: status", () => {
  const states: Record<string, ChatSidebarRowState> = {
    i1: "idle",
    i2: "idle",
    i3: "idle",
    u1: "unread",
    w1: "working",
    e1: "error",
    a1: "attention",
  }
  const all = Object.keys(states).map((id, n) => s(id, id, n))
  const sessionIDs = (items: readonly { type: string }[]) =>
    items.map((i) => (i as unknown as { session: Session }).session.id)

  test("bucket order and error lands in attention", () => {
    const secs = buildChatSidebarSections(makeInput({ mode: "status", recent: all, states }))
    expect(secs.map((x) => x.key)).toEqual(["status:attention", "status:working", "status:unread", "status:idle"])
    expect(secs.map((x) => x.status)).toEqual(["attention", "working", "unread", "idle"])
    expect(secs.every((x) => x.kind === "status")).toBe(true)
    // a1 has a higher "updated" than e1 (later in key order).
    expect(sessionIDs(secs[0]!.items)).toEqual(["a1", "e1"])
  })
  test("empty buckets omitted", () => {
    const secs = buildChatSidebarSections(
      makeInput({ mode: "status", recent: [s("w1"), s("i1")], states: { w1: "working" } }),
    )
    expect(secs.map((x) => x.status)).toEqual(["working", "idle"])
    expect(buildChatSidebarSections(makeInput({ mode: "status" }))).toEqual([])
  })
  test("only idle is limited", () => {
    const recent = [
      ...Array.from({ length: 4 }, (_, n) => s(`w${n}`, `w${n}`, n)),
      ...Array.from({ length: 5 }, (_, n) => s(`i${n}`, `i${n}`, n)),
    ]
    const st = Object.fromEntries(recent.map((r) => [r.id, r.id.startsWith("w") ? "working" : "idle"])) as Record<
      string,
      ChatSidebarRowState
    >
    const secs = buildChatSidebarSections(makeInput({ mode: "status", recent, states: st, limit: 2 }))
    const w = secs.find((x) => x.status === "working")!
    const i = secs.find((x) => x.status === "idle")!
    expect(w.items.length).toBe(4)
    expect(w.hiddenItems).toBe(0)
    expect(i.items.length).toBe(2)
    expect(i.hiddenItems).toBe(3)
    expect(i.total).toBe(5)
    expect(w.total).toBe(4)
  })
  test("group split across buckets clusters only where >=2 share a bucket", () => {
    const G = grp("g", "g")
    const recent = [s("m1", "g / 1", 4), s("m2", "g / 2", 3), s("m3", "g / 3", 2), s("m4", "g / 4", 1)]
    const st: Record<string, ChatSidebarRowState> = { m1: "working", m2: "working", m3: "unread", m4: "idle" }
    const groups = Object.fromEntries(recent.map((r) => [r.id, G]))
    const secs = buildChatSidebarSections(makeInput({ mode: "status", recent, states: st, groups }))
    const by: Record<string, ChatSidebarSection> = Object.fromEntries(secs.map((x) => [x.status, x]))
    expect(by.working!.items.map((i) => i.key)).toEqual(["c:status:working:g"])
    expect(by.unread!.items.map((i) => i.key)).toEqual(["s:m3"])
    expect(by.idle!.items.map((i) => i.key)).toEqual(["s:m4"])
  })
  test("error and attention members of one group cluster together in attention", () => {
    const G = grp("g", "g")
    const recent = [s("m1"), s("m2")]
    const secs = buildChatSidebarSections(
      makeInput({
        mode: "status",
        recent,
        groups: { m1: G, m2: G },
        states: { m1: "error", m2: "attention" },
      }),
    )
    expect(secs.length).toBe(1)
    const c = cluster(secs[0]!.items[0])
    const counts = countChatSidebarClusterStates(c.members, (m) => (m.id === "m1" ? "error" : "attention"))
    expect(counts.error).toBe(1)
    expect(counts.attention).toBe(1)
    expect(counts.total).toBe(2)
  })
})

describe("reuseChatSidebarSections", () => {
  const G = grp("g", "g")
  const pool = [s("a", "a", 5), s("m1", "g / 1", 4), s("m2", "g / 2", 3), s("b", "b", 2)]
  const build = (states: Record<string, ChatSidebarRowState> = {}, over: Partial<ChatSidebarTreeInput> = {}) =>
    buildChatSidebarSections(makeInput({ recent: pool, groups: { m1: G, m2: G }, states, ...over }))

  test("undefined previous returns next", () => {
    const next = build()
    expect(reuseChatSidebarSections(undefined, next)).toBe(next)
  })
  test("identical recompute reuses section and item objects", () => {
    const prev = build()
    const out = reuseChatSidebarSections(prev, build())
    expect(out).toBe(prev)
    expect(out[0]).toBe(prev[0]!)
    out[0]!.items.forEach((item, i) => expect(item).toBe(prev[0]!.items[i]!))
  })
  test("a single member state flip replaces nothing: sections and items keep identity", () => {
    const prev = build()
    const out = reuseChatSidebarSections(prev, build({ m1: "working" }))
    expect(out).toBe(prev)
    expect(out[0]).toBe(prev[0]!)
    out[0]!.items.forEach((item, i) => expect(item).toBe(prev[0]!.items[i]!))
  })
  test("a member reorder replaces only that cluster item, siblings keep identity", () => {
    const prev = build()
    // Pin m2 (now working) ahead of m1 inside the group.
    const out = reuseChatSidebarSections(
      prev,
      build({ m2: "working" }, { pin: (rows) => [...rows.filter((r) => r.id === "m2"), ...rows.filter((r) => r.id !== "m2")] }),
    )
    const next = out[0]!.items
    const before = prev[0]!.items
    const c = next.find((i) => i.type === "cluster")!
    expect(c).not.toBe(before.find((i) => i.type === "cluster")!)
    expect(ids(cluster(c).members)).toEqual(["m2", "m1"])
    // Plain session rows keep identity even though the cluster moved ahead of them.
    for (const item of next.filter((i) => i.type === "session")) expect(before).toContain(item)
  })
  test("recent/projects clustering never evaluates stateOf", () => {
    let calls = 0
    const input = makeInput({ recent: pool, groups: { m1: G, m2: G } })
    input.stateOf = () => {
      calls += 1
      return "idle"
    }
    buildChatSidebarSections(input)
    buildChatSidebarSections({ ...input, mode: "projects", projects: [{ key: "p", sessions: pool, total: 4 }] })
    expect(calls).toBe(0)
  })
  test("identical cluster counts compare equal; a flip does not", () => {
    const a = countChatSidebarClusterStates([s("m1"), s("m2")], () => "idle")
    const b = countChatSidebarClusterStates([s("m1"), s("m2")], () => "idle")
    const c = countChatSidebarClusterStates([s("m1"), s("m2")], (m) => (m.id === "m1" ? "working" : "idle"))
    expect(sameChatSidebarClusterCounts(a, b)).toBe(true)
    expect(sameChatSidebarClusterCounts(a, c)).toBe(false)
  })
  test("changed section total yields new section but unchanged items keep identity", () => {
    const prev = build()
    const next = build()
    next[0]!.total = prev[0]!.total + 10
    const out = reuseChatSidebarSections(prev, next)
    expect(out[0]).not.toBe(prev[0]!)
    expect(out[0]!.total).toBe(prev[0]!.total + 10)
    out[0]!.items.forEach((item, i) => expect(item).toBe(prev[0]!.items[i]!))
  })
  test("changed hiddenItems yields new section", () => {
    const prev = build({}, { limit: 3 })
    const out = reuseChatSidebarSections(prev, build({}, { limit: 2 }))
    expect(out[0]).not.toBe(prev[0]!)
    expect(out[0]!.hiddenItems).toBe(prev[0]!.hiddenItems + 1)
  })
  test("new session object with same id replaces the item", () => {
    const prev = build()
    const replaced = pool.map((x) => (x.id === "a" ? s("a", "a", 5) : x))
    const next = buildChatSidebarSections(makeInput({ recent: replaced, groups: { m1: G, m2: G } }))
    const out = reuseChatSidebarSections(prev, next)
    expect(out[0]!.items[0]).not.toBe(prev[0]!.items[0]!)
    expect(out[0]!.items[1]).toBe(prev[0]!.items[1]!)
  })
  test("session items replace cluster items when clustering is turned off", () => {
    const prev = build()
    const next = buildChatSidebarSections(makeInput({ recent: pool, cluster: false }))
    const out = reuseChatSidebarSections(prev, next)
    expect(out[0]!.items.every((i) => i.type === "session")).toBe(true)
  })
  test("sections are matched by key; new sections pass through", () => {
    const states: Record<string, ChatSidebarRowState> = { a: "working", b: "idle" }
    const mk = (st: Record<string, ChatSidebarRowState>) =>
      buildChatSidebarSections(makeInput({ mode: "status", recent: pool, states: st }))
    const prev = mk(states)
    const out = reuseChatSidebarSections(prev, mk({ ...states, b: "unread" }))
    const byKey = Object.fromEntries(out.map((x) => [x.key, x]))
    expect(byKey["status:working"]).toBe(prev.find((x) => x.key === "status:working")!)
    expect(byKey["status:unread"]).toBeDefined()
    expect(prev.find((x) => x.key === "status:unread")).toBeUndefined()
  })
  test("cluster membership change yields a new cluster", () => {
    const prev = build()
    const next = buildChatSidebarSections(
      makeInput({ recent: [...pool, s("m3", "g / 3", 1)], groups: { m1: G, m2: G, m3: G } }),
    )
    const out = reuseChatSidebarSections(prev, next)
    const pc = prev[0]!.items.find((i) => i.type === "cluster")!
    const nc = out[0]!.items.find((i) => i.type === "cluster")!
    expect(nc).not.toBe(pc)
    expect(cluster(nc).members.length).toBe(3)
  })
})

describe("collectChatSidebarWarmIDs", () => {
  const G = grp("g", "g")
  const pool = [s("a", "a", 5), s("m1", "g / 1", 4), s("m2", "g / 2", 3), s("m3", "g / 3", 2)]
  const sections = buildChatSidebarSections(makeInput({ recent: pool, groups: { m1: G, m2: G, m3: G } }))
  const open = () => true

  test("collapsed cluster members are NOT warmed; only the lead anchors the head", () => {
    const ids = collectChatSidebarWarmIDs(sections, { section: open, cluster: () => false })
    expect([...ids].sort()).toEqual(["a", "m1"])
  })
  test("an expanded cluster warms every member", () => {
    const ids = collectChatSidebarWarmIDs(sections, { section: open, cluster: (id) => id === "g" })
    expect([...ids].sort()).toEqual(["a", "m1", "m2", "m3"])
  })
  test("collapsed sections warm nothing, even with expanded clusters", () => {
    const ids = collectChatSidebarWarmIDs(sections, { section: () => false, cluster: () => true })
    expect(ids.size).toBe(0)
  })
})

describe("reconcileChatSidebarSlots", () => {
  type Box = { key: string; v: number }
  const mk = (key: string, v: number): Box => ({ key, v })
  const create = (key: string, item: Box) => {
    let value = item
    return { key, get: () => value, set: (next: Box) => void (value = next) }
  }
  const run = (prev: ReturnType<typeof reconcileChatSidebarSlots<Box>> | undefined, items: Box[], update = true) =>
    reconcileChatSidebarSlots(prev, items, (x) => x.key, () => update, create)

  test("same refs return the previous state object untouched", () => {
    const items = [mk("a", 1), mk("b", 2)]
    const first = run(undefined, items)
    expect(run(first, [...items])).toBe(first)
  })
  test("a re-minted value updates its slot in place: slot identity and array survive", () => {
    const first = run(undefined, [mk("a", 1), mk("b", 2)])
    const second = run(first, [mk("a", 1), mk("b", 3)])
    expect(second).toBe(first)
    expect(second.slots[1]!.get().v).toBe(3)
  })
  test("canUpdate=false replaces only that slot", () => {
    const a = mk("a", 1)
    const first = run(undefined, [a, mk("b", 2)])
    const second = run(first, [a, mk("b", 3)], false)
    expect(second.slots[0]).toBe(first.slots[0]!)
    expect(second.slots[1]).not.toBe(first.slots[1]!)
  })
  test("reorder keeps slots (moves, not remounts); removed keys drop out", () => {
    const a = mk("a", 1)
    const b = mk("b", 2)
    const first = run(undefined, [a, b, mk("c", 3)])
    const second = run(first, [b, a])
    expect(second.slots[0]).toBe(first.slots[1]!)
    expect(second.slots[1]).toBe(first.slots[0]!)
    expect(second.slots.length).toBe(2)
  })
  test("duplicate keys never share a slot", () => {
    const state = run(undefined, [mk("a", 1), mk("a", 2)])
    expect(state.slots[0]).not.toBe(state.slots[1]!)
  })
})
