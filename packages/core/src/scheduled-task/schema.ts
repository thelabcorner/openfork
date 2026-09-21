export * as ScheduledTaskSchema from "./schema"

import { Schema } from "effect"
import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("ScheduledTask.NotFoundError", {
  taskID: ScheduledTask.ID,
}) {
  override get message() {
    return `Scheduled task not found: ${this.taskID}`
  }
}

export class StaleRevisionError extends Schema.TaggedErrorClass<StaleRevisionError>()(
  "ScheduledTask.StaleRevisionError",
  {
    taskID: ScheduledTask.ID,
    expectedRevision: Schema.Number,
    actualRevision: Schema.Number,
  },
) {
  override get message() {
    return `Scheduled task ${this.taskID} changed concurrently (expected revision ${this.expectedRevision}, current revision ${this.actualRevision}).`
  }
}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("ScheduledTask.ValidationError", {
  reason: Schema.String,
}) {
  override get message() {
    return `Scheduled task operation rejected: ${this.reason}`
  }
}

export class RunNotFoundError extends Schema.TaggedErrorClass<RunNotFoundError>()("ScheduledTask.RunNotFoundError", {
  runID: ScheduledTask.RunID,
}) {
  override get message() {
    return `Scheduled task run not found: ${this.runID}`
  }
}

export class RunAttemptConflictError extends Schema.TaggedErrorClass<RunAttemptConflictError>()(
  "ScheduledTask.RunAttemptConflictError",
  {
    runID: ScheduledTask.RunID,
    expectedAttempt: Schema.Number,
    actualAttempt: Schema.Number,
    status: ScheduledTask.RunStatus,
  },
) {
  override get message() {
    return (
      "Scheduled task run " +
      this.runID +
      " attempt " +
      this.expectedAttempt +
      " no longer owns the active run (current attempt " +
      this.actualAttempt +
      ", status " +
      this.status +
      ")."
    )
  }
}

export type Error = NotFoundError | StaleRevisionError | ValidationError | RunNotFoundError | RunAttemptConflictError
