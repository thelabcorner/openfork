import { describe, expect, test } from "bun:test"
import { sheetClamp } from "./bottom-sheet-v2"

describe("sheetClamp", () => {
  test("keyboard closed keeps the full layout height and no inset", () => {
    const clamp = sheetClamp(800, 0, 800)
    expect(clamp.maxHeight).toBe(800)
    expect(clamp.keyboardInset).toBe(0)
  })

  test("keyboard open lifts the visible box above the keyboard", () => {
    const clamp = sheetClamp(800, 0, 300)
    expect(clamp.maxHeight).toBe(800)
    expect(clamp.keyboardInset).toBe(500)
    expect(clamp.maxHeight - clamp.keyboardInset).toBe(300)
  })

  test("scrolled visual viewport accounts for offsetTop", () => {
    const clamp = sheetClamp(800, 120, 500)
    expect(clamp.maxHeight).toBe(680)
    expect(clamp.keyboardInset).toBe(180)
    expect(clamp.maxHeight - clamp.keyboardInset).toBe(500)
  })

  test("never returns negative geometry", () => {
    const clamp = sheetClamp(800, 40, 900)
    expect(clamp.maxHeight).toBe(760)
    expect(clamp.keyboardInset).toBe(0)
  })
})
