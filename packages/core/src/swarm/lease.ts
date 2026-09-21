import { and, asc, desc, eq, inArray, lt, lte, ne, or, sql } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { EventV2 } from "../event"
import { SessionInputTable } from "../session/sql"
import { isTaskTerminal, semanticRetryConsumesBudget } from "./state-machine"
import {
  hydrateLease,
  hydrateTask,
  hydrateTaskRun,
} from "./projection"
import {
  type Db,
  requireLeaseRow,
  requireMemberRow,
  requireTaskRow,
  requireTaskRunRow,
} from "./repository"
import { SwarmSchema } from "./schema"
import {
  SwarmMemberTable,
  SwarmTaskLeaseTable,
  SwarmTaskRunTable,
  SwarmTaskTable,
} from "./sql"
import { commitFail, publishWithCommit } from "./transaction"

export interface LeaseToken {
  readonly swarmID: Swarm.ID
  readonly taskID: Swarm.TaskID
  readonly generation: number
  readonly memberID: Swarm.MemberID
  readonly sessionID: Swarm.TaskLease["ownerSessionID"]
  readonly bindingGeneration: number
  readonly processOwner: string
}

export interface ClaimTaskInput {
  readonly swarmID: Swarm.ID
  readonly taskID: Swarm.TaskID
  readonly memberID: Swarm.MemberID
  readonly processOwner: string
  readonly leaseMs: number
  readonly now?: number
}

export interface RenewTaskLeaseInput {
  readonly token: LeaseToken
  readonly leaseMs: number
  readonly now?: number
}

export interface HoldTaskInput {
  readonly token: LeaseToken
  readonly userSeq: number
  readonly deadline: number
  readonly now?: number
}

export type RetirementReason =
  | "human_focus"
  | "lease_expired"
  | "lease_owner_lost"
  | "member_rebind"
  | "operator_release"
  | "member_stop"
  | "swarm_freeze"
  | "recovery"

export interface RequestTaskRetirementInput {
  readonly token: LeaseToken
  readonly reason: RetirementReason
  readonly now?: number
}

export interface TaskRunHistoryCursor {
  readonly createdAt: number
  readonly id: Swarm.TaskRunID
}

export interface TaskRunHistoryPage {
  readonly items: ReadonlyArray<Swarm.TaskRun>
  readonly more: boolean
  readonly next?: TaskRunHistoryCursor
}

export interface RecordTaskRunInput {
  readonly token: LeaseToken
  readonly id?: Swarm.TaskRunID
  readonly sessionInputID: SessionMessage.ID
  readonly admittedAt?: number
  readonly now?: number
}

export interface CommitTaskRunAdmissionInput {
  readonly token: LeaseToken
  readonly id: Swarm.TaskRunID
  readonly sessionInputID: SessionMessage.ID
  readonly admittedAt: number
}

export interface StartTaskRunInput {
  readonly token: LeaseToken
  readonly runID: Swarm.TaskRunID
  readonly now?: number
}

export type TaskSettlement =
  | { readonly type: "completed" }
  | {
      readonly type: "failed"
      readonly failureKind: Swarm.TaskFailureKind
      readonly detail?: string
    }
  | { readonly type: "cancelled"; readonly detail?: string }
  | { readonly type: "superseded"; readonly detail?: string }

export interface SettleTaskInput {
  readonly token: LeaseToken
  readonly runID?: Swarm.TaskRunID
  readonly settlement: TaskSettlement
  readonly now?: number
}

function validDuration(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

function sameTokenRow(row: typeof SwarmTaskLeaseTable.$inferSelect, token: LeaseToken) {
  return (
    row.task_id === token.taskID &&
    row.generation === token.generation &&
    row.owner_member_id === token.memberID &&
    row.owner_session_id === token.sessionID &&
    row.owner_binding_generation === token.bindingGeneration &&
    row.lease_owner_process === token.processOwner
  )
}

function staleLease(id: Swarm.TaskID, expected: number, actual: number) {
  return new SwarmSchema.StaleFenceError({
    fence: "task_lease",
    id,
    expectedGeneration: expected,
    actualGeneration: actual,
  })
}

/**
 * Phase-2 Session commit-hook projection for assignment admission.
 *
 * This must run from the durable Session SyntheticAdmitted EventV2 transaction.
 * It intentionally does not publish a second Swarm aggregate event: the Session
 * admission event is the durable cause, while this normalized row is the exact
 * crash-recovery correlation proving that the assignment input committed.
 */
export const commitTaskRunAdmission = Effect.fn("Swarm.commitTaskRunAdmission")(function* (
  database: Db,
  request: CommitTaskRunAdmissionInput,
) {
  const [taskRow, leaseRow] = yield* Effect.all([
    requireTaskRow(database, request.token.swarmID, request.token.taskID),
    requireLeaseRow(database, request.token.taskID),
  ])
  if (!sameTokenRow(leaseRow, request.token))
    return yield* staleLease(request.token.taskID, request.token.generation, leaseRow.generation)
  if (taskRow.status !== "working")
    return yield* new SwarmSchema.InvalidTransitionError({
      entity: "task",
      id: request.token.taskID,
      from: taskRow.status,
      to: "task_run",
    })
  if (leaseRow.state === "retiring")
    return yield* new SwarmSchema.ConflictError({
      code: "swarm.lease_retiring",
      reason: `Task ${request.token.taskID} is retiring and cannot admit more work.`,
    })
  yield* requireRunnableBinding(database, request.token)

  const admitted = yield* database
    .select({
      sessionID: SessionInputTable.session_id,
      kind: SessionInputTable.kind,
      admissionClass: SessionInputTable.admission_class,
    })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.id, request.sessionInputID))
    .get()
    .pipe(Effect.orDie)
  if (
    !admitted ||
    admitted.sessionID !== request.token.sessionID ||
    admitted.kind !== "synthetic" ||
    admitted.admissionClass !== "host"
  )
    return yield* new SwarmSchema.ConflictError({
      code: "swarm.task_input_not_admitted",
      reason: `Session input ${request.sessionInputID} is not the admitted host assignment for ${request.token.sessionID}.`,
    })

  const byInput = yield* database
    .select()
    .from(SwarmTaskRunTable)
    .where(eq(SwarmTaskRunTable.session_input_id, request.sessionInputID))
    .get()
    .pipe(Effect.orDie)
  if (byInput) {
    if (byInput.id === request.id) return hydrateTaskRun(byInput)
    return yield* new SwarmSchema.ConflictError({
      code: "swarm.task_input_exists",
      reason: `Session input ${request.sessionInputID} is already bound to another task run.`,
    })
  }
  const byID = yield* database
    .select()
    .from(SwarmTaskRunTable)
    .where(eq(SwarmTaskRunTable.id, request.id))
    .get()
    .pipe(Effect.orDie)
  if (byID)
    return yield* new SwarmSchema.ConflictError({
      code: "swarm.task_run_id_exists",
      reason: `Task run already exists: ${request.id}.`,
    })

  const row = {
    id: request.id,
    task_id: request.token.taskID,
    member_id: request.token.memberID,
    session_id: request.token.sessionID,
    binding_generation: request.token.bindingGeneration,
    lease_generation: request.token.generation,
    session_input_id: request.sessionInputID,
    status: "admitted" as const,
    admitted_at: request.admittedAt,
    time_created: request.admittedAt,
  }
  yield* database.insert(SwarmTaskRunTable).values(row).run().pipe(Effect.orDie)
  return hydrateTaskRun({
    ...row,
    failure_kind: null,
    failure_detail: null,
    started_at: null,
    ended_at: null,
  })
})

const requireRunnableBinding = Effect.fnUntraced(function* (
  database: Db,
  token: LeaseToken,
) {
  const member = yield* database
    .select({
      lifecycle: SwarmMemberTable.lifecycle,
      sessionID: SwarmMemberTable.session_id,
      generation: SwarmMemberTable.binding_generation,
    })
    .from(SwarmMemberTable)
    .where(
      and(
        eq(SwarmMemberTable.id, token.memberID),
        eq(SwarmMemberTable.swarm_id, token.swarmID),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!member)
    return yield* new SwarmSchema.NotFoundError({ entity: "member", id: token.memberID })
  if (
    member.lifecycle !== "active" ||
    member.sessionID !== token.sessionID ||
    member.generation !== token.bindingGeneration
  )
    return yield* new SwarmSchema.StaleFenceError({
      fence: "member_binding",
      id: token.memberID,
      expectedGeneration: token.bindingGeneration,
      actualGeneration: member.generation,
    })
  return member
})

/**
 * A terminal prerequisite can only make scheduler-owned dependents more ready;
 * it can never make them less ready. Promote every directly affected task whose
 * full prerequisite set is now satisfied in one set-oriented statement. This
 * runs inside the prerequisite settlement transaction, so there is no crash
 * window where durable settlement and the readiness projection disagree.
 *
 * Readiness is a deterministic projection of task/dependency history, not a
 * second authority. The settlement EventV2 record is therefore the durable
 * cause; this write only advances the normalized current-state projection.
 */
const promoteSatisfiedDependents = Effect.fnUntraced(function* (
  database: Db,
  input: { readonly swarmID: Swarm.ID; readonly prerequisiteTaskID: Swarm.TaskID; readonly now: number },
) {
  yield* database
    .run(sql`
      UPDATE swarm_task
      SET
        status = 'ready',
        ready_at = COALESCE(ready_at, ${input.now}),
        time_updated = ${input.now}
      WHERE swarm_id = ${input.swarmID}
        AND status IN ('pending', 'blocked')
        AND EXISTS (
          SELECT 1
          FROM swarm_task_dependency AS direct_dependency
          WHERE direct_dependency.task_id = swarm_task.id
            AND direct_dependency.depends_on_task_id = ${input.prerequisiteTaskID}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM swarm_task_dependency AS dependency
          INNER JOIN swarm_task AS prerequisite
            ON prerequisite.id = dependency.depends_on_task_id
          WHERE dependency.task_id = swarm_task.id
            AND (
              (dependency.requirement = 'require_success' AND prerequisite.status != 'completed')
              OR
              (dependency.requirement = 'require_terminal' AND prerequisite.status NOT IN ('completed', 'failed', 'cancelled'))
            )
        )
    `)
    .pipe(Effect.orDie)
})

export function makeLeaseOperations(input: {
  readonly db: Db
  readonly readDb: Db
  readonly events: EventV2.Interface
}) {
  const { db, readDb, events } = input

  const claimTask = Effect.fn("Swarm.claimTask")(function* (request: ClaimTaskInput) {
    const leaseMs = validDuration(request.leaseMs)
    if (!leaseMs)
      return yield* new SwarmSchema.ValidationError({ reason: "leaseMs must be a positive finite duration." })
    const processOwner = request.processOwner.trim()
    if (!processOwner)
      return yield* new SwarmSchema.ValidationError({ reason: "processOwner is required." })

    const [taskRow, memberRow] = yield* Effect.all([
      requireTaskRow(readDb, request.swarmID, request.taskID),
      requireMemberRow(readDb, request.swarmID, request.memberID),
    ])
    if (taskRow.status !== "ready")
      return yield* new SwarmSchema.InvalidTransitionError({
        entity: "task",
        id: request.taskID,
        from: taskRow.status,
        to: "working",
      })
    if (memberRow.lifecycle !== "active" || !memberRow.session_id)
      return yield* new SwarmSchema.ValidationError({
        reason: `Member ${request.memberID} must be active and Session-bound before claiming work.`,
      })
    const ownerSessionID = memberRow.session_id

    const now = request.now ?? Date.now()
    const generation = taskRow.lease_generation + 1
    const task = hydrateTask({
      ...taskRow,
      status: "working",
      lease_generation: generation,
      ready_at: null,
      time_updated: now,
    })
    const lease = Swarm.TaskLease.make({
      taskID: request.taskID,
      generation,
      ownerMemberID: request.memberID,
      ownerSessionID,
      ownerBindingGeneration: memberRow.binding_generation,
      leaseOwnerProcess: processOwner,
      state: "active",
      acquiredAt: DateTime.makeUnsafe(now),
      expiresAt: DateTime.makeUnsafe(now + leaseMs),
    })

    yield* publishWithCommit(
      events,
      Swarm.Event.TaskLeaseUpdated,
      { swarmID: request.swarmID, task, lease },
      () =>
        Effect.gen(function* () {
          const member = yield* db
            .select({
              lifecycle: SwarmMemberTable.lifecycle,
              sessionID: SwarmMemberTable.session_id,
              generation: SwarmMemberTable.binding_generation,
            })
            .from(SwarmMemberTable)
            .where(
              and(
                eq(SwarmMemberTable.id, request.memberID),
                eq(SwarmMemberTable.swarm_id, request.swarmID),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (
            !member ||
            member.lifecycle !== "active" ||
            member.sessionID !== ownerSessionID ||
            member.generation !== memberRow.binding_generation
          )
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.member_changed",
                reason: `Member ${request.memberID} changed while task ${request.taskID} was being claimed.`,
              }),
            )

          const occupied = yield* db
            .select({ taskID: SwarmTaskLeaseTable.task_id })
            .from(SwarmTaskLeaseTable)
            .where(
              or(
                eq(SwarmTaskLeaseTable.owner_member_id, request.memberID),
                eq(SwarmTaskLeaseTable.owner_session_id, ownerSessionID),
              ),
            )
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (occupied)
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.member_busy",
                reason: `Member ${request.memberID} / Session ${ownerSessionID} already owns task ${occupied.taskID}.`,
              }),
            )

          const existingLease = yield* db
            .select({ generation: SwarmTaskLeaseTable.generation })
            .from(SwarmTaskLeaseTable)
            .where(eq(SwarmTaskLeaseTable.task_id, request.taskID))
            .get()
            .pipe(Effect.orDie)
          if (existingLease)
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.task_already_leased",
                reason: `Task ${request.taskID} already has an authoritative lease.`,
              }),
            )

          const claimed = yield* db
            .update(SwarmTaskTable)
            .set({
              status: "working",
              lease_generation: generation,
              ready_at: null,
              time_updated: now,
            })
            .where(
              and(
                eq(SwarmTaskTable.id, request.taskID),
                eq(SwarmTaskTable.swarm_id, request.swarmID),
                eq(SwarmTaskTable.status, "ready"),
                eq(SwarmTaskTable.lease_generation, taskRow.lease_generation),
              ),
            )
            .returning({ id: SwarmTaskTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!claimed)
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.task_claim_raced",
                reason: `Task ${request.taskID} changed while being claimed.`,
              }),
            )
          yield* db
            .insert(SwarmTaskLeaseTable)
            .values({
              task_id: request.taskID,
              generation,
              owner_member_id: request.memberID,
              owner_session_id: ownerSessionID,
              owner_binding_generation: memberRow.binding_generation,
              lease_owner_process: processOwner,
              state: "active",
              acquired_at: now,
              expires_at: now + leaseMs,
            })
            .run()
            .pipe(Effect.orDie)
        }),
    )

    const token: LeaseToken = {
      swarmID: request.swarmID,
      taskID: request.taskID,
      generation,
      memberID: request.memberID,
      sessionID: ownerSessionID,
      bindingGeneration: memberRow.binding_generation,
      processOwner,
    }
    return { task, lease, token }
  })

  const renewTaskLease = Effect.fn("Swarm.renewTaskLease")(function* (request: RenewTaskLeaseInput) {
    const leaseMs = validDuration(request.leaseMs)
    if (!leaseMs)
      return yield* new SwarmSchema.ValidationError({ reason: "leaseMs must be a positive finite duration." })
    const [taskRow, leaseRow] = yield* Effect.all([
      requireTaskRow(readDb, request.token.swarmID, request.token.taskID),
      requireLeaseRow(readDb, request.token.taskID),
    ])
    if (!sameTokenRow(leaseRow, request.token))
      return yield* staleLease(request.token.taskID, request.token.generation, leaseRow.generation)
    if (leaseRow.state !== "retiring") yield* requireRunnableBinding(readDb, request.token)
    const now = request.now ?? Date.now()
    const lease = hydrateLease({
      ...leaseRow,
      expires_at: now + leaseMs,
      renewed_at: now,
    })
    const task = hydrateTask(taskRow)
    yield* publishWithCommit(
      events,
      Swarm.Event.TaskLeaseUpdated,
      { swarmID: request.token.swarmID, task, lease },
      () =>
        Effect.gen(function* () {
          const current = yield* db
            .select()
            .from(SwarmTaskLeaseTable)
            .where(eq(SwarmTaskLeaseTable.task_id, request.token.taskID))
            .get()
            .pipe(Effect.orDie)
          if (!current)
            return yield* commitFail(
              new SwarmSchema.NotFoundError({ entity: "task", id: request.token.taskID }),
            )
          if (!sameTokenRow(current, request.token))
            return yield* commitFail(staleLease(request.token.taskID, request.token.generation, current.generation))
          if (current.state !== "retiring")
            yield* requireRunnableBinding(db, request.token).pipe(Effect.catch((error) => commitFail(error)))
          const updated = yield* db
            .update(SwarmTaskLeaseTable)
            .set({ expires_at: now + leaseMs, renewed_at: now })
            .where(
              and(
                eq(SwarmTaskLeaseTable.task_id, request.token.taskID),
                eq(SwarmTaskLeaseTable.generation, request.token.generation),
                eq(SwarmTaskLeaseTable.owner_member_id, request.token.memberID),
                eq(SwarmTaskLeaseTable.owner_session_id, request.token.sessionID),
                eq(SwarmTaskLeaseTable.owner_binding_generation, request.token.bindingGeneration),
                eq(SwarmTaskLeaseTable.lease_owner_process, request.token.processOwner),
              ),
            )
            .returning({ id: SwarmTaskLeaseTable.task_id })
            .get()
            .pipe(Effect.orDie)
          if (!updated)
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.lease_changed",
                reason: `Task lease ${request.token.taskID} changed during renewal.`,
              }),
            )
        }),
    )
    return lease
  })

  const holdTask = Effect.fn("Swarm.holdTask")(function* (request: HoldTaskInput) {
    if (!Number.isSafeInteger(request.userSeq) || request.userSeq < 0)
      return yield* new SwarmSchema.ValidationError({ reason: "userSeq must be a non-negative safe integer." })
    const now = request.now ?? Date.now()
    if (!Number.isFinite(request.deadline) || request.deadline <= now)
      return yield* new SwarmSchema.ValidationError({ reason: "Human-hold deadline must be in the future." })
    const [taskRow, leaseRow] = yield* Effect.all([
      requireTaskRow(readDb, request.token.swarmID, request.token.taskID),
      requireLeaseRow(readDb, request.token.taskID),
    ])
    if (!sameTokenRow(leaseRow, request.token))
      return yield* staleLease(request.token.taskID, request.token.generation, leaseRow.generation)
    if (leaseRow.state !== "active")
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.lease_not_active",
        reason: `Task ${request.token.taskID} cannot enter human hold from ${leaseRow.state}.`,
      })
    yield* requireRunnableBinding(readDb, request.token)
    const lease = hydrateLease({
      ...leaseRow,
      state: "human_hold",
      hold_user_seq: request.userSeq,
      hold_started_at: now,
      hold_deadline: request.deadline,
    })
    const task = hydrateTask(taskRow)
    yield* publishWithCommit(
      events,
      Swarm.Event.TaskLeaseUpdated,
      { swarmID: request.token.swarmID, task, lease },
      () =>
        Effect.gen(function* () {
          yield* requireRunnableBinding(db, request.token).pipe(Effect.catch((error) => commitFail(error)))
          const updated = yield* db
            .update(SwarmTaskLeaseTable)
            .set({
              state: "human_hold",
              hold_user_seq: request.userSeq,
              hold_started_at: now,
              hold_deadline: request.deadline,
            })
            .where(
              and(
                eq(SwarmTaskLeaseTable.task_id, request.token.taskID),
                eq(SwarmTaskLeaseTable.generation, request.token.generation),
                eq(SwarmTaskLeaseTable.state, "active"),
                eq(SwarmTaskLeaseTable.owner_member_id, request.token.memberID),
                eq(SwarmTaskLeaseTable.owner_session_id, request.token.sessionID),
                eq(SwarmTaskLeaseTable.owner_binding_generation, request.token.bindingGeneration),
                eq(SwarmTaskLeaseTable.lease_owner_process, request.token.processOwner),
              ),
            )
            .returning({ id: SwarmTaskLeaseTable.task_id })
            .get()
            .pipe(Effect.orDie)
          if (!updated)
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.lease_changed",
                reason: `Task ${request.token.taskID} changed before human hold could be recorded.`,
              }),
            )
        }),
    )
    return lease
  })

  const resumeHeldTask = Effect.fn("Swarm.resumeHeldTask")(function* (request: {
    readonly token: LeaseToken
    readonly now?: number
  }) {
    const [taskRow, leaseRow] = yield* Effect.all([
      requireTaskRow(readDb, request.token.swarmID, request.token.taskID),
      requireLeaseRow(readDb, request.token.taskID),
    ])
    if (!sameTokenRow(leaseRow, request.token))
      return yield* staleLease(request.token.taskID, request.token.generation, leaseRow.generation)
    if (leaseRow.state !== "human_hold")
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.lease_not_held",
        reason: `Task ${request.token.taskID} is not in human_hold.`,
      })
    yield* requireRunnableBinding(readDb, request.token)
    const lease = hydrateLease({
      ...leaseRow,
      state: "active",
      hold_user_seq: null,
      hold_started_at: null,
      hold_deadline: null,
    })
    const task = hydrateTask(taskRow)
    yield* publishWithCommit(
      events,
      Swarm.Event.TaskLeaseUpdated,
      { swarmID: request.token.swarmID, task, lease },
      () =>
        Effect.gen(function* () {
          yield* requireRunnableBinding(db, request.token).pipe(Effect.catch((error) => commitFail(error)))
          const updated = yield* db
            .update(SwarmTaskLeaseTable)
            .set({
              state: "active",
              hold_user_seq: null,
              hold_started_at: null,
              hold_deadline: null,
            })
            .where(
              and(
                eq(SwarmTaskLeaseTable.task_id, request.token.taskID),
                eq(SwarmTaskLeaseTable.generation, request.token.generation),
                eq(SwarmTaskLeaseTable.state, "human_hold"),
                eq(SwarmTaskLeaseTable.owner_member_id, request.token.memberID),
                eq(SwarmTaskLeaseTable.owner_session_id, request.token.sessionID),
                eq(SwarmTaskLeaseTable.owner_binding_generation, request.token.bindingGeneration),
                eq(SwarmTaskLeaseTable.lease_owner_process, request.token.processOwner),
              ),
            )
            .returning({ id: SwarmTaskLeaseTable.task_id })
            .get()
            .pipe(Effect.orDie)
          if (!updated)
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.lease_changed",
                reason: `Task ${request.token.taskID} changed before hold release.`,
              }),
            )
        }),
    )
    return lease
  })

  const requestTaskRetirement = Effect.fn("Swarm.requestTaskRetirement")(function* (
    request: RequestTaskRetirementInput,
  ) {
    const [taskRow, leaseRow] = yield* Effect.all([
      requireTaskRow(readDb, request.token.swarmID, request.token.taskID),
      requireLeaseRow(readDb, request.token.taskID),
    ])
    if (!sameTokenRow(leaseRow, request.token))
      return yield* staleLease(request.token.taskID, request.token.generation, leaseRow.generation)
    if (leaseRow.state === "retiring") return hydrateLease(leaseRow)
    const now = request.now ?? Date.now()
    const lease = hydrateLease({
      ...leaseRow,
      state: "retiring",
      retire_reason: request.reason,
      retire_requested_at: now,
    })
    const task = hydrateTask(taskRow)
    yield* publishWithCommit(
      events,
      Swarm.Event.TaskLeaseUpdated,
      { swarmID: request.token.swarmID, task, lease },
      () =>
        Effect.gen(function* () {
          const updated = yield* db
            .update(SwarmTaskLeaseTable)
            .set({
              state: "retiring",
              retire_reason: request.reason,
              retire_requested_at: now,
            })
            .where(
              and(
                eq(SwarmTaskLeaseTable.task_id, request.token.taskID),
                eq(SwarmTaskLeaseTable.generation, request.token.generation),
                inArray(SwarmTaskLeaseTable.state, ["active", "human_hold"]),
                eq(SwarmTaskLeaseTable.owner_member_id, request.token.memberID),
                eq(SwarmTaskLeaseTable.owner_session_id, request.token.sessionID),
                eq(SwarmTaskLeaseTable.owner_binding_generation, request.token.bindingGeneration),
                eq(SwarmTaskLeaseTable.lease_owner_process, request.token.processOwner),
              ),
            )
            .returning({ id: SwarmTaskLeaseTable.task_id })
            .get()
            .pipe(Effect.orDie)
          if (!updated) {
            const current = yield* db
              .select()
              .from(SwarmTaskLeaseTable)
              .where(eq(SwarmTaskLeaseTable.task_id, request.token.taskID))
              .get()
              .pipe(Effect.orDie)
            if (!current)
              return yield* commitFail(
                new SwarmSchema.NotFoundError({ entity: "task", id: request.token.taskID }),
              )
            if (!sameTokenRow(current, request.token))
              return yield* commitFail(
                staleLease(request.token.taskID, request.token.generation, current.generation),
              )
            if (current.state !== "retiring")
              return yield* commitFail(
                new SwarmSchema.ConflictError({
                  code: "swarm.lease_changed",
                  reason: `Task ${request.token.taskID} lease changed before retirement.`,
                }),
              )
          }
        }),
    )
    return lease
  })

  const recordTaskRun = Effect.fn("Swarm.recordTaskRun")(function* (request: RecordTaskRunInput) {
    const [taskRow, leaseRow] = yield* Effect.all([
      requireTaskRow(readDb, request.token.swarmID, request.token.taskID),
      requireLeaseRow(readDb, request.token.taskID),
    ])
    if (!sameTokenRow(leaseRow, request.token))
      return yield* staleLease(request.token.taskID, request.token.generation, leaseRow.generation)
    if (taskRow.status !== "working")
      return yield* new SwarmSchema.InvalidTransitionError({
        entity: "task",
        id: request.token.taskID,
        from: taskRow.status,
        to: "task_run",
      })
    if (leaseRow.state === "retiring")
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.lease_retiring",
        reason: `Task ${request.token.taskID} is retiring and cannot admit more work.`,
      })
    yield* requireRunnableBinding(readDb, request.token)
    const now = request.now ?? Date.now()
    const admittedAt = request.admittedAt ?? now
    const run = Swarm.TaskRun.make({
      id: request.id ?? Swarm.TaskRunID.create(),
      taskID: request.token.taskID,
      memberID: request.token.memberID,
      sessionID: request.token.sessionID,
      bindingGeneration: request.token.bindingGeneration,
      leaseGeneration: request.token.generation,
      sessionInputID: request.sessionInputID,
      status: "admitted",
      admittedAt: DateTime.makeUnsafe(admittedAt),
      createdAt: DateTime.makeUnsafe(now),
    })
    yield* publishWithCommit(
      events,
      Swarm.Event.TaskRunUpdated,
      {
        swarmID: request.token.swarmID,
        task: hydrateTask(taskRow),
        run,
        lease: hydrateLease(leaseRow),
      },
      () =>
        Effect.gen(function* () {
          const currentLease = yield* db
            .select()
            .from(SwarmTaskLeaseTable)
            .where(eq(SwarmTaskLeaseTable.task_id, request.token.taskID))
            .get()
            .pipe(Effect.orDie)
          if (!currentLease || !sameTokenRow(currentLease, request.token))
            return yield* commitFail(
              staleLease(
                request.token.taskID,
                request.token.generation,
                currentLease?.generation ?? request.token.generation + 1,
              ),
            )
          if (currentLease.state === "retiring")
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.lease_retiring",
                reason: `Task ${request.token.taskID} began retiring before run admission was recorded.`,
              }),
            )
          yield* requireRunnableBinding(db, request.token).pipe(Effect.catch((error) => commitFail(error)))
          const duplicate = yield* db
            .select({ id: SwarmTaskRunTable.id })
            .from(SwarmTaskRunTable)
            .where(eq(SwarmTaskRunTable.session_input_id, request.sessionInputID))
            .get()
            .pipe(Effect.orDie)
          if (duplicate) {
            if (duplicate.id === run.id) return
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.task_input_exists",
                reason: `Session input ${request.sessionInputID} is already bound to another task run.`,
              }),
            )
          }
          yield* db
            .insert(SwarmTaskRunTable)
            .values({
              id: run.id,
              task_id: run.taskID,
              member_id: run.memberID,
              session_id: run.sessionID,
              binding_generation: run.bindingGeneration,
              lease_generation: run.leaseGeneration,
              session_input_id: run.sessionInputID,
              status: "admitted",
              admitted_at: admittedAt,
              time_created: now,
            })
            .run()
            .pipe(Effect.orDie)
        }),
    )
    return run
  })

  const startTaskRun = Effect.fn("Swarm.startTaskRun")(function* (request: StartTaskRunInput) {
    const [taskRow, leaseRow, runRow] = yield* Effect.all([
      requireTaskRow(readDb, request.token.swarmID, request.token.taskID),
      requireLeaseRow(readDb, request.token.taskID),
      requireTaskRunRow(readDb, request.runID),
    ])
    if (!sameTokenRow(leaseRow, request.token))
      return yield* staleLease(request.token.taskID, request.token.generation, leaseRow.generation)
    if (
      runRow.task_id !== request.token.taskID ||
      runRow.member_id !== request.token.memberID ||
      runRow.session_id !== request.token.sessionID ||
      runRow.binding_generation !== request.token.bindingGeneration ||
      runRow.lease_generation !== request.token.generation
    )
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.run_token_mismatch",
        reason: `Task run ${request.runID} is not owned by the supplied lease token.`,
      })
    if (runRow.status !== "admitted")
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.run_not_admitted",
        reason: `Task run ${request.runID} cannot start from ${runRow.status}.`,
      })
    if (leaseRow.state === "retiring")
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.lease_retiring",
        reason: `Task ${request.token.taskID} is retiring and cannot start admitted work.`,
      })
    yield* requireRunnableBinding(readDb, request.token)
    const now = request.now ?? Date.now()
    const run = hydrateTaskRun({ ...runRow, status: "running", started_at: now })
    yield* publishWithCommit(
      events,
      Swarm.Event.TaskRunUpdated,
      {
        swarmID: request.token.swarmID,
        task: hydrateTask(taskRow),
        run,
        lease: hydrateLease(leaseRow),
      },
      () =>
        Effect.gen(function* () {
          yield* requireRunnableBinding(db, request.token).pipe(Effect.catch((error) => commitFail(error)))
          const currentLease = yield* db
            .select()
            .from(SwarmTaskLeaseTable)
            .where(eq(SwarmTaskLeaseTable.task_id, request.token.taskID))
            .get()
            .pipe(Effect.orDie)
          if (!currentLease || !sameTokenRow(currentLease, request.token))
            return yield* commitFail(
              staleLease(
                request.token.taskID,
                request.token.generation,
                currentLease?.generation ?? request.token.generation + 1,
              ),
            )
          if (currentLease.state === "retiring")
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.lease_retiring",
                reason: `Task ${request.token.taskID} began retiring before run start.`,
              }),
            )
          const updated = yield* db
            .update(SwarmTaskRunTable)
            .set({ status: "running", started_at: now })
            .where(
              and(
                eq(SwarmTaskRunTable.id, request.runID),
                eq(SwarmTaskRunTable.status, "admitted"),
                eq(SwarmTaskRunTable.lease_generation, request.token.generation),
                eq(SwarmTaskRunTable.binding_generation, request.token.bindingGeneration),
              ),
            )
            .returning({ id: SwarmTaskRunTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!updated)
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.run_changed",
                reason: `Task run ${request.runID} changed before start.`,
              }),
            )
        }),
    )
    return run
  })

  const settleTask = Effect.fn("Swarm.settleTask")(function* (request: SettleTaskInput) {
    const [taskRow, leaseRow] = yield* Effect.all([
      requireTaskRow(readDb, request.token.swarmID, request.token.taskID),
      requireLeaseRow(readDb, request.token.taskID),
    ])
    if (!sameTokenRow(leaseRow, request.token))
      return yield* staleLease(request.token.taskID, request.token.generation, leaseRow.generation)
    if (request.settlement.type === "superseded" && leaseRow.state !== "retiring")
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.supersede_requires_retirement",
        reason: `Task ${request.token.taskID} must enter retiring before it can be superseded.`,
      })
    if (request.settlement.type === "completed" || request.settlement.type === "failed")
      yield* requireRunnableBinding(readDb, request.token)

    const runRow = request.runID === undefined ? undefined : yield* requireTaskRunRow(readDb, request.runID)
    if (
      runRow &&
      (runRow.task_id !== request.token.taskID ||
        runRow.member_id !== request.token.memberID ||
        runRow.session_id !== request.token.sessionID ||
        runRow.binding_generation !== request.token.bindingGeneration ||
        runRow.lease_generation !== request.token.generation)
    )
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.run_token_mismatch",
        reason: `Task run ${request.runID} is not owned by the supplied lease token.`,
      })
    if (
      runRow &&
      !["admitted", "running"].includes(runRow.status)
    )
      return yield* new SwarmSchema.ConflictError({
        code: "swarm.run_terminal",
        reason: `Task run ${request.runID} is already ${runRow.status}.`,
      })

    const now = request.now ?? Date.now()
    const nextGeneration = request.token.generation + 1
    const semanticFailure =
      request.settlement.type === "failed" && semanticRetryConsumesBudget(request.settlement.failureKind)
    const nextStatus: Swarm.TaskStatus =
      request.settlement.type === "completed"
        ? "completed"
        : request.settlement.type === "cancelled"
          ? "cancelled"
          : request.settlement.type === "superseded"
            ? "ready"
            : semanticFailure
              ? "failed"
              : "ready"
    const task = hydrateTask({
      ...taskRow,
      status: nextStatus,
      lease_generation: nextGeneration,
      semantic_retry_count: taskRow.semantic_retry_count + (semanticFailure ? 1 : 0),
      ready_at: nextStatus === "ready" ? now : null,
      time_updated: now,
      time_completed:
        nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled" ? now : null,
    })
    const nextRunStatus: Swarm.TaskRunStatus | undefined =
      request.settlement.type === "completed"
        ? "completed"
        : request.settlement.type === "cancelled"
          ? "cancelled"
          : request.settlement.type === "superseded"
            ? "superseded"
            : "failed"
    const run =
      runRow === undefined
        ? undefined
        : hydrateTaskRun({
            ...runRow,
            status: nextRunStatus!,
            failure_kind:
              request.settlement.type === "failed" ? request.settlement.failureKind : runRow.failure_kind,
            failure_detail:
              request.settlement.type === "failed" || request.settlement.type === "cancelled" || request.settlement.type === "superseded"
                ? request.settlement.detail ?? null
                : runRow.failure_detail,
            ended_at: now,
          })

    const definition = run ? Swarm.Event.TaskRunUpdated : Swarm.Event.TaskLeaseUpdated
    const data = run
      ? { swarmID: request.token.swarmID, task, run, lease: undefined }
      : { swarmID: request.token.swarmID, task, lease: undefined }
    yield* publishWithCommit(events, definition as never, data as never, () =>
      Effect.gen(function* () {
        const liveLease = yield* db
          .select()
          .from(SwarmTaskLeaseTable)
          .where(eq(SwarmTaskLeaseTable.task_id, request.token.taskID))
          .get()
          .pipe(Effect.orDie)
        if (!liveLease || !sameTokenRow(liveLease, request.token))
          return yield* commitFail(
            staleLease(
              request.token.taskID,
              request.token.generation,
              liveLease?.generation ?? request.token.generation + 1,
            ),
          )
        if (request.settlement.type === "superseded" && liveLease.state !== "retiring")
          return yield* commitFail(
            new SwarmSchema.ConflictError({
              code: "swarm.supersede_requires_retirement",
              reason: `Task ${request.token.taskID} left retiring before settlement.`,
            }),
          )
        if (request.settlement.type === "completed" || request.settlement.type === "failed")
          yield* requireRunnableBinding(db, request.token).pipe(Effect.catch((error) => commitFail(error)))

        if (runRow) {
          const updatedRun = yield* db
            .update(SwarmTaskRunTable)
            .set({
              status: nextRunStatus!,
              failure_kind:
                request.settlement.type === "failed" ? request.settlement.failureKind : runRow.failure_kind,
              failure_detail:
                request.settlement.type === "failed" ||
                request.settlement.type === "cancelled" ||
                request.settlement.type === "superseded"
                  ? request.settlement.detail ?? null
                  : runRow.failure_detail,
              ended_at: now,
            })
            .where(
              and(
                eq(SwarmTaskRunTable.id, runRow.id),
                inArray(SwarmTaskRunTable.status, ["admitted", "running"]),
                eq(SwarmTaskRunTable.lease_generation, request.token.generation),
                eq(SwarmTaskRunTable.binding_generation, request.token.bindingGeneration),
              ),
            )
            .returning({ id: SwarmTaskRunTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!updatedRun)
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.run_changed",
                reason: `Task run ${runRow.id} changed before settlement.`,
              }),
            )
        }

        const released = yield* db
          .delete(SwarmTaskLeaseTable)
          .where(
            and(
              eq(SwarmTaskLeaseTable.task_id, request.token.taskID),
              eq(SwarmTaskLeaseTable.generation, request.token.generation),
              eq(SwarmTaskLeaseTable.owner_member_id, request.token.memberID),
              eq(SwarmTaskLeaseTable.owner_session_id, request.token.sessionID),
              eq(SwarmTaskLeaseTable.owner_binding_generation, request.token.bindingGeneration),
              eq(SwarmTaskLeaseTable.lease_owner_process, request.token.processOwner),
            ),
          )
          .returning({ id: SwarmTaskLeaseTable.task_id })
          .get()
          .pipe(Effect.orDie)
        if (!released)
          return yield* commitFail(
            new SwarmSchema.ConflictError({
              code: "swarm.lease_changed",
              reason: `Task lease ${request.token.taskID} changed before settlement.`,
            }),
          )
        const updatedTask = yield* db
          .update(SwarmTaskTable)
          .set({
            status: nextStatus,
            lease_generation: nextGeneration,
            semantic_retry_count: task.semanticRetryCount,
            ready_at: nextStatus === "ready" ? now : null,
            time_updated: now,
            time_completed:
              nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled" ? now : null,
          })
          .where(
            and(
              eq(SwarmTaskTable.id, request.token.taskID),
              eq(SwarmTaskTable.swarm_id, request.token.swarmID),
              eq(SwarmTaskTable.status, "working"),
              eq(SwarmTaskTable.lease_generation, request.token.generation),
            ),
          )
          .returning({ id: SwarmTaskTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!updatedTask)
          return yield* commitFail(
            new SwarmSchema.ConflictError({
              code: "swarm.task_changed",
              reason: `Task ${request.token.taskID} changed before settlement.`,
            }),
          )
        if (isTaskTerminal(nextStatus))
          yield* promoteSatisfiedDependents(db, {
            swarmID: request.token.swarmID,
            prerequisiteTaskID: request.token.taskID,
            now,
          })
      }),
    )
    return { task, ...(run === undefined ? {} : { run }) }
  })

  const expiredLeases = Effect.fn("Swarm.expiredLeases")(function* (request: {
    readonly now: number
    readonly limit?: number
  }) {
    const limit = Math.min(256, Math.max(1, Math.trunc(request.limit ?? 64)))
    const rows = yield* readDb
      .select()
      .from(SwarmTaskLeaseTable)
      .where(
        and(
          lte(SwarmTaskLeaseTable.expires_at, request.now),
          ne(SwarmTaskLeaseTable.state, "retiring"),
        ),
      )
      .orderBy(asc(SwarmTaskLeaseTable.expires_at), asc(SwarmTaskLeaseTable.task_id))
      .limit(limit)
      .all()
      .pipe(Effect.orDie)
    return rows.map(hydrateLease)
  })

  const taskRunHistory = Effect.fn("Swarm.taskRunHistory")(function* (request: {
    readonly swarmID: Swarm.ID
    readonly taskID?: Swarm.TaskID
    readonly limit?: number
    readonly before?: TaskRunHistoryCursor
  }) {
    const limit = Math.min(200, Math.max(1, Math.trunc(request.limit ?? 50)))
    const predicates = [eq(SwarmTaskTable.swarm_id, request.swarmID)]
    if (request.taskID !== undefined) predicates.push(eq(SwarmTaskRunTable.task_id, request.taskID))
    if (request.before !== undefined) {
      predicates.push(
        or(
          lt(SwarmTaskRunTable.time_created, request.before.createdAt),
          and(
            eq(SwarmTaskRunTable.time_created, request.before.createdAt),
            lt(SwarmTaskRunTable.id, request.before.id),
          ),
        )!,
      )
    }
    const rows = yield* readDb
      .select({ run: SwarmTaskRunTable })
      .from(SwarmTaskRunTable)
      .innerJoin(SwarmTaskTable, eq(SwarmTaskTable.id, SwarmTaskRunTable.task_id))
      .where(and(...predicates))
      .orderBy(desc(SwarmTaskRunTable.time_created), desc(SwarmTaskRunTable.id))
      .limit(limit + 1)
      .all()
      .pipe(Effect.orDie)
    const more = rows.length > limit
    const last = more ? rows.at(limit - 1)?.run : undefined
    return {
      items: rows.slice(0, limit).map((row) => hydrateTaskRun(row.run)),
      more,
      ...(last === undefined ? {} : { next: { createdAt: last.time_created, id: last.id } }),
    } satisfies TaskRunHistoryPage
  })

  return {
    claimTask,
    renewTaskLease,
    holdTask,
    resumeHeldTask,
    requestTaskRetirement,
    recordTaskRun,
    startTaskRun,
    settleTask,
    expiredLeases,
    taskRunHistory,
  }
}
