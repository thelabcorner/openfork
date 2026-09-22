import { Goal } from "@opencode-ai/core/goal"
import { GoalAutomation } from "@opencode-ai/core/goal/automation"
import { Goal as GoalModel } from "@opencode-ai/schema/goal"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { WorkspaceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { Cause, Effect, Scope } from "effect"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import * as ApiError from "../errors"
import {
  CreatePayload,
  CriterionPayload,
  DispatchPayload,
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
    const automation = yield* GoalAutomation.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const instances = yield* InstanceStore.Service
    const scope = yield* Scope.Scope

    const list = Effect.fn("GoalHttpApi.list")((ctx: { query: typeof ListQuery.Type }) => goals.list(ctx.query))

    const create = Effect.fn("GoalHttpApi.create")((ctx: { payload: typeof CreatePayload.Type }) =>
      mapError(goals.create({ ...ctx.payload, actor: "user" })),
    )

    const get = Effect.fn("GoalHttpApi.get")((ctx: { params: { goalID: Goal.ID } }) => mapError(goals.get(ctx.params.goalID)))

    const update = Effect.fn("GoalHttpApi.update")((ctx: {
      params: { goalID: Goal.ID }
      payload: typeof UpdatePayload.Type
    }) => mapError(goals.update({ id: ctx.params.goalID, ...ctx.payload, actor: "user" })))

    const transition = Effect.fn("GoalHttpApi.transition")(function* (ctx: {
      params: { goalID: Goal.ID }
      payload: typeof TransitionPayload.Type
    }) {
      const { sessionID, ...payload } = ctx.payload

      // A user verification request is an execution-preemption command, not a
      // passive lifecycle transition. Goal Mode has one execution behavior;
      // this action simply requests the independent auditor immediately rather
      // than waiting for the current worker cycle to settle. SessionPrompt
      // durably latches the request, brings active worker/tool execution to
      // finalized idle, then starts the auditor. Existing orphaned `verifying`
      // Goals use this same path.
      if (payload.action === "request_verification") {
        // Verification is an execution command, so there must always be a
        // concrete parent Session whose runner can be preempted and whose
        // transcript the independent auditor will inspect. Falling through to
        // the lifecycle state machine without this owner would recreate the
        // old orphaned `verifying` state with no auditor dispatch.
        if (!sessionID) return yield* new HttpApiError.BadRequest({})
        const [detail, focused] = yield* Effect.all([mapError(goals.get(ctx.params.goalID)), goals.focused(sessionID)])
        if (detail.goal.revision !== payload.expectedRevision) {
          return yield* new ApiError.ConflictError({
            message: `Goal ${ctx.params.goalID} revision changed from ${payload.expectedRevision} to ${detail.goal.revision}`,
            resource: ctx.params.goalID,
            code: "goal_stale_revision",
          })
        }
        if (!focused || focused.detail.goal.id !== ctx.params.goalID) {
          return yield* new HttpApiError.BadRequest({})
        }
        if (detail.goal.status === "active" || detail.goal.status === "verifying") {
          // Goal routes are deliberately durable/global and are not behind
          // InstanceContextMiddleware. The Session named by the request is the
          // authoritative location owner for this Tier-3 audit. Resolve that
          // durable location before detaching, then provide it explicitly to the
          // entire audit Effect. Never depend on ambient request context or cwd.
          const owner = yield* sessions
            .get(sessionID)
            .pipe(Effect.mapError((error) => ApiError.notFound(error.message)))
          const audit = instances.provide(
            { directory: owner.directory },
            prompt.requestGoalAudit(sessionID).pipe(Effect.provideService(WorkspaceRef, owner.workspaceID)),
          )
          yield* audit.pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const error = Cause.squash(cause)
                if (
                  error instanceof Session.BusyError ||
                  (typeof error === "object" &&
                    error !== null &&
                    "_tag" in error &&
                    error._tag === "SessionBusyError")
                ) {
                  // Session execution ownership is a serialization signal, not
                  // evidence that the auditor itself failed. The durable audit
                  // request remains latched and SessionPrompt owns preemption.
                  yield* Effect.logInfo("Goal audit dispatch coalesced with existing Session owner", {
                    sessionID,
                    goalID: ctx.params.goalID,
                  })
                  return
                }
                const message = error instanceof Error ? error.message : String(error)
                yield* automation
                  .failAudit({ sessionID, error: `Goal audit orchestration failed: ${message}` })
                  .pipe(Effect.ignore)
                yield* Effect.logError("Goal audit orchestration failed", {
                  sessionID,
                  goalID: ctx.params.goalID,
                  cause: Cause.pretty(cause),
                })
              }),
            ),
            Effect.forkIn(scope, { startImmediately: true }),
          )
          return detail
        }
      }

      const detail = yield* mapError(goals.transition({ id: ctx.params.goalID, ...payload, actor: "user" }))
      // User-owned lifecycle changes invalidate transient automation state. A
      // fresh request_verification above is the only UI action that starts an
      // audit; resume/pause/cancel/fail must not leave stale runtime badges.
      if (sessionID && ["pause", "verification_fail", "cancel", "fail"].includes(payload.action)) {
        yield* automation.cancel(sessionID)
      }
      return detail
    })

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
      const current = yield* goals.focused(ctx.params.sessionID)
      if (!current) return null
      const runtime = yield* automation.runtime(ctx.params.sessionID)
      return { ...current, ...(runtime ? { automation: runtime } : {}) }
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

    const dispatch = Effect.fn("GoalHttpApi.dispatch")(function* (ctx: {
      params: { sessionID: SessionSchema.ID }
      payload: typeof DispatchPayload.Type
    }) {
      const focused = yield* goals.focused(ctx.params.sessionID)
      if (!focused || focused.detail.goal.id !== ctx.payload.goalID) return yield* new HttpApiError.BadRequest({})
      if (focused.detail.goal.revision !== ctx.payload.revision) {
        return yield* new ApiError.ConflictError({
          message: `Goal ${ctx.payload.goalID} revision changed from ${ctx.payload.revision} to ${focused.detail.goal.revision}`,
          resource: ctx.payload.goalID,
          code: "goal_stale_revision",
        })
      }
      const status = focused.detail.goal.status
      if (ctx.payload.action === "start" && status !== "active") return yield* new HttpApiError.BadRequest({})
      if (ctx.payload.action === "update" && !["active", "paused", "blocked"].includes(status)) {
        return yield* new HttpApiError.BadRequest({})
      }

      const source =
        ctx.payload.action === "start"
          ? SessionTurnProvenance.Source.GoalStart
          : SessionTurnProvenance.Source.GoalUpdate
      const text = ctx.payload.action === "start" ? "Begin the focused Goal." : "Continue with the updated focused Goal."
      const messageID = MessageID.make(
        `msg_goal_action_${ctx.payload.action}_${ctx.payload.goalID}_${ctx.payload.revision}`,
      )
      const owner = yield* sessions
        .get(ctx.params.sessionID)
        .pipe(Effect.mapError((error) => ApiError.notFound(error.message)))
      yield* instances
        .provide(
          { directory: owner.directory },
          prompt
            .userActionPrompt(
              {
                sessionID: ctx.params.sessionID,
                messageID,
                parts: [{ type: "text", text }],
              },
              { source },
            )
            .pipe(Effect.provideService(WorkspaceRef, owner.workspaceID)),
        )
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      return HttpApiSchema.NoContent.make()
    })

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
      .handle("dispatch", dispatch)
  }),
)
