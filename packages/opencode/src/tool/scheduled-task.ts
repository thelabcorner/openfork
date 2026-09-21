import { Effect } from "effect"
import { ScheduledTaskAgent } from "@opencode-ai/core/scheduled-task/agent"
import * as Tool from "./tool"
import { current as currentUserActionTurn } from "./user-action-turn"

type Metadata = {
  action: string
  taskID?: string
  created?: boolean
  enabled?: boolean
  nextRunAt?: number
}

export const ScheduledTaskTool = Tool.define<
  typeof ScheduledTaskAgent.Input,
  Metadata,
  ScheduledTaskAgent.Service
>(
  "scheduled_task",
  Effect.gen(function* () {
    const scheduled = yield* ScheduledTaskAgent.Service
    return {
      description: [
        "Create and manage durable Scheduled Tasks for this parent Session's project directory.",
        "Omit action for backward-compatible creation, or use action=create/list/get/update/remove/set_enabled/runs/inbox/unread_count/acknowledge/run_now/preview/agenda.",
        "Creation and mutations require the current human user to explicitly ask for them or confirm your immediately preceding proposal. Read-only inspection does not. The host enforces this boundary.",
        "Do not create, edit, delete, enable/disable, acknowledge notifications, or manually run durable automation merely because it might be useful; ask first.",
        "Translate natural-language timing into one of three input families: relative ({kind:'relative', delayMs}) for X time from now, timestamp ({kind:'timestamp', at}) for an absolute epoch-millisecond instant, or recurring ({kind:'recurring', schedule}) wrapping daily/weekly/5-field-cron recurrence. Canonical once/daily/weekly/cron forms remain accepted for compatibility.",
        "Relative timing is a one-shot: the host resolves it once at creation/update time and persists the resulting absolute instant. Do not use relative to mean 'every X duration'; recurring interval schedules require separate anchored semantics.",
        "Timezone is irrelevant for relative/timestamp/once inputs. Daily/weekly times are local wall-clock hour/minute values and cron is standard 5-field cron; those wall-clock schedules require an explicit IANA timezone. Use known user context when authoritative; if the intended timezone is ambiguous, ask rather than guessing from the host machine.",
        "Tasks are scoped to this parent Session's current directory tree; child Sessions cannot manage durable schedules.",
        "Tasks are enabled immediately unless the user explicitly asks for a draft/disabled schedule. Omitted policy fields use the scheduler's persisted named defaults (deny permissions, failure notifications, bounded retry/runtime/retention).",
        "Creation inherits this Session's agent/model unless you explicitly provide an override. Updates use expectedRevision from list/get so stale model writes fail closed.",
        "run_now queues one durable manual run and does not change the recurrence schedule.",
      ].join(" "),
      parameters: ScheduledTaskAgent.Input,
      execute: (input, ctx) =>
        scheduled.execute(ctx.sessionID, input, currentUserActionTurn(ctx.messages)).pipe(
          Effect.map((result) => {
            const task = "task" in result ? result.task : undefined
            const taskID = task?.id ?? ("taskID" in result ? result.taskID : undefined)
            const title =
              result.action === "create"
                ? result.created
                  ? `Scheduled ${result.task.name}`
                  : `Schedule already exists: ${result.task.name}`
                : result.action === "list"
                  ? "Scheduled tasks"
                  : result.action === "preview"
                    ? "Schedule preview"
                    : result.action === "agenda"
                      ? "Schedule agenda"
                      : result.action === "runs"
                        ? "Scheduled task runs"
                        : result.action === "inbox"
                          ? "Scheduled task inbox"
                          : result.action === "unread_count"
                            ? "Scheduled task unread count"
                            : result.action === "acknowledge"
                              ? `Acknowledged scheduled task run ${result.runID}`
                        : result.action === "remove"
                          ? `Removed scheduled task ${result.taskID}`
                          : result.action === "run_now"
                            ? `Queued scheduled task run ${result.run.id}`
                            : task
                              ? `Scheduled task ${task.name}`
                              : "Scheduled task"
            return {
              title,
              output: JSON.stringify(result),
              metadata: {
                action: result.action,
                ...(taskID ? { taskID } : {}),
                ...(result.action === "create" ? { created: result.created } : {}),
                ...(task ? { enabled: task.enabled } : {}),
                ...(task?.nextRunAt !== undefined ? { nextRunAt: task.nextRunAt } : {}),
              },
            }
          }),
          Effect.orDie,
        ),
    }
  }),
)
