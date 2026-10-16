import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { indexChatSidebarWorkingIDs } from "./chat-sidebar-working-index"
import { sameChatSidebarIDSet } from "./chat-sidebar-scope-equality"

describe("sparse sidebar working index", () => {
  test("derives working status from busy, retry and unpaused state", () => {
    const statuses: Record<string, SessionStatus> = {
      a: { type: "busy" },
      b: { type: "retry", attempt: 1, message: "retrying", next: Date.now() },
      c: { type: "idle" },
      d: { type: "busy" },
    }
    expect([...indexChatSidebarWorkingIDs(statuses, { d: true })]).toEqual(["a", "b"])
    expect(indexChatSidebarWorkingIDs({}, {}).size).toBe(0)
  })

  test("matches the canonical session_working contract over randomized snapshots", () => {
    let seed = 42
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    for (let trial = 0; trial < 500; trial++) {
      const statuses: Record<string, SessionStatus> = {}
      const paused: Record<string, boolean> = {}
      for (let i = 0; i < random(300); i++) {
        const kind = random(3)
        statuses[`s${i}`] = kind === 0 ? { type: "busy" } : kind === 1
          ? { type: "idle" }
          : { type: "retry", attempt: 1, message: "retry", next: 0 }
        if (random(5) === 0) paused[`s${i}`] = true
      }
      const result = indexChatSidebarWorkingIDs(statuses, paused)
      for (const [id, status] of Object.entries(statuses)) {
        const canonical = (status.type === "busy" || status.type === "retry") && paused[id] !== true
        expect(result.has(id)).toBe(canonical)
      }
    }
  })

  test("Solid-browser reactive subscription follows additions/pauses/deletions", () => {
    createRoot((dispose) => {
      const [data, update] = createStore({
        statuses: {} as Record<string, SessionStatus | undefined>,
        paused: {} as Record<string, boolean | undefined>,
      })
      const working = createMemo(
        () => indexChatSidebarWorkingIDs(data.statuses, data.paused),
        undefined,
        { equals: sameChatSidebarIDSet },
      )
      expect([...working()]).toEqual([])
      update("statuses", "s1", { type: "busy" })
      expect([...working()]).toEqual(["s1"])
      const stable = working()
      update("statuses", "s1", { type: "retry", attempt: 1, message: "retrying", next: 0 })
      expect(working()).toBe(stable)
      update("paused", "s1", true)
      expect([...working()]).toEqual([])
      update("paused", "s1", false)
      expect([...working()]).toEqual(["s1"])
      update("statuses", "s1", undefined)
      expect([...working()]).toEqual([])
      dispose()
    })
  })
})