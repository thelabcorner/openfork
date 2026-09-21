import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, ne, or } from "drizzle-orm"
import { Effect } from "effect"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionInputTable } from "../session/sql"
import type { DatabaseShape } from "../database/database"
import type { LeaseToken, RetirementReason } from "./lease"
import { hydrateLease, hydrateMember, hydrateTask, hydrateTaskRun } from "./projection"
import { SwarmSchema } from "./schema"
import {
  SwarmMessageDeliveryTable,
  SwarmMessageTable,
  SwarmMemberTable,
  SwarmTable,
  SwarmTaskLeaseTable,
  SwarmTaskRunTable,
  SwarmTaskTable,
} from "./sql"

type Db = DatabaseShape

export interface LeaseRuntimeTarget {
  readonly swarmID: Swarm.ID
  readonly token: LeaseToken
  readonly lease: Swarm.TaskLease
}

export interface SessionTaskAuthority extends LeaseRuntimeTarget {
  readonly member: Swarm.Member
  readonly task: Swarm.Task
  readonly run: Swarm.TaskRun
}

export interface RetirementRun {
  readonly run: Swarm.TaskRun
  readonly input?: {
    readonly id: SessionMessage.ID
    readonly promotedSeq?: number
    readonly revokedSeq?: number
  }
}

export interface RetirementTarget extends LeaseRuntimeTarget {
  readonly runs: ReadonlyArray<RetirementRun>
}

export interface RetirementRequiredTarget extends LeaseRuntimeTarget {
  readonly reason: RetirementReason
}

export interface NextRuntimeDeadlineInput {
  readonly now: number
  readonly processOwner: string
  readonly leaseRenewAheadMs: number
}

export interface RuntimeDeadlineState {
  readonly at?: number
  readonly hasRetiring: boolean
  /** A retry/reclaim/reservation transition is already due and needs a dispatcher wake. */
  readonly dispatchDue: boolean
}

function targetOf(
  swarmID: Swarm.ID,
  row: typeof SwarmTaskLeaseTable.$inferSelect,
): LeaseRuntimeTarget {
  return {
    swarmID,
    lease: hydrateLease(row),
    token: {
      swarmID,
      taskID: row.task_id,
      generation: row.generation,
      memberID: row.owner_member_id,
      sessionID: row.owner_session_id,
      bindingGeneration: row.owner_binding_generation,
      processOwner: row.lease_owner_process,
    },
  }
}

function finitePositive(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

export function makeRuntimeOperations(input: { readonly readDb: Db }) {
  const { readDb } = input

  /**
   * Resolve member-side task mutation authority exclusively from trusted
   * Session identity plus durable Swarm state. The caller never supplies a
   * lease token, task id, member id, binding generation, or run id.
   *
   * Human-held/retiring leases and merely-admitted runs are deliberately not
   * authority to settle work.
   */
  const sessionTaskAuthority = Effect.fn("Swarm.sessionTaskAuthority")(function* (request: {
    readonly swarmID: Swarm.ID
    readonly sessionID: Swarm.TaskRun["sessionID"]
  }) {
    const rows = yield* readDb
      .select({
        member: SwarmMemberTable,
        lease: SwarmTaskLeaseTable,
        task: SwarmTaskTable,
        run: SwarmTaskRunTable,
      })
      .from(SwarmMemberTable)
      .innerJoin(
        SwarmTaskLeaseTable,
        and(
          eq(SwarmTaskLeaseTable.owner_member_id, SwarmMemberTable.id),
          eq(SwarmTaskLeaseTable.owner_session_id, request.sessionID),
          eq(SwarmTaskLeaseTable.owner_binding_generation, SwarmMemberTable.binding_generation),
          eq(SwarmTaskLeaseTable.state, "active"),
        ),
      )
      .innerJoin(
        SwarmTaskTable,
        and(
          eq(SwarmTaskTable.id, SwarmTaskLeaseTable.task_id),
          eq(SwarmTaskTable.swarm_id, request.swarmID),
          eq(SwarmTaskTable.status, "working"),
        ),
      )
      .innerJoin(
        SwarmTaskRunTable,
        and(
          eq(SwarmTaskRunTable.task_id, SwarmTaskLeaseTable.task_id),
          eq(SwarmTaskRunTable.member_id, SwarmMemberTable.id),
          eq(SwarmTaskRunTable.session_id, request.sessionID),
          eq(SwarmTaskRunTable.binding_generation, SwarmTaskLeaseTable.owner_binding_generation),
          eq(SwarmTaskRunTable.lease_generation, SwarmTaskLeaseTable.generation),
          eq(SwarmTaskRunTable.status, "running"),
        ),
      )
      .where(
        and(
          eq(SwarmMemberTable.swarm_id, request.swarmID),
          eq(SwarmMemberTable.session_id, request.sessionID),
          eq(SwarmMemberTable.lifecycle, "active"),
        ),
      )
      .limit(2)
      .all()
      .pipe(Effect.orDie)

    if (rows.length !== 1)
      return yield* new SwarmSchema.ConflictError({
        code: rows.length === 0 ? "swarm.session_task_authority_missing" : "swarm.session_task_authority_ambiguous",
        reason:
          rows.length === 0
            ? `Session ${request.sessionID} does not own one active running task in Swarm ${request.swarmID}.`
            : `Session ${request.sessionID} has ambiguous active task authority in Swarm ${request.swarmID}.`,
      })

    const row = rows[0]!
    const target = targetOf(request.swarmID, row.lease)
    return {
      ...target,
      member: hydrateMember(row.member),
      task: hydrateTask(row.task),
      run: hydrateTaskRun(row.run),
    } satisfies SessionTaskAuthority
  })

  const leaseRenewalTargets = Effect.fn("Swarm.leaseRenewalTargets")(function* (request: {
    readonly processOwner: string
    readonly now: number
    readonly renewBefore: number
    readonly limit?: number
  }) {
    const owner = request.processOwner.trim()
    if (!owner || request.renewBefore <= request.now) return [] as LeaseRuntimeTarget[]
    const limit = Math.min(256, Math.max(1, Math.trunc(request.limit ?? 64)))
    const rows = yield* readDb
      .select({ lease: SwarmTaskLeaseTable, swarmID: SwarmTaskTable.swarm_id })
      .from(SwarmTaskLeaseTable)
      .innerJoin(SwarmTaskTable, eq(SwarmTaskTable.id, SwarmTaskLeaseTable.task_id))
      .where(
        and(
          eq(SwarmTaskLeaseTable.lease_owner_process, owner),
          gt(SwarmTaskLeaseTable.expires_at, request.now),
          lte(SwarmTaskLeaseTable.expires_at, request.renewBefore),
        ),
      )
      .orderBy(asc(SwarmTaskLeaseTable.expires_at), asc(SwarmTaskLeaseTable.task_id))
      .limit(limit)
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => targetOf(row.swarmID, row.lease))
  })

  const activeLeaseOwnerProcessIDs = Effect.fn("Swarm.activeLeaseOwnerProcessIDs")(function* (request?: {
    readonly excludeProcessOwner?: string
    readonly afterProcessOwner?: string
    readonly limit?: number
  }) {
    const exclude = request?.excludeProcessOwner?.trim()
    const after = request?.afterProcessOwner?.trim()
    const limit = Math.min(256, Math.max(1, Math.trunc(request?.limit ?? 64)))
    const predicates = [inArray(SwarmTaskLeaseTable.state, ["active", "human_hold"])]
    if (exclude) predicates.push(ne(SwarmTaskLeaseTable.lease_owner_process, exclude))
    if (after) predicates.push(gt(SwarmTaskLeaseTable.lease_owner_process, after))
    const rows = yield* readDb
      .selectDistinct({ processOwner: SwarmTaskLeaseTable.lease_owner_process })
      .from(SwarmTaskLeaseTable)
      .where(and(...predicates))
      .orderBy(asc(SwarmTaskLeaseTable.lease_owner_process))
      .limit(limit)
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => row.processOwner)
  })

  const processLeaseTargets = Effect.fn("Swarm.processLeaseTargets")(function* (request: {
    readonly processOwner: string
    readonly limit?: number
  }) {
    const owner = request.processOwner.trim()
    if (!owner) return [] as LeaseRuntimeTarget[]
    const limit = Math.min(256, Math.max(1, Math.trunc(request.limit ?? 64)))
    const rows = yield* readDb
      .select({ lease: SwarmTaskLeaseTable, swarmID: SwarmTaskTable.swarm_id })
      .from(SwarmTaskLeaseTable)
      .innerJoin(SwarmTaskTable, eq(SwarmTaskTable.id, SwarmTaskLeaseTable.task_id))
      .where(
        and(
          eq(SwarmTaskLeaseTable.lease_owner_process, owner),
          inArray(SwarmTaskLeaseTable.state, ["active", "human_hold"]),
        ),
      )
      .orderBy(asc(SwarmTaskLeaseTable.task_id))
      .limit(limit)
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => targetOf(row.swarmID, row.lease))
  })

  const expiredLeaseTargets = Effect.fn("Swarm.expiredLeaseTargets")(function* (request: {
    readonly now: number
    readonly limit?: number
  }) {
    const limit = Math.min(256, Math.max(1, Math.trunc(request.limit ?? 64)))
    const rows = yield* readDb
      .select({ lease: SwarmTaskLeaseTable, swarmID: SwarmTaskTable.swarm_id })
      .from(SwarmTaskLeaseTable)
      .innerJoin(SwarmTaskTable, eq(SwarmTaskTable.id, SwarmTaskLeaseTable.task_id))
      .where(and(lte(SwarmTaskLeaseTable.expires_at, request.now), ne(SwarmTaskLeaseTable.state, "retiring")))
      .orderBy(asc(SwarmTaskLeaseTable.expires_at), asc(SwarmTaskLeaseTable.task_id))
      .limit(limit)
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => targetOf(row.swarmID, row.lease))
  })

  const dueHoldTargets = Effect.fn("Swarm.dueHoldTargets")(function* (request: {
    readonly now: number
    readonly limit?: number
  }) {
    const limit = Math.min(256, Math.max(1, Math.trunc(request.limit ?? 64)))
    const rows = yield* readDb
      .select({ lease: SwarmTaskLeaseTable, swarmID: SwarmTaskTable.swarm_id })
      .from(SwarmTaskLeaseTable)
      .innerJoin(SwarmTaskTable, eq(SwarmTaskTable.id, SwarmTaskLeaseTable.task_id))
      .where(
        and(
          eq(SwarmTaskLeaseTable.state, "human_hold"),
          isNotNull(SwarmTaskLeaseTable.hold_deadline),
          lte(SwarmTaskLeaseTable.hold_deadline, request.now),
        ),
      )
      .orderBy(asc(SwarmTaskLeaseTable.hold_deadline), asc(SwarmTaskLeaseTable.task_id))
      .limit(limit)
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => targetOf(row.swarmID, row.lease))
  })

  const retiringTargets = Effect.fn("Swarm.retiringTargets")(function* (request?: { readonly limit?: number }) {
    const limit = Math.min(256, Math.max(1, Math.trunc(request?.limit ?? 64)))
    const leaseRows = yield* readDb
      .select({ lease: SwarmTaskLeaseTable, swarmID: SwarmTaskTable.swarm_id })
      .from(SwarmTaskLeaseTable)
      .innerJoin(SwarmTaskTable, eq(SwarmTaskTable.id, SwarmTaskLeaseTable.task_id))
      .where(eq(SwarmTaskLeaseTable.state, "retiring"))
      .orderBy(asc(SwarmTaskLeaseTable.retire_requested_at), asc(SwarmTaskLeaseTable.task_id))
      .limit(limit)
      .all()
      .pipe(Effect.orDie)
    if (leaseRows.length === 0) return [] as RetirementTarget[]

    const taskIDs = leaseRows.map((row) => row.lease.task_id)
    const runRows = yield* readDb
      .select()
      .from(SwarmTaskRunTable)
      .where(
        and(
          inArray(SwarmTaskRunTable.task_id, taskIDs),
          inArray(SwarmTaskRunTable.status, ["admitted", "running"]),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    const inputIDs = runRows.map((row) => row.session_input_id)
    const inputRows =
      inputIDs.length === 0
        ? []
        : yield* readDb
            .select({
              id: SessionInputTable.id,
              promotedSeq: SessionInputTable.promoted_seq,
              revokedSeq: SessionInputTable.revoked_seq,
            })
            .from(SessionInputTable)
            .where(inArray(SessionInputTable.id, inputIDs))
            .all()
            .pipe(Effect.orDie)
    const inputs = new Map(inputRows.map((row) => [row.id, row] as const))

    return leaseRows.map((row) => {
      const target = targetOf(row.swarmID, row.lease)
      const runs = runRows
        .filter(
          (run) =>
            run.task_id === row.lease.task_id &&
            run.member_id === row.lease.owner_member_id &&
            run.session_id === row.lease.owner_session_id &&
            run.binding_generation === row.lease.owner_binding_generation &&
            run.lease_generation === row.lease.generation,
        )
        .map((run) => {
          const inputRow = inputs.get(run.session_input_id)
          return {
            run: hydrateTaskRun(run),
            ...(inputRow
              ? {
                  input: {
                    id: inputRow.id,
                    ...(inputRow.promotedSeq === null ? {} : { promotedSeq: inputRow.promotedSeq }),
                    ...(inputRow.revokedSeq === null ? {} : { revokedSeq: inputRow.revokedSeq }),
                  },
                }
              : {}),
          } satisfies RetirementRun
        })
      return { ...target, runs } satisfies RetirementTarget
    })
  })

  const retirementRequiredTargets = Effect.fn("Swarm.retirementRequiredTargets")(function* (request?: {
    readonly limit?: number
  }) {
    const limit = Math.min(256, Math.max(1, Math.trunc(request?.limit ?? 64)))
    const rows = yield* readDb
      .select({
        lease: SwarmTaskLeaseTable,
        swarmID: SwarmTaskTable.swarm_id,
        swarmStatus: SwarmTable.status,
        memberLifecycle: SwarmMemberTable.lifecycle,
        memberSessionID: SwarmMemberTable.session_id,
        memberBindingGeneration: SwarmMemberTable.binding_generation,
      })
      .from(SwarmTaskLeaseTable)
      .innerJoin(SwarmTaskTable, eq(SwarmTaskTable.id, SwarmTaskLeaseTable.task_id))
      .innerJoin(SwarmTable, eq(SwarmTable.id, SwarmTaskTable.swarm_id))
      .innerJoin(SwarmMemberTable, eq(SwarmMemberTable.id, SwarmTaskLeaseTable.owner_member_id))
      .where(
        and(
          inArray(SwarmTaskLeaseTable.state, ["active", "human_hold"]),
          or(
            ne(SwarmTable.status, "active"),
            ne(SwarmMemberTable.lifecycle, "active"),
            isNull(SwarmMemberTable.session_id),
            ne(SwarmMemberTable.session_id, SwarmTaskLeaseTable.owner_session_id),
            ne(SwarmMemberTable.binding_generation, SwarmTaskLeaseTable.owner_binding_generation),
          ),
        ),
      )
      .orderBy(asc(SwarmTaskLeaseTable.state), asc(SwarmTaskLeaseTable.task_id))
      .limit(limit)
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => ({
      ...targetOf(row.swarmID, row.lease),
      reason:
        row.swarmStatus !== "active"
          ? ("swarm_freeze" as const)
          : row.memberLifecycle !== "active"
            ? ("member_stop" as const)
            : ("member_rebind" as const),
    }))
  })

  const nextRuntimeDeadline = Effect.fn("Swarm.nextRuntimeDeadline")(function* (request: NextRuntimeDeadlineInput) {
    const renewAhead = finitePositive(request.leaseRenewAheadMs)
    const owner = request.processOwner.trim()
    const future = (value: number | null | undefined) =>
      value !== null && value !== undefined && value > request.now ? value : undefined

    const [renewal, expiry, hold, messageExpiry, pendingDelivery, claimedDelivery, reservation, retiring] = yield* Effect.all([
      owner
        ? readDb
            .select({ due: SwarmTaskLeaseTable.expires_at })
            .from(SwarmTaskLeaseTable)
            .where(
              and(
                eq(SwarmTaskLeaseTable.lease_owner_process, owner),
                gt(SwarmTaskLeaseTable.expires_at, request.now),
              ),
            )
            .orderBy(asc(SwarmTaskLeaseTable.expires_at))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
        : Effect.succeed(undefined),
      readDb
        .select({ due: SwarmTaskLeaseTable.expires_at })
        .from(SwarmTaskLeaseTable)
        .where(and(ne(SwarmTaskLeaseTable.state, "retiring"), gt(SwarmTaskLeaseTable.expires_at, request.now)))
        .orderBy(asc(SwarmTaskLeaseTable.expires_at))
        .limit(1)
        .get()
        .pipe(Effect.orDie),
      readDb
        .select({ due: SwarmTaskLeaseTable.hold_deadline })
        .from(SwarmTaskLeaseTable)
        .where(
          and(
            eq(SwarmTaskLeaseTable.state, "human_hold"),
            isNotNull(SwarmTaskLeaseTable.hold_deadline),
            gt(SwarmTaskLeaseTable.hold_deadline, request.now),
          ),
        )
        .orderBy(asc(SwarmTaskLeaseTable.hold_deadline))
        .limit(1)
        .get()
        .pipe(Effect.orDie),
      readDb
        .select({ due: SwarmMessageTable.expires_at })
        .from(SwarmMessageTable)
        .innerJoin(SwarmMessageDeliveryTable, eq(SwarmMessageDeliveryTable.message_id, SwarmMessageTable.id))
        .where(
          and(
            isNotNull(SwarmMessageTable.expires_at),
            gt(SwarmMessageTable.expires_at, request.now),
            inArray(SwarmMessageDeliveryTable.state, ["pending", "claimed"]),
          ),
        )
        .orderBy(asc(SwarmMessageTable.expires_at))
        .limit(1)
        .get()
        .pipe(Effect.orDie),
      readDb
        .select({ due: SwarmMessageDeliveryTable.next_attempt_at })
        .from(SwarmMessageDeliveryTable)
        .where(
          and(
            eq(SwarmMessageDeliveryTable.state, "pending"),
            isNotNull(SwarmMessageDeliveryTable.next_attempt_at),
          ),
        )
        .orderBy(asc(SwarmMessageDeliveryTable.next_attempt_at))
        .limit(1)
        .get()
        .pipe(Effect.orDie),
      readDb
        .select({ due: SwarmMessageDeliveryTable.claim_expires_at })
        .from(SwarmMessageDeliveryTable)
        .where(
          and(
            eq(SwarmMessageDeliveryTable.state, "claimed"),
            isNotNull(SwarmMessageDeliveryTable.claim_expires_at),
          ),
        )
        .orderBy(asc(SwarmMessageDeliveryTable.claim_expires_at))
        .limit(1)
        .get()
        .pipe(Effect.orDie),
      readDb
        .select({ due: SwarmTaskTable.reserved_until })
        .from(SwarmTaskTable)
        .where(
          and(
            eq(SwarmTaskTable.status, "ready"),
            isNotNull(SwarmTaskTable.reserved_until),
          ),
        )
        .orderBy(asc(SwarmTaskTable.reserved_until))
        .limit(1)
        .get()
        .pipe(Effect.orDie),
      readDb
        .select({ id: SwarmTaskLeaseTable.task_id })
        .from(SwarmTaskLeaseTable)
        .where(eq(SwarmTaskLeaseTable.state, "retiring"))
        .orderBy(asc(SwarmTaskLeaseTable.retire_requested_at), asc(SwarmTaskLeaseTable.task_id))
        .limit(1)
        .get()
        .pipe(Effect.orDie),
    ])

    const candidates = [
      renewal?.due === undefined ? undefined : Math.max(request.now, renewal.due - renewAhead),
      future(expiry?.due),
      future(hold?.due),
      future(messageExpiry?.due),
      future(pendingDelivery?.due),
      future(claimedDelivery?.due),
      future(reservation?.due),
    ].filter((value): value is number => value !== undefined)
    const dispatchDue =
      (pendingDelivery?.due !== null &&
        pendingDelivery?.due !== undefined &&
        pendingDelivery.due <= request.now) ||
      (claimedDelivery?.due !== null &&
        claimedDelivery?.due !== undefined &&
        claimedDelivery.due <= request.now) ||
      (reservation?.due !== null && reservation?.due !== undefined && reservation.due <= request.now)
    return {
      ...(candidates.length === 0 ? {} : { at: Math.min(...candidates) }),
      hasRetiring: retiring !== undefined,
      dispatchDue,
    } satisfies RuntimeDeadlineState
  })

  return {
    sessionTaskAuthority,
    activeLeaseOwnerProcessIDs,
    processLeaseTargets,
    leaseRenewalTargets,
    expiredLeaseTargets,
    dueHoldTargets,
    retirementRequiredTargets,
    retiringTargets,
    nextRuntimeDeadline,
  }
}
