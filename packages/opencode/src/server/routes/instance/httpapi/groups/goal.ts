import { Goal } from "@opencode-ai/schema/goal"
import { ProjectV2 } from "@opencode-ai/core/project"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { ApiNotFoundError, ConflictError } from "../errors"
import { described } from "./metadata"

const root = "/goal"

export const GoalPaths = {
  list: root,
  create: root,
  get: `${root}/:goalID`,
  update: `${root}/:goalID`,
  transition: `${root}/:goalID/transition`,
  criterion: `${root}/:goalID/criterion/:criterionID`,
  step: `${root}/:goalID/step/:stepID`,
  evidence: `${root}/:goalID/evidence`,
  audit: `${root}/:goalID/audit`,
  focuses: `${root}/:goalID/focus`,
  sessionFocus: `/session/:sessionID/goal`,
} as const

export const ListQuery = Schema.Struct({
  projectID: ProjectV2.ID,
  workspaceID: Schema.optionalKey(WorkspaceV2.ID),
})

const StepDraft = Schema.Struct({
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
})

export const CreatePayload = Schema.Struct({
  projectID: ProjectV2.ID,
  workspaceID: Schema.optionalKey(WorkspaceV2.ID),
  title: Schema.String,
  objective: Schema.String,
  constraints: Schema.optionalKey(Schema.Array(Schema.String)),
  criteria: Schema.optionalKey(Schema.Array(Schema.String)),
  steps: Schema.optionalKey(Schema.Array(StepDraft)),
  continuationPolicy: Schema.optionalKey(Goal.ContinuationPolicy),
  auditorPolicy: Schema.optionalKey(Goal.AuditorPolicy),
})

export const UpdatePayload = Schema.Struct({
  expectedRevision: Schema.Number,
  title: Schema.optionalKey(Schema.String),
  objective: Schema.optionalKey(Schema.String),
  constraints: Schema.optionalKey(Schema.Array(Schema.String)),
  criteria: Schema.optionalKey(Schema.Array(Schema.String)),
  steps: Schema.optionalKey(Schema.Array(StepDraft)),
  continuationPolicy: Schema.optionalKey(Goal.ContinuationPolicy),
  auditorPolicy: Schema.optionalKey(Goal.AuditorPolicy),
})

export const TransitionPayload = Schema.Struct({
  expectedRevision: Schema.Number,
  action: Schema.Literals([
    "start",
    "pause",
    "resume",
    "block",
    "request_verification",
    "verification_pass",
    "verification_fail",
    "cancel",
    "fail",
  ]),
  blocker: Schema.optionalKey(Schema.String),
})

export const CriterionPayload = Schema.Struct({
  expectedRevision: Schema.Number,
  status: Goal.CriterionStatus,
})

export const StepPayload = Schema.Struct({
  expectedRevision: Schema.Number,
  status: Schema.optionalKey(Goal.StepStatus),
  assignedSessionID: Schema.optionalKey(Schema.NullOr(SessionSchema.ID)),
})

export const EvidencePayload = Schema.Struct({
  expectedRevision: Schema.Number,
  criterionID: Schema.optionalKey(Goal.CriterionID),
  stepID: Schema.optionalKey(Goal.StepID),
  type: Schema.String,
  sessionID: Schema.optionalKey(SessionSchema.ID),
  messageID: Schema.optionalKey(Schema.String),
  checkpointID: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  commitSHA: Schema.optionalKey(Schema.String),
  summary: Schema.String,
  verdict: Schema.optionalKey(Schema.String),
})

export const FocusPayload = Schema.Struct({
  goalID: Goal.ID,
  role: Schema.optionalKey(Goal.FocusRole),
})

const errors = [HttpApiError.BadRequest, ApiNotFoundError, ConflictError] as const

export const GoalApi = HttpApi.make("goal")
  .add(
    HttpApiGroup.make("goal")
      .add(
        HttpApiEndpoint.get("list", GoalPaths.list, {
          query: ListQuery,
          success: described(Schema.Array(Goal.Info), "Goals in project scope"),
          error: errors,
        }).annotateMerge(OpenApi.annotations({ identifier: "goal.list", summary: "List Goals" })),
        HttpApiEndpoint.post("create", GoalPaths.create, {
          payload: CreatePayload,
          success: described(Goal.Detail, "Created Goal"),
          error: errors,
        }).annotateMerge(OpenApi.annotations({ identifier: "goal.create", summary: "Create Goal" })),
        HttpApiEndpoint.get("get", GoalPaths.get, {
          params: { goalID: Goal.ID },
          success: described(Goal.Detail, "Goal detail"),
          error: errors,
        }).annotateMerge(OpenApi.annotations({ identifier: "goal.get", summary: "Get Goal" })),
        HttpApiEndpoint.patch("update", GoalPaths.update, {
          params: { goalID: Goal.ID },
          payload: UpdatePayload,
          success: described(Goal.Detail, "Updated Goal"),
          error: errors,
        }).annotateMerge(OpenApi.annotations({ identifier: "goal.update", summary: "Update Goal specification" })),
        HttpApiEndpoint.post("transition", GoalPaths.transition, {
          params: { goalID: Goal.ID },
          payload: TransitionPayload,
          success: described(Goal.Detail, "Transitioned Goal"),
          error: errors,
        }).annotateMerge(OpenApi.annotations({ identifier: "goal.transition", summary: "Transition Goal lifecycle" })),
        HttpApiEndpoint.patch("criterion", GoalPaths.criterion, {
          params: { goalID: Goal.ID, criterionID: Goal.CriterionID },
          payload: CriterionPayload,
          success: described(Goal.Detail, "Updated acceptance criterion"),
          error: errors,
        }).annotateMerge(OpenApi.annotations({ identifier: "goal.criterion", summary: "Update Goal criterion" })),
        HttpApiEndpoint.patch("step", GoalPaths.step, {
          params: { goalID: Goal.ID, stepID: Goal.StepID },
          payload: StepPayload,
          success: described(Goal.Detail, "Updated Goal step"),
          error: errors,
        }).annotateMerge(OpenApi.annotations({ identifier: "goal.step", summary: "Update or assign Goal step" })),
        HttpApiEndpoint.get("evidence", GoalPaths.evidence, {
          params: { goalID: Goal.ID },
          success: described(Schema.Array(Goal.Evidence), "Goal evidence"),
          error: errors,
        }).annotateMerge(OpenApi.annotations({ identifier: "goal.evidence", summary: "List Goal evidence" })),
        HttpApiEndpoint.post("addEvidence", GoalPaths.evidence, {
          params: { goalID: Goal.ID },
          payload: EvidencePayload,
          success: described(Goal.Evidence, "Added Goal evidence"),
          error: errors,
        }).annotateMerge(OpenApi.annotations({ identifier: "goal.addEvidence", summary: "Add Goal evidence" })),
        HttpApiEndpoint.get("audit", GoalPaths.audit, {
          params: { goalID: Goal.ID },
          success: described(Schema.Array(Goal.AuditEvent), "Goal audit history"),
          error: errors,
        }).annotateMerge(OpenApi.annotations({ identifier: "goal.audit", summary: "Get Goal audit history" })),
        HttpApiEndpoint.get("focuses", GoalPaths.focuses, {
          params: { goalID: Goal.ID },
          success: described(Schema.Array(Goal.Focus), "Sessions focused on Goal"),
          error: errors,
        }).annotateMerge(OpenApi.annotations({ identifier: "goal.focuses", summary: "List Goal Session focus bindings" })),
        HttpApiEndpoint.get("focused", GoalPaths.sessionFocus, {
          params: { sessionID: SessionSchema.ID },
          success: described(Schema.NullOr(Schema.Struct({ focus: Goal.Focus, detail: Goal.Detail })), "Focused Goal"),
          error: errors,
        }).annotateMerge(OpenApi.annotations({ identifier: "goal.focused", summary: "Get focused Goal for Session" })),
        HttpApiEndpoint.put("focus", GoalPaths.sessionFocus, {
          params: { sessionID: SessionSchema.ID },
          payload: FocusPayload,
          success: described(Goal.Focus, "Focused Goal"),
          error: errors,
        }).annotateMerge(OpenApi.annotations({ identifier: "goal.focus", summary: "Focus Goal for Session" })),
        HttpApiEndpoint.delete("unfocus", GoalPaths.sessionFocus, {
          params: { sessionID: SessionSchema.ID },
          success: described(HttpApiSchema.NoContent, "Removed Goal focus"),
          error: errors,
        }).annotateMerge(OpenApi.annotations({ identifier: "goal.unfocus", summary: "Unfocus Goal for Session" })),
      )
      .annotateMerge(
        OpenApi.annotations({ title: "goal", description: "Fork-owned durable Goal orchestration routes." }),
      )
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "opencode Goal HttpApi", version: "0.0.1", description: "Native Goal Mode API." }),
  )
