import { describe, expect, test } from "bun:test"
import {
  formatGoalElapsed,
  goalLifecycleAction,
  goalProgress,
  isGoalTerminal,
  nextCriterionStatus,
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

  test("formats elapsed time with every applicable unit", () => {
    expect(formatGoalElapsed(-500)).toBe("0s")
    expect(formatGoalElapsed(0)).toBe("0s")
    expect(formatGoalElapsed(59_999)).toBe("59s")
    expect(formatGoalElapsed(60_000)).toBe("1m")
    expect(formatGoalElapsed(90_000)).toBe("1m 30s")
    expect(formatGoalElapsed(3_660_000)).toBe("1h 1m")
    expect(formatGoalElapsed(3_661_000)).toBe("1h 1m 1s")
    expect(formatGoalElapsed(7_200_000)).toBe("2h")
    expect(formatGoalElapsed(90_000_000)).toBe("1d 1h")
    expect(formatGoalElapsed(9 * 86_400_000 + 3 * 3_600_000 + 5 * 60_000 + 7_000)).toBe("1w 2d 3h 5m 7s")
    expect(formatGoalElapsed(65 * 86_400_000 + 2 * 3_600_000)).toBe("2mo 5d 2h")
  })

  test("maps only legal shelf lifecycle controls", () => {
    expect(goalLifecycleAction("draft")).toBe("start")
    expect(goalLifecycleAction("active")).toBe("pause")
    expect(goalLifecycleAction("paused")).toBe("resume")
    expect(goalLifecycleAction("blocked")).toBe("resume")
    expect(goalLifecycleAction("verifying")).toBeUndefined()
    expect(goalLifecycleAction("completed")).toBeUndefined()
  })

  test("cycles a criterion through every reviewable status", () => {
    expect(nextCriterionStatus("pending")).toBe("passed")
    expect(nextCriterionStatus("passed")).toBe("failed")
    expect(nextCriterionStatus("failed")).toBe("pending")
    expect(nextCriterionStatus("")).toBe("pending")
  })

  test("recognizes every terminal state", () => {
    expect(["completed", "cancelled", "failed"].every(isGoalTerminal)).toBe(true)
    expect(["draft", "active", "paused", "blocked", "verifying"].some(isGoalTerminal)).toBe(false)
  })
})
