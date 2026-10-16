import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { indexProjects, projectForSession, projectForSessionIndexed } from "./helpers"

const session = (directory: string, projectID?: string) => ({ directory, projectID }) as Session

describe("shared tab project index", () => {
  test("preserves ID priority, sandbox fallback, and missing-project behavior", () => {
    const projects = [
      { id: "a", worktree: "/a", sandboxes: ["/a/test"] },
      { id: "b", worktree: "/b", sandboxes: ["/b/test"] },
    ]
    const index = indexProjects(projects)
    for (const row of [
      session("/a"),
      session("/a/test"),
      session("/b/test"),
      session("/missing", "b"),
      session("/a", "b"),
      session("/a", "deleted"),
      session("/missing"),
    ]) {
      expect(projectForSessionIndexed(row, index)).toBe(projectForSession(row, projects))
    }
    expect(projectForSessionIndexed(undefined, index)).toBeUndefined()
    expect(projectForSessionIndexed(session("/a"), undefined)).toBeUndefined()
  })

  test("preserves legacy first-directory and last-ID duplicate precedence", () => {
    const projects = [
      { id: "dup", worktree: "/original", sandboxes: ["/shared"] },
      { id: "dup", worktree: "/shared", sandboxes: ["/other"] },
      { id: "third", worktree: "/other", sandboxes: [] },
    ]
    const index = indexProjects(projects)
    for (const row of [session("/shared"), session("/shared", "dup"), session("/other")]) {
      expect(projectForSessionIndexed(row, index)).toBe(projectForSession(row, projects))
    }
  })

  test("normalizes mixed Windows directory separators consistently", () => {
    const projects = [{ id: "win", worktree: "C:\\work\\repo", sandboxes: ["C:\\work\\repo\\sandbox"] }]
    const row = session("C:/work/repo/sandbox/")
    expect(projectForSessionIndexed(row, indexProjects(projects))).toBe(projectForSession(row, projects))
  })

  test("matches the former scan across colliding IDs, directories and sandboxes", () => {
    for (let size = 0; size <= 64; size++) {
      const projects = Array.from({ length: size }, (_, i) => ({
        id: `project-${i % 11}`,
        worktree: `/repo/${i % 19}`,
        sandboxes: [`/repo/${i % 7}/sandbox`, `/repo/${i % 5}/shared`],
      }))
      const index = indexProjects(projects)
      for (let i = 0; i < 64; i++) {
        const directory = [
          `/repo/${i % 19}`,
          `/repo/${i % 7}/sandbox`,
          `/repo/${i % 5}/shared`,
          `/missing/${i}`,
        ][i % 4]
        const row = session(directory, i % 3 ? `project-${i % 11}` : undefined)
        expect(projectForSessionIndexed(row, index)).toBe(projectForSession(row, projects))
      }
    }
  })
})