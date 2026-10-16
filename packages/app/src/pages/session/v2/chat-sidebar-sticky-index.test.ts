import { describe, expect, test } from "bun:test"
import { indexChatSidebarStickyHeaders, stickyChatSidebarHeader } from "./chat-sidebar-sticky-index"

const slow = (blocks: readonly { type: string }[], start: number) => {
  for (let index = start; index >= 0; index--) {
    const type = blocks[index]?.type
    if (!type || type === "oxp" || type === "empty" || type === "archived") return -1
    if (type === "section-head") return index
  }
  return -1
}

describe("sidebar sticky-header sparse index", () => {
  test("matches backward scanning across empty, collapsed, and expanded sections", () => {
    const layouts = [
      ["oxp", "archived"],
      ["oxp", "empty", "archived"],
      ["oxp", "section-head", "session", "cluster-head", "cluster-member", "section-head", "session", "archived"],
      ["oxp", "section-head", ...Array(10_000).fill("cluster-member"), "section-head", "more", "archived"],
    ]
    for (const layout of layouts) {
      const blocks = layout.map((type) => ({ type }))
      const markers = indexChatSidebarStickyHeaders(blocks)
      for (let index = 0; index < blocks.length; index++) {
        expect(stickyChatSidebarHeader(markers, index)).toBe(slow(blocks, index))
      }
      expect(stickyChatSidebarHeader(markers, -1)).toBe(-1)
      expect(stickyChatSidebarHeader(markers, Number.NaN)).toBe(-1)
      expect(stickyChatSidebarHeader(markers, blocks.length)).toBe(slow(blocks, blocks.length))
    }
  })

  test("tracks section inserts, removals and terminal boundaries with a rebuilt index", () => {
    const before = ["oxp", "section-head", "session", "archived"].map((type) => ({ type }))
    const after = ["oxp", "section-head", "session", "section-head", "session", "archived"].map((type) => ({ type }))
    expect(stickyChatSidebarHeader(indexChatSidebarStickyHeaders(before), 3)).toBe(-1)
    expect(stickyChatSidebarHeader(indexChatSidebarStickyHeaders(after), 4)).toBe(3)
  })
})