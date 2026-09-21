import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"
import { ScheduledTaskRunTable } from "./sql"

export function hydrateRun(row: typeof ScheduledTaskRunTable.$inferSelect): ScheduledTask.Run {
  return {
    id: row.id,
    taskID: row.task_id,
    fireFor: row.fire_for,
    trigger: row.trigger,
    status: row.status,
    sessionID: (row.session_id ?? undefined) as ScheduledTask.Run["sessionID"],
    goalID: (row.goal_id ?? undefined) as ScheduledTask.Run["goalID"],
    workspaceID: (row.workspace_id ?? undefined) as ScheduledTask.Run["workspaceID"],
    directory: row.directory ?? undefined,
    skipReason: row.skip_reason ?? undefined,
    errorKind: row.error_kind ?? undefined,
    errorMessage: row.error_message ?? undefined,
    acknowledgedAt: row.acknowledged_at ?? undefined,
    attempt: row.attempt,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
  }
}
