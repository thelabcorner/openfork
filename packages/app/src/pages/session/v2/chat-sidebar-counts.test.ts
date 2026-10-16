import { describe, expect, test } from "bun:test"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { countSidebarWaiting, countSidebarWorking } from "./chat-sidebar-counts"

describe("sparse chat sidebar footer counts", () => {
  test("working counts only visible, unpaused non-idle statuses once", () => {
    const statuses: Record<string, SessionStatus> = {
      busy: { type: "busy" },
      paused: { type: "busy" },
      idle: { type: "idle" },
      unrelated: { type: "busy" },
    }
    const visible = new Set(["busy", "paused", "idle"])
    expect(countSidebarWorking(visible, statuses, { paused: true })).toBe(1)
    expect(countSidebarWorking(visible, statuses, {})).toBe(2)
    expect(countSidebarWorking(new Set(), statuses, {})).toBe(0)
  })

  test("pending questions and manual permissions are deduplicated and scoped", () => {
    const scope = new Map([
      ["a", new Set(["/a"])],
      ["b", new Set(["/a", "/b"])],
      ["c", new Set([""])],
    ])
    const questions = { a: [1], c: [], outside: [3] }
    const permissions = { a: [1], b: [2], c: [4], outside: [8] }
    const responses: Array<[number, string]> = []
    expect(
      countSidebarWaiting(scope, questions, permissions, (request, directory) => {
        responses.push([request, directory])
        return directory === "/a" || request === 4
      }),
    ).toBe(2)
    expect(responses).toEqual([[2, "/a"], [2, "/b"], [4, ""]])
  })

  test("question takes precedence over permission auto-response and empty entries do not count", () => {
    const scope = new Map([["a", new Set(["/a"])]])
    expect(countSidebarWaiting(scope, { a: [] }, { a: [] }, () => false)).toBe(0)
    let called = 0
    expect(countSidebarWaiting(scope, { a: ["question"] }, { a: ["permission"] }, () => {
      called++
      return true
    })).toBe(1)
    expect(called).toBe(0)
  })

  test("randomized differential parity with the original per-visible-session scans", () => {
    let seed = 57391
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    for (let trial = 0; trial < 250; trial++) {
      const entries = Array.from({ length: 1 + random(110) }, (_, index) => ({
        id: `s${random(120)}`,
        directory: `/workspace/${random(5)}`,
      }))
      const scope = new Map<string, Set<string>>()
      for (const entry of entries) {
        if (!scope.has(entry.id)) scope.set(entry.id, new Set())
        scope.get(entry.id)!.add(entry.directory)
      }
      const statuses: Record<string, SessionStatus> = {}
      const paused: Record<string, boolean> = {}
      const questions: Record<string, number[]> = {}
      const permissions: Record<string, number[]> = {}
      for (let i = 0; i < 140; i++) {
        const id = `s${i}`
        if (random(4) === 0) statuses[id] = { type: "busy" }
        if (random(9) === 0) paused[id] = true
        if (random(14) === 0) questions[id] = [random(8)]
        if (random(11) === 0) permissions[id] = [random(8)]
      }
      const auto = (request: number, directory: string) =>
        request % 2 === 0 && directory.endsWith("/2")
      const naiveWorking = new Set<string>()
      const naiveWaiting = new Set<string>()
      for (const entry of entries) {
        if (statuses[entry.id]?.type === "busy" && paused[entry.id] !== true) naiveWorking.add(entry.id)
        if (
          (questions[entry.id]?.length ?? 0) > 0 ||
          (permissions[entry.id] ?? []).some((permission) => !auto(permission, entry.directory))
        ) naiveWaiting.add(entry.id)
      }
      expect(countSidebarWorking(new Set(scope.keys()), statuses, paused)).toBe(naiveWorking.size)
      expect(countSidebarWaiting(scope, questions, permissions, auto)).toBe(naiveWaiting.size)
    }
  })
})