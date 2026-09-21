import { expect } from "bun:test"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { nextOccurrence } from "@opencode-ai/core/scheduled-task/recurrence"

/** The pure engine is the authority; the cursor must equal its answer. */
export function expectedCursor(task: ScheduledTask.Info, after: number): number | undefined {
  return nextOccurrence({ schedule: task.schedule, timezone: task.timezone, after })
}

/**
 * Shared Tier B assertion (T3): call at the end of EVERY mutating test so a
 * future mutation path that forgets to recompute `next_run_at` fails.
 *
 * A disabled task is not scheduled at all, so its cursor must be NULL; an
 * enabled task's cursor must equal the pure engine's answer.
 */
export function assertCursorConsistent(task: ScheduledTask.Info, after: number): void {
  if (!task.enabled) {
    expect(task.nextRunAt).toBeUndefined()
    return
  }
  expect(task.nextRunAt).toBe(expectedCursor(task, after))
}
