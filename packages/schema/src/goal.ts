export * as Goal from "./goal"

import { Schema } from "effect"
import { define } from "./event"
import { GoalID } from "./goal-id"
import { ProjectID } from "./project-id"
import { SessionID } from "./session-id"
import { WorkspaceID } from "./workspace-id"
import { Model } from "./model"
import { DateTimeUtcFromMillis, optional, statics } from "./schema"
import { descending } from "./identifier"

export const ID = GoalID
export type ID = GoalID

function childID<const Prefix extends string, const Brand extends string>(prefix: Prefix, brand: Brand) {
  return Schema.String.check(Schema.isStartsWith(prefix)).pipe(
    Schema.brand(brand),
    statics((schema) => ({ create: () => schema.make(prefix + descending()) })),
  )
}

export const CriterionID = childID("gcr_", "GoalCriterionID")
export type CriterionID = typeof CriterionID.Type

export const StepID = childID("gst_", "GoalStepID")
export type StepID = typeof StepID.Type

export const EvidenceID = childID("gev_", "GoalEvidenceID")
export type EvidenceID = typeof EvidenceID.Type

export const AuditEventID = childID("gae_", "GoalAuditEventID")
export type AuditEventID = typeof AuditEventID.Type

export const Status = Schema.Literals([
  "draft",
  "active",
  "paused",
  "blocked",
  "verifying",
  "completed",
  "cancelled",
  "failed",
]).annotate({ identifier: "Goal.Status" })
export type Status = typeof Status.Type

export const CriterionStatus = Schema.Literals(["pending", "passed", "failed"]).annotate({
  identifier: "Goal.CriterionStatus",
})
export type CriterionStatus = typeof CriterionStatus.Type

export const StepStatus = Schema.Literals(["pending", "active", "blocked", "completed", "cancelled"]).annotate({
  identifier: "Goal.StepStatus",
})
export type StepStatus = typeof StepStatus.Type

export const FocusRole = Schema.Literals(["owner", "worker", "verifier"]).annotate({ identifier: "Goal.FocusRole" })
export type FocusRole = typeof FocusRole.Type

export const AutomationMode = Schema.Literals(["manual", "auto_continue", "unattended"]).annotate({
  identifier: "Goal.AutomationMode",
})
export type AutomationMode = typeof AutomationMode.Type

/**
 * User-owned continuation policy. Limits intentionally live in JSON so the
 * guardrail surface can grow without a database migration for every knob.
 * Phase 1 only consumes `mode`; later runner integration may honor the bounds.
 */
export interface ContinuationPolicy extends Schema.Schema.Type<typeof ContinuationPolicy> {}
export const ContinuationPolicy = Schema.Struct({
  mode: AutomationMode,
  maxConsecutiveTurns: optional(Schema.Number),
  maxNoProgressTurns: optional(Schema.Number),
  maxDurationMs: optional(Schema.Number),
  tokenBudget: optional(Schema.Number),
}).annotate({ identifier: "Goal.ContinuationPolicy" })

/**
 * Independent evaluator configuration for automatic Goal execution.
 *
 * `model` is intentionally optional: when omitted the runtime inherits the
 * worker Session model. Persisting the override on the Goal keeps auditor
 * choice stable across workers, app restarts, and delegated Sessions.
 */
export interface AuditorPolicy extends Schema.Schema.Type<typeof AuditorPolicy> {}
export const AuditorPolicy = Schema.Struct({
  model: Model.Ref.pipe(optional),
  blockedThreshold: Schema.Number.pipe(optional),
  maxAttempts: Schema.Number.pipe(optional),
}).annotate({ identifier: "Goal.AuditorPolicy" })

export const AuditorDecision = Schema.Literals(["continue", "complete", "blocked"]).annotate({
  identifier: "Goal.AuditorDecision",
})
export type AuditorDecision = typeof AuditorDecision.Type

const AuditorVerdictBase = {
  rationale: Schema.String,
  progressMade: Schema.Boolean,
  confidence: Schema.Number.pipe(optional),
  criteria: Schema.Array(
    Schema.Struct({
      criterionID: CriterionID,
      status: CriterionStatus,
      evidence: Schema.String,
    }).annotate({ identifier: "Goal.AuditorCriterionAssessment" }),
  ),
} as const

/**
 * The verdict is also the semantic handoff between the independent auditor and
 * the next autonomous worker cycle. `continuationPrompt` is deliberately
 * decision-specific rather than optional on every verdict: if the auditor
 * authorizes more work, it must say what the next worker should actually do.
 * `criteria` is the auditor's independent criterion-by-criterion verification
 * result. Core, not the model, decides how those findings mutate durable Goal
 * state and whether they are sufficient to complete the verification gate.
 */
export const AuditorVerdict = Schema.Union([
  Schema.Struct({
    ...AuditorVerdictBase,
    decision: Schema.Literal("continue"),
    continuationPrompt: Schema.String,
  }),
  Schema.Struct({
    ...AuditorVerdictBase,
    decision: Schema.Literal("blocked"),
    blocker: Schema.String,
    continuationPrompt: Schema.String,
  }),
  Schema.Struct({
    ...AuditorVerdictBase,
    decision: Schema.Literal("complete"),
  }),
]).annotate({ identifier: "Goal.AuditorVerdict" })
export type AuditorVerdict = typeof AuditorVerdict.Type

export interface Criterion extends Schema.Schema.Type<typeof Criterion> {}
export const Criterion = Schema.Struct({
  id: CriterionID,
  position: Schema.Number,
  description: Schema.String,
  status: CriterionStatus,
}).annotate({ identifier: "Goal.Criterion" })

export interface Step extends Schema.Schema.Type<typeof Step> {}
export const Step = Schema.Struct({
  id: StepID,
  position: Schema.Number,
  title: Schema.String,
  description: Schema.String,
  status: StepStatus,
  assignedSessionID: optional(SessionID),
  attempts: Schema.Number,
  time: Schema.Struct({
    started: optional(DateTimeUtcFromMillis),
    completed: optional(DateTimeUtcFromMillis),
  }),
}).annotate({ identifier: "Goal.Step" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  projectID: ProjectID,
  workspaceID: optional(WorkspaceID),
  title: Schema.String,
  objective: Schema.String,
  constraints: Schema.Array(Schema.String),
  status: Status,
  revision: Schema.Number,
  continuationPolicy: ContinuationPolicy,
  auditorPolicy: AuditorPolicy,
  blocker: optional(Schema.String),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    completed: optional(DateTimeUtcFromMillis),
  }),
}).annotate({ identifier: "Goal.Info" })

export interface Detail extends Schema.Schema.Type<typeof Detail> {}
export const Detail = Schema.Struct({
  goal: Info,
  criteria: Schema.Array(Criterion),
  steps: Schema.Array(Step),
}).annotate({ identifier: "Goal.Detail" })

export interface Focus extends Schema.Schema.Type<typeof Focus> {}
export const Focus = Schema.Struct({
  sessionID: SessionID,
  goalID: ID,
  role: FocusRole,
  focusedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Goal.Focus" })

export const AuditActor = Schema.Literals(["user", "agent", "auditor", "system"]).annotate({ identifier: "Goal.AuditActor" })
export type AuditActor = typeof AuditActor.Type

export const AuditEventType = Schema.Literals([
  "created",
  "specification_updated",
  "transitioned",
  "criterion_updated",
  "step_updated",
  "evidence_added",
  "audited",
  "auditor_session_linked",
  "focused",
  "unfocused",
]).annotate({ identifier: "Goal.AuditEventType" })
export type AuditEventType = typeof AuditEventType.Type

export interface Evidence extends Schema.Schema.Type<typeof Evidence> {}
export const Evidence = Schema.Struct({
  id: EvidenceID,
  goalID: ID,
  criterionID: optional(CriterionID),
  stepID: optional(StepID),
  type: Schema.String,
  sessionID: optional(SessionID),
  messageID: optional(Schema.String),
  checkpointID: optional(Schema.String),
  path: optional(Schema.String),
  commitSHA: optional(Schema.String),
  summary: Schema.String,
  verdict: optional(Schema.String),
  createdAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Goal.Evidence" })

export interface AuditEvent extends Schema.Schema.Type<typeof AuditEvent> {}
export const AuditEvent = Schema.Struct({
  id: AuditEventID,
  goalID: ID,
  seq: Schema.Number,
  type: AuditEventType,
  actor: AuditActor,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  createdAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "Goal.AuditEvent" })

// Live protocol events. These are intentionally non-durable in EventV2: the
// authoritative Goal rows plus `goal_event` audit log are the durable source of
// truth, while these notifications keep clients incrementally coherent.
const Created = define({ type: "goal.created", schema: { goalID: ID, info: Info } })
const Updated = define({ type: "goal.updated", schema: { goalID: ID, info: Info } })
const Focused = define({ type: "goal.focused", schema: { goalID: ID, sessionID: SessionID, role: FocusRole } })
const Unfocused = define({ type: "goal.unfocused", schema: { goalID: ID, sessionID: SessionID } })

export const Event = {
  Created,
  Updated,
  Focused,
  Unfocused,
  Definitions: [Created, Updated, Focused, Unfocused],
} as const
