import { describe, expect, test } from "bun:test"
import { planStartupSessionHydration } from "./startup-session-hydration"

describe("planStartupSessionHydration", () => {
  test("loads the last active project in the foreground", () => {
    const projects = [
      { worktree: "C:/alpha", expanded: false },
      { worktree: "C:/beta", expanded: true },
      { worktree: "C:/gamma", expanded: true },
    ]

    const result = planStartupSessionHydration(projects, "C:\\alpha")

    expect(result.foreground).toBe(projects[0])
    expect(result.background).toEqual([projects[1], projects[2]])
  })

  test("prioritizes expanded projects while preserving stable order", () => {
    const projects = [
      { worktree: "/a", expanded: false },
      { worktree: "/b", expanded: true },
      { worktree: "/c", expanded: false },
      { worktree: "/d", expanded: true },
    ]

    const result = planStartupSessionHydration(projects)
    expect(result.foreground).toBe(projects[1])
    expect(result.background).toEqual([
      projects[3],
      projects[0],
      projects[2],
    ])
  })

  test("falls back to the first project when there is no expanded or remembered project", () => {
    const projects = [
      { worktree: "/a", expanded: false },
      { worktree: "/b", expanded: false },
    ]

    const result = planStartupSessionHydration(projects, "/missing")
    expect(result.foreground).toBe(projects[0])
    expect(result.background).toEqual([projects[1]])
  })
})
