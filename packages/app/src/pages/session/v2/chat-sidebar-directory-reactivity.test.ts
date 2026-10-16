import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { withChatSidebarDirectory } from "./chat-sidebar-directory"

// Run with: bun test --conditions=browser chat-sidebar-directory-reactivity.test.ts
describe("server-reconciled missing-directory Session proxies", () => {
  test("Solid in-place title and timestamp updates invalidate the cached projection", () => {
    createRoot((dispose) => {
      const [store, set] = createStore({
        session: {
          id: "s1", title: "Before", slug: "s1", version: "1",
          projectID: "p", directory: "", time: { created: 1, updated: 3 },
        } as Session,
      })
      const projected = createMemo(() => withChatSidebarDirectory(store.session, "/home"))
      const before = projected()
      expect(before.title).toBe("Before")
      expect(before.directory).toBe("/home")
      set("session", "title", "After")
      expect(projected().title).toBe("After")
      expect(projected()).not.toBe(before)
      const titleRevision = projected()
      set("session", "time", "updated", 9)
      expect(projected().time.updated).toBe(9)
      expect(projected()).not.toBe(titleRevision)
      expect(before.time.updated).toBe(3)
      expect(projected()).toBe(projected())
      dispose()
    })
  })
})