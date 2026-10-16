import { describe, expect, test } from "bun:test"
import { reuseChatSidebarVirtualBlocks } from "./chat-sidebar-virtual-reuse"

const item = (key: string, rev = 1) => ({ key, rev })
const same = (a: ReturnType<typeof item>, b: ReturnType<typeof item>) => a.key === b.key && a.rev === b.rev

describe("reuseChatSidebarVirtualBlocks", () => {
  test("returns the identical array and blocks for unchanged data", () => {
    const before = [item("one"), item("two"), item("three")]
    expect(reuseChatSidebarVirtualBlocks(before, before.map((x) => ({ ...x })), same)).toBe(before)
  })
  test("a single value revision replaces only that block", () => {
    const before = [item("one"), item("two"), item("three")]
    const after = reuseChatSidebarVirtualBlocks(before, [item("one"), item("two", 2), item("three")], same)
    expect(after).not.toBe(before)
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after[2]).toBe(before[2])
  })
  test("reorder/insert/remove recover logical identity across indexes", () => {
    const before = [item("a"), item("b"), item("c")]
    const reordered = reuseChatSidebarVirtualBlocks(before, [item("c"), item("a"), item("b")], same)
    expect(reordered).toEqual([before[2], before[0], before[1]])
    expect(reordered[0]).toBe(before[2])
    const inserted = reuseChatSidebarVirtualBlocks(before, [item("new"), item("a"), item("b"), item("c")], same)
    expect(inserted[1]).toBe(before[0])
    expect(inserted[3]).toBe(before[2])
    const removed = reuseChatSidebarVirtualBlocks(before, [item("a"), item("c")], same)
    expect(removed[1]).toBe(before[2])
  })
  test("differential against the original key-map reconciliation under randomized edits", () => {
    let seed = 323
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    for (let trial = 0; trial < 300; trial++) {
      const before = Array.from({ length: random(150) }, (_, i) => item(`k${i}`, random(4)))
      const next = Array.from({ length: random(150) }, () => item(`k${random(160)}`, random(4)))
      const original = new Map(before.map((block) => [block.key, block]))
      const expected = next.map((block) => {
        const prior = original.get(block.key)
        return prior && same(prior, block) ? prior : block
      })
      const actual = reuseChatSidebarVirtualBlocks(before, [...next], same)
      expect(actual.length).toBe(expected.length)
      for (let i = 0; i < expected.length; i++) {
        expect(actual[i]).toEqual(expected[i])
        if (expected[i] === original.get(expected[i]!.key)) expect(actual[i]).toBe(expected[i])
      }
    }
  })
})