import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { SessionGroupEntry } from "@/context/session-groups"
import { buildChatSidebarSessionTreeRows } from "./chat-sidebar-session-tree"

const session = (id: string, parentID?: string): Session =>
  ({
    id,
    slug: id,
    parentID,
    title: id,
    directory: "C:/repo",
    projectID: "project",
    version: "1",
    time: { created: 1, updated: 1 },
  }) as Session

const group = (input: Partial<SessionGroupEntry> & Pick<SessionGroupEntry, "id" | "sessionIds">): SessionGroupEntry =>
  ({
    name: input.id,
    position: 0,
    kind: "user",
    sessions: input.sessionIds.map((id, position) => ({
      id,
      title: id,
      position,
      locked: false,
      origin: "user",
      timeAdded: 1,
    })),
    time: { created: 1, updated: 1 },
    ...input,
  }) as SessionGroupEntry

describe("buildChatSidebarSessionTreeRows", () => {
  test("hydrates subagent members that are absent from the root-only list and nests them by parentID", () => {
    const root = session("root")
    const child = session("child", "root")
    const grandchild = session("grandchild", "child")
    const info = new Map([child, grandchild].map((item) => [item.id, item]))
    const subagents = group({
      id: "subagents",
      kind: "subagent",
      anchorSessionID: root.id,
      sessionIds: [root.id, child.id, grandchild.id],
      sessions: [root, child, grandchild].map((item, position) => ({
        id: item.id,
        title: item.title,
        position,
        locked: item.id !== root.id,
        origin: "auto_subagent" as const,
        timeAdded: position,
      })),
    })

    const rows = buildChatSidebarSessionTreeRows({
      roots: [root],
      groups: [subagents],
      sessionByID: (id) => info.get(id),
    })

    expect(rows.map((row) => [row.session.id, row.depth])).toEqual([
      ["root", 0],
      ["child", 1],
      ["grandchild", 2],
    ])
    expect(rows[0]?.visibleCount).toBe(3)
    expect(rows[0]?.first).toBe(true)
  })

  test("uses group-member session projections without requiring a session-info cache lookup", () => {
    const root = session("root")
    const child = session("child", root.id)
    const subagents = group({
      id: "subagents-projected",
      kind: "subagent",
      anchorSessionID: root.id,
      sessionIds: [root.id, child.id],
      sessions: [root, child].map((item, position) => ({
        id: item.id,
        title: item.title,
        slug: item.slug,
        projectID: item.projectID,
        directory: item.directory,
        parentID: item.parentID,
        version: item.version,
        time: item.time,
        position,
        locked: item.id !== root.id,
        origin: "auto_subagent" as const,
        timeAdded: position,
      })),
    })

    const lookups: string[] = []
    const rows = buildChatSidebarSessionTreeRows({
      roots: [root],
      groups: [subagents],
      sessionByID: (id) => {
        lookups.push(id)
        return undefined
      },
    })

    expect(rows.map((row) => [row.session.id, row.depth])).toEqual([
      [root.id, 0],
      [child.id, 1],
    ])
    expect(lookups).toEqual([child.id])
  })

  test("keeps unresolved descendants reachable once their own session info exists even if an intermediate parent is missing", () => {
    const root = session("root")
    const grandchild = session("grandchild", "missing-child")
    const subagents = group({
      id: "subagents",
      kind: "subagent",
      anchorSessionID: root.id,
      sessionIds: [root.id, "missing-child", grandchild.id],
    })

    const rows = buildChatSidebarSessionTreeRows({
      roots: [root],
      groups: [subagents],
      sessionByID: (id) => (id === grandchild.id ? grandchild : undefined),
    })

    expect(rows.map((row) => [row.session.id, row.depth])).toEqual([
      ["root", 0],
      ["grandchild", 1],
    ])
  })

  test("does not duplicate a root that belongs to multiple groups", () => {
    const root = session("root")
    const first = group({ id: "first", position: 1, sessionIds: [root.id] })
    const second = group({ id: "second", position: 2, sessionIds: [root.id] })

    const rows = buildChatSidebarSessionTreeRows({ roots: [root], groups: [second, first], sessionByID: () => undefined })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.group?.id).toBe("first")
    expect(rows[0]?.depth).toBe(1)
  })

  test("indents ordinary grouped sessions beneath their group container while standalone roots remain flush", () => {
    const grouped = session("grouped")
    const standalone = session("standalone")
    const collection = group({ id: "collection", sessionIds: [grouped.id] })

    const rows = buildChatSidebarSessionTreeRows({
      roots: [grouped, standalone],
      groups: [collection],
      sessionByID: () => undefined,
    })

    expect(rows.map((row) => [row.session.id, row.depth])).toEqual([
      [grouped.id, 1],
      [standalone.id, 0],
    ])
  })

  test("prioritizes subagent lineage over an older manual membership on the same root", () => {
    const root = session("root")
    const child = session("child", root.id)
    const manual = group({ id: "manual", position: 1, sessionIds: [root.id] })
    const subagents = group({
      id: "subagents",
      position: 2,
      kind: "subagent",
      anchorSessionID: root.id,
      sessionIds: [root.id, child.id],
    })

    const rows = buildChatSidebarSessionTreeRows({
      roots: [root],
      groups: [manual, subagents],
      sessionByID: (id) => (id === child.id ? child : undefined),
    })

    expect(rows.map((row) => row.session.id)).toEqual([root.id, child.id])
    expect(rows[0]?.group?.id).toBe(subagents.id)
  })

  test("renders an anchored plugin group as coordinator parent with root worker sessions beneath it", () => {
    const coordinator = session("coordinator")
    const workerA = session("worker-a")
    const workerB = session("worker-b")
    const swarm = group({
      id: "swarm-a",
      kind: "plugin",
      ownerPlugin: "openswarm",
      anchorSessionID: coordinator.id,
      sessionIds: [coordinator.id, workerA.id, workerB.id],
    })

    const rows = buildChatSidebarSessionTreeRows({
      roots: [coordinator, workerA, workerB],
      groups: [swarm],
      sessionByID: () => undefined,
    })

    expect(rows.map((row) => [row.session.id, row.depth])).toEqual([
      [coordinator.id, 0],
      [workerA.id, 1],
      [workerB.id, 1],
    ])
    expect(rows[0]?.treeKey).toBe(`session-tree:${coordinator.id}`)
    expect(rows[0]?.visibleCount).toBe(3)
  })

  test("merges multiple anchored plugin groups under one coordinator without duplicating the parent", () => {
    const coordinator = session("coordinator")
    const workerA = session("worker-a")
    const workerB = session("worker-b")
    const first = group({
      id: "swarm-a",
      kind: "plugin",
      position: 1,
      anchorSessionID: coordinator.id,
      sessionIds: [coordinator.id, workerA.id],
    })
    const second = group({
      id: "swarm-b",
      kind: "plugin",
      position: 2,
      anchorSessionID: coordinator.id,
      sessionIds: [coordinator.id, workerB.id],
    })

    const rows = buildChatSidebarSessionTreeRows({
      roots: [coordinator, workerA, workerB],
      groups: [first, second],
      sessionByID: () => undefined,
    })

    expect(rows.map((row) => row.session.id)).toEqual([coordinator.id, workerA.id, workerB.id])
    expect(rows.filter((row) => row.session.id === coordinator.id)).toHaveLength(1)
    expect(rows[1]?.group?.id).toBe(first.id)
    expect(rows[2]?.group?.id).toBe(second.id)
  })
})
