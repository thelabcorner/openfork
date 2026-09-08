import { describe, expect, test } from "bun:test"
import type { SessionGroupEntry } from "@/context/session-groups"
import { groupedSessionsForTabPreview } from "./titlebar-tab-group-preview"

function group(input: {
  id: string
  name?: string
  kind?: SessionGroupEntry["kind"]
  sessions: string[]
  position?: number
}): SessionGroupEntry {
  return {
    id: input.id,
    name: input.name ?? input.id,
    kind: input.kind ?? "user",
    position: input.position ?? 0,
    sessionIds: [...input.sessions],
    sessions: input.sessions.map((id, position) => ({
      id,
      title: id,
      locked: false,
      origin: input.kind === "plugin" ? "plugin" : input.kind === "subagent" ? "auto_subagent" : "user",
      position,
      timeAdded: position,
    })),
    time: { created: 0, updated: 0 },
  }
}

describe("groupedSessionsForTabPreview", () => {
  test("merges managed memberships and de-duplicates a shared coordinator", () => {
    const first = group({ id: "swarm-a", name: "Swarm A", kind: "plugin", sessions: ["coord", "a1", "a2"] })
    const second = group({ id: "swarm-b", name: "Swarm B", kind: "plugin", sessions: ["coord", "b1"] })

    expect(groupedSessionsForTabPreview([first, second], "coord")).toEqual([
      { id: "coord", title: "coord", group: "Swarm A · Swarm B" },
      { id: "a1", title: "a1", group: "Swarm A" },
      { id: "a2", title: "a2", group: "Swarm A" },
      { id: "b1", title: "b1", group: "Swarm B" },
    ])
  })

  test("prefers structural topology over an unrelated manual membership", () => {
    const manual = group({ id: "manual", sessions: ["root", "unrelated"] })
    const subagents = group({ id: "workers", kind: "subagent", sessions: ["root", "worker"] })

    expect(groupedSessionsForTabPreview([manual, subagents], "root")?.map((row) => row.id)).toEqual([
      "root",
      "worker",
    ])
  })

  test("does not merge multiple manual folders", () => {
    const first = group({ id: "first", sessions: ["root", "a"] })
    const second = group({ id: "second", sessions: ["root", "b"] })

    expect(groupedSessionsForTabPreview([first, second], "root")?.map((row) => row.id)).toEqual(["root", "a"])
  })
})
