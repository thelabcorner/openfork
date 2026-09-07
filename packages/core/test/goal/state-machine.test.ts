import { describe, expect, test } from "bun:test"
import { GoalV2 } from "@opencode-ai/core/goal"
import type { Goal } from "@opencode-ai/schema/goal"

const machine = GoalV2.GoalStateMachine

describe("GoalStateMachine", () => {
  test("encodes the complete initial lifecycle algebra", () => {
    const expected: Record<Goal.Status, Record<string, Goal.Status>> = {
      draft: { start: "active", cancel: "cancelled", fail: "failed" },
      active: {
        pause: "paused",
        block: "blocked",
        request_verification: "verifying",
        cancel: "cancelled",
        fail: "failed",
      },
      paused: { resume: "active", cancel: "cancelled", fail: "failed" },
      blocked: { resume: "active", cancel: "cancelled", fail: "failed" },
      verifying: { verification_pass: "completed", verification_fail: "active", cancel: "cancelled", fail: "failed" },
      completed: {},
      cancelled: {},
      failed: {},
    }

    for (const [status, transitions] of Object.entries(expected) as Array<[Goal.Status, Record<string, Goal.Status>]>) {
      expect(Object.fromEntries(machine.actions(status).map((action) => [action, machine.next(status, action)]))).toEqual(
        transitions,
      )
    }
  })

  test("has no direct completion transition outside verification", () => {
    for (const status of ["draft", "active", "paused", "blocked"] as const) {
      expect(machine.actions(status).some((action) => machine.next(status, action) === "completed")).toBe(false)
    }
    expect(machine.next("verifying", "verification_pass")).toBe("completed")
  })

  test("terminal states are immutable", () => {
    for (const status of ["completed", "cancelled", "failed"] as const) {
      expect(machine.isTerminal(status)).toBe(true)
      expect(machine.actions(status)).toEqual([])
    }
    expect(machine.isTerminal("active")).toBe(false)
  })
})
