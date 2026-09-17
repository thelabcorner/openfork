import { Goal } from "@opencode-ai/core/goal"
import { Goal as GoalModel } from "@opencode-ai/schema/goal"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import * as ApiError from "../errors"
import {
  CreatePayload,
  CriterionPayload,
  EvidencePayload,
  FocusPayload,
  ListQuery,
  PreparePayload,
  StepPayload,
  TransitionPayload,
  UpdatePayload,
} from "../groups/goal"

type GoalApiError = HttpApiError.BadRequest | ApiError.ApiNotFoundError | ApiError.ConflictError

const mapError = <A, R>(effect: Effect.Effect<A, Goal.Error, R>): Effect.Effect<A, GoalApiError, R> =>
  effect.pipe(
    Effect.catchTag("Goal.NotFoundError", (error) => Effect.fail(ApiError.notFound(error.message))),
    Effect.catchTag("Goal.StaleRevisionError", (error) =>
      Effect.fail(
        new ApiError.ConflictError({
          message: error.message,
          resource: error.goalID,
          code: "goal_stale_revision",
        }),
      ),
    ),
    Effect.catchTag("Goal.InvalidTransitionError", (error) =>
      Effect.fail(
        new ApiError.ConflictError({ message: error.message, resource: error.goalID, code: "goal_transition" }),
      ),
    ),
    Effect.catchTag("Goal.ValidationError", () => Effect.fail(new HttpApiError.BadRequest({}))),
  )

export const goalHandlers = HttpApiBuilder.group(InstanceHttpApi, "goal", (handlers) =>
  Effect.gen(function* () {
    const goals = yield* Goal.Service

    const list = Effect.fn("GoalHttpApi.list")((ctx: { query: typeof ListQuery.Type }) => goals.list(ctx.query))

    const create = Effect.fn("GoalHttpApi.create")((ctx: { payload: typeof CreatePayload.Type }) =>
      mapError(goals.create({ ...ctx.payload, actor: "user" })),
    )

    const get = Effect.fn("GoalHttpApi.get")((ctx: { params: { goalID: Goal.ID } }) => mapError(goals.get(ctx.params.goalID)))

    const update = Effect.fn("GoalHttpApi.update")((ctx: {
      params: { goalID: Goal.ID }
      payload: typeof UpdatePayload.Type
    }) => mapError(goals.update({ id: ctx.params.goalID, ...ctx.payload, actor: "user" })))

    const transition = Effect.fn("GoalHttpApi.transition")((ctx: {
      params: { goalID: Goal.ID }
      payload: typeof TransitionPayload.Type
    }) => mapError(goals.transition({ id: ctx.params.goalID, ...ctx.payload, actor: "user" })))

    const criterion = Effect.fn("GoalHttpApi.criterion")((ctx: {
      params: { goalID: Goal.ID; criterionID: GoalModel.CriterionID }
      payload: typeof CriterionPayload.Type
    }) => mapError(goals.updateCriterion({ goalID: ctx.params.goalID, criterionID: ctx.params.criterionID, ...ctx.payload, actor: "user" })))

    const step = Effect.fn("GoalHttpApi.step")((ctx: {
      params: { goalID: Goal.ID; stepID: GoalModel.StepID }
      payload: typeof StepPayload.Type
    }) => mapError(goals.updateStep({ goalID: ctx.params.goalID, stepID: ctx.params.stepID, ...ctx.payload, actor: "user" })))

    const evidence = Effect.fn("GoalHttpApi.evidence")((ctx: { params: { goalID: Goal.ID } }) =>
      mapError(goals.evidence(ctx.params.goalID)),
    )

    const addEvidence = Effect.fn("GoalHttpApi.addEvidence")((ctx: {
      params: { goalID: Goal.ID }
      payload: typeof EvidencePayload.Type
    }) => mapError(goals.addEvidence({ goalID: ctx.params.goalID, ...ctx.payload, actor: "user" })))

    const audit = Effect.fn("GoalHttpApi.audit")((ctx: { params: { goalID: Goal.ID } }) => mapError(goals.audit(ctx.params.goalID)))
    const focuses = Effect.fn("GoalHttpApi.focuses")((ctx: { params: { goalID: Goal.ID } }) => goals.focuses(ctx.params.goalID))

    const focused = Effect.fn("GoalHttpApi.focused")(function* (ctx: { params: { sessionID: SessionSchema.ID } }) {
      return (yield* goals.focused(ctx.params.sessionID)) ?? null
    })

    const focus = Effect.fn("GoalHttpApi.focus")((ctx: {
      params: { sessionID: SessionSchema.ID }
      payload: typeof FocusPayload.Type
    }) => mapError(goals.focus({ sessionID: ctx.params.sessionID, ...ctx.payload, actor: "user" })))

    const unfocus = Effect.fn("GoalHttpApi.unfocus")(function* (ctx: { params: { sessionID: SessionSchema.ID } }) {
      yield* goals.unfocus({ sessionID: ctx.params.sessionID, actor: "user" })
      return HttpApiSchema.NoContent.make()
    })

    const prepare = Effect.fn("GoalHttpApi.prepare")((ctx: {
      params: { sessionID: SessionSchema.ID }
      payload: typeof PreparePayload.Type
    }) => mapError(goals.prepareForSession({ sessionID: ctx.params.sessionID, ...ctx.payload, actor: "user" })))

    return handlers
      .handle("list", list)
      .handle("create", create)
      .handle("get", get)
      .handle("update", update)
      .handle("transition", transition)
      .handle("criterion", criterion)
      .handle("step", step)
      .handle("evidence", evidence)
      .handle("addEvidence", addEvidence)
      .handle("audit", audit)
      .handle("focuses", focuses)
      .handle("focused", focused)
      .handle("focus", focus)
      .handle("unfocus", unfocus)
      .handle("prepare", prepare)
  }),
)
