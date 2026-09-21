export * as ScheduledTask from "./index"

import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer } from "effect"
import { ScheduledTask as ScheduledTaskModel } from "@opencode-ai/schema/scheduled-task"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { ProjectTable } from "../project/sql"
import { AbsolutePath } from "../schema"
import { ScheduledTaskSchema } from "./schema"
import {
  ScheduledTaskPolicy,
  countsTowardCircuitBreaker,
  decideDue,
  isRetryable,
  retryBackoffMs,
  retryableAttempts,
} from "./policy"
import { hydrateRun } from "./projection"
import { jitterFor, nextOccurrence, occurrencesBetween, resolveScheduleInput, validateSchedule } from "./recurrence"
import {
  ScheduledTaskControlTable,
  ScheduledTaskLeaseTable,
  ScheduledTaskRunTable,
  ScheduledTaskSessionBindingTable,
  ScheduledTaskTable,
} from "./sql"

export const ID = ScheduledTaskModel.ID
export type ID = ScheduledTaskModel.ID
export const RunID = ScheduledTaskModel.RunID
export type RunID = ScheduledTaskModel.RunID
export const Info = ScheduledTaskModel.Info
export type Info = ScheduledTaskModel.Info
export const Run = ScheduledTaskModel.Run
export type Run = ScheduledTaskModel.Run
export const Event = ScheduledTaskModel.Event
export const SkipReason = ScheduledTaskModel.SkipReason
export type SkipReason = ScheduledTaskModel.SkipReason
export const ErrorKind = ScheduledTaskModel.ErrorKind
export type ErrorKind = ScheduledTaskModel.ErrorKind
export const RunStatus = ScheduledTaskModel.RunStatus
export type RunStatus = ScheduledTaskModel.RunStatus
export const Trigger = ScheduledTaskModel.Trigger
export type Trigger = ScheduledTaskModel.Trigger
export const PermissionMode = ScheduledTaskModel.PermissionMode
export type PermissionMode = ScheduledTaskModel.PermissionMode
export const Schedule = ScheduledTaskModel.Schedule
export type Schedule = ScheduledTaskModel.Schedule
export const ScheduleInput = ScheduledTaskModel.ScheduleInput
export type ScheduleInput = ScheduledTaskModel.ScheduleInput
export const Policy = ScheduledTaskModel.Policy
export type Policy = ScheduledTaskModel.Policy
export const Target = ScheduledTaskModel.Target
export type Target = ScheduledTaskModel.Target
export const SessionPolicy = ScheduledTaskModel.SessionPolicy
export type SessionPolicy = ScheduledTaskModel.SessionPolicy
export const Action = ScheduledTaskModel.Action
export type Action = ScheduledTaskModel.Action
export const AgendaOccurrence = ScheduledTaskModel.AgendaOccurrence
export type AgendaOccurrence = ScheduledTaskModel.AgendaOccurrence

export { ScheduledTaskSchema, ScheduledTaskPolicy }
export type Error = ScheduledTaskSchema.Error

export const CIRCUIT_BREAKER_THRESHOLD = 5

export interface CreateInput {
  readonly projectID?: typeof ProjectTable.$inferSelect.id
  readonly targetDirectory: string
  readonly target?: ScheduledTaskModel.Target
  readonly sessionPolicy?: ScheduledTaskModel.SessionPolicy
  readonly name: string
  readonly enabled?: boolean
  readonly schedule: ScheduledTaskModel.ScheduleInput
  readonly timezone?: string
  readonly action: ScheduledTaskModel.Action
  readonly policy?: ScheduledTaskModel.Policy
  readonly source?: ScheduledTaskModel.Source
  readonly sourcePath?: string
  readonly sourceMessageID?: string
  readonly sourceRef?: string
  readonly sourcePrincipal?: string
  readonly now?: number
}

export interface UpdateInput {
  readonly id: ID
  readonly expectedRevision: number
  readonly name?: string
  readonly targetDirectory?: string
  readonly target?: ScheduledTaskModel.Target
  readonly sessionPolicy?: ScheduledTaskModel.SessionPolicy
  readonly schedule?: ScheduledTaskModel.ScheduleInput
  /** `null` clears the explicit zone (host zone at every computation). */
  readonly timezone?: string | null
  readonly action?: ScheduledTaskModel.Action
  readonly policy?: ScheduledTaskModel.Policy
  readonly now?: number
}

export interface SetEnabledInput {
  readonly id: ID
  readonly enabled: boolean
  readonly expectedRevision?: number
  readonly now?: number
}

export interface RunStartInput {
  readonly taskID: ID
  readonly fireFor: number
  readonly trigger: ScheduledTaskModel.Trigger
  readonly attempt: number
  /** How a pre-existing run row for this fire_for is treated. */
  readonly acceptExisting: "none" | "retry" | "queued"
  readonly now: number
}

export type RunStartResult =
  | { readonly kind: "started"; readonly run: Run }
  | { readonly kind: "exists"; readonly run: Run | undefined }

export interface SettleInput {
  readonly taskID: ID
  readonly runID: ScheduledTaskModel.RunID
  readonly fireFor: number
  readonly status: "succeeded" | "failed" | "skipped"
  readonly now: number
  readonly attempt: number
  readonly leaseID?: string
  readonly sessionID?: ScheduledTaskModel.Run["sessionID"]
  readonly workspaceID?: ScheduledTaskModel.Run["workspaceID"]
  readonly directory?: string
  readonly skipReason?: ScheduledTaskModel.SkipReason
  readonly errorKind?: ScheduledTaskModel.ErrorKind
  readonly errorMessage?: string
  /** `undefined` derives from the engine; `null` is an explicit exhaustion. */
  readonly nextRunAt?: number | null
  /** `run_once` catch-up collapses the remaining misses onto `now`. */
  readonly collapseAfterNow?: boolean
}

export interface SettleResult {
  readonly run: Run
  /** Present when the settlement scheduled a bounded retry instead of advancing. */
  readonly retryAt?: number
}

export interface FiringPlan {
  readonly task: Info
  readonly fireFor: number
  readonly trigger: "schedule" | "catchup" | "manual" | "retry"
  readonly attempt: number
  readonly acceptExisting: "none" | "retry" | "queued"
}

type DatabaseExecutor = Omit<Database.DatabaseShape, "$client">

export interface RunSessionAuthorizationInput {
  readonly runID: ScheduledTaskModel.RunID
  readonly attempt: number
  readonly sessionID: NonNullable<ScheduledTaskModel.Run["sessionID"]>
}

/**
 * Transaction-compatible run -> Session authorization.
 *
 * Callers inside an EventV2 commit hook pass the transaction-bound Database
 * service so this fence and the admission projection commit atomically.
 */
export const authorizeRunSessionIn = Effect.fn("ScheduledTask.authorizeRunSessionIn")(function* (
  database: DatabaseExecutor,
  input: RunSessionAuthorizationInput,
) {
  const row = yield* database
    .select({
      taskID: ScheduledTaskRunTable.task_id,
      attempt: ScheduledTaskRunTable.attempt,
      status: ScheduledTaskRunTable.status,
      sessionID: ScheduledTaskRunTable.session_id,
    })
    .from(ScheduledTaskRunTable)
    .where(eq(ScheduledTaskRunTable.id, input.runID))
    .get()
    .pipe(Effect.orDie)
  if (!row) return yield* new ScheduledTaskSchema.RunNotFoundError({ runID: input.runID })
  if (row.attempt !== input.attempt || (row.status !== "running" && row.status !== "waiting")) {
    return yield* new ScheduledTaskSchema.RunAttemptConflictError({
      runID: input.runID,
      expectedAttempt: input.attempt,
      actualAttempt: row.attempt,
      status: row.status,
    })
  }
  if (row.sessionID !== input.sessionID) {
    return yield* new ScheduledTaskSchema.ValidationError({
      reason: `scheduled run ${input.runID} is bound to ${row.sessionID ?? "<no Session>"}, not ${input.sessionID}`,
    })
  }
  return { taskID: row.taskID }
})

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info, ScheduledTaskSchema.ValidationError>
  readonly get: (id: ID) => Effect.Effect<Info, ScheduledTaskSchema.NotFoundError>
  readonly findByName: (input: {
    readonly projectID?: typeof ProjectTable.$inferSelect.id
    readonly name: string
  }) => Effect.Effect<Info | undefined>
  readonly list: (input?: {
    readonly projectID?: typeof ProjectTable.$inferSelect.id
  }) => Effect.Effect<ReadonlyArray<Info>>
  readonly agenda: (input: {
    readonly from: number
    readonly to: number
    readonly limit: number
    readonly projectID?: typeof ProjectTable.$inferSelect.id
  }) => Effect.Effect<ReadonlyArray<AgendaOccurrence>>
  readonly update: (
    input: UpdateInput,
  ) => Effect.Effect<
    Info,
    ScheduledTaskSchema.NotFoundError | ScheduledTaskSchema.StaleRevisionError | ScheduledTaskSchema.ValidationError
  >
  readonly remove: (id: ID) => Effect.Effect<void, ScheduledTaskSchema.NotFoundError>
  readonly removeChecked: (input: {
    readonly id: ID
    readonly expectedRevision: number
  }) => Effect.Effect<void, ScheduledTaskSchema.NotFoundError | ScheduledTaskSchema.StaleRevisionError>
  readonly setEnabled: (
    input: SetEnabledInput,
  ) => Effect.Effect<Info, ScheduledTaskSchema.NotFoundError | ScheduledTaskSchema.StaleRevisionError>
  readonly listRuns: (input: {
    readonly taskID: ID
    readonly limit?: number
    readonly before?: number
  }) => Effect.Effect<ReadonlyArray<Run>, ScheduledTaskSchema.NotFoundError>
  readonly inbox: (input?: {
    readonly limit?: number
    readonly unreadOnly?: boolean
    readonly taskIDs?: ReadonlyArray<ID>
  }) => Effect.Effect<ReadonlyArray<Run>>
  readonly unreadCount: (input?: { readonly taskIDs?: ReadonlyArray<ID> }) => Effect.Effect<number>
  readonly acknowledge: (input: {
    readonly runID: ScheduledTaskModel.RunID
    readonly now?: number
  }) => Effect.Effect<void, ScheduledTaskSchema.RunNotFoundError>
  readonly acknowledgeChecked: (input: {
    readonly taskID: ID
    readonly runID: ScheduledTaskModel.RunID
    readonly expectedRevision: number
    readonly now?: number
  }) => Effect.Effect<
    void,
    ScheduledTaskSchema.NotFoundError | ScheduledTaskSchema.StaleRevisionError | ScheduledTaskSchema.RunNotFoundError
  >
  readonly due: (now: number) => Effect.Effect<ReadonlyArray<Info>>
  readonly nextDueAt: (now: number) => Effect.Effect<number | undefined>
  /**
   * Tier 0 due planning: performs the skip/advance settlements for catch-up
   * and returns the firings the runner should dispatch.
   */
  readonly planDue: (now: number) => Effect.Effect<ReadonlyArray<FiringPlan>>
  /** Process-start / clock-jump self-healing cursor recompute (02 § 3.2 Case C). */
  readonly recomputeAll: (now: number) => Effect.Effect<number>
  readonly recordRunStart: (input: RunStartInput) => Effect.Effect<RunStartResult, ScheduledTaskSchema.NotFoundError>
  readonly settleRun: (
    input: SettleInput,
  ) => Effect.Effect<
    SettleResult,
    ScheduledTaskSchema.NotFoundError | ScheduledTaskSchema.RunNotFoundError | ScheduledTaskSchema.RunAttemptConflictError
  >
  readonly skipSettled: (input: {
    readonly taskID: ID
    readonly fireFor: number
    readonly now: number
    readonly nextRunAt?: number
  }) => Effect.Effect<void>
  readonly markRunStatus: (input: {
    readonly runID: ScheduledTaskModel.RunID
    readonly attempt: number
    readonly status: "running" | "waiting"
    readonly now: number
  }) => Effect.Effect<boolean>
  /**
   * Bind the execution container for the current attempt before model work
   * begins. The attempt fence prevents a stale executor from overwriting a
   * newer retry's Session pointer.
   */
  readonly attachRunSession: (input: {
    readonly runID: ScheduledTaskModel.RunID
    readonly attempt: number
    readonly sessionID: NonNullable<ScheduledTaskModel.Run["sessionID"]>
    readonly directory: string
  }) => Effect.Effect<boolean>
  /**
   * Correlate exactly one Goal with this logical run. The Goal ID is scalar
   * history: Goal deletion/pruning must not rewrite the run audit record.
   */
  readonly attachRunGoal: (input: {
    readonly runID: ScheduledTaskModel.RunID
    readonly attempt: number
    readonly goalID: NonNullable<ScheduledTaskModel.Run["goalID"]>
  }) => Effect.Effect<boolean>
  /** O(1) logical-run Goal correlation. Retries reuse this exact Goal. */
  readonly runGoal: (
    runID: ScheduledTaskModel.RunID,
  ) => Effect.Effect<NonNullable<ScheduledTaskModel.Run["goalID"]> | undefined, ScheduledTaskSchema.RunNotFoundError>
  /** O(1) proof used before replacing a terminal focus in a reusable Session. */
  readonly goalOwner: (goalID: NonNullable<ScheduledTaskModel.Run["goalID"]>) => Effect.Effect<
    { readonly runID: ScheduledTaskModel.RunID; readonly taskID: ID } | undefined
  >
  /**
   * O(1) trusted-admission fence. A scheduler host turn may enter a Session only
   * while this exact logical run attempt owns that exact Session binding.
   */
  readonly authorizeRunSession: (input: {
    readonly runID: ScheduledTaskModel.RunID
    readonly attempt: number
    readonly sessionID: NonNullable<ScheduledTaskModel.Run["sessionID"]>
  }) => Effect.Effect<
    { readonly taskID: ID },
    ScheduledTaskSchema.RunNotFoundError | ScheduledTaskSchema.RunAttemptConflictError | ScheduledTaskSchema.ValidationError
  >
  readonly enqueueManualRun: (
    input: { readonly taskID: ID; readonly now: number; readonly expectedRevision?: number },
  ) => Effect.Effect<Run, ScheduledTaskSchema.NotFoundError | ScheduledTaskSchema.StaleRevisionError>
  /** Cheap primary-key read used as the cross-process scheduler invalidation epoch. */
  readonly generation: () => Effect.Effect<number>
  readonly control: () => Effect.Effect<ScheduledTaskModel.Control>
  readonly setPaused: (input: { readonly paused: boolean; readonly now?: number }) => Effect.Effect<ScheduledTaskModel.Control>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ScheduledTask") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service
    const events = yield* EventV2.Service
    const requireRow = Effect.fnUntraced(function* (database: DatabaseExecutor, id: ID) {
      const row = yield* database.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get().pipe(Effect.orDie)
      if (!row) return yield* new ScheduledTaskSchema.NotFoundError({ taskID: id })
      return row
    })

    const create = Effect.fn("ScheduledTask.create")(function* (input: CreateInput) {
      const now = input.now ?? Date.now()
      const name = input.name.trim()
      if (!name) return yield* new ScheduledTaskSchema.ValidationError({ reason: "name is required" })
      const directory = normalizeDirectory(input.targetDirectory)
      if (!directory.ok) return yield* new ScheduledTaskSchema.ValidationError({ reason: directory.reason })
      const resolvedSchedule = resolveScheduleInput(input.schedule, now)
      if (!resolvedSchedule.ok) return yield* new ScheduledTaskSchema.ValidationError({ reason: resolvedSchedule.reason })
      const schedule = validateScheduleChecked(resolvedSchedule.schedule, now, input.timezone)
      if (!schedule.ok) return yield* new ScheduledTaskSchema.ValidationError({ reason: schedule.reason })
      const action = validateAction(input.action)
      if (!action.ok) return yield* new ScheduledTaskSchema.ValidationError({ reason: action.reason })
      const policy = ScheduledTaskPolicy.resolvePolicy(input.policy)
      const target = input.target ?? ({ kind: "directory" } as const)
      const sessionPolicy = input.sessionPolicy ?? ({ kind: "new" } as const)
      const sessionPolicyTarget = validateSessionPolicyTarget(sessionPolicy, target)
      if (!sessionPolicyTarget.ok) {
        return yield* new ScheduledTaskSchema.ValidationError({ reason: sessionPolicyTarget.reason })
      }
      const enabled = input.enabled ?? false
      const id = ScheduledTaskModel.ID.create()

      const row = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
            if (input.projectID) {
              const project = yield* tx
                .select({ id: ProjectTable.id })
                .from(ProjectTable)
                .where(eq(ProjectTable.id, input.projectID))
                .get()
                .pipe(Effect.orDie)
              if (!project) {
                return yield* new ScheduledTaskSchema.ValidationError({
                  reason: `project does not exist: ${input.projectID}`,
                })
              }
            }
            const duplicate = yield* tx
              .select({ id: ScheduledTaskTable.id })
              .from(ScheduledTaskTable)
              .where(nameWhere(input.projectID, name))
              .get()
              .pipe(Effect.orDie)
            if (duplicate) {
              return yield* new ScheduledTaskSchema.ValidationError({ reason: `a scheduled task named "${name}" already exists` })
            }
            const nextRunAt = enabled
              ? nextOccurrence({ schedule: resolvedSchedule.schedule, timezone: input.timezone, after: now }) ?? null
              : null
            yield* tx
              .insert(ScheduledTaskTable)
              .values({
                id,
                project_id: input.projectID ?? null,
                target_directory: AbsolutePath.make(directory.value),
                target,
                session_policy: sessionPolicy,
                name,
                enabled,
                revision: 0,
                schedule: resolvedSchedule.schedule,
                timezone: input.timezone?.trim() || null,
                action: input.action,
                policy,
                next_run_at: nextRunAt,
                source: input.source ?? "api",
                source_path: input.sourcePath ?? null,
                source_message_id: input.sourceMessageID ?? null,
                source_ref: input.sourceRef ?? null,
                source_principal: input.sourcePrincipal ?? null,
                time_created: now,
                time_updated: now,
              })
              .run()
              .pipe(Effect.orDie)
            return yield* requireRow(tx, id).pipe(Effect.catchTag("ScheduledTask.NotFoundError", Effect.die))
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      const info = hydrateInfo(row)
      yield* events.publish(Event.Created, { taskID: id, info })
      return info
    })

    const get = Effect.fn("ScheduledTask.get")(function* (id: ID) {
      return hydrateInfo(yield* requireRow(readDb, id))
    })

    const findByName = Effect.fn("ScheduledTask.findByName")(function* (input: {
      readonly projectID?: typeof ProjectTable.$inferSelect.id
      readonly name: string
    }) {
      const name = input.name.trim()
      if (!name) return undefined
      const row = yield* readDb
        .select()
        .from(ScheduledTaskTable)
        .where(nameWhere(input.projectID, name))
        .get()
        .pipe(Effect.orDie)
      return row ? hydrateInfo(row) : undefined
    })

    const list = Effect.fn("ScheduledTask.list")(function* (input?: { projectID?: typeof ProjectTable.$inferSelect.id }) {
      const query = readDb.select().from(ScheduledTaskTable)
      const rows = yield* (input?.projectID ? query.where(eq(ScheduledTaskTable.project_id, input.projectID)) : query)
        .orderBy(
          desc(ScheduledTaskTable.enabled),
          sql`case when scheduled_task.next_run_at is null then 1 else 0 end`,
          asc(ScheduledTaskTable.next_run_at),
          asc(ScheduledTaskTable.name),
        )
        .all()
        .pipe(Effect.orDie)
      return rows.map(hydrateInfo)
    })

    const agenda = Effect.fn("ScheduledTask.agenda")(function* (input: {
      readonly from: number
      readonly to: number
      readonly limit: number
      readonly projectID?: typeof ProjectTable.$inferSelect.id
    }) {
      const limit = Math.max(0, Math.floor(input.limit))
      if (limit === 0 || !Number.isFinite(input.from) || !Number.isFinite(input.to) || input.to < input.from) return []

      const taskRows = yield* list({ projectID: input.projectID })
      // Keep only the globally earliest K effective occurrences as we scan
      // tasks. The heap root is the current worst selected event. Once full,
      // any future raw recurrence with scheduledAt > root.effectiveAt is
      // impossible to improve the result because jitter is non-negative.
      const occurrences: AgendaOccurrence[] = []
      const compareAgenda = (left: AgendaOccurrence, right: AgendaOccurrence) =>
        left.effectiveAt - right.effectiveAt ||
        left.taskID.localeCompare(right.taskID) ||
        left.scheduledAt - right.scheduledAt
      const siftDown = (index: number) => {
        while (true) {
          const left = index * 2 + 1
          const right = left + 1
          let largest = index
          if (left < occurrences.length && compareAgenda(occurrences[left]!, occurrences[largest]!) > 0) largest = left
          if (right < occurrences.length && compareAgenda(occurrences[right]!, occurrences[largest]!) > 0) largest = right
          if (largest === index) return
          ;[occurrences[index], occurrences[largest]] = [occurrences[largest]!, occurrences[index]!]
          index = largest
        }
      }
      const consider = (occurrence: AgendaOccurrence) => {
        if (occurrences.length < limit) {
          occurrences.push(occurrence)
          let index = occurrences.length - 1
          while (index > 0) {
            const parent = Math.floor((index - 1) / 2)
            if (compareAgenda(occurrences[parent]!, occurrences[index]!) >= 0) break
            ;[occurrences[parent], occurrences[index]] = [occurrences[index]!, occurrences[parent]!]
            index = parent
          }
          return
        }
        if (compareAgenda(occurrence, occurrences[0]!) >= 0) return
        occurrences[0] = occurrence
        siftDown(0)
      }

      // Cache only recurrence windows proven complete (the enumerator returned
      // fewer rows than requested). This makes common daily/weekly schedule
      // shapes effectively O(one recurrence scan + task jitter transforms)
      // without retaining large partial minute-level cron arrays.
      const recurrenceCache = new Map<string, ReadonlyArray<number>>()
      for (const task of taskRows) {
        if (!task.enabled) continue
        const jitterMs = Math.max(0, Number(task.policy.jitterMs) || 0)
        const rawFrom = input.from - jitterMs
        const rawTo =
          occurrences.length < limit ? input.to : Math.min(input.to, occurrences[0]?.effectiveAt ?? input.to)
        if (rawTo < rawFrom) continue
        const remaining = Math.max(1, limit - occurrences.length)
        // At one-minute minimum recurrence density, J bounds both (a) raw
        // candidates exposed before `from` by the widened jitter window and
        // (b) later raw candidates that can overtake the current Kth event by
        // receiving less jitter. Both horizons must be covered while the heap
        // is still being filled. Once full, enumerate every raw candidate up
        // to the exact current worst effective time instead.
        const jitterSlack = Math.ceil(jitterMs / 60_000) + 1
        const rawLimit =
          occurrences.length < limit
            ? remaining + 2 * jitterSlack
            : Math.max(1, Math.floor((rawTo - rawFrom) / 60_000) + 2)
        const recurrenceKey = `${task.timezone ?? ""}\u0000${jitterMs}\u0000${JSON.stringify(task.schedule)}`
        // A cached entry is complete through input.to, so it is also a valid
        // superset for every later heap-derived earlier cutoff. The loop below
        // stops at rawTo without recomputing recurrence/DST resolution.
        let scheduled = recurrenceCache.get(recurrenceKey)
        if (!scheduled) {
          scheduled = occurrencesBetween({
            schedule: task.schedule,
            timezone: task.timezone,
            from: rawFrom,
            to: rawTo,
            limit: rawLimit,
          })
          if (rawTo === input.to && scheduled.length < rawLimit) recurrenceCache.set(recurrenceKey, scheduled)
        }
        for (const scheduledAt of scheduled) {
          if (scheduledAt > rawTo) break
          const effectiveAt = scheduledAt + jitterFor(task.id, scheduledAt, jitterMs)
          if (effectiveAt < input.from || effectiveAt > input.to) continue
          consider({ taskID: task.id, scheduledAt, effectiveAt })
        }
      }
      occurrences.sort(compareAgenda)
      return occurrences
    })

    const update = Effect.fn("ScheduledTask.update")(function* (input: UpdateInput) {
      const now = input.now ?? Date.now()
      const name = input.name === undefined ? undefined : input.name.trim()
      if (name !== undefined && !name) {
        return yield* new ScheduledTaskSchema.ValidationError({ reason: "name cannot be empty" })
      }
      const directory = input.targetDirectory === undefined ? undefined : normalizeDirectory(input.targetDirectory)
      if (directory && !directory.ok) return yield* new ScheduledTaskSchema.ValidationError({ reason: directory.reason })
      const resolvedSchedule = input.schedule === undefined ? undefined : resolveScheduleInput(input.schedule, now)
      if (resolvedSchedule && !resolvedSchedule.ok) {
        return yield* new ScheduledTaskSchema.ValidationError({ reason: resolvedSchedule.reason })
      }
      if (resolvedSchedule?.ok) {
        const schedule = validateScheduleChecked(resolvedSchedule.schedule, now, input.timezone ?? undefined)
        if (!schedule.ok) return yield* new ScheduledTaskSchema.ValidationError({ reason: schedule.reason })
      }
      if (input.timezone !== undefined && input.timezone !== null) {
        const zone = validateSchedule(
          resolvedSchedule?.ok ? resolvedSchedule.schedule : { kind: "daily", times: [{ hour: 0, minute: 0 }] },
          { timezone: input.timezone },
        )
        if (!zone.ok && zone.reason.startsWith("unknown IANA timezone")) {
          return yield* new ScheduledTaskSchema.ValidationError({ reason: zone.reason })
        }
      }
      if (input.action !== undefined) {
        const action = validateAction(input.action)
        if (!action.ok) return yield* new ScheduledTaskSchema.ValidationError({ reason: action.reason })
      }
      const policy = input.policy === undefined ? undefined : ScheduledTaskPolicy.resolvePolicy(input.policy)

      const row = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
            const current = yield* requireRow(tx, input.id)
            if (current.revision !== input.expectedRevision) {
              return yield* new ScheduledTaskSchema.StaleRevisionError({
                taskID: input.id,
                expectedRevision: input.expectedRevision,
                actualRevision: current.revision,
              })
            }
            if (name !== undefined && name !== current.name) {
              const duplicate = yield* tx
                .select({ id: ScheduledTaskTable.id })
                .from(ScheduledTaskTable)
                .where(and(nameWhere(current.project_id, name), sql`${ScheduledTaskTable.id} != ${input.id}`))
                .get()
                .pipe(Effect.orDie)
              if (duplicate) {
                return yield* new ScheduledTaskSchema.ValidationError({
                  reason: `a scheduled task named "${name}" already exists`,
                })
              }
            }
            const schedule = resolvedSchedule?.ok ? resolvedSchedule.schedule : current.schedule
            const timezone = input.timezone === undefined ? current.timezone : input.timezone?.trim() || null
            const target = input.target ?? current.target
            const sessionPolicy = input.sessionPolicy ?? current.session_policy
            const sessionPolicyTarget = validateSessionPolicyTarget(sessionPolicy, target)
            if (!sessionPolicyTarget.ok) {
              return yield* new ScheduledTaskSchema.ValidationError({ reason: sessionPolicyTarget.reason })
            }
            // The due cursor is recomputed in the SAME transaction as the
            // mutation that could change it (T3 invariant). Spec-only edits
            // (name, prompt) keep the cursor so an overdue instant still goes
            // through the catch-up policy instead of being silently erased.
            const scheduleChanged = input.schedule !== undefined || input.timezone !== undefined
            const nextRunAt = current.enabled
              ? scheduleChanged || current.next_run_at === null
                ? nextOccurrence({ schedule, timezone: timezone ?? undefined, after: now }) ?? null
                : current.next_run_at
              : null
            const bindingInvalidated =
              (directory?.ok === true && directory.value !== current.target_directory) ||
              (input.target !== undefined && !sameTarget(input.target, current.target)) ||
              (input.sessionPolicy !== undefined && !sameSessionPolicy(input.sessionPolicy, current.session_policy))
            yield* tx
              .update(ScheduledTaskTable)
              .set({
                ...(name !== undefined ? { name } : {}),
                ...(directory?.ok ? { target_directory: AbsolutePath.make(directory.value) } : {}),
                ...(input.target !== undefined ? { target: input.target } : {}),
                ...(input.sessionPolicy !== undefined ? { session_policy: input.sessionPolicy } : {}),
                ...(resolvedSchedule?.ok ? { schedule: resolvedSchedule.schedule } : {}),
                ...(input.timezone !== undefined ? { timezone } : {}),
                ...(input.action !== undefined ? { action: input.action } : {}),
                ...(policy !== undefined ? { policy } : {}),
                next_run_at: nextRunAt,
                revision: sql`${ScheduledTaskTable.revision} + 1`,
                time_updated: now,
              })
              .where(eq(ScheduledTaskTable.id, input.id))
              .run()
              .pipe(Effect.orDie)
            if (bindingInvalidated) {
              yield* tx
                .delete(ScheduledTaskSessionBindingTable)
                .where(eq(ScheduledTaskSessionBindingTable.task_id, input.id))
                .run()
                .pipe(Effect.orDie)
            }
            return yield* requireRow(tx, input.id)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      const info = hydrateInfo(row)
      yield* events.publish(Event.Updated, { taskID: input.id, info })
      return info
    })

    const remove = Effect.fn("ScheduledTask.remove")(function* (id: ID) {
      yield* requireRow(db, id)
      // Sessions created by runs are deliberately untouched: only the task's
      // own rows cascade (lease + run history).
      yield* db.delete(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).run().pipe(Effect.orDie)
      yield* events.publish(Event.Removed, { taskID: id })
    })

    const removeChecked = Effect.fn("ScheduledTask.removeChecked")(function* (input: {
      id: ID
      expectedRevision: number
    }) {
      yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const current = yield* requireRow(tx, input.id)
              if (current.revision !== input.expectedRevision) {
                return yield* new ScheduledTaskSchema.StaleRevisionError({
                  taskID: input.id,
                  expectedRevision: input.expectedRevision,
                  actualRevision: current.revision,
                })
              }
              yield* tx.delete(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, input.id)).run().pipe(Effect.orDie)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      yield* events.publish(Event.Removed, { taskID: input.id })
    })

    const setEnabled = Effect.fn("ScheduledTask.setEnabled")(function* (input: SetEnabledInput) {
      const now = input.now ?? Date.now()
      const row = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
            const current = yield* requireRow(tx, input.id)
            if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
              return yield* new ScheduledTaskSchema.StaleRevisionError({
                taskID: input.id,
                expectedRevision: input.expectedRevision,
                actualRevision: current.revision,
              })
            }
            const nextRunAt = input.enabled
              ? nextOccurrence({
                  schedule: current.schedule,
                  timezone: current.timezone ?? undefined,
                  after: now,
                }) ?? null
              : null
            yield* tx
              .update(ScheduledTaskTable)
              .set({
                enabled: input.enabled,
                next_run_at: nextRunAt,
                consecutive_failures: input.enabled ? 0 : current.consecutive_failures,
                revision: sql`${ScheduledTaskTable.revision} + 1`,
                time_updated: now,
              })
              .where(eq(ScheduledTaskTable.id, input.id))
              .run()
              .pipe(Effect.orDie)
            return yield* requireRow(tx, input.id)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      const info = hydrateInfo(row)
      yield* events.publish(Event.Updated, { taskID: input.id, info })
      return info
    })

    const listRuns = Effect.fn("ScheduledTask.listRuns")(function* (input: {
      taskID: ID
      limit?: number
      before?: number
    }) {
      yield* requireRow(readDb, input.taskID)
      const rows = yield* readDb
        .select()
        .from(ScheduledTaskRunTable)
        .where(
          input.before === undefined
            ? eq(ScheduledTaskRunTable.task_id, input.taskID)
            : and(
                eq(ScheduledTaskRunTable.task_id, input.taskID),
                sql`${ScheduledTaskRunTable.started_at} < ${input.before}`,
              ),
        )
        .orderBy(desc(ScheduledTaskRunTable.started_at), desc(ScheduledTaskRunTable.id))
        .limit(Math.min(Math.max(input.limit ?? 50, 1), 500))
        .all()
        .pipe(Effect.orDie)
      return rows.map(hydrateRun)
    })

    const inbox = Effect.fn("ScheduledTask.inbox")(function* (input?: {
      limit?: number
      unreadOnly?: boolean
      taskIDs?: ReadonlyArray<ID>
    }) {
      if (input?.taskIDs?.length === 0) return []
      const rows = yield* readDb
        .select()
        .from(ScheduledTaskRunTable)
        .where(
          and(
            input?.unreadOnly ? unreadWhere() : undefined,
            input?.taskIDs ? inArray(ScheduledTaskRunTable.task_id, input.taskIDs) : undefined,
          ),
        )
        .orderBy(desc(ScheduledTaskRunTable.started_at), desc(ScheduledTaskRunTable.id))
        .limit(Math.min(Math.max(input?.limit ?? 50, 1), 500))
        .all()
        .pipe(Effect.orDie)
      return rows.map(hydrateRun)
    })

    const unreadCount = Effect.fn("ScheduledTask.unreadCount")(function* (input?: { taskIDs?: ReadonlyArray<ID> }) {
      if (input?.taskIDs?.length === 0) return 0
      const row = yield* readDb
        .select({ count: sql<number>`count(*)` })
        .from(ScheduledTaskRunTable)
        .where(
          and(
            unreadWhere(),
            input?.taskIDs ? inArray(ScheduledTaskRunTable.task_id, input.taskIDs) : undefined,
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row?.count ?? 0
    })

    const acknowledge = Effect.fn("ScheduledTask.acknowledge")(function* (input: {
      runID: ScheduledTaskModel.RunID
      now?: number
    }) {
      const now = input.now ?? Date.now()
      const updated = yield* db
        .update(ScheduledTaskRunTable)
        .set({ acknowledged_at: now })
        .where(and(eq(ScheduledTaskRunTable.id, input.runID), isNull(ScheduledTaskRunTable.acknowledged_at)))
        .returning({ id: ScheduledTaskRunTable.id })
        .get()
        .pipe(Effect.orDie)
      if (updated) return
      const exists = yield* readDb
        .select({ id: ScheduledTaskRunTable.id })
        .from(ScheduledTaskRunTable)
        .where(eq(ScheduledTaskRunTable.id, input.runID))
        .get()
        .pipe(Effect.orDie)
      if (!exists) return yield* new ScheduledTaskSchema.RunNotFoundError({ runID: input.runID })
    })

    const acknowledgeChecked = Effect.fn("ScheduledTask.acknowledgeChecked")(function* (input: {
      taskID: ID
      runID: ScheduledTaskModel.RunID
      expectedRevision: number
      now?: number
    }) {
      const now = input.now ?? Date.now()
      yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const task = yield* requireRow(tx, input.taskID)
              if (task.revision !== input.expectedRevision) {
                return yield* new ScheduledTaskSchema.StaleRevisionError({
                  taskID: input.taskID,
                  expectedRevision: input.expectedRevision,
                  actualRevision: task.revision,
                })
              }
              const run = yield* tx
                .select({ taskID: ScheduledTaskRunTable.task_id })
                .from(ScheduledTaskRunTable)
                .where(eq(ScheduledTaskRunTable.id, input.runID))
                .get()
                .pipe(Effect.orDie)
              if (!run || run.taskID !== input.taskID) {
                return yield* new ScheduledTaskSchema.RunNotFoundError({ runID: input.runID })
              }
              yield* tx
                .update(ScheduledTaskRunTable)
                .set({ acknowledged_at: now })
                .where(
                  and(
                    eq(ScheduledTaskRunTable.id, input.runID),
                    eq(ScheduledTaskRunTable.task_id, input.taskID),
                    isNull(ScheduledTaskRunTable.acknowledged_at),
                  ),
                )
                .run()
                .pipe(Effect.orDie)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    const paused = Effect.fnUntraced(function* () {
      const row = yield* readDb
        .select({ paused: ScheduledTaskControlTable.paused })
        .from(ScheduledTaskControlTable)
        .where(eq(ScheduledTaskControlTable.id, "global"))
        .get()
        .pipe(Effect.orDie)
      return row?.paused ?? false
    })

    const dueRows = Effect.fnUntraced(function* (now: number) {
      return yield* readDb
        .select()
        .from(ScheduledTaskTable)
        .where(
          and(
            eq(ScheduledTaskTable.enabled, true),
            isNotNull(ScheduledTaskTable.next_run_at),
            sql`${ScheduledTaskTable.next_run_at} <= ${now}`,
          ),
        )
        .orderBy(asc(ScheduledTaskTable.next_run_at))
        .all()
        .pipe(Effect.orDie)
    })

    const due = Effect.fn("ScheduledTask.due")(function* (now: number) {
      if (yield* paused()) return []
      const rows = yield* dueRows(now)
      // Jitter changes when the runner wakes, never what fire_for means.
      return rows
        .filter((row) => row.next_run_at! + jitterFor(row.id, row.next_run_at!, row.policy.jitterMs) <= now)
        .map(hydrateInfo)
    })

    const nextDueAt = Effect.fn("ScheduledTask.nextDueAt")(function* (now: number) {
      void now
      if (yield* paused()) return undefined
      const head = yield* readDb
        .select({ value: sql<number | null>`min(${ScheduledTaskTable.next_run_at})` })
        .from(ScheduledTaskTable)
        .where(and(eq(ScheduledTaskTable.enabled, true), isNotNull(ScheduledTaskTable.next_run_at)))
        .get()
        .pipe(Effect.orDie)
      if (head?.value === null || head?.value === undefined) return undefined
      // Only jittered tasks can move an armed timer past the raw minimum.
      const jittered = yield* readDb
        .select({
          id: ScheduledTaskTable.id,
          next_run_at: ScheduledTaskTable.next_run_at,
          policy: ScheduledTaskTable.policy,
        })
        .from(ScheduledTaskTable)
        .where(
          and(
            eq(ScheduledTaskTable.enabled, true),
            isNotNull(ScheduledTaskTable.next_run_at),
            sql`${ScheduledTaskTable.next_run_at} <= ${head.value + ScheduledTaskPolicy.LIMITS.jitterMs}`,
            sql`json_extract(${ScheduledTaskTable.policy}, '$.jitterMs') > 0`,
          ),
        )
        .all()
        .pipe(Effect.orDie)
      let result = head.value
      for (const row of jittered) {
        const effective = row.next_run_at! + jitterFor(row.id, row.next_run_at!, row.policy.jitterMs)
        if (effective < result) result = effective
      }
      return result
    })

    const recordSkip = Effect.fnUntraced(function* (input: {
      taskID: ID
      fireFor: number
      trigger: ScheduledTaskModel.Trigger
      reason: ScheduledTaskModel.SkipReason
      nextRunAt: number | undefined
      disable?: boolean
      now: number
    }) {
      const runID = ScheduledTaskModel.RunID.create()
      const created = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
            const inserted = yield* tx
              .insert(ScheduledTaskRunTable)
              .values({
                id: runID,
                task_id: input.taskID,
                fire_for: input.fireFor,
                trigger: input.trigger,
                status: "skipped",
                skip_reason: input.reason,
                // Skip rows are informational visibility, not inbox noise.
                acknowledged_at: input.now,
                started_at: input.now,
                finished_at: input.now,
              })
              .onConflictDoNothing()
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (!inserted) return undefined
            yield* tx
              .update(ScheduledTaskTable)
              .set({
                next_run_at: input.nextRunAt ?? null,
                ...(input.disable ? { enabled: false } : {}),
                last_run_at: input.now,
                last_run_status: "skipped",
                last_run_id: runID,
                time_updated: input.now,
              })
              .where(and(eq(ScheduledTaskTable.id, input.taskID), eq(ScheduledTaskTable.next_run_at, input.fireFor)))
              .run()
              .pipe(Effect.orDie)
            return inserted
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      if (!created) return
      const task = yield* readDb
        .select()
        .from(ScheduledTaskTable)
        .where(eq(ScheduledTaskTable.id, input.taskID))
        .get()
        .pipe(Effect.orDie)
      yield* events.publish(Event.RunSettled, { taskID: input.taskID, run: hydrateRun(created) })
      if (task) yield* events.publish(Event.Updated, { taskID: input.taskID, info: hydrateInfo(task) })
    })

    const planDue = Effect.fn("ScheduledTask.planDue")(function* (now: number) {
      if (yield* paused()) return []
      const plans: FiringPlan[] = []

      // 1. Queued manual runs are independent of the cursor.
      const queued = yield* readDb
        .select({ run: ScheduledTaskRunTable, task: ScheduledTaskTable })
        .from(ScheduledTaskRunTable)
        .innerJoin(ScheduledTaskTable, eq(ScheduledTaskTable.id, ScheduledTaskRunTable.task_id))
        .where(eq(ScheduledTaskRunTable.status, "queued"))
        .all()
        .pipe(Effect.orDie)
      for (const item of queued) {
        const lease = yield* readDb
          .select()
          .from(ScheduledTaskLeaseTable)
          .where(eq(ScheduledTaskLeaseTable.task_id, item.run.task_id))
          .get()
          .pipe(Effect.orDie)
        if (lease?.owner) {
          // Overrun policy owns the conflict. `queue` leaves it pending;
          // everything else records a visible skip.
          if (item.task.policy.overrun !== "queue") {
            yield* settleQueuedOverrun(item.run, now)
          }
          continue
        }
        plans.push({
          task: hydrateInfo(item.task),
          fireFor: item.run.fire_for,
          trigger: "manual",
          attempt: Math.max(1, item.run.attempt),
          acceptExisting: "queued",
        })
      }

      // 2. Due cursors, including pending-retry and recovered leases.
      const rows = yield* dueRows(now)
      if (rows.length === 0) return plans
      const leases = yield* readDb
        .select()
        .from(ScheduledTaskLeaseTable)
        .where(inArray(ScheduledTaskLeaseTable.task_id, rows.map((row) => row.id)))
        .all()
        .pipe(Effect.orDie)
      const leaseByTask = new Map(leases.map((lease) => [lease.task_id, lease]))
      for (const row of rows) {
        const effective = row.next_run_at! + jitterFor(row.id, row.next_run_at!, row.policy.jitterMs)
        if (effective > now) continue
        const lease = leaseByTask.get(row.id)
        // A held lease means an active run owns this task; settlement will
        // advance the cursor. Never plan a second firing over a live claim.
        if (lease && lease.owner !== null) continue
        const decision = decideDue({
          task: {
            id: row.id,
            schedule: row.schedule,
            timezone: row.timezone ?? undefined,
            policy: row.policy,
            nextRunAt: row.next_run_at!,
          },
          now,
          pendingRetry: lease && lease.owner === null ? { fireFor: lease.fire_for } : undefined,
        })
        if (decision.kind === "fire") {
          plans.push({
            task: hydrateInfo(row),
            fireFor: decision.fireFor,
            trigger: decision.trigger,
            attempt: decision.trigger === "retry" && lease ? lease.attempt : 1,
            acceptExisting: decision.trigger === "retry" ? "retry" : "none",
          })
        } else {
          yield* recordSkip({
            taskID: row.id,
            fireFor: decision.fireFor,
            trigger: decision.trigger,
            reason: decision.reason,
            nextRunAt: decision.nextRunAt,
            disable: row.schedule.kind === "once" && decision.nextRunAt === undefined,
            now,
          })
        }
      }
      return plans
    })

    const settleQueuedOverrun = Effect.fnUntraced(function* (
      run: typeof ScheduledTaskRunTable.$inferSelect,
      now: number,
    ) {
      const settled = yield* db
        .update(ScheduledTaskRunTable)
        .set({
          status: "skipped",
          skip_reason: "overrun",
          acknowledged_at: now,
          finished_at: now,
        })
        .where(and(eq(ScheduledTaskRunTable.id, run.id), eq(ScheduledTaskRunTable.status, "queued")))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (settled) {
        yield* events.publish(Event.RunSettled, { taskID: settled.task_id, run: hydrateRun(settled) })
      }
    })

    const recomputeAll = Effect.fn("ScheduledTask.recomputeAll")(function* (now: number) {
      const rows = yield* readDb
        .select()
        .from(ScheduledTaskTable)
        .where(and(eq(ScheduledTaskTable.enabled, true), isNotNull(ScheduledTaskTable.next_run_at)))
        .all()
        .pipe(Effect.orDie)
      let changed = 0
      for (const row of rows) {
        const next = nextOccurrence({
          schedule: row.schedule,
          timezone: row.timezone ?? undefined,
          after: now,
        })
        if (next === row.next_run_at) continue
        yield* db
          .update(ScheduledTaskTable)
          .set({
            next_run_at: next ?? null,
            ...(next === undefined ? { enabled: false } : {}),
            time_updated: now,
          })
          .where(and(eq(ScheduledTaskTable.id, row.id), eq(ScheduledTaskTable.next_run_at, row.next_run_at!)))
          .run()
          .pipe(Effect.orDie)
        changed++
        const updated = yield* readDb
          .select()
          .from(ScheduledTaskTable)
          .where(eq(ScheduledTaskTable.id, row.id))
          .get()
          .pipe(Effect.orDie)
        if (updated) yield* events.publish(Event.Updated, { taskID: row.id, info: hydrateInfo(updated) })
      }
      return changed
    })

    const recordRunStart = Effect.fn("ScheduledTask.recordRunStart")(function* (input: RunStartInput) {
      const result = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
            const task = yield* requireRow(tx, input.taskID)
            void task
            if (input.acceptExisting !== "none") {
              const expected = input.acceptExisting === "retry" ? "failed" : "queued"
              const accepted = yield* tx
                .update(ScheduledTaskRunTable)
                .set(
                  input.acceptExisting === "retry"
                    ? {
                        status: "running",
                        attempt: input.attempt,
                        started_at: input.now,
                        finished_at: null,
                        session_id: null,
                        workspace_id: null,
                        directory: null,
                        skip_reason: null,
                        error_kind: null,
                        error_message: null,
                      }
                    : {
                        status: "running",
                        attempt: input.attempt,
                        started_at: input.now,
                        finished_at: null,
                        skip_reason: null,
                      },
                )
                .where(
                  and(
                    eq(ScheduledTaskRunTable.task_id, input.taskID),
                    eq(ScheduledTaskRunTable.fire_for, input.fireFor),
                    eq(ScheduledTaskRunTable.status, expected),
                  ),
                )
                .returning()
                .get()
                .pipe(Effect.orDie)
              if (accepted) return { kind: "started" as const, run: accepted }
            }
            const inserted = yield* tx
              .insert(ScheduledTaskRunTable)
              .values({
                id: ScheduledTaskModel.RunID.create(),
                task_id: input.taskID,
                fire_for: input.fireFor,
                trigger: input.trigger,
                status: "running",
                attempt: input.attempt,
                started_at: input.now,
              })
              .onConflictDoNothing()
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (inserted) return { kind: "started" as const, run: inserted }
            const existing = yield* tx
              .select()
              .from(ScheduledTaskRunTable)
              .where(
                and(
                  eq(ScheduledTaskRunTable.task_id, input.taskID),
                  eq(ScheduledTaskRunTable.fire_for, input.fireFor),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            return { kind: "exists" as const, run: existing }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      if (result.kind === "started") {
        yield* events.publish(Event.RunStarted, { taskID: input.taskID, run: hydrateRun(result.run) })
        return { kind: "started" as const, run: hydrateRun(result.run) }
      }
      return { kind: "exists" as const, run: result.run ? hydrateRun(result.run) : undefined }
    })

    const settleRun = Effect.fn("ScheduledTask.settleRun")(function* (input: SettleInput) {
      const outcome = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
            const task = yield* requireRow(tx, input.taskID)
            const run = yield* tx
              .select()
              .from(ScheduledTaskRunTable)
              .where(eq(ScheduledTaskRunTable.id, input.runID))
              .get()
              .pipe(Effect.orDie)
            if (!run) return yield* new ScheduledTaskSchema.RunNotFoundError({ runID: input.runID })
            if (run.attempt !== input.attempt || (run.status !== "running" && run.status !== "waiting")) {
              return yield* new ScheduledTaskSchema.RunAttemptConflictError({
                runID: input.runID,
                expectedAttempt: input.attempt,
                actualAttempt: run.attempt,
                status: run.status,
              })
            }
            const policy = task.policy

            // Bounded retry: same logical instant, updated row, cursor moved to
            // the backoff instant so the timer wakes for it. Must land before
            // the next scheduled instant or it is abandoned (03 § 6).
            let retryAt: number | undefined
            if (
              input.status === "failed" &&
              task.enabled &&
              task.schedule.kind !== "once" &&
              isRetryable(input.errorKind) &&
              input.attempt < retryableAttempts(policy)
            ) {
              const nextSchedule = nextOccurrence({
                schedule: task.schedule,
                timezone: task.timezone ?? undefined,
                after: input.fireFor,
              })
              const candidate = input.now + retryBackoffMs(input.attempt)
              if (nextSchedule !== undefined && candidate < nextSchedule) retryAt = candidate
            }

            if (retryAt !== undefined) {
              yield* tx
                .update(ScheduledTaskRunTable)
                .set({
                  status: "failed",
                  finished_at: input.now,
                  error_kind: input.errorKind ?? "internal",
                  error_message: input.errorMessage ?? null,
                  attempt: input.attempt,
                })
                .where(eq(ScheduledTaskRunTable.id, input.runID))
                .run()
                .pipe(Effect.orDie)
              yield* tx
                .update(ScheduledTaskLeaseTable)
                .set({ owner: null, attempt: sql`${ScheduledTaskLeaseTable.attempt} + 1`, heartbeat_at: input.now })
                .where(
                  input.leaseID
                    ? eq(ScheduledTaskLeaseTable.lease_id, input.leaseID)
                    : eq(ScheduledTaskLeaseTable.task_id, input.taskID),
                )
                .run()
                .pipe(Effect.orDie)
              // The pending retry must survive as an unowned lease carrying the
              // logical instant, even if settlement runs without a live claim
              // (defensive: a recovered/orphaned retry still lands on the same
              // run row because fire_for is preserved).
              yield* tx
                .insert(ScheduledTaskLeaseTable)
                .values({
                  task_id: input.taskID,
                  fire_for: input.fireFor,
                  lease_id: crypto.randomUUID(),
                  owner: null,
                  acquired_at: input.now,
                  heartbeat_at: input.now,
                  attempt: input.attempt + 1,
                })
                .onConflictDoNothing()
                .run()
                .pipe(Effect.orDie)
              yield* tx
                .update(ScheduledTaskTable)
                .set({
                  next_run_at: retryAt,
                  last_run_at: input.now,
                  last_run_status: "failed",
                  last_run_id: input.runID,
                  time_updated: input.now,
                })
                .where(eq(ScheduledTaskTable.id, input.taskID))
                .run()
                .pipe(Effect.orDie)
              const updated = yield* tx
                .select()
                .from(ScheduledTaskRunTable)
                .where(eq(ScheduledTaskRunTable.id, input.runID))
                .get()
                .pipe(Effect.orDie)
              return { run: updated!, retryAt }
            }

            let next: number | null
            if (input.nextRunAt !== undefined) next = input.nextRunAt
            else if (input.collapseAfterNow) {
              next = nextOccurrence({
                schedule: task.schedule,
                timezone: task.timezone ?? undefined,
                after: input.now,
              }) ?? null
            } else {
              next = nextOccurrence({
                schedule: task.schedule,
                timezone: task.timezone ?? undefined,
                after: input.fireFor,
              }) ?? null
            }
            const exhaustedOnce = task.schedule.kind === "once"
            if (exhaustedOnce) next = null
            // A task disabled while a run was in flight completes, settles,
            // and must not arm a future instant (fixture E12).
            if (!task.enabled) next = null

            const counts = input.status === "failed" && countsTowardCircuitBreaker(input.errorKind)
            const failures =
              input.status === "succeeded" || input.status === "skipped"
                ? 0
                : counts
                  ? task.consecutive_failures + 1
                  : task.consecutive_failures
            const circuitBroken = counts && failures >= CIRCUIT_BREAKER_THRESHOLD
            if (circuitBroken) next = null

            yield* tx
              .update(ScheduledTaskRunTable)
              .set({
                status: input.status,
                finished_at: input.now,
                session_id: input.sessionID ?? run.session_id,
                workspace_id: input.workspaceID ?? run.workspace_id,
                directory: input.directory ?? run.directory,
                skip_reason: input.skipReason ?? null,
                error_kind: input.errorKind ?? null,
                error_message: input.errorMessage ?? null,
                attempt: input.attempt,
                acknowledged_at:
                  input.status === "failed" ? run.acknowledged_at : (run.acknowledged_at ?? input.now),
              })
              .where(eq(ScheduledTaskRunTable.id, input.runID))
              .run()
              .pipe(Effect.orDie)
            yield* tx
              .update(ScheduledTaskTable)
              .set({
                next_run_at: next,
                enabled: circuitBroken || exhaustedOnce ? false : task.enabled,
                last_run_at: input.now,
                last_run_status: input.status,
                last_run_id: input.runID,
                consecutive_failures: failures,
                time_updated: input.now,
              })
              .where(eq(ScheduledTaskTable.id, input.taskID))
              .run()
              .pipe(Effect.orDie)
            yield* tx
              .delete(ScheduledTaskLeaseTable)
              .where(
                input.leaseID
                  ? eq(ScheduledTaskLeaseTable.lease_id, input.leaseID)
                  : eq(ScheduledTaskLeaseTable.task_id, input.taskID),
              )
              .run()
              .pipe(Effect.orDie)
            yield* tx.run(sql`
              DELETE FROM ${ScheduledTaskRunTable}
              WHERE ${ScheduledTaskRunTable.task_id} = ${input.taskID}
                AND ${ScheduledTaskRunTable.acknowledged_at} IS NOT NULL
                AND ${ScheduledTaskRunTable.id} NOT IN (
                  SELECT ${ScheduledTaskRunTable.id} FROM ${ScheduledTaskRunTable}
                  WHERE ${ScheduledTaskRunTable.task_id} = ${input.taskID}
                  ORDER BY ${ScheduledTaskRunTable.started_at} DESC, ${ScheduledTaskRunTable.id} DESC
                  LIMIT ${policy.retentionRuns}
                )
            `).pipe(Effect.orDie)
            const updated = yield* tx
              .select()
              .from(ScheduledTaskRunTable)
              .where(eq(ScheduledTaskRunTable.id, input.runID))
              .get()
              .pipe(Effect.orDie)
            return { run: updated! }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))

      const task = yield* readDb
        .select()
        .from(ScheduledTaskTable)
        .where(eq(ScheduledTaskTable.id, input.taskID))
        .get()
        .pipe(Effect.orDie)
      const settled = hydrateRun(outcome.run)
      yield* events.publish(Event.RunSettled, { taskID: input.taskID, run: settled })
      if (task) yield* events.publish(Event.Updated, { taskID: input.taskID, info: hydrateInfo(task) })
      return { run: settled, ...(outcome.retryAt !== undefined ? { retryAt: outcome.retryAt } : {}) }
    })

    const skipSettled = Effect.fn("ScheduledTask.skipSettled")(function* (input: {
      taskID: ID
      fireFor: number
      now: number
      nextRunAt?: number
    }) {
      const changed = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
            const task = yield* requireRow(tx, input.taskID)
            yield* tx
              .delete(ScheduledTaskLeaseTable)
              .where(eq(ScheduledTaskLeaseTable.task_id, input.taskID))
              .run()
              .pipe(Effect.orDie)
            const next =
              input.nextRunAt !== undefined
                ? input.nextRunAt
                : nextOccurrence({
                    schedule: task.schedule,
                    timezone: task.timezone ?? undefined,
                    after: input.fireFor,
                  }) ?? null
            const exhaustedOnce = task.schedule.kind === "once"
            yield* tx
              .update(ScheduledTaskTable)
              .set({
                next_run_at: next,
                enabled: exhaustedOnce ? false : task.enabled,
                time_updated: input.now,
              })
              .where(and(eq(ScheduledTaskTable.id, input.taskID), eq(ScheduledTaskTable.next_run_at, input.fireFor)))
              .run()
              .pipe(Effect.orDie)
            return yield* tx
              .select()
              .from(ScheduledTaskTable)
              .where(eq(ScheduledTaskTable.id, input.taskID))
              .get()
              .pipe(Effect.orDie)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      if (changed) yield* events.publish(Event.Updated, { taskID: input.taskID, info: hydrateInfo(changed) })
    })

    const skipSettledSafe = Effect.fnUntraced(function* (input: {
      taskID: ID
      fireFor: number
      now: number
      nextRunAt?: number
    }) {
      yield* skipSettled(input).pipe(Effect.catchTag("ScheduledTask.NotFoundError", () => Effect.void))
    })

    const markRunStatus = Effect.fn("ScheduledTask.markRunStatus")(function* (input: {
      runID: ScheduledTaskModel.RunID
      attempt: number
      status: "running" | "waiting"
      now: number
    }) {
      const updated = yield* db
        .update(ScheduledTaskRunTable)
        .set({ status: input.status })
        .where(
          and(
            eq(ScheduledTaskRunTable.id, input.runID),
            eq(ScheduledTaskRunTable.attempt, input.attempt),
            inArray(ScheduledTaskRunTable.status, ["running", "waiting"]),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!updated) return false
      yield* events.publish(Event.RunUpdated, { taskID: updated.task_id, run: hydrateRun(updated) })
      return true
    })

    const attachRunSession = Effect.fn("ScheduledTask.attachRunSession")(function* (input: {
      runID: ScheduledTaskModel.RunID
      attempt: number
      sessionID: NonNullable<ScheduledTaskModel.Run["sessionID"]>
      directory: string
    }) {
      const updated = yield* db
        .update(ScheduledTaskRunTable)
        .set({ session_id: input.sessionID, directory: input.directory })
        .where(
          and(
            eq(ScheduledTaskRunTable.id, input.runID),
            eq(ScheduledTaskRunTable.attempt, input.attempt),
            inArray(ScheduledTaskRunTable.status, ["running", "waiting"]),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!updated) return false
      yield* events.publish(Event.RunUpdated, { taskID: updated.task_id, run: hydrateRun(updated) })
      return true
    })

    const attachRunGoal = Effect.fn("ScheduledTask.attachRunGoal")(function* (input: {
      runID: ScheduledTaskModel.RunID
      attempt: number
      goalID: NonNullable<ScheduledTaskModel.Run["goalID"]>
    }) {
      const updated = yield* db
        .update(ScheduledTaskRunTable)
        .set({ goal_id: input.goalID })
        .where(
          and(
            eq(ScheduledTaskRunTable.id, input.runID),
            eq(ScheduledTaskRunTable.attempt, input.attempt),
            inArray(ScheduledTaskRunTable.status, ["running", "waiting"]),
            sql`(${ScheduledTaskRunTable.goal_id} IS NULL OR ${ScheduledTaskRunTable.goal_id} = ${input.goalID})`,
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!updated) return false
      yield* events.publish(Event.RunUpdated, { taskID: updated.task_id, run: hydrateRun(updated) })
      return true
    })

    const runGoal = Effect.fn("ScheduledTask.runGoal")(function* (runID: ScheduledTaskModel.RunID) {
      const row = yield* readDb
        .select({ goalID: ScheduledTaskRunTable.goal_id })
        .from(ScheduledTaskRunTable)
        .where(eq(ScheduledTaskRunTable.id, runID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new ScheduledTaskSchema.RunNotFoundError({ runID })
      return row.goalID ?? undefined
    })

    const goalOwner = Effect.fn("ScheduledTask.goalOwner")(function* (
      goalID: NonNullable<ScheduledTaskModel.Run["goalID"]>,
    ) {
      const row = yield* readDb
        .select({ runID: ScheduledTaskRunTable.id, taskID: ScheduledTaskRunTable.task_id })
        .from(ScheduledTaskRunTable)
        .where(eq(ScheduledTaskRunTable.goal_id, goalID))
        .get()
        .pipe(Effect.orDie)
      return row
    })

    const authorizeRunSession = Effect.fn("ScheduledTask.authorizeRunSession")((input: RunSessionAuthorizationInput) =>
      authorizeRunSessionIn(readDb, input),
    )

    const enqueueManualRun = Effect.fn("ScheduledTask.enqueueManualRun")(function* (input: {
      taskID: ID
      now: number
      expectedRevision?: number
    }) {
      const runID = ScheduledTaskModel.RunID.create()
      const row = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const current = yield* requireRow(tx, input.taskID)
              if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
                return yield* new ScheduledTaskSchema.StaleRevisionError({
                  taskID: input.taskID,
                  expectedRevision: input.expectedRevision,
                  actualRevision: current.revision,
                })
              }
              const created = yield* tx
                .insert(ScheduledTaskRunTable)
                .values({
                  id: runID,
                  task_id: input.taskID,
                  fire_for: input.now,
                  trigger: "manual",
                  status: "queued",
                  started_at: input.now,
                })
                .onConflictDoNothing()
                .returning()
                .get()
                .pipe(Effect.orDie)
              if (created) return created
              return yield* tx
                .select()
                .from(ScheduledTaskRunTable)
                .where(
                  and(eq(ScheduledTaskRunTable.task_id, input.taskID), eq(ScheduledTaskRunTable.fire_for, input.now)),
                )
                .get()
                .pipe(Effect.orDie)
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
      if (!row) return yield* new ScheduledTaskSchema.NotFoundError({ taskID: input.taskID })
      yield* events.publish(Event.RunUpdated, { taskID: input.taskID, run: hydrateRun(row) })
      return hydrateRun(row)
    })

    const generation = Effect.fn("ScheduledTask.generation")(function* () {
      const row = yield* readDb
        .select({ generation: ScheduledTaskControlTable.generation })
        .from(ScheduledTaskControlTable)
        .where(eq(ScheduledTaskControlTable.id, "global"))
        .get()
        .pipe(Effect.orDie)
      return row?.generation ?? 0
    })

    const control = Effect.fn("ScheduledTask.control")(function* () {
      const row = yield* readDb
        .select()
        .from(ScheduledTaskControlTable)
        .where(eq(ScheduledTaskControlTable.id, "global"))
        .get()
        .pipe(Effect.orDie)
      return row
        ? { paused: row.paused, timeUpdated: DateTime.makeUnsafe(row.time_updated) }
        : { paused: false, timeUpdated: DateTime.makeUnsafe(0) }
    })

    const setPaused = Effect.fn("ScheduledTask.setPaused")(function* (input: {
      paused: boolean
      now?: number
    }) {
      const now = input.now ?? Date.now()
      yield* db
        .insert(ScheduledTaskControlTable)
        .values({ id: "global", paused: input.paused, time_updated: now })
        .onConflictDoUpdate({
          target: ScheduledTaskControlTable.id,
          set: { paused: input.paused, time_updated: now },
        })
        .run()
        .pipe(Effect.orDie)
      const next = { paused: input.paused, timeUpdated: DateTime.makeUnsafe(now) }
      yield* events.publish(Event.ControlChanged, { control: next })
      return next
    })

    return Service.of({
      create,
      get,
      findByName,
      list,
      agenda,
      update,
      remove,
      removeChecked,
      setEnabled,
      listRuns,
      inbox,
      unreadCount,
      acknowledge,
      acknowledgeChecked,
      due,
      nextDueAt,
      planDue,
      recomputeAll,
      recordRunStart,
      settleRun,
      skipSettled: skipSettledSafe,
      markRunStatus,
      attachRunSession,
      attachRunGoal,
      runGoal,
      goalOwner,
      authorizeRunSession,
      enqueueManualRun,
      generation,
      control,
      setPaused,
    })
  }),
)

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

function hydrateInfo(row: typeof ScheduledTaskTable.$inferSelect): Info {
  return {
    id: row.id,
    projectID: row.project_id ?? undefined,
    targetDirectory: row.target_directory,
    target: row.target,
    sessionPolicy: row.session_policy,
    name: row.name,
    enabled: row.enabled,
    revision: row.revision,
    schedule: row.schedule,
    timezone: row.timezone ?? undefined,
    action: row.action,
    policy: row.policy,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    lastRunStatus: row.last_run_status ?? undefined,
    lastRunID: row.last_run_id ?? undefined,
    consecutiveFailures: row.consecutive_failures,
    source: row.source,
    sourcePath: row.source_path ?? undefined,
    sourceMessageID: row.source_message_id ?? undefined,
    sourceRef: row.source_ref ?? undefined,
    sourcePrincipal: row.source_principal ?? undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
    },
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

type Normalized<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }

function normalizeDirectory(input: string): Normalized<string> {
  const value = input.trim()
  if (!value) return { ok: false, reason: "targetDirectory is required" }
  const normalized = value.replaceAll("\\", "/")
  const absolute = normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
  // Missing location is toxic: a schedule without an explicit absolute
  // directory must be rejected, never resolved against process.cwd().
  if (!absolute) return { ok: false, reason: `targetDirectory must be an absolute path: ${input}` }
  return { ok: true, value }
}

function validateScheduleChecked(
  schedule: ScheduledTaskModel.Schedule,
  now: number,
  timezone: string | undefined,
): Normalized<true> {
  const result = validateSchedule(schedule, { now, timezone })
  return result.ok ? { ok: true, value: true } : { ok: false, reason: result.reason }
}

function validateAction(action: ScheduledTaskModel.Action): Normalized<true> {
  if (!action.prompt.trim()) return { ok: false, reason: "action.prompt is required" }
  if (action.goal) {
    if (!action.goal.title.trim()) return { ok: false, reason: "goal title is required" }
    if (!action.goal.objective.trim()) return { ok: false, reason: "goal objective is required" }
  }
  return { ok: true, value: true }
}

function validateSessionPolicyTarget(
  sessionPolicy: ScheduledTaskModel.SessionPolicy,
  target: ScheduledTaskModel.Target,
): Normalized<true> {
  if ((sessionPolicy.kind === "reuse" || sessionPolicy.kind === "auto") && target.kind === "worktree" && !target.reuse) {
    return {
      ok: false,
      reason: `sessionPolicy=${sessionPolicy.kind} requires a stable execution directory; worktree.reuse must be true`,
    }
  }
  if (sessionPolicy.kind === "existing" && target.kind !== "directory") {
    return {
      ok: false,
      reason: "sessionPolicy=existing derives execution location from the selected Session and requires target.kind=directory",
    }
  }
  return { ok: true, value: true }
}

function sameTarget(left: ScheduledTaskModel.Target, right: ScheduledTaskModel.Target) {
  if (left.kind !== right.kind) return false
  if (left.kind === "directory" || right.kind === "directory") return true
  return left.reuse === right.reuse && left.baseRef === right.baseRef
}

function sameSessionPolicy(left: ScheduledTaskModel.SessionPolicy, right: ScheduledTaskModel.SessionPolicy) {
  if (left.kind !== right.kind) return false
  if (left.kind !== "existing" || right.kind !== "existing") return true
  return left.sessionID === right.sessionID
}

function nameWhere(projectID: typeof ProjectTable.$inferSelect.id | null | undefined, name: string) {
  return projectID
    ? and(eq(ScheduledTaskTable.project_id, projectID), eq(ScheduledTaskTable.name, name))
    : and(isNull(ScheduledTaskTable.project_id), eq(ScheduledTaskTable.name, name))
}

function unreadWhere() {
  return and(
    isNull(ScheduledTaskRunTable.acknowledged_at),
    inArray(ScheduledTaskRunTable.status, ["failed", "waiting"]),
  )
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node] })
