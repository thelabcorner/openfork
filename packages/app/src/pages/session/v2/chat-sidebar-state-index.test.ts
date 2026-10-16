import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { indexChatSidebarRowStates, sameChatSidebarRowStateIndex } from "./chat-sidebar-state-index"

type Permission = { auto: boolean; directory?: string }

describe("authoritative sparse sidebar row-state index", () => {
  test("precedence is attention > error > working > unread > idle", () => {
    const state = indexChatSidebarRowStates({
      statuses: {
        attention: { type: "busy" }, error: { type: "busy" },
        working: { type: "busy" }, paused: { type: "busy" },
      },
      paused: { paused: true },
      questions: { attention: ["q"] },
      permissions: { permission: [{ auto: false }] },
      unseenCounts: { attention: 1, error: 1, working: 1, unread: 2, paused: 0 },
      unseenErrors: { error: true },
      directoryByID: new Map([["permission", "/repo"]]),
      autoResponds: (request) => request.auto,
    })
    expect(state.get("attention")).toBe("attention")
    expect(state.get("permission")).toBe("attention")
    expect(state.get("error")).toBe("error")
    expect(state.get("working")).toBe("working")
    expect(state.get("unread")).toBe("unread")
    expect(state.get("paused")).toBeUndefined()
    expect(state.get("unknown")).toBeUndefined()
  })

  test("permission responses use the owning session's directory", () => {
    const state = indexChatSidebarRowStates({
      statuses: {}, paused: {}, questions: {},
      permissions: { a: [{ auto: true, directory: "/one" }], b: [{ auto: true, directory: "/one" }] },
      unseenCounts: {}, unseenErrors: {},
      directoryByID: new Map([["a", "/one"], ["b", "/two"]]),
      autoResponds: (request, directory) => request.auto && request.directory === directory,
    })
    expect(state.get("a")).toBeUndefined()
    expect(state.get("b")).toBe("attention")
  })

  test("randomized parity with legacy per-row status and notification resolution", () => {
    let seed = 7249
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    for (let trial = 0; trial < 250; trial++) {
      const statuses: Record<string, SessionStatus> = {}
      const paused: Record<string, boolean> = {}
      const questions: Record<string, number[]> = {}
      const permissions: Record<string, Permission[]> = {}
      const unseenCounts: Record<string, number> = {}
      const unseenErrors: Record<string, boolean> = {}
      const dirs = new Map<string, string>()
      for (let i = 0; i < 190; i++) {
        const id = `s${i}`
        const kind = random(3)
        if (random(4) === 0) statuses[id] = kind === 0 ? { type: "busy" }
          : kind === 1 ? { type: "idle" } : { type: "retry", attempt: 1, message: "retry", next: 0 }
        if (random(6) === 0) paused[id] = true
        if (random(12) === 0) questions[id] = [1]
        if (random(10) === 0) permissions[id] = [{ auto: random(2) === 0, directory: "/one" }]
        if (random(7) === 0) unseenCounts[id] = 1 + random(3)
        if (random(11) === 0) unseenErrors[id] = true
        dirs.set(id, random(2) === 0 ? "/one" : "/two")
      }
      const autoResponds = (request: Permission, directory: string) =>
        request.auto && directory === request.directory
      const states = indexChatSidebarRowStates({
        statuses, paused, questions, permissions, unseenCounts, unseenErrors,
        directoryByID: dirs, autoResponds,
      })
      for (const [id, dir] of dirs) {
        const pending = (questions[id]?.length ?? 0) > 0 ||
          (permissions[id] ?? []).some((item) => !autoResponds(item, dir))
        const working = (statuses[id]?.type === "busy" || statuses[id]?.type === "retry") &&
          paused[id] !== true
        const expected = pending ? "attention" : unseenErrors[id] ? "error"
          : working ? "working" : unseenCounts[id] ? "unread" : "idle"
        expect(states.get(id) ?? "idle").toBe(expected)
      }
    }
  })

  test("store additions, semantic no-ops and removals update the memo correctly", () => {
    createRoot((dispose) => {
      const [data, set] = createStore({
        statuses: {} as Record<string, SessionStatus | undefined>,
        paused: {} as Record<string, boolean>,
        questions: {} as Record<string, string[]>,
        permissions: {} as Record<string, Permission[]>,
        unread: {} as Record<string, number>,
        errors: {} as Record<string, boolean>,
        directory: "/one",
      })
      const derived = createMemo(() => indexChatSidebarRowStates({
        statuses: data.statuses,
        paused: data.paused,
        questions: data.questions,
        permissions: data.permissions,
        unseenCounts: data.unread,
        unseenErrors: data.errors,
        directoryByID: new Map([["s1", data.directory]]),
        autoResponds: (request: Permission, directory: string) =>
          request.auto && request.directory === directory,
      }), undefined, { equals: sameChatSidebarRowStateIndex })
      expect(derived().get("s1")).toBeUndefined()
      set("statuses", "s1", { type: "busy" })
      expect(derived().get("s1")).toBe("working")
      const initial = derived()
      set("statuses", "s1", { type: "retry", attempt: 2, message: "retry", next: 0 })
      expect(derived()).toBe(initial)
      set("errors", "s1", true)
      expect(derived().get("s1")).toBe("error")
      set("permissions", "s1", [{ auto: true, directory: "/one" }])
      expect(derived().get("s1")).toBe("error")
      set("directory", "/two")
      expect(derived().get("s1")).toBe("attention")
      set("questions", "s1", ["q1"])
      set("permissions", "s1", [])
      expect(derived().get("s1")).toBe("attention")
      set("questions", "s1", [])
      expect(derived().get("s1")).toBe("error")
      set("errors", "s1", false)
      set("statuses", "s1", undefined)
      expect(derived().get("s1")).toBeUndefined()
      dispose()
    })
  })
})