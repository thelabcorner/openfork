import { describe, expect, test } from "bun:test"
import { ScheduledTaskPolicy } from "@opencode-ai/core/scheduled-task/policy"

describe("scheduled task notification policy", () => {
  test("never suppresses every terminal outcome", () => {
    for (const status of ["succeeded", "failed", "skipped", "abandoned"] as const) {
      expect(ScheduledTaskPolicy.shouldNotifyRun({ notify: "never", status, retryPending: false })).toBe(false)
    }
  })

  test("always notifies every terminal outcome but never an intermediate retry failure", () => {
    for (const status of ["succeeded", "failed", "skipped", "abandoned"] as const) {
      expect(ScheduledTaskPolicy.shouldNotifyRun({ notify: "always", status, retryPending: false })).toBe(true)
    }
    expect(ScheduledTaskPolicy.shouldNotifyRun({ notify: "always", status: "failed", retryPending: true })).toBe(false)
  })

  test("failure notifies failed or abandoned logical runs only", () => {
    expect(ScheduledTaskPolicy.shouldNotifyRun({ notify: "failure", status: "failed", retryPending: false })).toBe(true)
    expect(ScheduledTaskPolicy.shouldNotifyRun({ notify: "failure", status: "abandoned", retryPending: false })).toBe(true)
    expect(ScheduledTaskPolicy.shouldNotifyRun({ notify: "failure", status: "succeeded", retryPending: false })).toBe(false)
    expect(ScheduledTaskPolicy.shouldNotifyRun({ notify: "failure", status: "skipped", retryPending: false })).toBe(false)
    expect(ScheduledTaskPolicy.shouldNotifyRun({ notify: "failure", status: "failed", retryPending: true })).toBe(false)
  })

  test("rejects delayed settlement events after a retry has advanced durable truth", () => {
    const projected = { status: "failed" as const, attempt: 1, finishedAt: 1_000 }
    expect(
      ScheduledTaskPolicy.isCurrentSettlement({
        current: { status: "failed", attempt: 1, finishedAt: 1_000 },
        projected,
      }),
    ).toBe(true)
    expect(
      ScheduledTaskPolicy.isCurrentSettlement({
        current: { status: "running", attempt: 2, finishedAt: null },
        projected,
      }),
    ).toBe(false)
    expect(
      ScheduledTaskPolicy.isCurrentSettlement({
        current: { status: "failed", attempt: 2, finishedAt: 2_000 },
        projected,
      }),
    ).toBe(false)
  })
})
