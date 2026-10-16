import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { countSidebarWaiting, countSidebarWorking } from "./chat-sidebar-counts"

/**
 * Run using `bun test --conditions=browser <path>`. Server-side Solid is not
 * reactive, so SSR-only tests cannot validate Object.entries enumeration.
 */
describe("chat sidebar footer counts respond to Solid-store state transitions", () => {
  test("working count follows additions, in-place type changes, paused state and removal", () => {
    createRoot((dispose) => {
      const [data, setData] = createStore({
        status: {} as Record<string, { type: "busy" | "idle" }>,
        paused: {} as Record<string, boolean>,
      })
      const visible = new Set(["s1", "s2"])
      const value = createMemo(() => countSidebarWorking(visible, data.status, data.paused))
      expect(value()).toBe(0)
      setData("status", "s1", { type: "busy" })
      expect(value()).toBe(1)
      setData("status", "outside", { type: "busy" })
      expect(value()).toBe(1)
      setData("status", "s2", { type: "busy" })
      expect(value()).toBe(2)
      setData("paused", "s1", true)
      expect(value()).toBe(1)
      setData("status", "s2", "type", "idle")
      expect(value()).toBe(0)
      setData("status", "s1", undefined!)
      expect(value()).toBe(0)
      dispose()
    })
  })

  test("waiting count tracks new questions, settled questions and permission policy", () => {
    createRoot((dispose) => {
      const [data, setData] = createStore({
        question: {} as Record<string, string[]>,
        permission: {} as Record<string, string[]>,
        autoAccept: false,
      })
      const visible = new Map([["s1", new Set(["/a"])], ["s2", new Set(["/b"])]])
      const value = createMemo(() =>
        countSidebarWaiting(visible, data.question, data.permission, () => data.autoAccept),
      )
      expect(value()).toBe(0)
      setData("question", "s1", ["q1"])
      expect(value()).toBe(1)
      setData("permission", "s2", ["p1"])
      expect(value()).toBe(2)
      setData("question", "s1", [])
      expect(value()).toBe(1)
      setData("autoAccept", true)
      expect(value()).toBe(0)
      dispose()
    })
  })
})