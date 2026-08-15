import { describe, expect, test } from "bun:test"
import { canOpenTabRename, canStartTabDrag, forwardTabRef, isTabActionTarget } from "./titlebar-tab-gesture"

describe("titlebar tab gestures", () => {
  test("excludes close controls from tab gestures", () => {
    const close = document.createElement("div")
    const button = document.createElement("button")
    const link = document.createElement("a")
    close.dataset.slot = "tab-close"
    close.append(button)
    expect(isTabActionTarget(close)).toBe(true)
    expect(isTabActionTarget(button)).toBe(true)
    expect(isTabActionTarget(link)).toBe(false)
  })

  test("excludes the session-state action button from tab gestures", () => {
    const state = document.createElement("div")
    const button = document.createElement("button")
    state.dataset.slot = "tab-state"
    state.append(button)
    expect(isTabActionTarget(state)).toBe(true)
    expect(isTabActionTarget(button)).toBe(true)
    expect(isTabActionTarget(document.createElement("span"))).toBe(false)
  })

  test("forwards component refs", () => {
    const element = document.createElement("div")
    let received: HTMLDivElement | undefined
    forwardTabRef((value) => (received = value), element)
    expect(received).toBe(element)
  })

  test("does not reopen rename while a save is pending", () => {
    expect(canOpenTabRename(false, false, false)).toBe(true)
    expect(canOpenTabRename(false, false, true)).toBe(false)
  })

  test("preserves native panning for touch pointers", () => {
    expect(canStartTabDrag("mouse")).toBe(true)
    expect(canStartTabDrag("pen")).toBe(true)
    expect(canStartTabDrag("touch")).toBe(false)
  })
})
