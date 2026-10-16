import { describe, expect, test } from "bun:test"
import { contextMenuPosition } from "./context-menu-position"

function anchor(left: number, top: number, width: number, height: number) {
  return {
    getBoundingClientRect: () => ({ left, top, width, height }),
  }
}

describe("context menu pointer and keyboard anchors", () => {
  test("preserves pointer coordinates without reading layout", () => {
    let reads = 0
    const element = { getBoundingClientRect: () => { reads++; throw new Error("Unexpected layout read") } }
    expect(contextMenuPosition({ button: 2, clientX: 442, clientY: 210 }, element)).toEqual({ x: 442, y: 210 })
    expect(contextMenuPosition({ button: 0, clientX: 84, clientY: 1 }, element)).toEqual({ x: 84, y: 1 })
    expect(reads).toBe(0)
  })

  test("preserves an authentic right-click at the viewport origin", () => {
    expect(contextMenuPosition({ button: 2, clientX: 0, clientY: 0 }, anchor(80, 50, 200, 40))).toEqual({ x: 0, y: 0 })
  })

  test("anchors keyboard contextmenu to the target row instead of (0, 0)", () => {
    expect(contextMenuPosition({ button: 0, clientX: 0, clientY: 0 }, anchor(100, 60, 300, 40)))
      .toEqual({ x: 124, y: 80 })
  })

  test("keeps small and zero-sized targets within their anchor geometry", () => {
    expect(contextMenuPosition({ button: 0, clientX: 0, clientY: 0 }, anchor(20, 30, 10, 10)))
      .toEqual({ x: 25, y: 35 })
    expect(contextMenuPosition({ button: 0, clientX: 0, clientY: 0 }, anchor(20, 30, 0, 0)))
      .toEqual({ x: 20, y: 30 })
  })
})
