import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { compareChatSidebarSessionTime, mergeSortedChatSidebarSessions } from "./chat-sidebar-session-merge"

const session = (id: string, updated?: number, created?: number): Session =>
  ({ id, title: id, time: { updated, created } }) as Session
const canonical = (sources: readonly (readonly Session[])[]) => {
  const preferred = new Map<string, Session>()
  for (const rows of sources) for (const row of rows) preferred.set(row.id, row)
  return [...preferred.values()].sort(compareChatSidebarSessionTime)
}

describe("mergeSortedChatSidebarSessions", () => {
  test("empty, one-project and tied sessions match the existing global projection", () => {
    expect(mergeSortedChatSidebarSessions([])).toEqual([])
    expect(mergeSortedChatSidebarSessions([[]])).toEqual([])
    const sources = [
      [session("a", 12), session("b", 9), session("c", 9)].sort(compareChatSidebarSessionTime),
      [session("d", 12), session("e", 10), session("f", 9)].sort(compareChatSidebarSessionTime),
    ]
    expect(mergeSortedChatSidebarSessions(sources)).toEqual(canonical(sources))
    expect(mergeSortedChatSidebarSessions([sources[0]!])).toEqual(sources[0])
  })

  test("last project owns a duplicate even if an earlier store reports newer metadata", () => {
    const first = session("duplicate", 2)
    const newer = session("duplicate", 100)
    const sources = [
      [session("x", 20), first].sort(compareChatSidebarSessionTime),
      [newer, session("y", 1)].sort(compareChatSidebarSessionTime),
    ]
    const actual = mergeSortedChatSidebarSessions(sources)
    expect(actual.map((row) => row.id)).toEqual(["duplicate", "x", "y"])
    expect(actual[0]).toBe(newer)
  })

  test("differential: randomized overlapping sources, missing timestamps and project counts", () => {
    let seed = 1234567
    const random = (bound: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % bound
    }
    for (let iteration = 0; iteration < 250; iteration++) {
      const sources = Array.from({ length: 1 + random(25) }, (_, project) =>
        Array.from({ length: random(65) }, (_, index) =>
          session(
            random(3) === 0 ? `dup${random(80)}` : `p${project}s${index}`,
            random(10) === 0 ? undefined : random(30),
            random(15),
          ),
        ).sort(compareChatSidebarSessionTime),
      )
      const before = sources.map((rows) => [...rows])
      const expected = canonical(sources)
      const result = mergeSortedChatSidebarSessions(sources)
      expect(result.map((row) => row.id)).toEqual(expected.map((row) => row.id))
      expect(result.every((row, index) => row === expected[index])).toBe(true)
      expect(sources).toEqual(before)
    }
  })
})