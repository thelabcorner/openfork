import { describe, expect, test } from "bun:test"
import { projectPersistentSessionGroups } from "./home-session-grouping"

const record = (id: string, project: string) => ({ session: { id }, project })

describe("projectPersistentSessionGroups", () => {
  const crossProject = {
    id: "group",
    name: "Cross-project work",
    kind: "user" as const,
    sessionIds: ["a", "b"],
  }

  test("omits a group with no membership in the current project projection", () => {
    const result = projectPersistentSessionGroups([record("c", "C")], [crossProject])
    expect(result.groups).toEqual([])
    expect([...result.groupedSessionIDs]).toEqual([])
  })

  test("shows only the current project's members of a cross-project group", () => {
    const result = projectPersistentSessionGroups([record("a", "A")], [crossProject])
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]?.sessions.map((item) => item.session.id)).toEqual(["a"])
    expect([...result.groupedSessionIDs]).toEqual(["a"])
  })

  test("shows the full visible membership when Home is not project-filtered", () => {
    const result = projectPersistentSessionGroups([record("a", "A"), record("b", "B")], [crossProject])
    expect(result.groups[0]?.sessions.map((item) => item.session.id)).toEqual(["a", "b"])
  })
})
