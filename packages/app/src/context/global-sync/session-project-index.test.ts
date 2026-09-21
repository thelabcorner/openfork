import { describe, expect, test } from "bun:test"
import {
  rootSessionProjectID,
  sessionEventIndexDirectories,
  sessionIndexDirectory,
} from "./session-project-index"

const projects = [
  { id: "project-a", worktree: "/project-a", sandboxes: ["/project-a-sandbox"] },
  { id: "project-b", worktree: "/project-b", sandboxes: [] },
]

describe("project Session root indexing", () => {
  test("uses project scope only for the canonical worktree census", () => {
    expect(rootSessionProjectID("/project-a", projects)).toBe("project-a")
    expect(rootSessionProjectID("/project-a-sandbox", projects)).toBeUndefined()
    expect(rootSessionProjectID("/project-a/generated-worker", projects)).toBeUndefined()
  })

  test("preserves location-scoped sandbox ownership", () => {
    expect(sessionIndexDirectory({ projectID: "project-a", directory: "/project-a-sandbox" }, projects)).toBe(
      "/project-a-sandbox",
    )
    expect(sessionIndexDirectory({ projectID: "project-a", directory: "/project-a/generated-worker" }, projects)).toBe(
      "/project-a",
    )
  })

  test("mirrors foreign-directory root events into the canonical project index", () => {
    expect(
      sessionEventIndexDirectories(
        { projectID: "project-a", directory: "/scheduled/task-a", parentID: undefined },
        "/scheduled/task-a",
        projects,
      ),
    ).toEqual(["/project-a", "/scheduled/task-a"])
  })

  test("does not project child Session events into the project root index", () => {
    expect(
      sessionEventIndexDirectories(
        { projectID: "project-a", directory: "/scheduled/task-a", parentID: "ses_parent" },
        "/scheduled/task-a",
        projects,
      ),
    ).toEqual(["/scheduled/task-a"])
  })
})
