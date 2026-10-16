import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { withChatSidebarDirectory } from "./chat-sidebar-directory"

const row = (id: string, directory?: string) => ({ id, directory }) as Session
describe("directory backfill across server-owned project aliases", () => {
  test("repeated lookups in the same directory retain the identical Session projection", () => {
    const original = row("s1")
    const a = withChatSidebarDirectory(original, "/workspace/a")
    expect(a).toBe(withChatSidebarDirectory(original, "/workspace/a"))
    expect(a).not.toBe(original)
    expect(a.directory).toBe("/workspace/a")
    expect(original.directory).toBeUndefined()
  })
  test("a shared object in two worktrees never leaks the first worktree's directory", () => {
    const original = row("s1")
    const first = withChatSidebarDirectory(original, "/workspace/a")
    const second = withChatSidebarDirectory(original, "/workspace/b")
    const third = withChatSidebarDirectory(original, "/workspace/c")
    expect(second.directory).toBe("/workspace/b")
    expect(second).not.toBe(first)
    expect(third.directory).toBe("/workspace/c")
    expect(third).not.toBe(second)
    expect(withChatSidebarDirectory(original, "/workspace/b")).toBe(second)
    expect(withChatSidebarDirectory(original, "/workspace/a")).toBe(first)
  })
  test("an authoritative directory is never overwritten by directory-store aliases", () => {
    const explicit = row("s1", "/canonical")
    expect(withChatSidebarDirectory(explicit, "/alias")).toBe(explicit)
    expect(explicit.directory).toBe("/canonical")
  })
  test("independent Session objects with the same ID never share cached projections", () => {
    const first = withChatSidebarDirectory(row("same"), "/first")
    const second = withChatSidebarDirectory(row("same"), "/second")
    expect(first.directory).toBe("/first")
    expect(second.directory).toBe("/second")
    expect(first).not.toBe(second)
  })
  test("reconciled in-place title/time updates refresh the projected row without changing source identity", () => {
    const original = {
      id: "s1", title: "Before", version: "1", time: { created: 1, updated: 2 },
    } as Session
    const before = withChatSidebarDirectory(original, "/a")
    original.title = "After"
    original.time.updated = 3
    const after = withChatSidebarDirectory(original, "/a")
    expect(after).not.toBe(before)
    expect(after.title).toBe("After")
    expect(after.time.updated).toBe(3)
    expect(before.title).toBe("Before")
    expect(before.time.updated).toBe(2)
    expect(withChatSidebarDirectory(original, "/a")).toBe(after)
  })
  test("nested token/model changes refresh each directory alias independently", () => {
    const original = {
      id: "s1", title: "Live", model: { id: "a", providerID: "p" },
      tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 3, write: 1 } },
      time: { created: 1, updated: 2 },
    } as Session
    const a = withChatSidebarDirectory(original, "/a")
    const b = withChatSidebarDirectory(original, "/b")
    original.model!.id = "b"
    original.tokens!.cache.read = 15
    const nextA = withChatSidebarDirectory(original, "/a")
    const nextB = withChatSidebarDirectory(original, "/b")
    expect(nextA).not.toBe(a)
    expect(nextB).not.toBe(b)
    expect(nextA.model?.id).toBe("b")
    expect(nextB.tokens?.cache.read).toBe(15)
    expect(a.model?.id).toBe("a")
    expect(b.tokens?.cache.read).toBe(3)
    expect(nextA.directory).toBe("/a")
    expect(nextB.directory).toBe("/b")
  })
})