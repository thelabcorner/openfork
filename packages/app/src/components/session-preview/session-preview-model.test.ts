import { describe, expect, test } from "bun:test"
import type { SessionGroupMember } from "@opencode-ai/sdk/v2/client"
import type { SessionGroupEntry } from "@/context/session-groups"
import {
  buildSessionPreviewIndex,
  sessionPreviewGroupOnly,
  sessionPreviewRelationships,
  sessionPreviewRow,
  sessionPreviewTree,
  type SessionPreviewRow,
} from "./session-preview-model"

function member(input: Partial<SessionGroupMember> & { id: string }): SessionGroupMember {
  return {
    title: input.id,
    locked: false,
    origin: "user",
    position: 0,
    timeAdded: 0,
    ...input,
  }
}

function group(input: {
  id: string
  name?: string
  kind?: SessionGroupEntry["kind"]
  anchorSessionID?: string
  members: SessionGroupMember[]
  position?: number
}): SessionGroupEntry {
  return {
    id: input.id,
    name: input.name ?? input.id,
    kind: input.kind ?? "user",
    position: input.position ?? 0,
    anchorSessionID: input.anchorSessionID,
    sessionIds: input.members.map((m) => m.id),
    sessions: input.members,
    time: { created: 0, updated: 0 },
  }
}

describe("sessionPreviewTree", () => {
  const row = (id: string, parentID?: string): SessionPreviewRow => ({
    id,
    title: id,
    parentID,
    locked: false,
    origin: "user",
  })
  const shape = (rows: ReturnType<typeof sessionPreviewTree>) =>
    rows.map((r) => `${r.row.id}:${r.depth}${r.last ? "L" : ""}`)

  test("places children directly under their parent regardless of member order", () => {
    const rows = sessionPreviewTree([row("w1", "root"), row("root"), row("audit"), row("w2", "root"), row("w1a", "w1")])
    expect(shape(rows)).toEqual(["root:0", "w1:1", "w1a:2L", "w2:1L", "audit:0L"])
  })

  test("treats a parent outside the row set as a local root", () => {
    expect(shape(sessionPreviewTree([row("a", "elsewhere"), row("b", "a")]))).toEqual(["a:0L", "b:1L"])
  })

  test("caps depth and keeps parent cycles reachable", () => {
    const deep = sessionPreviewTree([row("a"), row("b", "a"), row("c", "b"), row("d", "c"), row("e", "d")], 2)
    expect(deep.map((r) => r.depth)).toEqual([0, 1, 2, 2, 2])
    const cycle = sessionPreviewTree([row("x", "y"), row("y", "x")])
    expect(cycle.map((r) => r.row.id).sort()).toEqual(["x", "y"])
  })
})

describe("sessionPreviewRow", () => {
  test("carries the group projection so the navigator never fetches per row", () => {
    const row = sessionPreviewRow(
      member({
        id: "ses_child",
        title: "Worker 1",
        slug: "worker-1",
        projectID: "prj",
        directory: "/repo",
        parentID: "ses_root",
        version: "1",
        time: { created: 10, updated: 20 },
        locked: true,
        origin: "auto_subagent",
        position: 1,
        timeAdded: 10,
      }),
    )
    expect(row).toMatchObject({ id: "ses_child", title: "Worker 1", parentID: "ses_root", updated: 20 })
    expect(row.session).toMatchObject({ id: "ses_child", directory: "/repo", parentID: "ses_root" })
  })

  test("legacy members without structural fields expose no ephemeral session", () => {
    const row = sessionPreviewRow(member({ id: "ses_old", title: "Old" }))
    expect(row.session).toBeUndefined()
  })
})

describe("sessionPreviewRelationships — ordinary structural topology", () => {
  test("ordinary parent-child subagents render as one tree, nested subagents included", () => {
    const root = member({ id: "root", origin: "auto_subagent" })
    const child = member({ id: "child", parentID: "root", origin: "auto_subagent" })
    const grandchild = member({ id: "grandchild", parentID: "child", origin: "auto_subagent" })
    const groups = [group({ id: "g1", kind: "subagent", anchorSessionID: "root", members: [root, child, grandchild] })]

    const result = sessionPreviewRelationships({ sessionID: "root", groups })
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0]!.kind).toBe("subagent")
    expect(result.sections[0]!.rows.map((r) => [r.row.id, r.depth])).toEqual([
      ["root", 0],
      ["child", 1],
      ["grandchild", 2],
    ])
  })

  test("does not manufacture hierarchy for an unanchored delegation batch", () => {
    const root = member({ id: "root", origin: "delegation" })
    const a = member({ id: "a", origin: "delegation" })
    const b = member({ id: "b", origin: "delegation", parentID: "a" })
    const groups = [group({ id: "d1", kind: "delegation", members: [root, a, b] })]

    const result = sessionPreviewRelationships({ sessionID: "root", groups })
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0]!.kind).toBe("delegation")
    // Flat: b is not nested under a even though it carries a parentID.
    expect(result.sections[0]!.rows.every((r) => r.depth === 0)).toBe(true)
  })

  test("keeps plugin-owned groups distinct and merges only groups sharing one anchor", () => {
    const coordinator = member({ id: "coord", origin: "plugin" })
    const workerA = member({ id: "a", origin: "plugin" })
    const workerB = member({ id: "b", origin: "plugin" })
    const first = group({ id: "p1", name: "Plugin A", kind: "plugin", anchorSessionID: "coord", members: [coordinator, workerA] })
    const second = group({ id: "p2", name: "Plugin B", kind: "plugin", anchorSessionID: "coord", members: [coordinator, workerB] })

    const result = sessionPreviewRelationships({ sessionID: "coord", groups: [first, second] })
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0]!.name).toBe("Plugin A · Plugin B")
    expect(result.sections[0]!.rows.map((r) => r.row.id)).toEqual(["coord", "a", "b"])
  })

  test("never merges multiple unrelated manual groups", () => {
    const a = member({ id: "a" })
    const b = member({ id: "b" })
    const first = group({ id: "m1", name: "Folder 1", kind: "user", members: [a] })
    const second = group({ id: "m2", name: "Folder 2", kind: "user", members: [b] })

    const result = sessionPreviewRelationships({ sessionID: "a", groups: [first, second] })
    // "a" is a member of "m1" directly; "m2" does not include "a", so only one
    // manual section should surface for this session.
    expect(result.sections.filter((s) => s.kind === "manual")).toHaveLength(1)
    expect(result.sections[0]!.name).toBe("Folder 1")
  })

  test("keeps multiple native Swarms containing the same session as separate sections", () => {
    const session = member({ id: "s", origin: "swarm" })
    const other1 = member({ id: "o1", origin: "swarm" })
    const other2 = member({ id: "o2", origin: "swarm" })
    const swarmA = group({ id: "grp_swarm_a", name: "Swarm A", kind: "swarm", members: [session, other1] })
    const swarmB = group({ id: "grp_swarm_b", name: "Swarm B", kind: "swarm", members: [session, other2] })

    const result = sessionPreviewRelationships({ sessionID: "s", groups: [swarmA, swarmB] })
    const swarmSections = result.sections.filter((sec) => sec.kind === "swarm")
    expect(swarmSections.map((sec) => sec.name)).toEqual(["Swarm A", "Swarm B"])
  })

  test("archived members are excluded everywhere", () => {
    const active = member({ id: "active" })
    const archived = member({ id: "gone", time: { created: 0, updated: 0, archived: 5 } })
    const groups = [group({ id: "m1", kind: "user", members: [active, archived] })]

    const result = sessionPreviewRelationships({ sessionID: "active", groups })
    expect(result.sections[0]!.rows.map((r) => r.row.id)).toEqual(["active"])
  })
})

describe("sessionPreviewRelationships — special agents", () => {
  test("classifies a special agent owned directly by the hovered (root) session", () => {
    const root = member({ id: "root", origin: "auto_subagent" })
    const auditor = member({ id: "auditor", parentID: "root", origin: "goal_auditor", specialAgent: "goal_auditor" })
    const groups = [group({ id: "g1", kind: "subagent", anchorSessionID: "root", members: [root, auditor] })]

    const result = sessionPreviewRelationships({ sessionID: "root", groups })
    expect(result.specialAgents).toHaveLength(1)
    expect(result.specialAgents[0]!.row.id).toBe("auditor")
    expect(result.specialAgents[0]!.row.specialAgent).toBe("goal_auditor")
    // Excluded from the ordinary subagent section, not duplicated as a worker.
    expect(result.sections[0]!.rows.map((r) => r.row.id)).toEqual(["root"])
  })

  test.each([
    ["goal_auditor"],
    ["goal_revisor"],
    ["prompt_revisor"],
    ["session_title"],
    ["spad_auditor"],
    ["future_special_agent_kind"],
  ])("surfaces %s as a special agent even if unknown", (kind) => {
    const root = member({ id: "root", origin: "auto_subagent" })
    const agent = member({ id: "agent", parentID: "root", origin: "special_agent", specialAgent: kind })
    const groups = [group({ id: "g1", kind: "subagent", anchorSessionID: "root", members: [root, agent] })]

    const result = sessionPreviewRelationships({ sessionID: "root", groups })
    expect(result.specialAgents.map((entry) => entry.row.specialAgent)).toEqual([kind])
  })

  test("falls back to origin-only classification for old servers missing the specialAgent scalar", () => {
    const root = member({ id: "root", origin: "auto_subagent" })
    const legacyGoalAuditor = member({ id: "old-auditor", parentID: "root", origin: "goal_auditor" })
    const legacyGeneric = member({ id: "old-generic", parentID: "root", origin: "special_agent" })
    const ordinary = member({ id: "worker", parentID: "root", origin: "auto_subagent" })
    const groups = [
      group({ id: "g1", kind: "subagent", anchorSessionID: "root", members: [root, legacyGoalAuditor, legacyGeneric, ordinary] }),
    ]

    const result = sessionPreviewRelationships({ sessionID: "root", groups })
    const ids = result.specialAgents.map((entry) => entry.row.id).sort()
    expect(ids).toEqual(["old-auditor", "old-generic"])
    expect(result.specialAgents.find((e) => e.row.id === "old-auditor")?.row.specialAgent).toBe("goal_auditor")
    expect(result.specialAgents.find((e) => e.row.id === "old-generic")?.row.specialAgent).toBeUndefined()
    expect(result.sections[0]!.rows.map((r) => r.row.id)).toEqual(["root", "worker"])
  })

  test("reaches a special agent owned by a nested worker several levels down", () => {
    const root = member({ id: "root", origin: "auto_subagent" })
    const worker = member({ id: "worker", parentID: "root", origin: "auto_subagent" })
    const rootGroup = group({ id: "g-root", kind: "subagent", anchorSessionID: "root", members: [root, worker] })

    // The worker itself anchors its own subagent group containing a nested
    // special agent — a structurally distinct SessionGroup, not a child of
    // the root's own group.
    const nestedAgent = member({ id: "nested-agent", parentID: "worker", origin: "special_agent", specialAgent: "prompt_revisor" })
    const nestedWorkerRow = member({ id: "worker", origin: "auto_subagent" })
    const nestedGroup = group({ id: "g-worker", kind: "subagent", anchorSessionID: "worker", members: [nestedWorkerRow, nestedAgent] })

    const result = sessionPreviewRelationships({ sessionID: "root", groups: [rootGroup, nestedGroup] })
    expect(result.specialAgents.map((entry) => entry.row.id)).toEqual(["nested-agent"])
    expect(result.specialAgents[0]!.parentTitle).toBe("worker")
    // Only the root's own group renders as a visible section; the nested
    // group's ordinary members are not inlined as a second worker section.
    expect(result.sections).toHaveLength(1)
  })

  test("is cycle-safe and bounded under corrupt structural data", () => {
    const a = member({ id: "a", origin: "auto_subagent" })
    const b = member({ id: "b", parentID: "a", origin: "auto_subagent" })
    // b's own anchored group points right back to a, forming a cycle.
    const groupA = group({ id: "g-a", kind: "subagent", anchorSessionID: "a", members: [a, b] })
    const groupB = group({ id: "g-b", kind: "subagent", anchorSessionID: "b", members: [b, a] })

    expect(() => sessionPreviewRelationships({ sessionID: "a", groups: [groupA, groupB], maxDepth: 5, maxNodes: 50 })).not.toThrow()
  })

  test("stable ordering and dedup: the same special agent id is never reported twice", () => {
    const root = member({ id: "root", origin: "auto_subagent" })
    const agent = member({ id: "agent", parentID: "root", origin: "goal_auditor", specialAgent: "goal_auditor" })
    // Two different anchored groups both happen to carry the same agent id
    // (defensive: should not happen in practice, but dedup must hold).
    const groupOne = group({ id: "g1", kind: "subagent", anchorSessionID: "root", members: [root, agent] })
    const groupTwo = group({ id: "g2", kind: "plugin", anchorSessionID: "root", members: [root, agent] })

    const result = sessionPreviewRelationships({ sessionID: "root", groups: [groupOne, groupTwo] })
    expect(result.specialAgents).toHaveLength(1)
  })
})

describe("buildSessionPreviewIndex", () => {
  test("indexed relationship lookup matches the unindexed computation", () => {
    const root = member({ id: "root", origin: "auto_subagent" })
    const child = member({ id: "child", parentID: "root", origin: "auto_subagent" })
    const groups = [group({ id: "g1", kind: "subagent", anchorSessionID: "root", members: [root, child] })]
    const index = buildSessionPreviewIndex(groups)

    expect(sessionPreviewRelationships({ sessionID: "root", groups, index })).toEqual(
      sessionPreviewRelationships({ sessionID: "root", groups }),
    )
  })
})

describe("sessionPreviewGroupOnly", () => {
  test("projects a raw group into one tree section for group-tab previews", () => {
    const a = member({ id: "a", origin: "auto_subagent" })
    const b = member({ id: "b", parentID: "a", origin: "auto_subagent" })
    const entry = group({ id: "g1", name: "My Group", kind: "subagent", members: [a, b] })

    const section = sessionPreviewGroupOnly(entry)
    expect(section.kind).toBe("subagent")
    expect(section.name).toBe("My Group")
    expect(section.rows.map((r) => [r.row.id, r.depth])).toEqual([
      ["a", 0],
      ["b", 1],
    ])
  })
})
