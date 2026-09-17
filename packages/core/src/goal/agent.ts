export * as GoalAgent from "./agent"

import { Context, Effect, Layer, Schema } from "effect"
import { Goal as GoalModel } from "@opencode-ai/schema/goal"
import { SessionSchema } from "../session/schema"
import { makeGlobalNode } from "../effect/app-node"
import { Goal } from "./index"
import { GoalSchema } from "./schema"
import { GoalCreationPolicy } from "./creation-policy"
import { SessionStore } from "../session/store"

const Step = Schema.Struct({
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
})

const Evidence = Schema.Struct({
  type: Schema.String,
  summary: Schema.String,
  verdict: Schema.optionalKey(Schema.String),
  checkpointID: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  commitSHA: Schema.optionalKey(Schema.String),
})

export const Input = Schema.Struct({
  action: Schema.Literals([
    "status",
    "progress",
    "add_evidence",
    "block",
    "request_verification",
    "claim_step",
    "release_step",
    "verify",
    "create",
  ]),
  expectedRevision: Schema.optionalKey(Schema.Number),
  criterionID: Schema.optionalKey(GoalModel.CriterionID),
  criterionStatus: Schema.optionalKey(GoalModel.CriterionStatus),
  stepID: Schema.optionalKey(GoalModel.StepID),
  stepStatus: Schema.optionalKey(GoalModel.StepStatus),
  evidence: Schema.optionalKey(Evidence),
  blocker: Schema.optionalKey(Schema.String),
  verdict: Schema.optionalKey(Schema.Literals(["pass", "fail"])),
  title: Schema.optionalKey(Schema.String),
  objective: Schema.optionalKey(Schema.String),
  constraints: Schema.optionalKey(Schema.Array(Schema.String)),
  criteria: Schema.optionalKey(Schema.Array(Schema.String)),
  steps: Schema.optionalKey(Schema.Array(Step)),
  start: Schema.optionalKey(Schema.Boolean),
  continuationMode: Schema.optionalKey(Schema.Literals(["manual", "auto_continue", "unattended"])),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  action: Schema.String,
  goal: GoalModel.Detail,
  evidence: Schema.optionalKey(GoalModel.Evidence),
})
export type Output = typeof Output.Type

export interface Interface {
  readonly execute: (
    sessionID: SessionSchema.ID,
    input: Input,
    turn?: GoalCreationPolicy.TurnProvenance,
  ) => Effect.Effect<Output, GoalSchema.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GoalAgent") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const goals = yield* Goal.Service
    const sessions = yield* SessionStore.Service

    const focused = Effect.fn("GoalAgent.focused")(function* (sessionID: SessionSchema.ID) {
      const current = yield* goals.focused(sessionID)
      if (!current) return yield* new GoalSchema.ValidationError({ reason: "this Session has no focused Goal" })
      return current
    })

    const expected = (input: Input, actual: number) => input.expectedRevision ?? actual

    const execute = Effect.fn("GoalAgent.execute")(function* (
      sessionID: SessionSchema.ID,
      input: Input,
      turn?: GoalCreationPolicy.TurnProvenance,
    ) {
      if (input.action === "create") {
        const authorization = GoalCreationPolicy.authorize(turn)
        if (!authorization.allowed) return yield* new GoalSchema.ValidationError({ reason: authorization.reason })
        const session = yield* sessions.get(sessionID)
        if (!session) return yield* new GoalSchema.ValidationError({ reason: `session does not exist: ${sessionID}` })
        if (session.parentID !== undefined) {
          return yield* new GoalSchema.ValidationError({
            reason: "child Sessions cannot create Goals; ask the parent Session to create and own the Goal",
          })
        }
        const objective = input.objective?.trim()
        if (!objective) return yield* new GoalSchema.ValidationError({ reason: "create requires objective" })
        const criteria = (input.criteria ?? []).map((item) => item.trim()).filter(Boolean)
        if (criteria.length === 0) {
          return yield* new GoalSchema.ValidationError({ reason: "create requires at least one acceptance criterion" })
        }
        if (input.continuationMode === "unattended" && !GoalCreationPolicy.explicitlyRequestsUnattended(turn!.userText)) {
          return yield* new GoalSchema.ValidationError({
            reason: "unattended Goal creation requires the user to explicitly request unattended Goal mode",
          })
        }

        const existing = yield* goals.focused(sessionID)
        const shouldStart = GoalCreationPolicy.explicitlyRequestsDraft(turn!.userText) ? false : (input.start ?? true)
        if (existing) {
          if (existing.detail.goal.objective !== objective) {
            return yield* new GoalSchema.ValidationError({
              reason: "this Session already has a different focused Goal; do not replace it implicitly",
            })
          }
          if (["completed", "cancelled", "failed"].includes(existing.detail.goal.status)) {
            return yield* new GoalSchema.ValidationError({
              reason: `the matching focused Goal is already ${existing.detail.goal.status}; unfocus it before creating a new Goal`,
            })
          }
          let detail = existing.detail
          if (shouldStart && detail.goal.status === "draft") {
            detail = yield* goals.transition({
              id: detail.goal.id,
              expectedRevision: detail.goal.revision,
              action: "start",
              actor: "agent",
            })
          }
          return { action: input.action, goal: detail }
        }

        const quickTitle = () => {
          const supplied = input.title?.trim()
          if (supplied) return supplied
          const line = objective.split(/\r?\n/, 1)[0]?.trim() || "Goal"
          return line.length <= 72 ? line : `${line.slice(0, 69).trimEnd()}…`
        }
        let detail = yield* goals.create({
          projectID: session.projectID,
          workspaceID: session.location.workspaceID,
          title: quickTitle(),
          objective,
          constraints: input.constraints,
          criteria,
          steps: input.steps,
          continuationPolicy: { mode: input.continuationMode ?? "auto_continue" },
          sourceMessageID: turn!.userMessageID,
          actor: "agent",
        })
        yield* goals.focus({ goalID: detail.goal.id, sessionID, role: "owner", actor: "agent" })
        if (shouldStart) {
          detail = yield* goals.transition({
            id: detail.goal.id,
            expectedRevision: detail.goal.revision,
            action: "start",
            actor: "agent",
          })
        }
        return { action: input.action, goal: detail }
      }

      const current = yield* focused(sessionID)
      let detail = current.detail
      let evidence: GoalModel.Evidence | undefined

      if (input.action === "status") return { action: input.action, goal: detail }

      if (input.action === "block") {
        if (!input.blocker?.trim()) return yield* new GoalSchema.ValidationError({ reason: "block requires blocker" })
        detail = yield* goals.transition({
          id: detail.goal.id,
          expectedRevision: expected(input, detail.goal.revision),
          action: "block",
          blocker: input.blocker,
          actor: "agent",
        })
        return { action: input.action, goal: detail }
      }

      if (input.action === "request_verification") {
        detail = yield* goals.transition({
          id: detail.goal.id,
          expectedRevision: expected(input, detail.goal.revision),
          action: "request_verification",
          actor: "agent",
        })
        return { action: input.action, goal: detail }
      }

      if (input.action === "claim_step" || input.action === "release_step") {
        if (!input.stepID) return yield* new GoalSchema.ValidationError({ reason: `${input.action} requires stepID` })
        detail = yield* (input.action === "claim_step" ? goals.claimStep : goals.releaseStep)({
          goalID: detail.goal.id,
          stepID: input.stepID,
          sessionID,
          expectedRevision: expected(input, detail.goal.revision),
          actor: "agent",
        })
        return { action: input.action, goal: detail }
      }

      if (input.action === "verify") {
        if (current.focus.role !== "verifier") {
          return yield* new GoalSchema.ValidationError({ reason: "verify requires a verifier Goal focus role" })
        }
        if (!input.verdict) return yield* new GoalSchema.ValidationError({ reason: "verify requires verdict pass or fail" })
        detail = yield* goals.transition({
          id: detail.goal.id,
          expectedRevision: expected(input, detail.goal.revision),
          action: input.verdict === "pass" ? "verification_pass" : "verification_fail",
          actor: "agent",
        })
        return { action: input.action, goal: detail }
      }

      if (input.action === "add_evidence") {
        if (!input.evidence) return yield* new GoalSchema.ValidationError({ reason: "add_evidence requires evidence" })
        if (!input.criterionID && !input.stepID) {
          return yield* new GoalSchema.ValidationError({ reason: "add_evidence requires criterionID and/or stepID" })
        }
        evidence = yield* goals.addEvidence({
          goalID: detail.goal.id,
          expectedRevision: expected(input, detail.goal.revision),
          criterionID: input.criterionID,
          stepID: input.stepID,
          sessionID,
          type: input.evidence.type,
          summary: input.evidence.summary,
          verdict: input.evidence.verdict,
          checkpointID: input.evidence.checkpointID,
          path: input.evidence.path,
          commitSHA: input.evidence.commitSHA,
          actor: "agent",
        })
        detail = yield* goals.get(detail.goal.id)
        return { action: input.action, goal: detail, evidence }
      }

      if (input.action !== "progress") return yield* new GoalSchema.ValidationError({ reason: "unsupported Goal action" })
      if (!input.criterionID && !input.stepID && !input.evidence) {
        return yield* new GoalSchema.ValidationError({ reason: "progress requires a criterion, step, and/or evidence update" })
      }
      if (input.criterionStatus === "passed" && !input.evidence) {
        const existing = yield* goals.evidence(detail.goal.id)
        if (!input.criterionID || !existing.some((item) => item.criterionID === input.criterionID)) {
          return yield* new GoalSchema.ValidationError({
            reason: "passing a criterion requires supporting evidence in this action or already attached to the criterion",
          })
        }
      }

      let revision = expected(input, detail.goal.revision)
      if (input.evidence) {
        if (!input.criterionID && !input.stepID) {
          return yield* new GoalSchema.ValidationError({ reason: "progress evidence requires criterionID and/or stepID" })
        }
        evidence = yield* goals.addEvidence({
          goalID: detail.goal.id,
          expectedRevision: revision,
          criterionID: input.criterionID,
          stepID: input.stepID,
          sessionID,
          type: input.evidence.type,
          summary: input.evidence.summary,
          verdict: input.evidence.verdict,
          checkpointID: input.evidence.checkpointID,
          path: input.evidence.path,
          commitSHA: input.evidence.commitSHA,
          actor: "agent",
        })
        revision++
      }
      if (input.stepID && input.stepStatus) {
        detail = yield* goals.updateStep({
          goalID: detail.goal.id,
          stepID: input.stepID,
          expectedRevision: revision,
          status: input.stepStatus,
          actor: "agent",
        })
        revision = detail.goal.revision
      }
      if (input.criterionID && input.criterionStatus) {
        detail = yield* goals.updateCriterion({
          goalID: detail.goal.id,
          criterionID: input.criterionID,
          expectedRevision: revision,
          status: input.criterionStatus,
          actor: "agent",
        })
      } else if (evidence && !input.stepStatus) {
        detail = yield* goals.get(detail.goal.id)
      }
      return { action: input.action, goal: detail, ...(evidence ? { evidence } : {}) }
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Goal.node, SessionStore.node] })
