import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskPolicy } from "@opencode-ai/core/scheduled-task/policy"
import { ScheduledTaskRecurrence } from "@opencode-ai/core/scheduled-task/recurrence"
import { ScheduledTaskSchema } from "@opencode-ai/core/scheduled-task/schema"
import { ScheduledTask as ScheduledTaskModel } from "@opencode-ai/schema/scheduled-task"
import { OxpAuthority } from "./authority"
import { OxpConfig } from "./config"
import { OxpContext } from "./context"
import { OxpError } from "./error"
import { OxpLocation } from "./location"
import { OxpResult } from "./result"
import { OxpSchema } from "./schema"

export const Parameters = Schema.Struct({
  action: Schema.optionalKey(Schema.Literal("create")),
  name: Schema.String.annotate({ description: "Short unique name for the durable Scheduled Task." }),
  rootID: Schema.optional(OxpSchema.RootID),
  path: Schema.optional(Schema.String).annotate({
    description: "Optional directory inside the approved root. Omit to target the approved root itself.",
  }),
  schedule: ScheduledTaskModel.ScheduleInput,
  timezone: Schema.optional(Schema.String).annotate({
    description:
      "IANA timezone for daily, weekly, and cron schedules. Required for wall-clock schedules; ignored for once.",
  }),
  prompt: Schema.String.annotate({ description: "Prompt or slash command to execute when the schedule fires." }),
  enabled: Schema.optional(Schema.Boolean).annotate({ description: "Defaults to true." }),
  notify: Schema.optional(ScheduledTaskModel.NotifyMode).annotate({
    description: "Optional outcome notification policy. Defaults to failure-only.",
  }),
})
export type Input = Schema.Schema.Type<typeof Parameters>

/**
 * Narrow persistence bridge. Its production implementation materializes only
 * the Tier-0 ScheduledTask Core graph, and only after an authorized call.
 */
export interface WriterInterface {
  readonly create: (
    input: ScheduledTask.CreateInput,
  ) => Effect.Effect<ScheduledTask.Info, ScheduledTaskSchema.ValidationError>
  readonly findByName: (name: string) => Effect.Effect<ScheduledTask.Info | undefined>
  readonly list: () => Effect.Effect<ReadonlyArray<ScheduledTask.Info>>
  readonly get: (id: ScheduledTask.ID) => Effect.Effect<ScheduledTask.Info, ScheduledTaskSchema.NotFoundError>
  readonly update: (input: ScheduledTask.UpdateInput) => Effect.Effect<
    ScheduledTask.Info,
    ScheduledTaskSchema.NotFoundError | ScheduledTaskSchema.StaleRevisionError | ScheduledTaskSchema.ValidationError
  >
  readonly removeChecked: (input: {
    readonly id: ScheduledTask.ID
    readonly expectedRevision: number
  }) => Effect.Effect<void, ScheduledTaskSchema.NotFoundError | ScheduledTaskSchema.StaleRevisionError>
  readonly setEnabled: (input: ScheduledTask.SetEnabledInput) => Effect.Effect<
    ScheduledTask.Info,
    ScheduledTaskSchema.NotFoundError | ScheduledTaskSchema.StaleRevisionError
  >
  readonly listRuns: (input: {
    readonly taskID: ScheduledTask.ID
    readonly limit?: number
    readonly before?: number
  }) => Effect.Effect<ReadonlyArray<ScheduledTask.Run>, ScheduledTaskSchema.NotFoundError>
  readonly inbox: (input?: {
    readonly limit?: number
    readonly unreadOnly?: boolean
    readonly taskIDs?: ReadonlyArray<ScheduledTask.ID>
  }) => Effect.Effect<ReadonlyArray<ScheduledTask.Run>>
  readonly unreadCount: (input?: {
    readonly taskIDs?: ReadonlyArray<ScheduledTask.ID>
  }) => Effect.Effect<number>
  readonly acknowledgeChecked: (input: {
    readonly taskID: ScheduledTask.ID
    readonly runID: ScheduledTask.RunID
    readonly expectedRevision: number
    readonly now?: number
  }) => Effect.Effect<
    void,
    ScheduledTaskSchema.NotFoundError | ScheduledTaskSchema.StaleRevisionError | ScheduledTaskSchema.RunNotFoundError
  >
  readonly agenda: (input: {
    readonly from: number
    readonly to: number
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<ScheduledTask.AgendaOccurrence>>
  readonly enqueueManualRun: (input: {
    readonly taskID: ScheduledTask.ID
    readonly now: number
    readonly expectedRevision?: number
  }) => Effect.Effect<ScheduledTask.Run, ScheduledTaskSchema.NotFoundError | ScheduledTaskSchema.StaleRevisionError>
}

export class Writer extends Context.Service<Writer, WriterInterface>()("@opencode/OxpScheduleWriter") {}

const makeWriterRuntime = () => ManagedRuntime.make(AppNodeBuilder.build(ScheduledTask.node))

const writerLayer = Layer.effect(
  Writer,
  Effect.gen(function* () {
    let runtime: ReturnType<typeof makeWriterRuntime> | undefined
    const getRuntime = () => (runtime ??= makeWriterRuntime())

    yield* Effect.addFinalizer(() =>
      runtime ? Effect.promise(() => runtime!.dispose()).pipe(Effect.ignore) : Effect.void,
    )

    const run = <A, E extends ScheduledTask.Error>(operation: (tasks: ScheduledTask.Interface) => Effect.Effect<A, E>) =>
      Effect.promise(() =>
        getRuntime().runPromise(
          ScheduledTask.Service.use((tasks) =>
            operation(tasks).pipe(
              Effect.match({
                onFailure: (error) => ({ ok: false as const, error }),
                onSuccess: (value) => ({ ok: true as const, value }),
              }),
            ),
          ),
        ),
      ).pipe(
        Effect.flatMap((result) => (result.ok ? Effect.succeed(result.value) : Effect.fail(result.error))),
      )

    const create: WriterInterface["create"] = (input) => run((tasks) => tasks.create(input))
    const findByName: WriterInterface["findByName"] = (name) => run((tasks) => tasks.findByName({ name }))
    const list: WriterInterface["list"] = () => run((tasks) => tasks.list())
    const get: WriterInterface["get"] = (id) => run((tasks) => tasks.get(id))
    const update: WriterInterface["update"] = (input) => run((tasks) => tasks.update(input))
    const removeChecked: WriterInterface["removeChecked"] = (input) => run((tasks) => tasks.removeChecked(input))
    const setEnabled: WriterInterface["setEnabled"] = (input) => run((tasks) => tasks.setEnabled(input))
    const listRuns: WriterInterface["listRuns"] = (input) => run((tasks) => tasks.listRuns(input))
    const inbox: WriterInterface["inbox"] = (input) => run((tasks) => tasks.inbox(input))
    const unreadCount: WriterInterface["unreadCount"] = (input) => run((tasks) => tasks.unreadCount(input))
    const acknowledgeChecked: WriterInterface["acknowledgeChecked"] = (input) =>
      run((tasks) => tasks.acknowledgeChecked(input))
    const agenda: WriterInterface["agenda"] = (input) => run((tasks) => tasks.agenda(input))
    const enqueueManualRun: WriterInterface["enqueueManualRun"] = (input) => run((tasks) => tasks.enqueueManualRun(input))

    return Writer.of({
      create,
      findByName,
      list,
      get,
      update,
      removeChecked,
      setEnabled,
      listRuns,
      inbox,
      unreadCount,
      acknowledgeChecked,
      agenda,
      enqueueManualRun,
    })
  }),
)

export const writerNode = makeGlobalNode({ service: Writer, layer: writerLayer, deps: [] })

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpSchedule") {}
export const use = serviceUse(Service)

function cancelled(signal?: AbortSignal) {
  return signal?.aborted
    ? Effect.fail<OxpError.Error>(new OxpError.Cancelled({ detail: "OXP schedule creation was cancelled" }))
    : Effect.void
}

function equalJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const config = yield* OxpConfig.Service
    const fs = yield* FSUtil.Service
    const writer = yield* Writer

    const execute = Effect.fn("OxpSchedule.execute")(function* (input: Input, signal?: AbortSignal) {
      yield* cancelled(signal)
      yield* OxpLocation.requireExplicit(input, "schedule.create")

      const admission = yield* authority.authorize({
        plane: "augmentation",
        operation: "schedule.create",
        phase: "mutate",
        rootID: input.rootID,
        path: input.path,
      })
      if (!admission.root) return yield* new OxpError.RootRequired({ detail: "schedule.create requires an approved root" })

      const target = OxpLocation.targetPath(admission.root)
      const stat = yield* fs.stat(target).pipe(
        Effect.mapError(() => new OxpError.NotFound({ detail: "Scheduled target directory does not exist" })),
      )
      if (stat.type !== "Directory") {
        return yield* new OxpError.InvalidArgument({ detail: "schedule.create target must be a directory" })
      }

      const now = Date.now()
      const resolvedSchedule = ScheduledTaskRecurrence.resolveScheduleInput(input.schedule, now)
      if (!resolvedSchedule.ok) return yield* new OxpError.InvalidArgument({ detail: resolvedSchedule.reason })
      const schedule = resolvedSchedule.schedule
      const timezone = schedule.kind === "once" ? undefined : input.timezone?.trim() || undefined
      if (schedule.kind !== "once" && !timezone) {
        return yield* new OxpError.InvalidArgument({
          detail: "timezone is required for OXP daily, weekly, and cron schedules; do not infer it from the host machine",
        })
      }

      const state = yield* config.get()
      const workspace = OxpContext.workspaceFromResolvedRoot(admission.root)
      const invocation = OxpContext.createInvocation({
        principal: {
          connectorID: admission.connectorID,
          label: state.connector.label,
          profileRealm: "oxp",
        },
        grantRevision: admission.revision,
        plane: "augmentation",
        operation: "schedule.create",
        rootID: admission.root.root.id,
        workspace,
      })

      const name = input.name.trim()
      const enabled = input.enabled ?? true
      const action: ScheduledTaskModel.Action = { prompt: input.prompt }
      const policy = ScheduledTaskPolicy.resolvePolicy(input.notify ? { notify: input.notify } : undefined)
      const principal = String(admission.connectorID)

      const sameRequest = (task: ScheduledTask.Info | undefined) =>
        task !== undefined &&
        task.source === "oxp" &&
        task.sourcePrincipal === principal &&
        task.projectID === undefined &&
        task.targetDirectory === target &&
        task.target.kind === "directory" &&
        task.name === name &&
        task.enabled === enabled &&
        (input.schedule.kind === "relative" ? task.schedule.kind === "once" : equalJson(task.schedule, schedule)) &&
        task.timezone === timezone &&
        equalJson(task.action, action) &&
        equalJson(task.policy, policy)

      // OXP authority is live, not an admission-time snapshot. Revalidate as
      // close as possible to the durable SQLite commit.
      yield* cancelled(signal)
      const fresh = yield* authority.revalidate(admission, "commit")
      if (!fresh.root || OxpLocation.targetPath(fresh.root) !== target) {
        return yield* new OxpError.AuthRevoked({ detail: "OXP schedule target changed before commit" })
      }
      // Durable ScheduledTask truth keeps the canonical native target directory,
      // but native paths do not cross the OXP model boundary. Re-project from
      // the freshly revalidated root so an alias rename cannot leak a stale
      // virtual address into the result.
      const externalTarget = OxpContext.workspaceFromResolvedRoot(fresh.root).virtualDirectory

      const recoverDuplicate = Effect.fnUntraced(function* (error: ScheduledTaskSchema.ValidationError) {
        const existing = yield* writer.findByName(name)
        if (sameRequest(existing)) return { task: existing!, created: false as const }
        if (existing) {
          return yield* new OxpError.Conflict({
            detail: `A different scheduled task named "${name}" already exists`,
          })
        }
        return yield* new OxpError.InvalidArgument({ detail: error.reason })
      })

      const createAttempt = writer
        .create({
          targetDirectory: target,
          target: { kind: "directory" },
          name,
          enabled,
          schedule,
          ...(timezone ? { timezone } : {}),
          action,
          policy: input.notify ? { notify: input.notify } : undefined,
          source: "oxp",
          sourceRef: String(invocation.id),
          sourcePrincipal: principal,
          now,
        })
        .pipe(
          Effect.map((task) => ({ task, created: true as const })),
          Effect.catch(recoverDuplicate),
        )
      const result = yield* createAttempt

      return {
        title: result.created ? `Scheduled ${result.task.name}` : `Schedule already exists: ${result.task.name}`,
        output: JSON.stringify({
          created: result.created,
          taskID: result.task.id,
          name: result.task.name,
          enabled: result.task.enabled,
          schedule: result.task.schedule,
          timezone: result.task.timezone,
          nextRunAt: result.task.nextRunAt,
          targetDirectory: externalTarget,
          notify: result.task.policy.notify,
          source: result.task.source,
          sourceRef: result.task.sourceRef,
        }),
        structured: {
          created: result.created,
          taskID: result.task.id,
          enabled: result.task.enabled,
          nextRunAt: result.task.nextRunAt,
        },
        metadata: {
          taskID: result.task.id,
          created: result.created,
          enabled: result.task.enabled,
          ...(result.task.nextRunAt === undefined ? {} : { nextRunAt: result.task.nextRunAt }),
          source: "oxp",
        },
        mutation: { attempted: true, committed: result.created },
      } satisfies OxpResult.CapabilityResult
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, OxpConfig.node, FSUtil.node, writerNode],
})

export * as OxpSchedule from "./schedule"
