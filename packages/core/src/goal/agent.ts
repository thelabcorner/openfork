export * as GoalAgent from "./agent"

import { Context, Effect, Layer, Schema } from "effect"
import { Goal as GoalModel } from "@opencode-ai/schema/goal"
import { SessionSchema } from "../session/schema"
import { makeGlobalNode } from "../effect/app-node"
import { Goal } from "./index"
import { GoalSchema } from "./schema"

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
  ]),
  expectedRevision: Schema.optionalKey(Schema.Number),
  criterionID: Schema.optionalKey(GoalModel.CriterionID),
  criterionStatus: Schema.optionalKey(GoalModel.CriterionStatus),
  stepID: Schema.optionalKey(GoalModel.StepID),
  stepStatus: Schema.optionalKey(GoalModel.StepStatus),
  evidence: Schema.optionalKey(Evidence),
  blocker: Schema.optionalKey(Schema.String),
  verdict: Schema.optionalKey(Schema.Literals(["pass", "fail"])),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  action: Schema.String,
  goal: GoalModel.Detail,
  evidence: Schema.optionalKey(GoalModel.Evidence),
})
export type Output = typeof Output.Type

export interface Interface {
  readonly execute: (sessionID: SessionSchema.ID, input: Input) => Effect.Effect<Output, GoalSchema.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GoalAgent") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const goals = yield* Goal.Service

    const focused = Effect.fn("GoalAgent.focused")(function* (sessionID: SessionSchema.ID) {
      const current = yield* goals.focused(sessionID)
      if (!current) return yield* new GoalSchema.ValidationError({ reason: "this Session has no focused Goal" })
      return current
    })

    const expected = (input: Input, actual: number) => input.expectedRevision ?? actual

    const execute = Effect.fn("GoalAgent.execute")(function* (sessionID: SessionSchema.ID, input: Input) {
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

export const node = makeGlobalNode({ service: Service, layer, deps: [Goal.node] })
