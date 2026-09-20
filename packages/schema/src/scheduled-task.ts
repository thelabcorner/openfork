export * as ScheduledTask from "./scheduled-task"

import { Schema } from "effect"
import { define } from "./event"
import { DateTimeUtcFromMillis, optional } from "./schema"
import { Goal } from "./goal"
import { Model } from "./model"
import { ProjectID } from "./project-id"
import { SessionID } from "./session-id"
import { WorkspaceID } from "./workspace-id"
import { ScheduledTaskID, ScheduledTaskRunID } from "./scheduled-task-id"

export const ID = ScheduledTaskID
export type ID = ScheduledTaskID

export const RunID = ScheduledTaskRunID
export type RunID = ScheduledTaskRunID

// ---------------------------------------------------------------------------
// Schedule representation (02-scheduling-semantics.md § 2)
//
// Stored structurally rather than lowered to cron at write time: a
// `daily at 09:00 and 17:30` schedule is not expressible as one cron string,
// and lowering it would silently drop the second time.
// ---------------------------------------------------------------------------

export const TimeOfDay = Schema.Struct({
  hour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
  minute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 59 })),
}).annotate({ identifier: "ScheduledTask.TimeOfDay" })
export interface TimeOfDay extends Schema.Schema.Type<typeof TimeOfDay> {}

export const Weekday = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })).annotate({
  identifier: "ScheduledTask.Weekday",
})
export type Weekday = typeof Weekday.Type

export const Schedule = Schema.Union([
  // Fires exactly once, then `next_run_at` becomes null and the task disables.
  Schema.Struct({ kind: Schema.Literal("once"), at: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("daily"), times: Schema.Array(TimeOfDay) }),
  Schema.Struct({
    kind: Schema.Literal("weekly"),
    weekdays: Schema.Array(Weekday),
    times: Schema.Array(TimeOfDay),
  }),
  // Standard 5-field cron (minute hour day-of-month month day-of-week).
  // A seconds field, `@reboot`, and L/W/# extensions are rejected at validation.
  Schema.Struct({ kind: Schema.Literal("cron"), expression: Schema.String }),
]).annotate({ identifier: "ScheduledTask.Schedule" })
export type Schedule = typeof Schedule.Type

// ---------------------------------------------------------------------------
// Execution target (03-execution-and-safety.md § 2)
// ---------------------------------------------------------------------------

export const TargetKind = Schema.Literals(["directory", "worktree"]).annotate({
  identifier: "ScheduledTask.TargetKind",
})
export type TargetKind = typeof TargetKind.Type

export const Target = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("directory") }),
  Schema.Struct({
    kind: Schema.Literal("worktree"),
    /** Defaults to the target repository's current HEAD at fire time. */
    baseRef: optional(Schema.String),
    /** One stable worktree per task instead of one per run (default true). */
    reuse: Schema.Boolean,
  }),
]).annotate({ identifier: "ScheduledTask.Target" })
export type Target = typeof Target.Type

// ---------------------------------------------------------------------------
// Conversation / Session continuity (08-scheduler-workspace-session-continuity)
// ---------------------------------------------------------------------------

export const SessionPolicy = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("new") }),
  Schema.Struct({ kind: Schema.Literal("reuse") }),
  Schema.Struct({ kind: Schema.Literal("auto") }),
  Schema.Struct({
    kind: Schema.Literal("existing"),
    sessionID: SessionID,
  }),
]).annotate({ identifier: "ScheduledTask.SessionPolicy" })
export type SessionPolicy = typeof SessionPolicy.Type

// ---------------------------------------------------------------------------
// Action (03-execution-and-safety.md § 4)
// ---------------------------------------------------------------------------

export const GoalAction = Schema.Struct({
  title: Schema.String,
  objective: Schema.String,
  criteria: optional(Schema.Array(Schema.String)),
  /** Bounds for the unattended run; core applies tighter scheduled defaults. */
  continuationPolicy: optional(Goal.ContinuationPolicy),
}).annotate({ identifier: "ScheduledTask.GoalAction" })
export interface GoalAction extends Schema.Schema.Type<typeof GoalAction> {}

export const Action = Schema.Struct({
  /** May be a slash command, e.g. `/review src/`. */
  prompt: Schema.String,
  agent: optional(Schema.String),
  model: optional(Model.Ref),
  goal: optional(GoalAction),
}).annotate({ identifier: "ScheduledTask.Action" })
export interface Action extends Schema.Schema.Type<typeof Action> {}

// ---------------------------------------------------------------------------
// Policy — every behavior is an explicit, persisted field (02, 03)
// ---------------------------------------------------------------------------

export const CatchUpPolicy = Schema.Literals(["skip", "run_once", "run_all"]).annotate({
  identifier: "ScheduledTask.CatchUpPolicy",
})
export type CatchUpPolicy = typeof CatchUpPolicy.Type

export const OverrunPolicy = Schema.Literals(["skip", "queue", "cancel_prior"]).annotate({
  identifier: "ScheduledTask.OverrunPolicy",
})
export type OverrunPolicy = typeof OverrunPolicy.Type

export const PermissionMode = Schema.Literals(["deny", "pause", "inherit"]).annotate({
  identifier: "ScheduledTask.PermissionMode",
})
export type PermissionMode = typeof PermissionMode.Type

export const NotifyMode = Schema.Literals(["failure", "always", "never"]).annotate({
  identifier: "ScheduledTask.NotifyMode",
})
export type NotifyMode = typeof NotifyMode.Type

/** User-supplied policy; omitted fields resolve to named defaults on write. */
export const Policy = Schema.Struct({
  catchUp: optional(CatchUpPolicy),
  catchUpMaxAgeMs: optional(Schema.Number),
  overrun: optional(OverrunPolicy),
  jitterMs: optional(Schema.Number),
  maxAttempts: optional(Schema.Number),
  maxDurationMs: optional(Schema.Number),
  retentionRuns: optional(Schema.Number),
  permission: optional(PermissionMode),
  notify: optional(NotifyMode),
}).annotate({ identifier: "ScheduledTask.Policy" })
export type Policy = typeof Policy.Type

/** Effective policy as stored; no field is implicit at the API boundary. */
export const ResolvedPolicy = Schema.Struct({
  catchUp: CatchUpPolicy,
  catchUpMaxAgeMs: Schema.Number,
  overrun: OverrunPolicy,
  jitterMs: Schema.Number,
  maxAttempts: Schema.Number,
  maxDurationMs: Schema.Number,
  retentionRuns: Schema.Number,
  permission: PermissionMode,
  notify: NotifyMode,
}).annotate({ identifier: "ScheduledTask.ResolvedPolicy" })
export interface ResolvedPolicy extends Schema.Schema.Type<typeof ResolvedPolicy> {}

export const SetPolicy = Schema.Struct({
  paused: Schema.Boolean,
}).annotate({ identifier: "ScheduledTask.SetPolicy" })

// ---------------------------------------------------------------------------
// Run history
// ---------------------------------------------------------------------------

export const RunStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "skipped",
  "abandoned",
]).annotate({ identifier: "ScheduledTask.RunStatus" })
export type RunStatus = typeof RunStatus.Type

export const Trigger = Schema.Literals(["schedule", "manual", "catchup", "retry"]).annotate({
  identifier: "ScheduledTask.Trigger",
})
export type Trigger = typeof Trigger.Type

export const SkipReason = Schema.Literals([
  "target_missing",
  "stale",
  "overrun",
  "disabled",
  "invalid_schedule",
  "paused",
  "already_settled",
  "deleted",
  "max_attempts",
]).annotate({ identifier: "ScheduledTask.SkipReason" })
export type SkipReason = typeof SkipReason.Type

export const ErrorKind = Schema.Literals([
  "config",
  "auth",
  "quota",
  "provider",
  "timeout",
  "aborted",
  "internal",
  "target_missing",
]).annotate({ identifier: "ScheduledTask.ErrorKind" })
export type ErrorKind = typeof ErrorKind.Type

export const Source = Schema.Literals(["api", "agent", "oxp", "loop_file"]).annotate({ identifier: "ScheduledTask.Source" })
export type Source = typeof Source.Type

/**
 * Durable run outcome. Times are epoch millis (not DateTime) because the
 * countdown UI formats the integer directly and never parses schedules.
 */
export const Run = Schema.Struct({
  id: RunID,
  taskID: ID,
  /** The logical scheduled instant, not "now". Idempotency key with taskID. */
  fireFor: Schema.Number,
  trigger: Trigger,
  status: RunStatus,
  sessionID: optional(SessionID),
  /** Fresh Goal owned by this logical run when action.goal is enabled. */
  goalID: optional(Goal.ID),
  workspaceID: optional(WorkspaceID),
  directory: optional(Schema.String),
  skipReason: optional(SkipReason),
  errorKind: optional(ErrorKind),
  errorMessage: optional(Schema.String),
  acknowledgedAt: optional(Schema.Number),
  attempt: optional(Schema.Number),
  startedAt: Schema.Number,
  finishedAt: optional(Schema.Number),
}).annotate({ identifier: "ScheduledTask.Run" })
export interface Run extends Schema.Schema.Type<typeof Run> {}

export const Info = Schema.Struct({
  id: ID,
  projectID: optional(ProjectID),
  targetDirectory: Schema.String,
  target: Target,
  sessionPolicy: SessionPolicy,
  name: Schema.String,
  enabled: Schema.Boolean,
  revision: Schema.Number,
  schedule: Schedule,
  timezone: optional(Schema.String),
  action: Action,
  policy: ResolvedPolicy,
  nextRunAt: optional(Schema.Number),
  lastRunAt: optional(Schema.Number),
  lastRunStatus: optional(RunStatus),
  lastRunID: optional(RunID),
  consecutiveFailures: Schema.Number,
  source: Source,
  sourcePath: optional(Schema.String),
  /** Opaque durable turn id that authorized an agent-created schedule. */
  sourceMessageID: optional(Schema.String),
  /** Producer-specific durable correlation for non-Session origins such as OXP. */
  sourceRef: optional(Schema.String),
  /** External producer principal when the origin is not a native Session turn. */
  sourcePrincipal: optional(Schema.String),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "ScheduledTask.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const SessionBinding = Schema.Struct({
  taskID: ID,
  sessionID: SessionID,
  taskRevision: Schema.Number,
  userSeqFence: optional(Schema.Number),
  generation: Schema.Number,
  timeUpdated: DateTimeUtcFromMillis,
}).annotate({ identifier: "ScheduledTask.SessionBinding" })
export interface SessionBinding extends Schema.Schema.Type<typeof SessionBinding> {}

/** Compact Tier-0 UI projection; the Auto User fence remains runner-private. */
export const SessionBindingProjection = Schema.Struct({
  taskID: ID,
  sessionID: SessionID,
  generation: Schema.Number,
  timeUpdated: DateTimeUtcFromMillis,
}).annotate({ identifier: "ScheduledTask.SessionBindingProjection" })
export interface SessionBindingProjection extends Schema.Schema.Type<typeof SessionBindingProjection> {}

/** Compact Tier-0 row for the Existing-Session picker. */
export const SessionCandidate = Schema.Struct({
  id: SessionID,
  projectID: ProjectID,
  directory: Schema.String,
  title: Schema.String,
  timeUpdated: DateTimeUtcFromMillis,
}).annotate({ identifier: "ScheduledTask.SessionCandidate" })
export interface SessionCandidate extends Schema.Schema.Type<typeof SessionCandidate> {}

export const Control = Schema.Struct({
  paused: Schema.Boolean,
  timeUpdated: DateTimeUtcFromMillis,
}).annotate({ identifier: "ScheduledTask.Control" })
export interface Control extends Schema.Schema.Type<typeof Control> {}

export const Preview = Schema.Struct({
  next: Schema.Array(Schema.Number),
  warnings: Schema.Array(Schema.String),
  summary: Schema.String,
}).annotate({ identifier: "ScheduledTask.Preview" })
export interface Preview extends Schema.Schema.Type<typeof Preview> {}

export const AgendaOccurrence = Schema.Struct({
  taskID: ID,
  /** Logical recurrence instant before deterministic jitter. */
  scheduledAt: Schema.Number,
  /** Effective fire instant after deterministic jitter. */
  effectiveAt: Schema.Number,
}).annotate({ identifier: "ScheduledTask.AgendaOccurrence" })
export interface AgendaOccurrence extends Schema.Schema.Type<typeof AgendaOccurrence> {}

export const InboxCount = Schema.Struct({
  unread: Schema.Number,
}).annotate({ identifier: "ScheduledTask.InboxCount" })
export interface InboxCount extends Schema.Schema.Type<typeof InboxCount> {}

// Live protocol events. These are intentionally non-durable in EventV2: the
// authoritative `scheduled_task` / `scheduled_task_run` rows are the durable
// source of truth, while these compact projections (never output bodies) keep
// clients incrementally coherent.
const Created = define({ type: "scheduledTask.created", schema: { taskID: ID, info: Info } })
const Updated = define({ type: "scheduledTask.updated", schema: { taskID: ID, info: Info } })
const Removed = define({ type: "scheduledTask.removed", schema: { taskID: ID } })
const RunStarted = define({ type: "scheduledTask.runStarted", schema: { taskID: ID, run: Run } })
const RunSettled = define({ type: "scheduledTask.runSettled", schema: { taskID: ID, run: Run } })
// Non-terminal run projection changes (manual enqueue, permission `waiting`).
// The Run payload is authoritative; clients patch one row by id.
const RunUpdated = define({ type: "scheduledTask.runUpdated", schema: { taskID: ID, run: Run } })
const ControlChanged = define({ type: "scheduledTask.controlChanged", schema: { control: Control } })
const SessionBindingChanged = define({
  type: "scheduledTask.sessionBindingChanged",
  schema: { taskID: ID, binding: Schema.NullOr(SessionBindingProjection) },
})

export const Event = {
  Created,
  Updated,
  Removed,
  RunStarted,
  RunSettled,
  RunUpdated,
  ControlChanged,
  SessionBindingChanged,
  Definitions: [Created, Updated, Removed, RunStarted, RunSettled, RunUpdated, ControlChanged, SessionBindingChanged],
} as const
