import { describe, expect, test } from "bun:test"
import { indexChatSidebarSearchHits } from "./chat-sidebar-search-index"

describe("sidebar search active-hit index", () => {
  test("supports empty lists, duplicate keys and first-match semantics", () => {
    expect(indexChatSidebarSearchHits([]).size).toBe(0)
    const rows = [{ key: "a" }, { key: "b" }, { key: "a" }, { key: "c" }]
    const positions = indexChatSidebarSearchHits(rows)
    expect([...positions.entries()]).toEqual([["a", 0], ["b", 1], ["c", 3]])
    expect(positions.get("missing") ?? -1).toBe(-1)
  })

  test("randomized active-key lookups agree with Array.findIndex", () => {
    let seed = 42
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    for (let trial = 0; trial < 200; trial++) {
      const rows = Array.from({ length: random(350) }, () => ({ key: `k${random(500)}` }))
      const index = indexChatSidebarSearchHits(rows)
      for (let attempt = 0; attempt < 20; attempt++) {
        const key = `k${random(520)}`
        expect(index.get(key) ?? -1).toBe(rows.findIndex((hit) => hit.key === key))
      }
    }
  })
})