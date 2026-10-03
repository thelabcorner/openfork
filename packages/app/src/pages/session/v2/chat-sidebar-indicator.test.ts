import { describe, expect, test } from "bun:test"
import { chatSidebarWorkingIndicatorAnimated, uniqueSidebarSessions } from "./chat-sidebar-pane-state"

describe("dense sidebar working indicator fanout", () => {
  test("limits animation to one Recent slot per logical session", () => {
    const presentations = [
      chatSidebarWorkingIndicatorAnimated(true, true, true), // visible Recent primary
      chatSidebarWorkingIndicatorAnimated(false, true, true), // project duplicate
      chatSidebarWorkingIndicatorAnimated(true, false, true), // duplicate slot
      chatSidebarWorkingIndicatorAnimated(true, true, false), // off-screen Recent row
    ]

    expect(presentations.filter(Boolean)).toHaveLength(1)
    expect(presentations.slice(1)).toEqual([false, false, false])
  })

  test("deduplicates the Recent union by logical session id", () => {
    const session = { id: "same-session" }
    expect(uniqueSidebarSessions([session, { id: session.id }, { id: "other" }])).toHaveLength(2)
  })

  test("keeps animations bounded by visible working rows, not total working sessions", () => {
    const ids = Array.from({ length: 100 }, (_, index) => `working-${index}`)
    const representations = ids.flatMap((id, index) => [
      { id, group: "recent" as const, visible: index < 30 },
      { id, group: "project" as const, visible: index < 30 },
    ])
    const animatedRoots = representations.reduce((count, row) => {
      const primarySlot = chatSidebarWorkingIndicatorAnimated(row.group === "recent", true, row.visible)
      const duplicateSlot = chatSidebarWorkingIndicatorAnimated(row.group === "recent", false, row.visible)
      return count + Number(primarySlot) + Number(duplicateSlot)
    }, 0)

    expect(animatedRoots).toBe(30)
    expect(animatedRoots).toBeLessThanOrEqual(representations.filter((row) => row.visible && row.group === "recent").length)
    expect(animatedRoots).toBeLessThan(12 * representations.length)
  })
})
