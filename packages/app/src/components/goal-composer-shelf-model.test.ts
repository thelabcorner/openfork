import { describe, expect, test } from "bun:test"
import {
  formatGoalElapsed,
  goalLifecycleAction,
  goalProgress,
  isGoalTerminal,
} from "./goal-composer-shelf-model"

describe("Goal composer shelf model", () => {
  test("combines criteria and execution steps into one stable progress fraction", () => {
    expect(
      goalProgress({
        criteria: [{ status: "passed" }, { status: "pending" }, { status: "passed" }],
        steps: [{ status: "completed" }, { status: "active" }],
      }),
    ).toEqual({ done: 3, total: 5, percent: 60 })
    expect(goalProgress({ criteria: [], steps: [] })).toEqual({ done: 0, total: 0, percent: 0 })
  })

  test("formats elapsed time densely without unstable precision", () => {
    expect(formatGoalElapsed(-500)).toBe("0s")
    expect(formatGoalElapsed(59_999)).toBe("59s")
    expect(formatGoalElapsed(60_000)).toBe("1m")
    expect(formatGoalElapsed(3_660_000)).toBe("1h 1m")
    expect(formatGoalElapsed(7_200_000)).toBe("2h")
  })

  test("maps only legal shelf lifecycle controls", () => {
    expect(goalLifecycleAction("draft")).toBe("start")
    expect(goalLifecycleAction("active")).toBe("pause")
    expect(goalLifecycleAction("paused")).toBe("resume")
    expect(goalLifecycleAction("blocked")).toBe("resume")
    expect(goalLifecycleAction("verifying")).toBeUndefined()
    expect(goalLifecycleAction("completed")).toBeUndefined()
  })

  test("recognizes every terminal state", () => {
    expect(["completed", "cancelled", "failed"].every(isGoalTerminal)).toBe(true)
    expect(["draft", "active", "paused", "blocked", "verifying"].some(isGoalTerminal)).toBe(false)
  })
})
