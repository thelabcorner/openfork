import { describe, expect, test } from "bun:test"
import { ScheduledTaskProvenance } from "@opencode-ai/core/scheduled-task/provenance"
import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"

describe("scheduled task Session provenance", () => {
  test("round-trips the current task-owned aggregate identity without a run id", () => {
    const value = ScheduledTaskProvenance.taskSessionMetadata({
      taskID: ScheduledTask.ID.make("stk_task_owned"),
    })
    expect(value).toEqual({ scheduledTaskID: ScheduledTask.ID.make("stk_task_owned") })
    expect(ScheduledTaskProvenance.parseSessionMetadata(value)).toEqual(value)
  })

  test("round-trips the producer-owned task/run Session metadata", () => {
    const value = ScheduledTaskProvenance.sessionMetadata({
      taskID: ScheduledTask.ID.make("stk_metadata"),
      runID: ScheduledTask.RunID.make("str_metadata"),
    })
    expect(ScheduledTaskProvenance.parseSessionMetadata(value)).toEqual(value)
  })

  test("fails closed for unrelated or malformed Session metadata", () => {
    expect(ScheduledTaskProvenance.parseSessionMetadata(undefined)).toBeUndefined()
    expect(ScheduledTaskProvenance.parseSessionMetadata({ scheduledTaskRunID: "str_orphan" })).toBeUndefined()
    expect(
      ScheduledTaskProvenance.parseSessionMetadata({
        scheduledTaskID: "stk_ok",
        scheduledTaskRunID: "bad-run",
      }),
    ).toBeUndefined()
    expect(
      ScheduledTaskProvenance.parseSessionMetadata({
        scheduledTaskID: "not-a-task",
        scheduledTaskRunID: "str_ok",
      }),
    ).toBeUndefined()
  })
})
