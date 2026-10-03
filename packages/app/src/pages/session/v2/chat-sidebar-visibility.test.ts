import { describe, expect, test } from "bun:test"
import { chatSidebarWorkingIndicatorAnimated } from "./chat-sidebar-pane-state"

describe("sidebar working visibility gate", () => {
  test("animates only a visible primary Recent row", () => {
    expect(chatSidebarWorkingIndicatorAnimated(true, true, false)).toBe(false)
    expect(chatSidebarWorkingIndicatorAnimated(true, false, true)).toBe(false)
    expect(chatSidebarWorkingIndicatorAnimated(false, true, true)).toBe(false)
    expect(chatSidebarWorkingIndicatorAnimated(true, true, true)).toBe(true)
  })
})
