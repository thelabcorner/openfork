import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { createChatSidebarSourceCache } from "./chat-sidebar-source-cache"

const row = (id: string, updated: number): Session =>
  ({ id, title: id, time: { created: updated, updated } }) as Session

describe("Recent/Status shared source-index cache", () => {
  const titleOf = (session: Session) => session.title
  test("same roster and same sort retain exact merged and sorted array identities", () => {
    const cache = createChatSidebarSourceCache()
    const roots = [row("b", 8), row("a", 4)]
    const members = [row("c", 6)]
    const merged = cache.merge(roots, members)
    const sorted = cache.sort(merged, "title", titleOf)
    expect(sorted.map((session) => session.id)).toEqual(["a", "b", "c"])
    expect(cache.merge(roots, members)).toBe(merged)
    expect(cache.sort(merged, "title", titleOf)).toBe(sorted)
    expect(cache.sort(merged, "updated", titleOf)).toBe(merged)
    expect(cache.sort(merged, "title", titleOf)).not.toBe(sorted)
  })
  test("different roots, members or title policy invalidate exactly the necessary phase", () => {
    const cache = createChatSidebarSourceCache()
    const roots = [row("a", 9)]
    const members = [row("b", 7)]
    const source = cache.merge(roots, members)
    const sorted = cache.sort(source, "title", titleOf)
    const differentLabels = (session: Session) => session.title
    expect(cache.sort(source, "title", differentLabels)).not.toBe(sorted)
    const changedMembers = cache.merge(roots, [row("c", 2)])
    expect(changedMembers).not.toBe(source)
    expect(cache.sort(changedMembers, "title", titleOf)).not.toBe(sorted)
    cache.clearSorted()
    expect(cache.merge(roots, members)).not.toBe(source)
  })
  test("clearing the cache releases both sorted and merged projections", () => {
    const cache = createChatSidebarSourceCache()
    const roots = [row("a", 9)]
    const members = [row("b", 7)]
    const initial = cache.merge(roots, members)
    const ordered = cache.sort(initial, "created", titleOf)
    cache.clear()
    const rebuilt = cache.merge(roots, members)
    expect(rebuilt).not.toBe(initial)
    expect(cache.sort(rebuilt, "created", titleOf)).not.toBe(ordered)
  })
})