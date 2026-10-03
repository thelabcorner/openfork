import { describe, expect, test } from "bun:test"
import { getTableColumns } from "drizzle-orm"
import { Schema } from "effect"
import { Goal } from "@opencode-ai/schema/goal"
import { GoalAutomationTable, GoalTable } from "@opencode-ai/core/goal/sql"

describe("Goal intrinsic-autonomy architecture", () => {
  test("auditor decisions are exactly continue, complete, or blocked", () => {
    expect(Schema.is(Goal.AuditorDecision)("continue")).toBe(true)
    expect(Schema.is(Goal.AuditorDecision)("complete")).toBe(true)
    expect(Schema.is(Goal.AuditorDecision)("blocked")).toBe(true)
    expect(Schema.is(Goal.AuditorDecision)("fail")).toBe(false)
  })

  test("current Goal persistence contains no continuation-policy or hidden budget state", () => {
    const goal = Object.keys(getTableColumns(GoalTable))
    const automation = Object.keys(getTableColumns(GoalAutomationTable))

    expect(goal).not.toContain("continuation_policy")
    expect(automation).not.toContain("started_at")
    expect(automation).not.toContain("consecutive_turns")
    expect(automation).not.toContain("no_progress_turns")
    expect(automation).not.toContain("auditor_blocked_streak")
    expect(automation).not.toContain("consumed_tokens")
    expect(automation).not.toContain("last_auditor_decision")
    expect(automation).not.toContain("last_auditor_rationale")
    expect(automation).not.toContain("previous_revision")
  })
})
