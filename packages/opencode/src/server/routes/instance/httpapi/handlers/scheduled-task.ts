import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskSessionBinding } from "@opencode-ai/core/scheduled-task/session-binding"
import { ScheduledTaskRecurrence } from "@opencode-ai/core/scheduled-task/recurrence"
import { RootHttpApi } from "../api"
import * as ApiError from "../errors"
import {
  AgendaQuery,
  ControlPayload,
  CreatePayload,
  EnabledPayload,
  InboxQuery,
  ListQuery,
  PreviewPayload,
  RunNowPayload,
  RunsQuery,
  SessionCandidatesQuery,
  UpdatePayload,
} from "../groups/scheduled-task"

type ScheduledTaskApiError = ApiError.InvalidRequestError | ApiError.ApiNotFoundError | ApiError.ConflictError

const mapError = <A, R>(effect: Effect.Effect<A, ScheduledTask.Error, R>): Effect.Effect<A, ScheduledTaskApiError, R> =>
  effect.pipe(
    Effect.catchTag("ScheduledTask.NotFoundError", (error) => Effect.fail(ApiError.notFound(error.message))),
    Effect.catchTag("ScheduledTask.RunNotFoundError", (error) => Effect.fail(ApiError.notFound(error.message))),
    Effect.catchTag("ScheduledTask.StaleRevisionError", (error) =>
      Effect.fail(
        new ApiError.ConflictError({
          message: error.message,
          resource: error.taskID,
          code: "scheduled_task_stale_revision",
        }),
      ),
    ),
    Effect.catchTag("ScheduledTask.RunAttemptConflictError", (error) =>
      Effect.fail(
        new ApiError.ConflictError({
          message: error.message,
          resource: error.runID,
          code: "scheduled_task_run_attempt_conflict",
        }),
      ),
    ),
    Effect.catchTag("ScheduledTask.ValidationError", (error) =>
      Effect.fail(
        new ApiError.InvalidRequestError({ message: error.message, kind: "scheduled_task_validation" }),
      ),
    ),
  )

export const scheduledTaskHandlers = HttpApiBuilder.group(RootHttpApi, "scheduledTask", (handlers) =>
  Effect.gen(function* () {
    const tasks = yield* ScheduledTask.Service
    const bindings = yield* ScheduledTaskSessionBinding.Service

    const list = Effect.fn("ScheduledTaskHttpApi.list")((ctx: { query: typeof ListQuery.Type }) =>
      tasks.list({ projectID: ctx.query.projectID }),
    )

    const create = Effect.fn("ScheduledTaskHttpApi.create")((ctx: { payload: typeof CreatePayload.Type }) =>
      mapError(tasks.create({ ...ctx.payload, source: "api" })),
    )

    const get = Effect.fn("ScheduledTaskHttpApi.get")((ctx: { params: { taskID: ScheduledTask.ID } }) =>
      mapError(tasks.get(ctx.params.taskID)),
    )

    const update = Effect.fn("ScheduledTaskHttpApi.update")((ctx: {
      params: { taskID: ScheduledTask.ID }
      payload: typeof UpdatePayload.Type
    }) =>
      mapError(
        tasks.update({
          id: ctx.params.taskID,
          expectedRevision: ctx.payload.expectedRevision,
          ...(ctx.payload.name !== undefined ? { name: ctx.payload.name } : {}),
          ...(ctx.payload.targetDirectory !== undefined ? { targetDirectory: ctx.payload.targetDirectory } : {}),
          ...(ctx.payload.target !== undefined ? { target: ctx.payload.target } : {}),
          ...(ctx.payload.sessionPolicy !== undefined ? { sessionPolicy: ctx.payload.sessionPolicy } : {}),
          ...(ctx.payload.schedule !== undefined ? { schedule: ctx.payload.schedule } : {}),
          ...(ctx.payload.timezone !== undefined ? { timezone: ctx.payload.timezone } : {}),
          ...(ctx.payload.action !== undefined ? { action: ctx.payload.action } : {}),
          ...(ctx.payload.policy !== undefined ? { policy: ctx.payload.policy } : {}),
        }),
      ),
    )

    const remove = Effect.fn("ScheduledTaskHttpApi.remove")(function* (ctx: {
      params: { taskID: ScheduledTask.ID }
    }) {
      yield* mapError(tasks.remove(ctx.params.taskID))
      return HttpApiSchema.NoContent.make()
    })

    const getBinding = Effect.fn("ScheduledTaskHttpApi.getBinding")(function* (ctx: {
      params: { taskID: ScheduledTask.ID }
    }) {
      // Confirm the task exists so an unknown id remains a 404 rather than
      // becoming indistinguishable from a valid task with no current anchor.
      yield* mapError(tasks.get(ctx.params.taskID))
      const binding = yield* bindings.get(ctx.params.taskID)
      return binding
        ? {
            taskID: binding.taskID,
            sessionID: binding.sessionID,
            generation: binding.generation,
            timeUpdated: binding.timeUpdated,
          }
        : null
    })

    const clearBinding = Effect.fn("ScheduledTaskHttpApi.clearBinding")(function* (ctx: {
      params: { taskID: ScheduledTask.ID }
    }) {
      yield* mapError(tasks.get(ctx.params.taskID))
      yield* bindings.clear({ taskID: ctx.params.taskID })
      return HttpApiSchema.NoContent.make()
    })

    const enabled = Effect.fn("ScheduledTaskHttpApi.enabled")((ctx: {
      params: { taskID: ScheduledTask.ID }
      payload: typeof EnabledPayload.Type
    }) =>
      mapError(
        tasks.setEnabled({
          id: ctx.params.taskID,
          enabled: ctx.payload.enabled,
          ...(ctx.payload.expectedRevision !== undefined ? { expectedRevision: ctx.payload.expectedRevision } : {}),
        }),
      ),
    )

    const runs = Effect.fn("ScheduledTaskHttpApi.runs")((ctx: {
      params: { taskID: ScheduledTask.ID }
      query: typeof RunsQuery.Type
    }) =>
      mapError(
        tasks.listRuns({
          taskID: ctx.params.taskID,
          limit: ctx.query.limit,
          before: ctx.query.before,
        }),
      ),
    )

    const inbox = Effect.fn("ScheduledTaskHttpApi.inbox")((ctx: { query: typeof InboxQuery.Type }) =>
      tasks.inbox({ limit: ctx.query.limit, unreadOnly: ctx.query.unread === "true" }),
    )

    const unreadCount = Effect.fn("ScheduledTaskHttpApi.unreadCount")(function* () {
      return { unread: yield* tasks.unreadCount() }
    })

    const getControl = Effect.fn("ScheduledTaskHttpApi.getControl")(function* () {
      return yield* tasks.control()
    })

    const setControl = Effect.fn("ScheduledTaskHttpApi.setControl")((ctx: { payload: typeof ControlPayload.Type }) =>
      tasks.setPaused({ paused: ctx.payload.paused }),
    )

    const acknowledge = Effect.fn("ScheduledTaskHttpApi.acknowledge")(function* (ctx: {
      params: { runID: ScheduledTask.RunID }
    }) {
      yield* mapError(tasks.acknowledge({ runID: ctx.params.runID }))
      return HttpApiSchema.NoContent.make()
    })

    const preview = Effect.fn("ScheduledTaskHttpApi.preview")(function* (ctx: {
      payload: typeof PreviewPayload.Type
    }) {
      // Pure: one recurrence implementation, no database, no Instance.
      const now = Date.now()
      const resolvedSchedule = ScheduledTaskRecurrence.resolveScheduleInput(ctx.payload.schedule, now)
      if (!resolvedSchedule.ok) {
        return yield* new ApiError.InvalidRequestError({
          message: resolvedSchedule.reason,
          kind: "scheduled_task_validation",
        })
      }
      const result = ScheduledTaskRecurrence.preview({
        schedule: resolvedSchedule.schedule,
        timezone: ctx.payload.timezone,
        after: now,
        count: Math.min(Math.max(Math.floor(ctx.payload.count ?? 5), 1), 20),
      })
      return {
        next: result.next,
        warnings: result.warnings,
        summary: ScheduledTaskRecurrence.describeSchedule(resolvedSchedule.schedule),
      }
    })

    const agenda = Effect.fn("ScheduledTaskHttpApi.agenda")(function* (ctx: { query: typeof AgendaQuery.Type }) {
      const from = Number(ctx.query.from)
      const to = Number(ctx.query.to)
      const limit = Math.min(Math.max(Math.floor(ctx.query.limit ?? 2_000), 1), 5_000)
      const maxWindowMs = 32 * 24 * 60 * 60 * 1_000
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > maxWindowMs) {
        return yield* new ApiError.InvalidRequestError({
          message: "agenda requires a finite from/to window no larger than 32 days",
          kind: "scheduled_task_validation",
        })
      }
      return yield* tasks.agenda({
        from,
        to,
        limit,
        ...(ctx.query.projectID ? { projectID: ctx.query.projectID } : {}),
      })
    })

    const sessionCandidates = Effect.fn("ScheduledTaskHttpApi.sessionCandidates")((ctx: {
      query: typeof SessionCandidatesQuery.Type
    }) =>
      bindings.candidates({
        targetDirectory: ctx.query.targetDirectory,
        ...(ctx.query.projectID ? { projectID: ctx.query.projectID } : {}),
        ...(ctx.query.limit === undefined ? {} : { limit: Number(ctx.query.limit) }),
      }),
    )

    const runNow = Effect.fn("ScheduledTaskHttpApi.runNow")((ctx: {
      params: { taskID: ScheduledTask.ID }
      payload: typeof RunNowPayload.Type
    }) =>
      // Enqueue is the entire HTTP responsibility. ScheduledTaskRunner listens
      // to the authoritative RunUpdated event and performs the due scan; only
      // its executor is allowed to cross into Tier 3 / Instance materialization.
      mapError(tasks.enqueueManualRun({ taskID: ctx.params.taskID, now: ctx.payload.now ?? Date.now() })),
    )

    return handlers
      .handle("list", list)
      .handle("create", create)
      .handle("preview", preview)
      .handle("agenda", agenda)
      .handle("sessionCandidates", sessionCandidates)
      .handle("inbox", inbox)
      .handle("unreadCount", unreadCount)
      .handle("getControl", getControl)
      .handle("setControl", setControl)
      .handle("acknowledge", acknowledge)
      .handle("get", get)
      .handle("getBinding", getBinding)
      .handle("clearBinding", clearBinding)
      .handle("update", update)
      .handle("remove", remove)
      .handle("enabled", enabled)
      .handle("runs", runs)
      .handle("runNow", runNow)
  }),
)
