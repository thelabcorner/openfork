export * as ScheduledTaskAgent from "./agent"

import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { ScheduledTask as ScheduledTaskModel } from "@opencode-ai/schema/scheduled-task"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { ScheduledTask } from "./index"
import { ScheduledTaskCreationPolicy } from "./creation-policy"
import { ScheduledTaskPolicy } from "./policy"
import { ScheduledTaskRecurrence } from "./recurrence"
import { ScheduledTaskSchema } from "./schema"

const CreateInput = Schema.Struct({
  action: Schema.optionalKey(Schema.Literal("create")),
  name: Schema.String.annotate({ description: "Short unique name for this project's scheduled task." }),
  schedule: ScheduledTaskModel.ScheduleInput,
  timezone: Schema.optionalKey(Schema.String).annotate({
    description:
      "IANA timezone for daily, weekly, and cron schedules. Required for wall-clock schedules; irrelevant for a once schedule.",
  }),
  prompt: Schema.String.annotate({
    description: "Prompt or slash command to execute when the schedule fires.",
  }),
  agent: Schema.optionalKey(Schema.String).annotate({
    description: "Optional agent override. Omit to inherit the current Session's agent.",
  }),
  model: Schema.optionalKey(ScheduledTaskModel.Action.fields.model).annotate({
    description: "Optional model override. Omit to inherit the current Session's model.",
  }),
  notify: Schema.optionalKey(ScheduledTaskModel.NotifyMode).annotate({
    description: "Optional notification override. Default is failure-only.",
  }),
})

const ListInput = Schema.Struct({ action: Schema.Literal("list") })
const GetInput = Schema.Struct({ action: Schema.Literal("get"), taskID: ScheduledTaskModel.ID })
const UpdateInput = Schema.Struct({
  action: Schema.Literal("update"),
  taskID: ScheduledTaskModel.ID,
  expectedRevision: Schema.Number.annotate({ description: "Revision returned by list/get; stale writes fail closed." }),
  name: Schema.optionalKey(Schema.String),
  schedule: Schema.optionalKey(ScheduledTaskModel.ScheduleInput),
  timezone: Schema.optionalKey(Schema.NullOr(Schema.String)),
  taskAction: Schema.optionalKey(ScheduledTaskModel.Action).annotate({
    description: "Optional complete replacement action (prompt/agent/model/goal).",
  }),
  target: Schema.optionalKey(ScheduledTaskModel.Target),
  sessionPolicy: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("new") }),
      Schema.Struct({ kind: Schema.Literal("reuse") }),
      Schema.Struct({ kind: Schema.Literal("auto") }),
    ]),
  ).annotate({
    description: "Scheduler-owned Session policy. Binding to an arbitrary existing Session is intentionally not exposed here.",
  }),
  policy: Schema.optionalKey(ScheduledTaskModel.Policy),
})
const RemoveInput = Schema.Struct({
  action: Schema.Literal("remove"),
  taskID: ScheduledTaskModel.ID,
  expectedRevision: Schema.Number.annotate({ description: "Revision returned by list/get; stale deletes fail closed." }),
})
const SetEnabledInput = Schema.Struct({
  action: Schema.Literal("set_enabled"),
  taskID: ScheduledTaskModel.ID,
  enabled: Schema.Boolean,
  expectedRevision: Schema.Number.annotate({ description: "Revision returned by list/get; stale writes fail closed." }),
})
const RunsInput = Schema.Struct({
  action: Schema.Literal("runs"),
  taskID: ScheduledTaskModel.ID,
  limit: Schema.optionalKey(Schema.Number),
  before: Schema.optionalKey(Schema.Number),
})
const InboxInput = Schema.Struct({
  action: Schema.Literal("inbox"),
  limit: Schema.optionalKey(Schema.Number),
  unreadOnly: Schema.optionalKey(Schema.Boolean),
})
const UnreadCountInput = Schema.Struct({ action: Schema.Literal("unread_count") })
const AcknowledgeInput = Schema.Struct({
  action: Schema.Literal("acknowledge"),
  taskID: ScheduledTaskModel.ID,
  runID: ScheduledTaskModel.RunID,
  expectedRevision: Schema.Number.annotate({
    description: "Revision returned by list/get; stale acknowledgement fails closed.",
  }),
})
const RunNowInput = Schema.Struct({
  action: Schema.Literal("run_now"),
  taskID: ScheduledTaskModel.ID,
  expectedRevision: Schema.Number.annotate({ description: "Revision returned by list/get; stale manual runs fail closed." }),
})
const PreviewInput = Schema.Struct({
  action: Schema.Literal("preview"),
  schedule: ScheduledTaskModel.ScheduleInput,
  timezone: Schema.optionalKey(Schema.String),
  count: Schema.optionalKey(Schema.Number),
})
const AgendaInput = Schema.Struct({
  action: Schema.Literal("agenda"),
  from: Schema.Number,
  to: Schema.Number,
  limit: Schema.optionalKey(Schema.Number),
})

export const Input = Schema.Union([
  CreateInput,
  ListInput,
  GetInput,
  UpdateInput,
  RemoveInput,
  SetEnabledInput,
  RunsInput,
  InboxInput,
  UnreadCountInput,
  AcknowledgeInput,
  RunNowInput,
  PreviewInput,
  AgendaInput,
])
export type Input = typeof Input.Type

export type Output =
  | { readonly action: "create"; readonly task: ScheduledTask.Info; readonly created: boolean }
  | { readonly action: "list"; readonly tasks: ReadonlyArray<ScheduledTask.Info> }
  | { readonly action: "get"; readonly task: ScheduledTask.Info }
  | { readonly action: "update"; readonly task: ScheduledTask.Info }
  | { readonly action: "remove"; readonly taskID: ScheduledTask.ID; readonly removed: true }
  | { readonly action: "set_enabled"; readonly task: ScheduledTask.Info }
  | { readonly action: "runs"; readonly taskID: ScheduledTask.ID; readonly runs: ReadonlyArray<ScheduledTask.Run> }
  | { readonly action: "inbox"; readonly runs: ReadonlyArray<ScheduledTask.Run> }
  | { readonly action: "unread_count"; readonly unread: number }
  | {
      readonly action: "acknowledge"
      readonly taskID: ScheduledTask.ID
      readonly runID: ScheduledTask.RunID
      readonly acknowledged: true
    }
  | { readonly action: "run_now"; readonly run: ScheduledTask.Run }
  | { readonly action: "preview"; readonly preview: ScheduledTaskModel.Preview }
  | { readonly action: "agenda"; readonly occurrences: ReadonlyArray<ScheduledTask.AgendaOccurrence> }

export interface Interface {
  readonly create: (
    sessionID: SessionSchema.ID,
    input: typeof CreateInput.Type,
    turn?: ScheduledTaskCreationPolicy.TurnProvenance,
  ) => Effect.Effect<{ readonly task: ScheduledTask.Info; readonly created: boolean }, ScheduledTaskSchema.ValidationError>
  readonly execute: (
    sessionID: SessionSchema.ID,
    input: Input,
    turn?: ScheduledTaskCreationPolicy.TurnProvenance,
  ) => Effect.Effect<Output, ScheduledTask.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/core/ScheduledTaskAgent") {}

function equalJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function scopedDirectory(parent: string, candidate: string) {
  const normalize = (value: string) => {
    const resolved = path.resolve(value)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  const left = normalize(parent)
  const right = normalize(candidate)
  if (left === right) return true
  return right.startsWith(left.endsWith(path.sep) ? left : `${left}${path.sep}`)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const tasks = yield* ScheduledTask.Service
    const sessions = yield* SessionStore.Service

    const requireParent = Effect.fn("ScheduledTaskAgent.requireParent")(function* (sessionID: SessionSchema.ID) {
      const session = yield* sessions.get(sessionID)
      if (!session) {
        return yield* new ScheduledTaskSchema.ValidationError({ reason: `session does not exist: ${sessionID}` })
      }
      if (session.parentID !== undefined) {
        return yield* new ScheduledTaskSchema.ValidationError({
          reason: "child Sessions cannot create scheduled tasks or manage durable scheduled tasks; use the parent Session",
        })
      }
      return session
    })

    const scopedTask = Effect.fn("ScheduledTaskAgent.scopedTask")(function* (
      session: SessionSchema.Info,
      taskID: ScheduledTask.ID,
    ) {
      const task = yield* tasks.get(taskID)
      if (!scopedDirectory(session.location.directory, task.targetDirectory)) {
        return yield* new ScheduledTaskSchema.NotFoundError({ taskID })
      }
      return task
    })

    const visibleTasks = Effect.fn("ScheduledTaskAgent.visibleTasks")(function* (
      session: SessionSchema.Info,
    ) {
      return (yield* tasks.list()).filter((task) => scopedDirectory(session.location.directory, task.targetDirectory))
    })

    const authorizeMutation = Effect.fn("ScheduledTaskAgent.authorizeMutation")(function* (
      action: ScheduledTaskCreationPolicy.ManagementAction,
      turn?: ScheduledTaskCreationPolicy.TurnProvenance,
    ) {
      const authorization = ScheduledTaskCreationPolicy.authorizeManagement(action, turn)
      if (!authorization.allowed) return yield* new ScheduledTaskSchema.ValidationError({ reason: authorization.reason })
    })

    const create = Effect.fn("ScheduledTaskAgent.create")(function* (
      sessionID: SessionSchema.ID,
      input: typeof CreateInput.Type,
      turn?: ScheduledTaskCreationPolicy.TurnProvenance,
    ) {
      const authorization = ScheduledTaskCreationPolicy.authorize(turn)
      if (!authorization.allowed) return yield* new ScheduledTaskSchema.ValidationError({ reason: authorization.reason })

      const session = yield* requireParent(sessionID)

      const name = input.name.trim()
      const now = Date.now()
      const resolvedSchedule = ScheduledTaskRecurrence.resolveScheduleInput(input.schedule, now)
      if (!resolvedSchedule.ok) {
        return yield* new ScheduledTaskSchema.ValidationError({ reason: resolvedSchedule.reason })
      }
      const schedule = resolvedSchedule.schedule
      // Conversational automation must never reinterpret "9 AM" through the
      // server's ambient timezone. The lower-level ScheduledTask API supports a
      // dynamic host zone for explicit API callers, but a human conversational
      // request needs a durable wall-clock interpretation chosen by the model
      // from known user context or clarified with the user.
      const timezone = schedule.kind === "once" ? undefined : input.timezone?.trim() || undefined
      if (schedule.kind !== "once" && !timezone) {
        return yield* new ScheduledTaskSchema.ValidationError({
          reason:
            "timezone is required for conversational daily, weekly, and cron schedules; ask the user rather than guessing from the host machine",
        })
      }
      const action: ScheduledTaskModel.Action = {
        prompt: input.prompt,
        ...(input.agent ?? session.agent ? { agent: input.agent ?? session.agent } : {}),
        ...(input.model ?? session.model ? { model: input.model ?? session.model } : {}),
      }
      const enabled = !ScheduledTaskCreationPolicy.explicitlyRequestsDisabled(turn!.userText)
      const policy = ScheduledTaskPolicy.resolvePolicy(input.notify ? { notify: input.notify } : undefined)
      const sourceMessageID = turn!.userMessageID

      const sameRequest = (task: ScheduledTask.Info | undefined) =>
        task !== undefined &&
        task.source === "agent" &&
        task.sourceMessageID === sourceMessageID &&
        task.projectID === session.projectID &&
        task.targetDirectory === session.location.directory &&
        task.target.kind === "directory" &&
        task.name === name &&
        task.enabled === enabled &&
        (input.schedule.kind === "relative" ? task.schedule.kind === "once" : equalJson(task.schedule, schedule)) &&
        task.timezone === timezone &&
        equalJson(task.action, action) &&
        equalJson(task.policy, policy)

      // Keep the uncontended creation hot path to one Session PK read + the
      // canonical create transaction. Do not preflight with a second name
      // lookup merely for idempotency: create already checks the indexed unique
      // name inside its IMMEDIATE transaction. Only a duplicate/replay pays the
      // recovery read below.
      const effect = tasks.create({
        projectID: session.projectID,
        targetDirectory: session.location.directory,
        target: { kind: "directory" },
        name,
        enabled,
        schedule,
        ...(timezone ? { timezone } : {}),
        action,
        policy: input.notify ? { notify: input.notify } : undefined,
        source: "agent",
        sourceMessageID,
        now,
      })

      return yield* effect.pipe(
        Effect.map((task) => ({ task, created: true as const })),
        Effect.catchTag("ScheduledTask.ValidationError", (error) =>
          tasks.findByName({ projectID: session.projectID, name }).pipe(
            Effect.flatMap((raced) =>
              sameRequest(raced)
                ? Effect.succeed({ task: raced!, created: false as const })
                : raced
                  ? Effect.fail(
                      new ScheduledTaskSchema.ValidationError({
                        reason: `a different scheduled task named "${name}" already exists in this project`,
                      }),
                    )
                  : Effect.fail(error),
            ),
          ),
        ),
      )
    })

    const execute: Interface["execute"] = Effect.fn("ScheduledTaskAgent.execute")(function* (sessionID, input, turn) {
      const action = input.action ?? "create"
      if (action === "create") {
        const result = yield* create(sessionID, input as typeof CreateInput.Type, turn)
        return { action: "create", ...result }
      }

      const session = yield* requireParent(sessionID)
      if (action === "list") return { action, tasks: yield* visibleTasks(session) }
      if (action === "get") {
        const params = input as typeof GetInput.Type
        return { action: "get" as const, task: yield* scopedTask(session, params.taskID) }
      }
      if (action === "preview") {
        const params = input as typeof PreviewInput.Type
        const count = Math.min(Math.max(Math.floor(params.count ?? 5), 1), 20)
        const now = Date.now()
        const resolvedSchedule = ScheduledTaskRecurrence.resolveScheduleInput(params.schedule, now)
        if (!resolvedSchedule.ok) {
          return yield* new ScheduledTaskSchema.ValidationError({ reason: resolvedSchedule.reason })
        }
        const result = ScheduledTaskRecurrence.preview({
          schedule: resolvedSchedule.schedule,
          timezone: params.timezone,
          after: now,
          count,
        })
        return {
          action: "preview" as const,
          preview: {
            next: result.next,
            warnings: result.warnings,
            summary: ScheduledTaskRecurrence.describeSchedule(resolvedSchedule.schedule),
          },
        }
      }
      if (action === "agenda") {
        const params = input as typeof AgendaInput.Type
        const maxWindowMs = 32 * 24 * 60 * 60 * 1_000
        if (!Number.isFinite(params.from) || !Number.isFinite(params.to) || params.to < params.from || params.to - params.from > maxWindowMs) {
          return yield* new ScheduledTaskSchema.ValidationError({ reason: "agenda requires a finite from/to window no larger than 32 days" })
        }
        const limit = Math.min(Math.max(Math.floor(params.limit ?? 2_000), 1), 5_000)
        const visible = yield* visibleTasks(session)
        const ids = new Set(visible.map((task) => task.id))
        const occurrences = (yield* tasks.agenda({ from: params.from, to: params.to, limit: 5_000 }))
          .filter((item) => ids.has(item.taskID))
          .slice(0, limit)
        return { action: "agenda" as const, occurrences }
      }
      if (action === "runs") {
        const params = input as typeof RunsInput.Type
        yield* scopedTask(session, params.taskID)
        return {
          action: "runs" as const,
          taskID: params.taskID,
          runs: yield* tasks.listRuns({
            taskID: params.taskID,
            limit: Math.min(Math.max(Math.floor(params.limit ?? 50), 1), 200),
            ...(params.before === undefined ? {} : { before: params.before }),
          }),
        }
      }

      if (action === "inbox") {
        const params = input as typeof InboxInput.Type
        const visible = yield* visibleTasks(session)
        return {
          action: "inbox" as const,
          runs: yield* tasks.inbox({
            taskIDs: visible.map((task) => task.id),
            limit: Math.min(Math.max(Math.floor(params.limit ?? 50), 1), 200),
            unreadOnly: params.unreadOnly ?? false,
          }),
        }
      }

      if (action === "unread_count") {
        const visible = yield* visibleTasks(session)
        return {
          action: "unread_count" as const,
          unread: yield* tasks.unreadCount({ taskIDs: visible.map((task) => task.id) }),
        }
      }

      const mutation = input as
        | typeof UpdateInput.Type
        | typeof RemoveInput.Type
        | typeof SetEnabledInput.Type
        | typeof AcknowledgeInput.Type
        | typeof RunNowInput.Type
      const task = yield* scopedTask(session, mutation.taskID)
      if (mutation.action === "update") {
        yield* authorizeMutation("update", turn)
        const updated = yield* tasks.update({
          id: task.id,
          expectedRevision: mutation.expectedRevision,
          ...(mutation.name === undefined ? {} : { name: mutation.name }),
          ...(mutation.schedule === undefined ? {} : { schedule: mutation.schedule }),
          ...(mutation.timezone === undefined ? {} : { timezone: mutation.timezone }),
          ...(mutation.taskAction === undefined ? {} : { action: mutation.taskAction }),
          ...(mutation.target === undefined ? {} : { target: mutation.target }),
          ...(mutation.sessionPolicy === undefined ? {} : { sessionPolicy: mutation.sessionPolicy }),
          ...(mutation.policy === undefined ? {} : { policy: mutation.policy }),
        })
        return { action: "update" as const, task: updated }
      }
      if (mutation.action === "remove") {
        yield* authorizeMutation("remove", turn)
        yield* tasks.removeChecked({ id: task.id, expectedRevision: mutation.expectedRevision })
        return { action: "remove" as const, taskID: task.id, removed: true as const }
      }
      if (mutation.action === "set_enabled") {
        yield* authorizeMutation("set_enabled", turn)
        return {
          action: "set_enabled" as const,
          task: yield* tasks.setEnabled({
            id: task.id,
            enabled: mutation.enabled,
            expectedRevision: mutation.expectedRevision,
          }),
        }
      }
      if (mutation.action === "run_now") {
        yield* authorizeMutation("run_now", turn)
        return {
          action: "run_now" as const,
          run: yield* tasks.enqueueManualRun({
            taskID: task.id,
            now: Date.now(),
            expectedRevision: mutation.expectedRevision,
          }),
        }
      }
      if (mutation.action === "acknowledge") {
        yield* authorizeMutation("acknowledge", turn)
        yield* tasks.acknowledgeChecked({
          taskID: task.id,
          runID: mutation.runID,
          expectedRevision: mutation.expectedRevision,
        })
        return {
          action: "acknowledge" as const,
          taskID: task.id,
          runID: mutation.runID,
          acknowledged: true as const,
        }
      }
      return yield* new ScheduledTaskSchema.ValidationError({ reason: "unsupported scheduled task action" })
    })

    return Service.of({ create, execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [ScheduledTask.node, SessionStore.node],
})
