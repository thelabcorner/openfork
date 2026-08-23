import { describe, expect, test } from "bun:test"
import { computeKeyboardInset, KEYBOARD_OPEN_THRESHOLD, keyboardInset } from "./keyboard-inset"

describe("computeKeyboardInset", () => {
  test("keyboard closed reads zero height and a full viewport bottom", () => {
    const inset = computeKeyboardInset(800, 0, 800)
    expect(inset.keyboardHeight).toBe(0)
    expect(inset.viewportBottom).toBe(800)
    expect(inset.keyboardOpen).toBe(false)
  })

  test("keyboard open reports the covered height and the visible bottom", () => {
    const inset = computeKeyboardInset(800, 0, 300)
    expect(inset.keyboardHeight).toBe(500)
    expect(inset.viewportBottom).toBe(300)
    expect(inset.keyboardOpen).toBe(true)
  })

  test("viewportBottom tracks offsetTop when the page is scrolled", () => {
    const inset = computeKeyboardInset(800, 120, 500)
    expect(inset.keyboardHeight).toBe(300)
    expect(inset.viewportBottom).toBe(620)
  })

  test("heights never go negative", () => {
    const inset = computeKeyboardInset(800, 40, 900)
    expect(inset.keyboardHeight).toBe(0)
    expect(inset.viewportBottom).toBe(940)
    expect(inset.keyboardOpen).toBe(false)
  })

  test("threshold filters toolbar flicker", () => {
    expect(KEYBOARD_OPEN_THRESHOLD).toBe(60)
    expect(computeKeyboardInset(800, 0, 750).keyboardOpen).toBe(false)
    expect(computeKeyboardInset(800, 0, 739).keyboardOpen).toBe(true)
  })
})

describe("keyboardInset store", () => {
  test("exposes reactive inset fields without wiring", () => {
    const inset = keyboardInset()
    expect(typeof inset.keyboardHeight).toBe("number")
    expect(typeof inset.viewportBottom).toBe("number")
    expect(typeof inset.keyboardOpen).toBe("boolean")
    expect(keyboardInset()).toBe(inset)
  })
})
