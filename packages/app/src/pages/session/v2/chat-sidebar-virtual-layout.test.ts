import { describe, expect, test } from "bun:test"
import { sidebarFixedBlockHeight, sidebarStickyBlockOffset } from "./chat-sidebar-virtual-layout"

describe("chat sidebar virtual row geometry", () => {
  test("fixed-height rows cannot collapse to a zero-height DOM measurement", () => {
    for (const density of ["compact", "detailed"] as const) {
      expect(sidebarFixedBlockHeight("section-head", density)).toBe(24)
      expect(sidebarFixedBlockHeight("cluster-head", density)).toBe(25)
      expect(sidebarFixedBlockHeight("cluster-member", density)).toBe(23)
      expect(sidebarFixedBlockHeight("more", density)).toBe(23)
      expect(sidebarFixedBlockHeight("less", density)).toBe(23)
    }
    expect(sidebarFixedBlockHeight("session", "compact")).toBe(23)
    expect(sidebarFixedBlockHeight("session", "detailed")).toBe(36)
    for (const type of ["archived", "oxp", "empty"]) {
      expect(sidebarFixedBlockHeight(type, "detailed")).toBeUndefined()
    }
  })

  test("detailed and compact rows reserve non-overlapping continuous positions", () => {
    for (const density of ["compact", "detailed"] as const) {
      const kinds = ["section-head", ...Array.from({ length: 8 }, () => "session"), "more", "archived"]
      let offset = 0
      const slots = kinds.map((kind) => {
        const start = offset
        const size = sidebarFixedBlockHeight(kind, density) ?? 24
        offset += size
        return { kind, start, size }
      })
      for (let index = 1; index < slots.length; index++) {
        expect(slots[index]!.start).toBe(slots[index - 1]!.start + slots[index - 1]!.size)
      }
      const expectedArchivedStart = 24 + (density === "detailed" ? 36 : 23) * 8 + 23
      expect(slots.at(-1)!.start).toBe(expectedArchivedStart)
    }
  })

  test("sticky header stays absolute in virtualizer coordinates while scrolling", () => {
    expect(sidebarStickyBlockOffset(180, 24, 0, 500)).toBe(180)
    expect(sidebarStickyBlockOffset(180, 24, 220, 500)).toBe(220)
    expect(sidebarStickyBlockOffset(180, 24, 480, 500)).toBe(476)
    expect(sidebarStickyBlockOffset(180, 24, 520, 500)).toBe(476)
    expect(sidebarStickyBlockOffset(180, 24, 520)).toBe(520)
  })

  test("malformed offsets cannot produce NaN transforms or move a header backward", () => {
    expect(sidebarStickyBlockOffset(100, 24, Number.NaN, 500)).toBe(100)
    expect(sidebarStickyBlockOffset(100, 24, 300, 101)).toBe(100)
    expect(sidebarStickyBlockOffset(100, 24, 300, Number.POSITIVE_INFINITY)).toBe(300)
    expect(sidebarStickyBlockOffset(Number.NaN, 24, 300, 500)).toBe(0)
  })
})
