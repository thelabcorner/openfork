import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskRecurrence } from "@opencode-ai/core/scheduled-task/recurrence"
import { ScheduledTask as ScheduledTaskModel } from "@opencode-ai/schema/scheduled-task"
import { ScheduledTaskWake } from "@/scheduled-task/wake"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpResult } from "./result"
import { isContained, OxpRoot } from "./root"
import { OxpSchedule } from "./schedule"
import { OxpSchema } from "./schema"

const RootID = Schema.Struct({
  rootID: OxpSchema.RootID.annotate({
    description: "Explicit approved OXP root that owns the Scheduled Task.",
  }),
})

const List = Schema.Struct({ action: Schema.Literal("list"), ...RootID.fields })
const Get = Schema.Struct({ action: Schema.Literal("get"), ...RootID.fields, taskID: ScheduledTaskModel.ID })
const Update = Schema.Struct({
  action: Schema.Literal("update"),
  ...RootID.fields,
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
    description: "Scheduler-owned Session policy. Existing-Session binding requires a separate supervision-aware surface.",
  }),
  policy: Schema.optionalKey(ScheduledTaskModel.Policy),
})
const Remove = Schema.Struct({
  action: Schema.Literal("remove"),
  ...RootID.fields,
  taskID: ScheduledTaskModel.ID,
  expectedRevision: Schema.Number.annotate({ description: "Revision returned by list/get; stale deletes fail closed." }),
})
const SetEnabled = Schema.Struct({
  action: Schema.Literal("set_enabled"),
  ...RootID.fields,
  taskID: ScheduledTaskModel.ID,
  enabled: Schema.Boolean,
  expectedRevision: Schema.Number.annotate({ description: "Revision returned by list/get; stale writes fail closed." }),
})
const Runs = Schema.Struct({
  action: Schema.Literal("runs"),
  ...RootID.fields,
  taskID: ScheduledTaskModel.ID,
  limit: Schema.optionalKey(Schema.Number),
  before: Schema.optionalKey(Schema.Number),
})
const Inbox = Schema.Struct({
  action: Schema.Literal("inbox"),
  ...RootID.fields,
  limit: Schema.optionalKey(Schema.Number),
  unreadOnly: Schema.optionalKey(Schema.Boolean),
})
const UnreadCount = Schema.Struct({ action: Schema.Literal("unread_count"), ...RootID.fields })
const Acknowledge = Schema.Struct({
  action: Schema.Literal("acknowledge"),
  ...RootID.fields,
  taskID: ScheduledTaskModel.ID,
  runID: ScheduledTaskModel.RunID,
  expectedRevision: Schema.Number.annotate({
    description: "Revision returned by list/get; stale acknowledgement fails closed.",
  }),
})
const RunNow = Schema.Struct({
  action: Schema.Literal("run_now"),
  ...RootID.fields,
  taskID: ScheduledTaskModel.ID,
  expectedRevision: Schema.Number.annotate({
    description: "Revision returned by list/get; stale manual runs fail closed.",
  }),
})
const Preview = Schema.Struct({
  action: Schema.Literal("preview"),
  ...RootID.fields,
  schedule: ScheduledTaskModel.ScheduleInput,
  timezone: Schema.optionalKey(Schema.String),
  count: Schema.optionalKey(Schema.Number),
})
const Agenda = Schema.Struct({
  action: Schema.Literal("agenda"),
  ...RootID.fields,
  from: Schema.Number,
  to: Schema.Number,
  limit: Schema.optionalKey(Schema.Number),
})

export const Parameters = Schema.Union([
  OxpSchedule.Parameters,
  List,
  Get,
  Update,
  Remove,
  SetEnabled,
  Runs,
  Inbox,
  UnreadCount,
  Acknowledge,
  RunNow,
  Preview,
  Agenda,
])
export type Input = Schema.Schema.Type<typeof Parameters>

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpScheduleManagement") {}
export const use = serviceUse(Service)

function cancelled(signal?: AbortSignal) {
  return signal?.aborted
    ? Effect.fail<OxpError.Error>(new OxpError.Cancelled({ detail: "OXP schedule operation was cancelled" }))
    : Effect.void
}

function mapTaskError(error: ScheduledTask.Error): OxpError.Error {
  switch (error._tag) {
    case "ScheduledTask.NotFoundError":
      return new OxpError.NotFound({ detail: "Scheduled task is unavailable in the selected OXP root" })
    case "ScheduledTask.RunNotFoundError":
      return new OxpError.NotFound({ detail: "Scheduled task run is unavailable" })
    case "ScheduledTask.StaleRevisionError":
      return new OxpError.Conflict({
        detail: `Scheduled task changed concurrently (expected revision ${error.expectedRevision}, current revision ${error.actualRevision})`,
      })
    case "ScheduledTask.RunAttemptConflictError":
      return new OxpError.Conflict({ detail: "Scheduled task run attempt changed concurrently" })
    case "ScheduledTask.ValidationError":
      return new OxpError.InvalidArgument({ detail: error.reason })
  }
}

function projectTask(root: OxpRoot.ResolvedRoot | OxpRoot.ResolvedPath, roots: OxpRoot.Interface, task: ScheduledTask.Info) {
  const { targetDirectory: _nativeTarget, sourcePath: _nativeSourcePath, ...rest } = task
  return {
    ...rest,
    targetDirectory: roots.toVirtualPath(root.root, task.targetDirectory),
  }
}

function projectRun(root: OxpRoot.ResolvedRoot | OxpRoot.ResolvedPath, roots: OxpRoot.Interface, run: ScheduledTask.Run) {
  const {
    id,
    taskID,
    fireFor,
    trigger,
    status,
    directory,
    skipReason,
    errorKind,
    acknowledgedAt,
    attempt,
    startedAt,
    finishedAt,
  } = run
  return {
    id,
    taskID,
    fireFor,
    trigger,
    status,
    ...(skipReason === undefined ? {} : { skipReason }),
    ...(errorKind === undefined ? {} : { errorKind }),
    ...(acknowledgedAt === undefined ? {} : { acknowledgedAt }),
    ...(attempt === undefined ? {} : { attempt }),
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(directory && isContained(root.canonicalPath, directory)
      ? { directory: roots.toVirtualPath(root.root, directory) }
      : {}),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const roots = yield* OxpRoot.Service
    const writer = yield* OxpSchedule.Writer
    const create = yield* OxpSchedule.Service

    const admit = Effect.fn("OxpScheduleManagement.admit")(function* (
      rootID: OxpSchema.RootID,
      action: string,
      phase: "read" | "mutate",
    ) {
      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: `schedule.${action}`,
        phase,
        rootID,
      })
      if (!admission.root) return yield* new OxpError.RootRequired({ detail: `schedule.${action} requires an approved root` })
      return admission
    })

    const scopedTask = Effect.fn("OxpScheduleManagement.scopedTask")(function* (
      admission: OxpAuthority.Admission,
      taskID: ScheduledTask.ID,
    ) {
      const task = yield* writer.get(taskID).pipe(Effect.mapError(mapTaskError))
      if (!admission.root || !isContained(admission.root.canonicalPath, task.targetDirectory)) {
        return yield* new OxpError.NotFound({ detail: "Scheduled task is unavailable in the selected OXP root" })
      }
      return task
    })

    const revalidateTask = Effect.fn("OxpScheduleManagement.revalidateTask")(function* (
      admission: OxpAuthority.Admission,
      task: ScheduledTask.Info,
      phase: "read" | "commit",
    ) {
      const fresh = yield* authority.revalidate(admission, phase)
      if (!fresh.root || !isContained(fresh.root.canonicalPath, task.targetDirectory)) {
        return yield* new OxpError.AuthRevoked({ detail: "Scheduled task left the authorized OXP root before completion" })
      }
      return fresh.root
    })

    const execute = Effect.fn("OxpScheduleManagement.execute")(function* (input: Input, signal?: AbortSignal) {
      yield* cancelled(signal)
      if (!("action" in input) || input.action === undefined || input.action === "create") {
        return yield* create.execute(input as OxpSchedule.Input, signal)
      }

      const management = input as
        | typeof List.Type
        | typeof Get.Type
        | typeof Update.Type
        | typeof Remove.Type
        | typeof SetEnabled.Type
        | typeof Runs.Type
        | typeof Inbox.Type
        | typeof UnreadCount.Type
        | typeof Acknowledge.Type
        | typeof RunNow.Type
        | typeof Preview.Type
        | typeof Agenda.Type
      const mutating =
        management.action === "update" ||
        management.action === "remove" ||
        management.action === "set_enabled" ||
        management.action === "acknowledge" ||
        management.action === "run_now"
      const admission = yield* admit(management.rootID, management.action, mutating ? "mutate" : "read")
      const root = admission.root!

      if (management.action === "preview") {
        const count = Math.min(Math.max(Math.floor(management.count ?? 5), 1), 20)
        const now = Date.now()
        const resolvedSchedule = ScheduledTaskRecurrence.resolveScheduleInput(management.schedule, now)
        if (!resolvedSchedule.ok) return yield* new OxpError.InvalidArgument({ detail: resolvedSchedule.reason })
        const preview = ScheduledTaskRecurrence.preview({
          schedule: resolvedSchedule.schedule,
          timezone: management.timezone,
          after: now,
          count,
        })
        yield* authority.revalidate(admission, "read")
        const result = {
          next: preview.next,
          warnings: preview.warnings,
          summary: ScheduledTaskRecurrence.describeSchedule(resolvedSchedule.schedule),
        }
        return {
          title: "Schedule preview",
          output: JSON.stringify(result),
          structured: { action: management.action, preview: result },
          metadata: { action: management.action, rootID: root.root.id },
        } satisfies OxpResult.CapabilityResult
      }

      if (management.action === "list") {
        const tasks = (yield* writer.list().pipe(Effect.mapError(mapTaskError)))
          .filter((task) => isContained(root.canonicalPath, task.targetDirectory))
          .map((task) => projectTask(root, roots, task))
        yield* authority.revalidate(admission, "read")
        return {
          title: "Scheduled tasks",
          output: JSON.stringify(tasks),
          structured: { action: management.action, tasks },
          metadata: { action: management.action, count: tasks.length, rootID: root.root.id },
        } satisfies OxpResult.CapabilityResult
      }

      if (management.action === "agenda") {
        const maxWindowMs = 32 * 24 * 60 * 60 * 1_000
        if (!Number.isFinite(management.from) || !Number.isFinite(management.to) || management.to < management.from || management.to - management.from > maxWindowMs) {
          return yield* new OxpError.InvalidArgument({ detail: "agenda requires a finite from/to window no larger than 32 days" })
        }
        const limit = Math.min(Math.max(Math.floor(management.limit ?? 2_000), 1), 5_000)
        const occurrences = yield* writer.agenda({ from: management.from, to: management.to, limit: 5_000 }).pipe(Effect.mapError(mapTaskError))
        const visible = (yield* writer.list().pipe(Effect.mapError(mapTaskError)))
          .filter((task) => isContained(root.canonicalPath, task.targetDirectory))
        const ids = new Set(visible.map((task) => task.id))
        const projected = occurrences.filter((item) => ids.has(item.taskID)).slice(0, limit)
        yield* authority.revalidate(admission, "read")
        return {
          title: "Schedule agenda",
          output: JSON.stringify(projected),
          structured: { action: management.action, occurrences: projected },
          metadata: { action: management.action, count: projected.length, rootID: root.root.id },
        } satisfies OxpResult.CapabilityResult
      }

      if (management.action === "inbox" || management.action === "unread_count") {
        const visible = (yield* writer.list().pipe(Effect.mapError(mapTaskError)))
          .filter((task) => isContained(root.canonicalPath, task.targetDirectory))
        const taskIDs = visible.map((task) => task.id)
        if (management.action === "unread_count") {
          const unread = yield* writer.unreadCount({ taskIDs }).pipe(Effect.mapError(mapTaskError))
          yield* authority.revalidate(admission, "read")
          return {
            title: "Scheduled task unread count",
            output: JSON.stringify({ unread }),
            structured: { action: management.action, unread },
            metadata: { action: management.action, unread, rootID: root.root.id },
          } satisfies OxpResult.CapabilityResult
        }

        const runs = yield* writer.inbox({
          taskIDs,
          limit: Math.min(Math.max(Math.floor(management.limit ?? 50), 1), 200),
          unreadOnly: management.unreadOnly ?? false,
        }).pipe(Effect.mapError(mapTaskError))
        const currentVisible = (yield* writer.list().pipe(Effect.mapError(mapTaskError)))
          .filter((task) => isContained(root.canonicalPath, task.targetDirectory))
        const currentIDs = new Set(currentVisible.map((task) => task.id))
        const projected = runs.filter((run) => currentIDs.has(run.taskID)).map((run) => projectRun(root, roots, run))
        yield* authority.revalidate(admission, "read")
        return {
          title: "Scheduled task inbox",
          output: JSON.stringify(projected),
          structured: { action: management.action, runs: projected },
          metadata: { action: management.action, count: projected.length, rootID: root.root.id },
        } satisfies OxpResult.CapabilityResult
      }

      if (management.action === "get") {
        const task = yield* scopedTask(admission, management.taskID)
        const freshRoot = yield* revalidateTask(admission, task, "read")
        const projected = projectTask(freshRoot, roots, task)
        return {
          title: `Scheduled task ${task.name}`,
          output: JSON.stringify(projected),
          structured: { action: management.action, task: projected },
          metadata: { action: management.action, taskID: task.id, rootID: freshRoot.root.id },
        } satisfies OxpResult.CapabilityResult
      }

      if (management.action === "runs") {
        const task = yield* scopedTask(admission, management.taskID)
        const runs = yield* writer.listRuns({
          taskID: task.id,
          limit: Math.min(Math.max(Math.floor(management.limit ?? 50), 1), 200),
          ...(management.before === undefined ? {} : { before: management.before }),
        }).pipe(Effect.mapError(mapTaskError))
        const freshRoot = yield* revalidateTask(admission, task, "read")
        const projected = runs.map((run) => projectRun(freshRoot, roots, run))
        return {
          title: `Runs for ${task.name}`,
          output: JSON.stringify(projected),
          structured: { action: management.action, taskID: task.id, runs: projected },
          metadata: { action: management.action, taskID: task.id, count: projected.length, rootID: freshRoot.root.id },
        } satisfies OxpResult.CapabilityResult
      }

      const mutation = management as
        | typeof Update.Type
        | typeof Remove.Type
        | typeof SetEnabled.Type
        | typeof Acknowledge.Type
        | typeof RunNow.Type
      const task = yield* scopedTask(admission, mutation.taskID)
      yield* cancelled(signal)
      const freshRoot = yield* revalidateTask(admission, task, "commit")

      if (mutation.action === "update") {
        const updated = yield* writer.update({
          id: task.id,
          expectedRevision: mutation.expectedRevision,
          ...(mutation.name === undefined ? {} : { name: mutation.name }),
          ...(mutation.schedule === undefined ? {} : { schedule: mutation.schedule }),
          ...(mutation.timezone === undefined ? {} : { timezone: mutation.timezone }),
          ...(mutation.taskAction === undefined ? {} : { action: mutation.taskAction }),
          ...(mutation.target === undefined ? {} : { target: mutation.target }),
          ...(mutation.sessionPolicy === undefined ? {} : { sessionPolicy: mutation.sessionPolicy }),
          ...(mutation.policy === undefined ? {} : { policy: mutation.policy }),
        }).pipe(Effect.mapError(mapTaskError))
        const projected = projectTask(freshRoot, roots, updated)
        return {
          title: `Updated ${updated.name}`,
          output: JSON.stringify(projected),
          structured: { action: mutation.action, task: projected },
          metadata: { action: mutation.action, taskID: updated.id, revision: updated.revision, rootID: freshRoot.root.id },
          mutation: { attempted: true, committed: true },
        } satisfies OxpResult.CapabilityResult
      }

      if (mutation.action === "remove") {
        yield* writer.removeChecked({ id: task.id, expectedRevision: mutation.expectedRevision }).pipe(Effect.mapError(mapTaskError))
        return {
          title: `Removed ${task.name}`,
          output: JSON.stringify({ action: mutation.action, taskID: task.id, removed: true }),
          structured: { action: mutation.action, taskID: task.id, removed: true },
          metadata: { action: mutation.action, taskID: task.id, rootID: freshRoot.root.id },
          mutation: { attempted: true, committed: true },
        } satisfies OxpResult.CapabilityResult
      }

      if (mutation.action === "set_enabled") {
        const updated = yield* writer.setEnabled({
          id: task.id,
          enabled: mutation.enabled,
          expectedRevision: mutation.expectedRevision,
        }).pipe(Effect.mapError(mapTaskError))
        const projected = projectTask(freshRoot, roots, updated)
        return {
          title: `${updated.enabled ? "Enabled" : "Disabled"} ${updated.name}`,
          output: JSON.stringify(projected),
          structured: { action: mutation.action, task: projected },
          metadata: { action: mutation.action, taskID: updated.id, enabled: updated.enabled, revision: updated.revision, rootID: freshRoot.root.id },
          mutation: { attempted: true, committed: true },
        } satisfies OxpResult.CapabilityResult
      }

      if (mutation.action === "run_now") {
        const run = yield* writer.enqueueManualRun({
          taskID: task.id,
          now: Date.now(),
          expectedRevision: mutation.expectedRevision,
        }).pipe(Effect.mapError(mapTaskError))
        const wakeRequested = yield* Effect.tryPromise({
          try: () => ScheduledTaskWake.poke(),
          catch: () => new OxpError.DependencyUnavailable({ detail: "Scheduled runner wake failed" }),
        }).pipe(Effect.catch(() => Effect.succeed(false)))
        const projected = projectRun(freshRoot, roots, run)
        return {
          title: `Queued manual run for ${task.name}`,
          output: JSON.stringify({ action: mutation.action, run: projected, wakeRequested }),
          structured: { action: mutation.action, run: projected, wakeRequested },
          metadata: { action: mutation.action, taskID: task.id, runID: run.id, wakeRequested, rootID: freshRoot.root.id },
          mutation: { attempted: true, committed: true },
        } satisfies OxpResult.CapabilityResult
      }

      if (mutation.action === "acknowledge") {
        yield* writer.acknowledgeChecked({
          taskID: task.id,
          runID: mutation.runID,
          expectedRevision: mutation.expectedRevision,
        }).pipe(Effect.mapError(mapTaskError))
        return {
          title: `Acknowledged scheduled task run ${mutation.runID}`,
          output: JSON.stringify({ action: mutation.action, taskID: task.id, runID: mutation.runID, acknowledged: true }),
          structured: { action: mutation.action, taskID: task.id, runID: mutation.runID, acknowledged: true },
          metadata: { action: mutation.action, taskID: task.id, runID: mutation.runID, rootID: freshRoot.root.id },
          mutation: { attempted: true, committed: true },
        } satisfies OxpResult.CapabilityResult
      }

      return yield* new OxpError.InvalidArgument({ detail: "Unsupported OXP schedule action" })
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpRoot.node, OxpSchedule.node, OxpSchedule.writerNode],
})

export * as OxpScheduleManagement from "./schedule-management"
