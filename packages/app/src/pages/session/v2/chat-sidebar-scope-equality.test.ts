import { describe, expect, test } from "bun:test"
import { sameChatSidebarDirectoryScope, sameChatSidebarIDSet, sameChatSidebarSessionDirectories } from "./chat-sidebar-scope-equality"

describe("stable sidebar scopes", () => {
  test("root membership remains equal after duplicate/metadata changes", () => {
    expect(sameChatSidebarIDSet(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true)
    expect(sameChatSidebarIDSet(new Set(["a", "b"]), new Set(["a", "c"]))).toBe(false)
    expect(sameChatSidebarIDSet(new Set(), new Set())).toBe(true)
  })
  test("footer directory equality detects scope moves and additional root contexts", () => {
    const first = { directories: new Map([["a", new Set(["/one"])], ["b", new Set(["/b"])]] ) }
    const same = { directories: new Map([["b", new Set(["/b"])], ["a", new Set(["/one"])]]) }
    const moved = { directories: new Map([["a", new Set(["/two"])], ["b", new Set(["/b"])]]) }
    const added = { directories: new Map([["a", new Set(["/one", "/two"])], ["b", new Set(["/b"])]]) }
    expect(sameChatSidebarDirectoryScope(first, same)).toBe(true)
    expect(sameChatSidebarDirectoryScope(first, moved)).toBe(false)
    expect(sameChatSidebarDirectoryScope(first, added)).toBe(false)
    expect(sameChatSidebarDirectoryScope(first, { directories: new Map() })).toBe(false)
  })
  test("status directory index suppresses metadata-only reactivity while detecting moved sessions", () => {
    const before = new Map([["a", "/one"], ["b", "/two"]])
    expect(sameChatSidebarSessionDirectories(before, new Map([["b", "/two"], ["a", "/one"]]))).toBe(true)
    expect(sameChatSidebarSessionDirectories(before, new Map([["a", "/two"], ["b", "/one"]]))).toBe(false)
    expect(sameChatSidebarSessionDirectories(before, new Map([["a", "/one"]]))).toBe(false)
    expect(sameChatSidebarSessionDirectories(new Map(), new Map())).toBe(true)
  })
})