export * as ScheduledTaskProvenance from "./provenance"

import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"
import { SessionMetadataOwnership } from "../session/metadata-ownership"

export type SessionMetadata = Readonly<Record<string, unknown>> & {
  readonly scheduledTaskID: ScheduledTask.ID
  /** Legacy one-run-per-Session aggregate correlation. New Sessions omit it. */
  readonly scheduledTaskRunID?: ScheduledTask.RunID
}

/** New task-owned aggregate identity. Run identity belongs to the run row/turn. */
export function taskSessionMetadata(input: { readonly taskID: ScheduledTask.ID }): SessionMetadata {
  return {
    [SessionMetadataOwnership.Keys.scheduledTaskID]: input.taskID,
  }
}

/** @deprecated Legacy one-run-per-Session metadata retained for stored rows/tests. */
export function sessionMetadata(input: {
  readonly taskID: ScheduledTask.ID
  readonly runID: ScheduledTask.RunID
}): SessionMetadata {
  return {
    [SessionMetadataOwnership.Keys.scheduledTaskID]: input.taskID,
    [SessionMetadataOwnership.Keys.scheduledTaskRunID]: input.runID,
  }
}

export function parseSessionMetadata(value: unknown): SessionMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const taskID = row[SessionMetadataOwnership.Keys.scheduledTaskID]
  const runID = row[SessionMetadataOwnership.Keys.scheduledTaskRunID]
  if (typeof taskID !== "string" || !taskID.startsWith("stk_")) return undefined
  // Presence is protected/fail-closed. A malformed legacy run id cannot be
  // interpreted as a valid task-owned aggregate merely because taskID parses.
  if (runID !== undefined && (typeof runID !== "string" || !runID.startsWith("str_"))) return undefined
  return {
    scheduledTaskID: taskID as ScheduledTask.ID,
    ...(runID === undefined ? {} : { scheduledTaskRunID: runID as ScheduledTask.RunID }),
  }
}
