import { describe, expect, test } from "bun:test"
import { findChatProject, isChatProjectAlias, isReservedChatProjectPath } from "./chat-project"

describe("chat project identity", () => {
  const canonical = {
    id: "chats",
    name: "Chat",
    worktree: "C:\\Users\\jackson\\.local\\share\\opencode\\chats",
  }

  test("finds the server-owned project by reserved id", () => {
    expect(findChatProject([{ id: "repo", worktree: "C:\\repo" }, canonical])).toEqual(canonical)
  })

  test("recognizes the legacy renderer-generated root as an alias", () => {
    const legacy = { worktree: "/.local/share/opencode/chats" }
    expect(isReservedChatProjectPath(legacy.worktree)).toBe(true)
    expect(isChatProjectAlias(legacy, canonical)).toBe(true)
  })

  test("does not collapse ordinary projects into Chat", () => {
    expect(isChatProjectAlias({ id: "repo", worktree: "C:\\work\\chats" }, canonical)).toBe(false)
    expect(isReservedChatProjectPath("C:\\work\\chats")).toBe(false)
  })
})
