import { describe, expect, test } from "bun:test"
import { createMemo, createRoot, createSignal } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  canReuseChatSidebarItemSlot,
  reconcileChatSidebarSlots,
  type ChatSidebarItem,
  type ChatSidebarSlot,
  type ChatSidebarSlotState,
} from "./chat-sidebar-tree"

/** Runs under --conditions=browser to validate Solid's client reactivity. */
describe("stable sidebar row ownership", () => {
  const session = (id: string, title: string): ChatSidebarItem => ({
    type: "session",
    key: `s:${id}`,
    session: { id, title, time: { created: 1, updated: 1 } } as Session,
  })
  test("metadata changes update the old row slot without remounting it", () => {
    createRoot((dispose) => {
      const createSlot = (key: string, value: ChatSidebarItem): ChatSidebarSlot<ChatSidebarItem> => {
        const [get, set] = createSignal(value, { equals: false })
        return { key, get, set }
      }
      const reconcile = (
        state: ChatSidebarSlotState<ChatSidebarItem> | undefined,
        items: ChatSidebarItem[],
      ) =>
        reconcileChatSidebarSlots(state, items, (row) => row.key, canReuseChatSidebarItemSlot, createSlot)

      const initial = reconcile(undefined, [session("a", "Before"), session("b", "Stable")])
      const mountedA = initial.slots[0]!
      const mountedB = initial.slots[1]!
      const title = createMemo(() => {
        const item = mountedA.get()
        return item.type === "session" ? item.session.title : ""
      })
      expect(title()).toBe("Before")
      const changed = reconcile(initial, [session("a", "After"), initial.slots[1]!.get()])
      expect(changed.slots[0]).toBe(mountedA)
      expect(changed.slots[1]).toBe(mountedB)
      expect(title()).toBe("After")
      const identical = reconcile(changed, [changed.slots[0]!.get(), changed.slots[1]!.get()])
      expect(identical).toBe(changed)
      const removed = reconcile(changed, [session("c", "New")])
      expect(removed.slots[0]).not.toBe(mountedA)
      dispose()
    })
  })

  test("item type changes cannot reuse a stale component", () => {
    const a = session("a", "A")
    const b = session("a", "B")
    const c = session("c", "C")
    const cluster: ChatSidebarItem = {
      type: "cluster", key: "cluster-a", group: { id: "g", name: "G", kind: "user" },
      members: [a.type === "session" ? a.session : ({} as Session)],
      labels: ["A"], lead: a.type === "session" ? a.session : ({} as Session),
    }
    expect(canReuseChatSidebarItemSlot(a, b)).toBe(true)
    expect(canReuseChatSidebarItemSlot(a, c)).toBe(false)
    expect(canReuseChatSidebarItemSlot(a, cluster)).toBe(false)
    expect(canReuseChatSidebarItemSlot(cluster, a)).toBe(false)
    expect(canReuseChatSidebarItemSlot(cluster, { ...cluster })).toBe(true)
  })
})