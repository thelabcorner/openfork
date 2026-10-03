export * as SwarmV2 from "./index"

import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer } from "effect"
import { Swarm as SwarmModel } from "@opencode-ai/schema/swarm"
import type { Definition } from "@opencode-ai/schema/event"
import { Database } from "../database/database"
import type { DatabaseShape } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { ProjectTable } from "../project/sql"
import { SessionTable } from "../session/sql"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { AbsolutePath } from "../schema"
import { rankCandidates, readinessStatus, validateDependencyGraph, type DependencyEdge } from "./graph"
import {
  hydrateDependency,
  hydrateInfo,
  hydrateMember,
  hydrateTask,
} from "./projection"
import { SwarmSchema } from "./schema"
import {
  requireMemberRow,
  requireSwarmRow,
  requireTaskRow,
  validateSessionBindingScope,
  validateSessionScope,
} from "./repository"
import { commitFail, publishWithCommit } from "./transaction"
import { makeLeaseOperations } from "./lease"
import { makeHandoffOperations, type HandoffLimits, type SwarmHandoff } from "./handoff"
import { makeObservabilityOperations } from "./observability"
import { makeMessagingOperations } from "./messaging"
import { makeSharedStateOperations } from "./shared-state"
import { makeRuntimeOperations } from "./runtime"
import { makeAggregateRecoveryOperations } from "./aggregate-recovery"
export type {
  LeaseRuntimeTarget,
  SessionTaskAuthority,
  RetirementRequiredTarget,
  RetirementRun,
  RetirementTarget,
  UnsettledTarget,
  NextRuntimeDeadlineInput,
  RuntimeDeadlineState,
} from "./runtime"
export {
  commitDeliveryAdmission,
} from "./messaging"
export { commitTaskRunAdmission } from "./lease"
export type {
  EnqueueMessageInput,
  DeliveryClaimToken,
  ClaimDeliveryInput,
  ReleaseDeliveryInput,
  DeliveryRelease,
  CommitDeliveryAdmissionInput,
  ExpireDeliveryInput,
} from "./messaging"
export type {
  PutBlackboardInput,
  ClaimToken,
  AcquireClaimInput,
  RenewClaimInput,
  ClaimConflictInput,
  ClaimConflict,
  PublishDeliverableInput,
  VerdictDeliverableInput,
} from "./shared-state"
export { SwarmClaims } from "./claims"
export type {
  LeaseToken,
  ClaimTaskInput,
  RenewTaskLeaseInput,
  HoldTaskInput,
  RequestTaskRetirementInput,
  RecordTaskRunInput,
  CommitTaskRunAdmissionInput,
  StartTaskRunInput,
  SettleTaskInput,
  TaskSettlement,
  TaskReviewDecision,
  ReviewTaskInput,
  RetirementReason,
} from "./lease"
import {
  SwarmMemberTable,
  SwarmMessageDeliveryTable,
  SwarmTable,
  SwarmTaskDependencyTable,
  SwarmTaskLeaseTable,
  SwarmTaskTable,
} from "./sql"

export const ID = SwarmModel.ID
export type ID = SwarmModel.ID
export const Info = SwarmModel.Info
export type Info = SwarmModel.Info
export const Member = SwarmModel.Member
export type Member = SwarmModel.Member
export const Task = SwarmModel.Task
export type Task = SwarmModel.Task
export const Event = SwarmModel.Event
export { SwarmSchema }

function absoluteDirectory(input: string) {
  const value = input.trim()
  if (!value) return undefined
  const normalized = value.replaceAll("\\", "/")
  return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
    ? AbsolutePath.make(value)
    : undefined
}

function memberName(input: string) {
  const value = input.trim()
  return value.length > 0 ? value : undefined
}

function taskTitle(input: string) {
  const value = input.trim()
  return value.length > 0 ? value : undefined
}

export interface CreateInput {
  readonly projectID: typeof ProjectTable.$inferSelect.id
  readonly directory: string
  readonly workspaceID?: typeof WorkspaceTable.$inferSelect.id
  readonly name: string
  readonly policy?: SwarmModel.Policy
  readonly now?: number
}

export interface PreflightMemberSessionInput {
  readonly projectID: typeof ProjectTable.$inferSelect.id
  readonly workspaceID?: typeof WorkspaceTable.$inferSelect.id
  readonly sessionID: typeof SessionTable.$inferSelect.id
}

export interface UpdateInput {
  readonly id: SwarmModel.ID
  readonly expectedRevision: number
  readonly name?: string
  readonly status?: SwarmModel.Status
  readonly policy?: SwarmModel.Policy
  readonly coordinatorMemberID?: SwarmModel.MemberID | null
  readonly now?: number
}

export interface AddMemberInput {
  readonly swarmID: SwarmModel.ID
  readonly name: string
  readonly kind: SwarmModel.MemberKind
  readonly role: string
  readonly sessionID?: typeof SessionTable.$inferSelect.id
  readonly desiredProfile?: SwarmModel.MemberExecutionProfile
  readonly workspacePolicy: SwarmModel.WorkspacePolicy
  readonly capabilities?: SwarmModel.MemberCapabilities
  readonly now?: number
}

export interface RebindMemberInput {
  readonly swarmID: SwarmModel.ID
  readonly memberID: SwarmModel.MemberID
  readonly expectedBindingGeneration: number
  readonly sessionID?: typeof SessionTable.$inferSelect.id
  readonly now?: number
}

export interface SetMemberLifecycleInput {
  readonly swarmID: SwarmModel.ID
  readonly memberID: SwarmModel.MemberID
  readonly expectedLifecycle: SwarmModel.MemberLifecycle
  readonly lifecycle: SwarmModel.MemberLifecycle
  readonly now?: number
}

export interface ConfigureMemberInput {
  readonly swarmID: SwarmModel.ID
  readonly memberID: SwarmModel.MemberID
  readonly expectedBindingGeneration: number
  readonly desiredProfile: SwarmModel.MemberExecutionProfile
  readonly workspacePolicy: SwarmModel.WorkspacePolicy
  readonly capabilities?: SwarmModel.MemberCapabilities
  readonly now?: number
}

/**
 * Cheap Tier-1 input for the runtime that materializes managed-member Sessions.
 * It deliberately contains only durable Swarm/member intent; live Session state
 * stays in Session and is resolved by the Tier-3 adapter.
 */
export interface MemberSessionTarget {
  readonly swarm: SwarmModel.Info
  readonly member: SwarmModel.Member
}

export interface ReadyAssignment {
  readonly task: SwarmModel.Task
  readonly member: SwarmModel.Member
}

export interface ProcessOwnedWork {
  readonly taskLeases: number
  readonly deliveryClaims: number
}

export interface SummaryListInput {
  readonly projectID?: typeof ProjectTable.$inferSelect.id
  readonly workspaceID?: typeof WorkspaceTable.$inferSelect.id
  readonly status?: SwarmModel.Status
  readonly limit?: number
}

export interface CreateTaskInput {
  readonly swarmID: SwarmModel.ID
  readonly id?: SwarmModel.TaskID
  readonly title: string
  readonly description?: string
  readonly priority?: number
  readonly createdByMemberID?: SwarmModel.MemberID
  readonly reservedMemberID?: SwarmModel.MemberID
  readonly reservedUntil?: number
  readonly acceptance?: SwarmModel.TaskAcceptance
  readonly metadata?: Record<string, unknown>
  readonly dependencies?: ReadonlyArray<{
    readonly taskID: SwarmModel.TaskID
    readonly requirement?: SwarmModel.DependencyRequirement
  }>
  readonly now?: number
}

export interface SetTaskDependenciesInput {
  readonly swarmID: SwarmModel.ID
  readonly taskID: SwarmModel.TaskID
  readonly dependencies: ReadonlyArray<{
    readonly taskID: SwarmModel.TaskID
    readonly requirement?: SwarmModel.DependencyRequirement
  }>
  readonly now?: number
}

export interface Interface
  extends ReturnType<typeof makeLeaseOperations>,
    ReturnType<typeof makeMessagingOperations>,
    ReturnType<typeof makeSharedStateOperations>,
    ReturnType<typeof makeRuntimeOperations>,
    ReturnType<typeof makeAggregateRecoveryOperations> {
  readonly create: (input: CreateInput) => Effect.Effect<SwarmModel.Info, SwarmSchema.Error>
  readonly info: (id: SwarmModel.ID) => Effect.Effect<SwarmModel.Info, SwarmSchema.Error>
  readonly get: (id: SwarmModel.ID) => Effect.Effect<SwarmModel.Detail, SwarmSchema.Error>
  readonly summary: (id: SwarmModel.ID) => Effect.Effect<SwarmModel.Summary, SwarmSchema.Error>
  /** Bootstrap-free bounded catalog projection. Aggregate counts are batched, never N+1. */
  readonly summaries: (input?: SummaryListInput) => Effect.Effect<ReadonlyArray<SwarmModel.Summary>>
  /**
   * Bootstrap-free compact lifecycle observability for one Swarm, aggregated
   * from durable `swarm_*` rows at the owning boundary. Consumers must read it
   * instead of recounting assignments, settlements, supersessions, peer
   * delivery, or shared-state writes from history or rendered rows.
   */
  readonly reliability: (input: {
    readonly swarmID: SwarmModel.ID
    readonly now?: number
  }) => Effect.Effect<SwarmModel.Reliability, SwarmSchema.Error>
  readonly list: (input?: {
    readonly projectID?: typeof ProjectTable.$inferSelect.id
    readonly status?: SwarmModel.Status
  }) => Effect.Effect<ReadonlyArray<SwarmModel.Info>>
  readonly update: (input: UpdateInput) => Effect.Effect<SwarmModel.Info, SwarmSchema.Error>
  /**
   * Read-only Core authority preflight for a prospective bound member Session.
   * Commit paths still revalidate transactionally; this exists only to reject
   * deterministic invalid coordinator bindings before Swarm.create writes.
   */
  readonly preflightMemberSession: (
    input: PreflightMemberSessionInput,
  ) => Effect.Effect<void, SwarmSchema.Error>
  readonly addMember: (input: AddMemberInput) => Effect.Effect<SwarmModel.Member, SwarmSchema.Error>
  readonly rebindMember: (input: RebindMemberInput) => Effect.Effect<SwarmModel.Member, SwarmSchema.Error>
  readonly setMemberLifecycle: (
    input: SetMemberLifecycleInput,
  ) => Effect.Effect<SwarmModel.Member, SwarmSchema.Error>
  /**
   * Replace a managed worker's durable execution intent only at a proven
   * stopped/unbound boundary. Current Session model/permission truth is never
   * rewritten in-place; resume materializes a fresh binding from this intent.
   */
  readonly configureMember: (
    input: ConfigureMemberInput,
  ) => Effect.Effect<SwarmModel.Member, SwarmSchema.Error>
  readonly memberSessionTarget: (
    swarmID: SwarmModel.ID,
    memberID: SwarmModel.MemberID,
  ) => Effect.Effect<MemberSessionTarget, SwarmSchema.Error>
  readonly unboundManagedMemberTargets: (input?: {
    readonly projectID?: typeof ProjectTable.$inferSelect.id
    readonly swarmID?: SwarmModel.ID
  }) => Effect.Effect<ReadonlyArray<MemberSessionTarget>>
  /** Bootstrap-free, bounded scheduler projection over currently assignable work. */
  readonly readyAssignments: (input?: {
    readonly now?: number
    readonly limit?: number
  }) => Effect.Effect<ReadonlyArray<ReadyAssignment>>
  /** Cheap authoritative liveness projection used by process-global owner retention. */
  readonly processOwnedWork: (processOwner: string) => Effect.Effect<ProcessOwnedWork>
  readonly createTask: (input: CreateTaskInput) => Effect.Effect<SwarmModel.Task, SwarmSchema.Error>
  readonly setTaskDependencies: (
    input: SetTaskDependenciesInput,
  ) => Effect.Effect<SwarmModel.Task, SwarmSchema.Error>
  readonly dependencies: (
    taskID: SwarmModel.TaskID,
  ) => Effect.Effect<ReadonlyArray<SwarmModel.TaskDependency>>
  /** Bootstrap-free whole-DAG edge projection for explicit Swarm detail surfaces. */
  readonly dependenciesForSwarm: (
    swarmID: SwarmModel.ID,
  ) => Effect.Effect<ReadonlyArray<SwarmModel.TaskDependency>>
  /**
   * Bootstrap-free bounded predecessor knowledge handoff for one task. Reads
   * Swarm collaboration tables only; it never hydrates predecessor Session
   * history, so its cost is independent of predecessor run history length.
   */
  readonly taskHandoff: (
    taskID: SwarmModel.TaskID,
    options?: { readonly swarmID?: SwarmModel.ID; readonly limits?: HandoffLimits },
  ) => Effect.Effect<SwarmHandoff>
  /**
   * Cheap reverse binding lookup for Session-control/navigation policy.
   * A Session may intentionally participate in more than one Swarm.
   */
  readonly membersForSession: (
    sessionID: typeof SessionTable.$inferSelect.id,
  ) => Effect.Effect<ReadonlyArray<SwarmModel.Member>>
  readonly navigation: (input?: {
    readonly projectID?: typeof ProjectTable.$inferSelect.id
  }) => Effect.Effect<ReadonlyArray<SwarmModel.NavigationGroup>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Swarm") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db, readDb } = yield* Database.Service
    const events = yield* EventV2.Service
    const lease = makeLeaseOperations({ db, readDb, events })
    const messaging = makeMessagingOperations({ db, readDb, events })
    const sharedState = makeSharedStateOperations({ db, readDb, events })
    const runtime = makeRuntimeOperations({ readDb })
    const handoff = makeHandoffOperations({ readDb })
    const aggregateRecovery = makeAggregateRecoveryOperations({ readDb })
    const observability = makeObservabilityOperations({ readDb })

    const create = Effect.fn("Swarm.create")(function* (input: CreateInput) {
      const directory = absoluteDirectory(input.directory)
      if (!directory)
        return yield* new SwarmSchema.ValidationError({
          reason: `directory must be an absolute path: ${input.directory}`,
        })
      const name = memberName(input.name)
      if (!name) return yield* new SwarmSchema.ValidationError({ reason: "Swarm name is required." })
      const now = input.now ?? Date.now()
      const id = SwarmModel.ID.create()
      const info = SwarmModel.Info.make({
        id,
        projectID: input.projectID,
        directory,
        ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
        name,
        status: "creating",
        policy: input.policy ?? {},
        revision: 0,
        time: {
          created: DateTime.makeUnsafe(now),
          updated: DateTime.makeUnsafe(now),
        },
      })
      yield* publishWithCommit(events, Event.Created, { swarmID: id, info }, () =>
        Effect.gen(function* () {
          const project = yield* db
            .select({ id: ProjectTable.id })
            .from(ProjectTable)
            .where(eq(ProjectTable.id, input.projectID))
            .get()
            .pipe(Effect.orDie)
          if (!project)
            return yield* commitFail(
              new SwarmSchema.ValidationError({ reason: `Project not found: ${input.projectID}` }),
            )
          if (input.workspaceID) {
            const workspace = yield* db
              .select({ projectID: WorkspaceTable.project_id })
              .from(WorkspaceTable)
              .where(eq(WorkspaceTable.id, input.workspaceID))
              .get()
              .pipe(Effect.orDie)
            if (!workspace || workspace.projectID !== input.projectID)
              return yield* commitFail(
                new SwarmSchema.ValidationError({
                  reason: `Workspace ${input.workspaceID} is not part of project ${input.projectID}.`,
                }),
              )
          }
          const existing = yield* db
            .select({ id: SwarmTable.id })
            .from(SwarmTable)
            .where(eq(SwarmTable.id, id))
            .get()
            .pipe(Effect.orDie)
          if (existing)
            return yield* commitFail(
              new SwarmSchema.ConflictError({ code: "swarm.id_exists", reason: `Swarm already exists: ${id}` }),
            )
          yield* db
            .insert(SwarmTable)
            .values({
              id,
              project_id: input.projectID,
              directory,
              workspace_id: input.workspaceID,
              name,
              status: "creating",
              policy: input.policy ?? {},
              revision: 0,
              time_created: now,
              time_updated: now,
            })
            .run()
            .pipe(Effect.orDie)
        }),
      )
      return info
    })

    const list = Effect.fn("Swarm.list")(function* (input?: {
      readonly projectID?: typeof ProjectTable.$inferSelect.id
      readonly status?: SwarmModel.Status
    }) {
      const conditions = [
        input?.projectID === undefined ? undefined : eq(SwarmTable.project_id, input.projectID),
        input?.status === undefined ? undefined : eq(SwarmTable.status, input.status),
      ].filter((item): item is Exclude<typeof item, undefined> => item !== undefined)
      const rows = yield* readDb
        .select()
        .from(SwarmTable)
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .orderBy(asc(SwarmTable.time_created), asc(SwarmTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(hydrateInfo)
    })

    const info = Effect.fn("Swarm.info")(function* (id: SwarmModel.ID) {
      return hydrateInfo(yield* requireSwarmRow(readDb, id))
    })

    const get = Effect.fn("Swarm.get")(function* (id: SwarmModel.ID) {
      const swarm = yield* requireSwarmRow(readDb, id)
      const [members, tasks] = yield* Effect.all([
        readDb
          .select()
          .from(SwarmMemberTable)
          .where(eq(SwarmMemberTable.swarm_id, id))
          .orderBy(asc(SwarmMemberTable.time_created), asc(SwarmMemberTable.id))
          .all()
          .pipe(Effect.orDie),
        readDb
          .select()
          .from(SwarmTaskTable)
          .where(eq(SwarmTaskTable.swarm_id, id))
          .orderBy(asc(SwarmTaskTable.time_created), asc(SwarmTaskTable.id))
          .all()
          .pipe(Effect.orDie),
      ])
      return SwarmModel.Detail.make({
        swarm: hydrateInfo(swarm),
        members: members.map(hydrateMember),
        tasks: tasks.map(hydrateTask),
      })
    })

    const summary = Effect.fn("Swarm.summary")(function* (id: SwarmModel.ID) {
      const swarm = yield* requireSwarmRow(readDb, id)
      const [memberCount, boundMemberCount, readyTaskCount, workingTaskCount, pendingDeliveryCount] =
        yield* Effect.all([
          readDb
            .select({ count: sql<number>`count(*)` })
            .from(SwarmMemberTable)
            .where(eq(SwarmMemberTable.swarm_id, id))
            .get()
            .pipe(Effect.orDie, Effect.map((row) => Number(row?.count ?? 0))),
          readDb
            .select({ count: sql<number>`count(*)` })
            .from(SwarmMemberTable)
            .where(and(eq(SwarmMemberTable.swarm_id, id), sql`${SwarmMemberTable.session_id} IS NOT NULL`))
            .get()
            .pipe(Effect.orDie, Effect.map((row) => Number(row?.count ?? 0))),
          readDb
            .select({ count: sql<number>`count(*)` })
            .from(SwarmTaskTable)
            .where(and(eq(SwarmTaskTable.swarm_id, id), eq(SwarmTaskTable.status, "ready")))
            .get()
            .pipe(Effect.orDie, Effect.map((row) => Number(row?.count ?? 0))),
          readDb
            .select({ count: sql<number>`count(*)` })
            .from(SwarmTaskTable)
            .where(and(eq(SwarmTaskTable.swarm_id, id), eq(SwarmTaskTable.status, "working")))
            .get()
            .pipe(Effect.orDie, Effect.map((row) => Number(row?.count ?? 0))),
          readDb
            .select({ count: sql<number>`count(*)` })
            .from(SwarmMessageDeliveryTable)
            .innerJoin(SwarmMemberTable, eq(SwarmMessageDeliveryTable.recipient_member_id, SwarmMemberTable.id))
            .where(and(eq(SwarmMemberTable.swarm_id, id), eq(SwarmMessageDeliveryTable.state, "pending")))
            .get()
            .pipe(Effect.orDie, Effect.map((row) => Number(row?.count ?? 0))),
        ])
      return SwarmModel.Summary.make({
        swarm: hydrateInfo(swarm),
        memberCount,
        boundMemberCount,
        readyTaskCount,
        workingTaskCount,
        pendingDeliveryCount,
      })
    })

    const summaries = Effect.fn("Swarm.summaries")(function* (input?: SummaryListInput) {
      const limit = Math.min(500, Math.max(1, Math.trunc(input?.limit ?? 100)))
      const conditions = [
        input?.projectID === undefined ? undefined : eq(SwarmTable.project_id, input.projectID),
        input?.workspaceID === undefined ? undefined : eq(SwarmTable.workspace_id, input.workspaceID),
        input?.status === undefined ? undefined : eq(SwarmTable.status, input.status),
      ].filter((item): item is Exclude<typeof item, undefined> => item !== undefined)
      const swarmRows = yield* readDb
        .select()
        .from(SwarmTable)
        .where(conditions.length === 0 ? undefined : and(...conditions))
        .orderBy(asc(SwarmTable.time_created), asc(SwarmTable.id))
        .limit(limit)
        .all()
        .pipe(Effect.orDie)
      if (swarmRows.length === 0) return []

      const ids = swarmRows.map((row) => row.id)
      const [memberRows, taskRows, deliveryRows] = yield* Effect.all([
        readDb
          .select({
            swarmID: SwarmMemberTable.swarm_id,
            memberCount: sql<number>`count(*)`,
            boundMemberCount: sql<number>`sum(case when ${SwarmMemberTable.session_id} is not null then 1 else 0 end)`,
          })
          .from(SwarmMemberTable)
          .where(inArray(SwarmMemberTable.swarm_id, ids))
          .groupBy(SwarmMemberTable.swarm_id)
          .all()
          .pipe(Effect.orDie),
        readDb
          .select({
            swarmID: SwarmTaskTable.swarm_id,
            readyTaskCount: sql<number>`sum(case when ${SwarmTaskTable.status} = 'ready' then 1 else 0 end)`,
            workingTaskCount: sql<number>`sum(case when ${SwarmTaskTable.status} = 'working' then 1 else 0 end)`,
          })
          .from(SwarmTaskTable)
          .where(inArray(SwarmTaskTable.swarm_id, ids))
          .groupBy(SwarmTaskTable.swarm_id)
          .all()
          .pipe(Effect.orDie),
        readDb
          .select({
            swarmID: SwarmMemberTable.swarm_id,
            pendingDeliveryCount: sql<number>`count(*)`,
          })
          .from(SwarmMessageDeliveryTable)
          .innerJoin(SwarmMemberTable, eq(SwarmMessageDeliveryTable.recipient_member_id, SwarmMemberTable.id))
          .where(
            and(
              inArray(SwarmMemberTable.swarm_id, ids),
              eq(SwarmMessageDeliveryTable.state, "pending"),
            ),
          )
          .groupBy(SwarmMemberTable.swarm_id)
          .all()
          .pipe(Effect.orDie),
      ])
      const members = new Map(memberRows.map((row) => [row.swarmID, row]))
      const tasks = new Map(taskRows.map((row) => [row.swarmID, row]))
      const deliveries = new Map(deliveryRows.map((row) => [row.swarmID, row]))

      return swarmRows.map((row) => {
        const member = members.get(row.id)
        const task = tasks.get(row.id)
        const delivery = deliveries.get(row.id)
        return SwarmModel.Summary.make({
          swarm: hydrateInfo(row),
          memberCount: Number(member?.memberCount ?? 0),
          boundMemberCount: Number(member?.boundMemberCount ?? 0),
          readyTaskCount: Number(task?.readyTaskCount ?? 0),
          workingTaskCount: Number(task?.workingTaskCount ?? 0),
          pendingDeliveryCount: Number(delivery?.pendingDeliveryCount ?? 0),
        })
      })
    })

    const update = Effect.fn("Swarm.update")(function* (input: UpdateInput) {
      const current = yield* requireSwarmRow(readDb, input.id)
      if (current.revision !== input.expectedRevision)
        return yield* new SwarmSchema.StaleRevisionError({
          swarmID: input.id,
          expectedRevision: input.expectedRevision,
          actualRevision: current.revision,
        })
      const name = input.name === undefined ? current.name : memberName(input.name)
      if (!name) return yield* new SwarmSchema.ValidationError({ reason: "Swarm name is required." })
      const now = input.now ?? Date.now()
      const nextRevision = current.revision + 1
      const nextStatus = input.status ?? current.status
      const coordinatorMemberID =
        input.coordinatorMemberID === undefined ? current.coordinator_member_id : input.coordinatorMemberID
      const info = hydrateInfo({
        ...current,
        name,
        status: nextStatus,
        policy: input.policy ?? current.policy,
        coordinator_member_id: coordinatorMemberID,
        revision: nextRevision,
        time_updated: now,
        time_completed:
          nextStatus === "completed" || nextStatus === "failed" ? current.time_completed ?? now : current.time_completed,
        time_archived: nextStatus === "archived" ? current.time_archived ?? now : current.time_archived,
      })
      yield* publishWithCommit(events, Event.Updated, { swarmID: input.id, info }, () =>
        Effect.gen(function* () {
          if (coordinatorMemberID) {
            const member = yield* db
              .select({ lifecycle: SwarmMemberTable.lifecycle })
              .from(SwarmMemberTable)
              .where(
                and(
                  eq(SwarmMemberTable.id, coordinatorMemberID),
                  eq(SwarmMemberTable.swarm_id, input.id),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (!member || member.lifecycle === "stopped")
              return yield* commitFail(
                new SwarmSchema.ValidationError({
                  reason: `Coordinator member ${coordinatorMemberID} is not an active member of Swarm ${input.id}.`,
                }),
              )
          }
          const changed = yield* db
            .update(SwarmTable)
            .set({
              name,
              status: nextStatus,
              policy: input.policy ?? current.policy,
              coordinator_member_id: coordinatorMemberID,
              revision: nextRevision,
              time_updated: now,
              time_completed:
                nextStatus === "completed" || nextStatus === "failed"
                  ? current.time_completed ?? now
                  : current.time_completed,
              time_archived: nextStatus === "archived" ? current.time_archived ?? now : current.time_archived,
            })
            .where(and(eq(SwarmTable.id, input.id), eq(SwarmTable.revision, input.expectedRevision)))
            .returning({ revision: SwarmTable.revision })
            .get()
            .pipe(Effect.orDie)
          if (!changed) {
            const actual = yield* db
              .select({ revision: SwarmTable.revision })
              .from(SwarmTable)
              .where(eq(SwarmTable.id, input.id))
              .get()
              .pipe(Effect.orDie)
            if (!actual)
              return yield* commitFail(new SwarmSchema.NotFoundError({ entity: "swarm", id: input.id }))
            return yield* commitFail(
              new SwarmSchema.StaleRevisionError({
                swarmID: input.id,
                expectedRevision: input.expectedRevision,
                actualRevision: actual.revision,
              }),
            )
          }
        }),
      )
      return info
    })

    const preflightMemberSession = Effect.fn("Swarm.preflightMemberSession")(function* (
      input: PreflightMemberSessionInput,
    ) {
      yield* validateSessionBindingScope(
        readDb,
        {
          projectID: input.projectID,
          ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
        },
        input.sessionID,
      )
    })

    const addMember = Effect.fn("Swarm.addMember")(function* (input: AddMemberInput) {
      const swarm = yield* requireSwarmRow(readDb, input.swarmID)
      const name = memberName(input.name)
      if (!name) return yield* new SwarmSchema.ValidationError({ reason: "Member name is required." })
      const role = input.role.trim()
      if (!role) return yield* new SwarmSchema.ValidationError({ reason: "Member role is required." })
      if (input.kind === "managed_worker" && input.desiredProfile === undefined) {
        return yield* new SwarmSchema.ValidationError({
          reason: "Managed worker members require a desired execution profile.",
        })
      }
      const now = input.now ?? Date.now()
      const member = SwarmModel.Member.make({
        id: SwarmModel.MemberID.create(),
        swarmID: input.swarmID,
        name,
        kind: input.kind,
        role,
        lifecycle: "active",
        ...(input.sessionID === undefined ? {} : { sessionID: input.sessionID }),
        bindingGeneration: input.sessionID === undefined ? 0 : 1,
        ...(input.desiredProfile === undefined ? {} : { desiredProfile: input.desiredProfile }),
        workspacePolicy: input.workspacePolicy,
        ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
        time: {
          created: DateTime.makeUnsafe(now),
          updated: DateTime.makeUnsafe(now),
        },
      })
      yield* publishWithCommit(events, Event.MemberUpdated, { swarmID: input.swarmID, member }, () =>
        Effect.gen(function* () {
          if (input.sessionID) {
            const scoped = yield* validateSessionScope(db, swarm, input.sessionID).pipe(
              Effect.catch((error) => commitFail(error)),
            )
            void scoped
          }
          const duplicateName = yield* db
            .select({ id: SwarmMemberTable.id })
            .from(SwarmMemberTable)
            .where(and(eq(SwarmMemberTable.swarm_id, input.swarmID), eq(SwarmMemberTable.name, name)))
            .get()
            .pipe(Effect.orDie)
          if (duplicateName)
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.member_name_exists",
                reason: `Member name already exists in Swarm ${input.swarmID}: ${name}`,
              }),
            )
          if (input.sessionID) {
            const duplicateBinding = yield* db
              .select({ id: SwarmMemberTable.id })
              .from(SwarmMemberTable)
              .where(
                and(
                  eq(SwarmMemberTable.swarm_id, input.swarmID),
                  eq(SwarmMemberTable.session_id, input.sessionID),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (duplicateBinding)
              return yield* commitFail(
                new SwarmSchema.ConflictError({
                  code: "swarm.session_already_bound",
                  reason: `Session ${input.sessionID} is already bound inside Swarm ${input.swarmID}.`,
                }),
              )
          }
          yield* db
            .insert(SwarmMemberTable)
            .values({
              id: member.id,
              swarm_id: input.swarmID,
              name,
              kind: input.kind,
              role,
              lifecycle: "active",
              session_id: input.sessionID,
              binding_generation: member.bindingGeneration,
              desired_profile: input.desiredProfile,
              workspace_policy: input.workspacePolicy,
              capabilities: input.capabilities,
              time_created: now,
              time_updated: now,
            })
            .run()
            .pipe(Effect.orDie)
        }),
      )
      return member
    })

    const rebindMember = Effect.fn("Swarm.rebindMember")(function* (input: RebindMemberInput) {
      const swarm = yield* requireSwarmRow(readDb, input.swarmID)
      const current = yield* requireMemberRow(readDb, input.swarmID, input.memberID)
      if (current.binding_generation !== input.expectedBindingGeneration)
        return yield* new SwarmSchema.StaleFenceError({
          fence: "member_binding",
          id: input.memberID,
          expectedGeneration: input.expectedBindingGeneration,
          actualGeneration: current.binding_generation,
        })
      const now = input.now ?? Date.now()
      const nextGeneration = current.binding_generation + 1
      const member = hydrateMember({
        ...current,
        session_id: input.sessionID ?? null,
        binding_generation: nextGeneration,
        time_updated: now,
      })
      yield* publishWithCommit(events, Event.MemberUpdated, { swarmID: input.swarmID, member }, () =>
        Effect.gen(function* () {
          if (input.sessionID) {
            yield* validateSessionScope(db, swarm, input.sessionID).pipe(
              Effect.catch((error) => commitFail(error)),
            )
            const duplicate = yield* db
              .select({ id: SwarmMemberTable.id })
              .from(SwarmMemberTable)
              .where(
                and(
                  eq(SwarmMemberTable.swarm_id, input.swarmID),
                  eq(SwarmMemberTable.session_id, input.sessionID),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (duplicate && duplicate.id !== input.memberID)
              return yield* commitFail(
                new SwarmSchema.ConflictError({
                  code: "swarm.session_already_bound",
                  reason: `Session ${input.sessionID} is already bound inside Swarm ${input.swarmID}.`,
                }),
              )
          }
          const changed = yield* db
            .update(SwarmMemberTable)
            .set({
              session_id: input.sessionID ?? null,
              binding_generation: nextGeneration,
              time_updated: now,
            })
            .where(
              and(
                eq(SwarmMemberTable.id, input.memberID),
                eq(SwarmMemberTable.swarm_id, input.swarmID),
                eq(SwarmMemberTable.binding_generation, input.expectedBindingGeneration),
              ),
            )
            .returning({ generation: SwarmMemberTable.binding_generation })
            .get()
            .pipe(Effect.orDie)
          if (!changed) {
            const actual = yield* db
              .select({ generation: SwarmMemberTable.binding_generation })
              .from(SwarmMemberTable)
              .where(
                and(
                  eq(SwarmMemberTable.id, input.memberID),
                  eq(SwarmMemberTable.swarm_id, input.swarmID),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (!actual)
              return yield* commitFail(new SwarmSchema.NotFoundError({ entity: "member", id: input.memberID }))
            return yield* commitFail(
              new SwarmSchema.StaleFenceError({
                fence: "member_binding",
                id: input.memberID,
                expectedGeneration: input.expectedBindingGeneration,
                actualGeneration: actual.generation,
              }),
            )
          }
        }),
      )
      return member
    })

    const setMemberLifecycle = Effect.fn("Swarm.setMemberLifecycle")(function* (
      input: SetMemberLifecycleInput,
    ) {
      const current = yield* requireMemberRow(readDb, input.swarmID, input.memberID)
      if (current.lifecycle !== input.expectedLifecycle)
        return yield* new SwarmSchema.InvalidTransitionError({
          entity: "member",
          id: input.memberID,
          from: current.lifecycle,
          to: input.lifecycle,
        })
      const now = input.now ?? Date.now()
      const stopping = input.lifecycle === "stopped"
      const nextGeneration = stopping ? current.binding_generation + 1 : current.binding_generation
      const member = hydrateMember({
        ...current,
        lifecycle: input.lifecycle,
        session_id: stopping ? null : current.session_id,
        binding_generation: nextGeneration,
        time_updated: now,
        time_stopped: stopping ? now : input.lifecycle === "active" ? null : current.time_stopped,
      })
      yield* publishWithCommit(events, Event.MemberUpdated, { swarmID: input.swarmID, member }, () =>
        Effect.gen(function* () {
          const changed = yield* db
            .update(SwarmMemberTable)
            .set({
              lifecycle: input.lifecycle,
              session_id: stopping ? null : current.session_id,
              binding_generation: nextGeneration,
              time_updated: now,
              time_stopped: stopping ? now : input.lifecycle === "active" ? null : current.time_stopped,
            })
            .where(
              and(
                eq(SwarmMemberTable.id, input.memberID),
                eq(SwarmMemberTable.swarm_id, input.swarmID),
                eq(SwarmMemberTable.lifecycle, input.expectedLifecycle),
                eq(SwarmMemberTable.binding_generation, current.binding_generation),
              ),
            )
            .returning({ id: SwarmMemberTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!changed)
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.member_changed",
                reason: `Member ${input.memberID} changed concurrently.`,
              }),
            )
        }),
      )
      return member
    })

    const configureMember = Effect.fn("Swarm.configureMember")(function* (input: ConfigureMemberInput) {
      const current = yield* requireMemberRow(readDb, input.swarmID, input.memberID)
      if (current.kind !== "managed_worker")
        return yield* new SwarmSchema.ValidationError({
          reason: "Only managed workers have configurable execution profiles: " + input.memberID + ".",
        })
      if (current.binding_generation !== input.expectedBindingGeneration)
        return yield* new SwarmSchema.StaleFenceError({
          fence: "member_binding",
          id: input.memberID,
          expectedGeneration: input.expectedBindingGeneration,
          actualGeneration: current.binding_generation,
        })
      if (current.lifecycle !== "stopped" || current.session_id !== null)
        return yield* new SwarmSchema.ConflictError({
          code: "swarm.member_configuration_requires_stopped",
          reason: "Member " + input.memberID + " must be stopped and unbound before changing execution profile.",
        })
      const now = input.now ?? Date.now()
      const member = hydrateMember({
        ...current,
        desired_profile: input.desiredProfile,
        workspace_policy: input.workspacePolicy,
        capabilities: input.capabilities ?? null,
        time_updated: now,
      })
      yield* publishWithCommit(events, Event.MemberUpdated, { swarmID: input.swarmID, member }, () =>
        Effect.gen(function* () {
          const changed = yield* db
            .update(SwarmMemberTable)
            .set({
              desired_profile: input.desiredProfile,
              workspace_policy: input.workspacePolicy,
              capabilities: input.capabilities ?? null,
              time_updated: now,
            })
            .where(
              and(
                eq(SwarmMemberTable.id, input.memberID),
                eq(SwarmMemberTable.swarm_id, input.swarmID),
                eq(SwarmMemberTable.kind, "managed_worker"),
                eq(SwarmMemberTable.lifecycle, "stopped"),
                isNull(SwarmMemberTable.session_id),
                eq(SwarmMemberTable.binding_generation, input.expectedBindingGeneration),
              ),
            )
            .returning({ id: SwarmMemberTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!changed)
            return yield* commitFail(
              new SwarmSchema.ConflictError({
                code: "swarm.member_configuration_changed",
                reason: "Member " + input.memberID + " changed before configuration committed.",
              }),
            )
        }),
      )
      return member
    })

    const memberSessionTarget = Effect.fn("Swarm.memberSessionTarget")(function* (
      swarmID: SwarmModel.ID,
      memberID: SwarmModel.MemberID,
    ) {
      const [swarm, member] = yield* Effect.all([
        requireSwarmRow(readDb, swarmID),
        requireMemberRow(readDb, swarmID, memberID),
      ])
      return {
        swarm: hydrateInfo(swarm),
        member: hydrateMember(member),
      } satisfies MemberSessionTarget
    })

    const unboundManagedMemberTargets = Effect.fn("Swarm.unboundManagedMemberTargets")(function* (input?: {
      readonly projectID?: typeof ProjectTable.$inferSelect.id
      readonly swarmID?: SwarmModel.ID
    }) {
      const swarmConditions = [
        input?.projectID === undefined ? undefined : eq(SwarmTable.project_id, input.projectID),
        input?.swarmID === undefined ? undefined : eq(SwarmTable.id, input.swarmID),
      ].filter((item): item is Exclude<typeof item, undefined> => item !== undefined)
      const swarmRows = yield* readDb
        .select()
        .from(SwarmTable)
        .where(and(...swarmConditions))
        .orderBy(asc(SwarmTable.time_created), asc(SwarmTable.id))
        .all()
        .pipe(Effect.orDie)
      if (swarmRows.length === 0) return []

      const memberRows = yield* readDb
        .select()
        .from(SwarmMemberTable)
        .where(
          and(
            inArray(
              SwarmMemberTable.swarm_id,
              swarmRows.map((row) => row.id),
            ),
            eq(SwarmMemberTable.kind, "managed_worker"),
            sql`${SwarmMemberTable.session_id} IS NULL`,
          ),
        )
        .orderBy(asc(SwarmMemberTable.swarm_id), asc(SwarmMemberTable.time_created), asc(SwarmMemberTable.id))
        .all()
        .pipe(Effect.orDie)
      const swarms = new Map(swarmRows.map((row) => [row.id, hydrateInfo(row)] as const))
      return memberRows.flatMap((row) => {
        const swarm = swarms.get(row.swarm_id)
        return swarm
          ? [
              {
                swarm,
                member: hydrateMember(row),
              } satisfies MemberSessionTarget,
            ]
          : []
      })
    })

    const readyAssignments = Effect.fn("Swarm.readyAssignments")(function* (input?: {
      readonly now?: number
      readonly limit?: number
    }) {
      const now = input?.now ?? Date.now()
      const limit = Math.min(64, Math.max(1, Math.trunc(input?.limit ?? 16)))

      // Only genuinely assignable tasks enter the bounded window. The partial
      // dispatch index makes this scan proportional to ready work rather than
      // total task history, while the correlated member predicate prevents a
      // queue of unavailable tasks from starving later runnable work.
      const candidateIDs = yield* readDb.all<{ id: SwarmModel.TaskID }>(sql`
        SELECT task.id AS id
        FROM swarm_task AS task INDEXED BY swarm_task_dispatch_ready_idx
        INNER JOIN swarm AS owner_swarm ON owner_swarm.id = task.swarm_id
        WHERE task.status = 'ready'
          AND owner_swarm.status = 'active'
          AND EXISTS (
            SELECT 1
            FROM swarm_member AS member
            WHERE member.swarm_id = task.swarm_id
              AND member.kind = 'managed_worker'
              AND member.lifecycle = 'active'
              AND member.session_id IS NOT NULL
              AND (
                task.reserved_member_id IS NULL
                OR (task.reserved_until IS NOT NULL AND task.reserved_until <= ${now})
                OR member.id = task.reserved_member_id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM swarm_task_lease AS busy
                WHERE busy.owner_member_id = member.id
                   OR busy.owner_session_id = member.session_id
              )
          )
        ORDER BY task.priority DESC, task.ready_at, task.time_created, task.id
        LIMIT ${limit}
      `).pipe(Effect.orDie)
      if (candidateIDs.length === 0) return []

      const taskRows = yield* readDb
        .select()
        .from(SwarmTaskTable)
        .where(inArray(SwarmTaskTable.id, candidateIDs.map((row) => row.id)))
        .all()
        .pipe(Effect.orDie)
      const taskOrder = new Map(candidateIDs.map((row, index) => [row.id, index] as const))
      taskRows.sort((a, b) => (taskOrder.get(a.id) ?? 0) - (taskOrder.get(b.id) ?? 0))

      const swarmIDs = [...new Set(taskRows.map((row) => row.swarm_id))]
      const memberRows = yield* readDb
        .select()
        .from(SwarmMemberTable)
        .where(
          and(
            inArray(SwarmMemberTable.swarm_id, swarmIDs),
            eq(SwarmMemberTable.kind, "managed_worker"),
            eq(SwarmMemberTable.lifecycle, "active"),
            isNotNull(SwarmMemberTable.session_id),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      if (memberRows.length === 0) return []

      const memberIDs = memberRows.map((row) => row.id)
      const sessionIDs = memberRows.flatMap((row) => (row.session_id ? [row.session_id] : []))
      if (sessionIDs.length === 0) return []
      const occupiedRows = yield* readDb
        .select({ memberID: SwarmTaskLeaseTable.owner_member_id, sessionID: SwarmTaskLeaseTable.owner_session_id })
        .from(SwarmTaskLeaseTable)
        .where(
          or(
            inArray(SwarmTaskLeaseTable.owner_member_id, memberIDs),
            inArray(SwarmTaskLeaseTable.owner_session_id, sessionIDs),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const occupiedMembers = new Set(occupiedRows.map((row) => row.memberID))
      const occupiedSessions = new Set(occupiedRows.map((row) => row.sessionID))
      const allocatedMembers = new Set<SwarmModel.MemberID>()
      const allocatedSessions = new Set<string>()
      const bySwarm = new Map<SwarmModel.ID, SwarmModel.Member[]>()
      for (const row of memberRows) {
        if (!row.session_id || occupiedMembers.has(row.id) || occupiedSessions.has(row.session_id)) continue
        const member = hydrateMember(row)
        const list = bySwarm.get(row.swarm_id)
        if (list) list.push(member)
        else bySwarm.set(row.swarm_id, [member])
      }

      const result: ReadyAssignment[] = []
      for (const row of taskRows) {
        const task = hydrateTask(row)
        const reservationActive =
          task.reservedMemberID !== undefined &&
          (task.reservedUntil === undefined || DateTime.toEpochMillis(task.reservedUntil) > now)
        let candidates = (bySwarm.get(task.swarmID) ?? []).filter(
          (member) =>
            member.sessionID !== undefined &&
            !allocatedMembers.has(member.id) &&
            !allocatedSessions.has(member.sessionID),
        )
        if (reservationActive) candidates = candidates.filter((member) => member.id === task.reservedMemberID)

        // Typed task capability/scope requirements do not exist yet. Never infer
        // authority from prose or arbitrary metadata; affinity remains a low-
        // authority deterministic tie-break after every expressible hard gate.
        const ranked = rankCandidates(task, candidates)[0]
        const member = ranked ? candidates.find((candidate) => candidate.id === ranked.id) : undefined
        if (!member?.sessionID) continue
        result.push({ task, member })
        allocatedMembers.add(member.id)
        allocatedSessions.add(member.sessionID)
      }
      return result
    })

    const processOwnedWork = Effect.fn("Swarm.processOwnedWork")(function* (processOwner: string) {
      const owner = processOwner.trim()
      if (!owner) return { taskLeases: 0, deliveryClaims: 0 } satisfies ProcessOwnedWork
      const [taskRow, deliveryRow] = yield* Effect.all([
        readDb
          .select({ count: sql<number>`count(*)` })
          .from(SwarmTaskLeaseTable)
          .where(eq(SwarmTaskLeaseTable.lease_owner_process, owner))
          .get()
          .pipe(Effect.orDie),
        readDb
          .select({ count: sql<number>`count(*)` })
          .from(SwarmMessageDeliveryTable)
          .where(
            and(
              eq(SwarmMessageDeliveryTable.state, "claimed"),
              eq(SwarmMessageDeliveryTable.claim_owner, owner),
            ),
          )
          .get()
          .pipe(Effect.orDie),
      ])
      return {
        taskLeases: Number(taskRow?.count ?? 0),
        deliveryClaims: Number(deliveryRow?.count ?? 0),
      } satisfies ProcessOwnedWork
    })

    const createTask = Effect.fn("Swarm.createTask")(function* (input: CreateTaskInput) {
      yield* requireSwarmRow(readDb, input.swarmID)
      const title = taskTitle(input.title)
      if (!title) return yield* new SwarmSchema.ValidationError({ reason: "Task title is required." })
      const id = input.id ?? SwarmModel.TaskID.create()
      const dependencies = [...(input.dependencies ?? [])].map((item) => ({
        taskID: id,
        dependsOnTaskID: item.taskID,
        requirement: item.requirement ?? "require_success",
      })) satisfies SwarmModel.TaskDependency[]
      const dependencyIDs = dependencies.map((item) => item.dependsOnTaskID)
      const dependencyRows =
        dependencyIDs.length === 0
          ? []
          : yield* readDb
              .select()
              .from(SwarmTaskTable)
              .where(
                and(
                  eq(SwarmTaskTable.swarm_id, input.swarmID),
                  inArray(SwarmTaskTable.id, dependencyIDs),
                ),
              )
              .all()
              .pipe(Effect.orDie)
      if (dependencyRows.length !== new Set(dependencyIDs).size)
        return yield* new SwarmSchema.ValidationError({
          reason: "Every task dependency must exist in the same Swarm.",
        })
      const prerequisite = new Map(dependencyRows.map((row) => [row.id, row.status] as const))
      const status = readinessStatus(
        "pending",
        dependencies.map((dependency) => ({
          requirement: dependency.requirement,
          status: prerequisite.get(dependency.dependsOnTaskID)!,
        })),
      )
      const now = input.now ?? Date.now()
      const task = SwarmModel.Task.make({
        id,
        swarmID: input.swarmID,
        title,
        ...(input.description?.trim() ? { description: input.description.trim() } : {}),
        status,
        priority: Math.trunc(input.priority ?? 0),
        ...(input.createdByMemberID === undefined ? {} : { createdByMemberID: input.createdByMemberID }),
        ...(input.reservedMemberID === undefined ? {} : { reservedMemberID: input.reservedMemberID }),
        ...(input.reservedUntil === undefined
          ? {}
          : { reservedUntil: DateTime.makeUnsafe(input.reservedUntil) }),
        reservationRevision: input.reservedMemberID === undefined ? 0 : 1,
        leaseGeneration: 0,
        semanticRetryCount: 0,
        acceptance: input.acceptance ?? { criteria: [] },
        metadata: (input.metadata ?? {}) as never,
        ...(status === "ready" ? { readyAt: DateTime.makeUnsafe(now) } : {}),
        time: {
          created: DateTime.makeUnsafe(now),
          updated: DateTime.makeUnsafe(now),
        },
      })
      yield* publishWithCommit(
        events,
        Event.TaskDependenciesUpdated,
        { swarmID: input.swarmID, task, dependencies },
        () =>
          Effect.gen(function* () {
            const existing = yield* db
              .select({ id: SwarmTaskTable.id })
              .from(SwarmTaskTable)
              .where(eq(SwarmTaskTable.id, id))
              .get()
              .pipe(Effect.orDie)
            if (existing)
              return yield* commitFail(
                new SwarmSchema.ConflictError({
                  code: "swarm.task_id_exists",
                  reason: `Task already exists: ${id}`,
                }),
              )
            if (input.createdByMemberID)
              yield* requireMemberRow(db, input.swarmID, input.createdByMemberID).pipe(
                Effect.catch((error) => commitFail(error)),
              )
            if (input.reservedMemberID)
              yield* requireMemberRow(db, input.swarmID, input.reservedMemberID).pipe(
                Effect.catch((error) => commitFail(error)),
              )
            if (dependencyIDs.length > 0) {
              const currentDeps = yield* db
                .select({ id: SwarmTaskTable.id, status: SwarmTaskTable.status })
                .from(SwarmTaskTable)
                .where(
                  and(
                    eq(SwarmTaskTable.swarm_id, input.swarmID),
                    inArray(SwarmTaskTable.id, dependencyIDs),
                  ),
                )
                .all()
                .pipe(Effect.orDie)
              if (currentDeps.length !== new Set(dependencyIDs).size)
                return yield* commitFail(
                  new SwarmSchema.ValidationError({
                    reason: "Every task dependency must exist in the same Swarm.",
                  }),
                )
              const currentStatus = new Map(currentDeps.map((row) => [row.id, row.status] as const))
              for (const row of dependencyRows) {
                if (currentStatus.get(row.id) !== row.status)
                  return yield* commitFail(
                    new SwarmSchema.ConflictError({
                      code: "swarm.dependencies_changed",
                      reason: "Task dependency state changed concurrently; retry task creation.",
                    }),
                  )
              }
            }
            yield* db
              .insert(SwarmTaskTable)
              .values({
                id,
                swarm_id: input.swarmID,
                title,
                description: task.description,
                status,
                priority: task.priority,
                created_by_member_id: input.createdByMemberID,
                reserved_member_id: input.reservedMemberID,
                reserved_until: input.reservedUntil,
                reservation_revision: task.reservationRevision,
                lease_generation: 0,
                semantic_retry_count: 0,
                acceptance: task.acceptance,
                metadata: input.metadata ?? {},
                ready_at: status === "ready" ? now : null,
                time_created: now,
                time_updated: now,
              })
              .run()
              .pipe(Effect.orDie)
            if (dependencies.length > 0)
              yield* db
                .insert(SwarmTaskDependencyTable)
                .values(
                  dependencies.map((dependency) => ({
                    task_id: dependency.taskID,
                    depends_on_task_id: dependency.dependsOnTaskID,
                    requirement: dependency.requirement,
                  })),
                )
                .run()
                .pipe(Effect.orDie)
          }),
      )
      return task
    })

    const setTaskDependencies = Effect.fn("Swarm.setTaskDependencies")(function* (
      input: SetTaskDependenciesInput,
    ) {
      const current = yield* requireTaskRow(readDb, input.swarmID, input.taskID)
      if (!["pending", "blocked", "ready"].includes(current.status))
        return yield* new SwarmSchema.InvalidTransitionError({
          entity: "task",
          id: input.taskID,
          from: current.status,
          to: "dependency_edit",
        })
      const rows = yield* readDb
        .select({ id: SwarmTaskTable.id, status: SwarmTaskTable.status })
        .from(SwarmTaskTable)
        .where(eq(SwarmTaskTable.swarm_id, input.swarmID))
        .all()
        .pipe(Effect.orDie)
      const allIDs = rows.map((row) => row.id)
      const existingEdges = yield* readDb
        .select()
        .from(SwarmTaskDependencyTable)
        .innerJoin(SwarmTaskTable, eq(SwarmTaskDependencyTable.task_id, SwarmTaskTable.id))
        .where(eq(SwarmTaskTable.swarm_id, input.swarmID))
        .all()
        .pipe(Effect.orDie)
      const nextEdges: DependencyEdge[] = existingEdges
        .map((row) => hydrateDependency(row.swarm_task_dependency))
        .filter((edge) => edge.taskID !== input.taskID)
        .concat(
          input.dependencies.map((dependency) => ({
            taskID: input.taskID,
            dependsOnTaskID: dependency.taskID,
            requirement: dependency.requirement ?? "require_success",
          })),
        )
      const graph = validateDependencyGraph(allIDs, nextEdges)
      if (!graph.ok)
        return yield* new SwarmSchema.ValidationError({
          reason:
            graph.reason === "cycle"
              ? `Task dependencies would create a cycle: ${graph.cycle.join(" -> ")}`
              : graph.reason === "self_dependency"
                ? "A task cannot depend on itself."
                : `Task dependency does not exist: ${graph.missingTaskID}`,
        })
      const statusByID = new Map(rows.map((row) => [row.id, row.status] as const))
      const targetDependencies = nextEdges.filter((edge) => edge.taskID === input.taskID)
      const nextStatus = readinessStatus(
        current.status,
        targetDependencies.map((edge) => ({
          requirement: edge.requirement,
          status: statusByID.get(edge.dependsOnTaskID)!,
        })),
      )
      const now = input.now ?? Date.now()
      const task = hydrateTask({
        ...current,
        status: nextStatus,
        ready_at: nextStatus === "ready" ? current.ready_at ?? now : null,
        time_updated: now,
      })
      const payloadDependencies = targetDependencies.map((edge) =>
        SwarmModel.TaskDependency.make({
          taskID: edge.taskID,
          dependsOnTaskID: edge.dependsOnTaskID,
          requirement: edge.requirement,
        }),
      )
      yield* publishWithCommit(
        events,
        Event.TaskDependenciesUpdated,
        { swarmID: input.swarmID, task, dependencies: payloadDependencies },
        () =>
          Effect.gen(function* () {
            const live = yield* db
              .select({ status: SwarmTaskTable.status })
              .from(SwarmTaskTable)
              .where(
                and(eq(SwarmTaskTable.id, input.taskID), eq(SwarmTaskTable.swarm_id, input.swarmID)),
              )
              .get()
              .pipe(Effect.orDie)
            if (!live)
              return yield* commitFail(new SwarmSchema.NotFoundError({ entity: "task", id: input.taskID }))
            if (live.status !== current.status)
              return yield* commitFail(
                new SwarmSchema.ConflictError({
                  code: "swarm.task_changed",
                  reason: `Task ${input.taskID} changed concurrently; retry dependency mutation.`,
                }),
              )
            const currentEdges = yield* db
              .select()
              .from(SwarmTaskDependencyTable)
              .innerJoin(SwarmTaskTable, eq(SwarmTaskDependencyTable.task_id, SwarmTaskTable.id))
              .where(eq(SwarmTaskTable.swarm_id, input.swarmID))
              .all()
              .pipe(Effect.orDie)
            const actualSignature = currentEdges
              .map((row) => hydrateDependency(row.swarm_task_dependency))
              .sort((a, b) =>
                a.taskID.localeCompare(b.taskID) ||
                a.dependsOnTaskID.localeCompare(b.dependsOnTaskID) ||
                a.requirement.localeCompare(b.requirement),
              )
            const expectedSignature = existingEdges
              .map((row) => hydrateDependency(row.swarm_task_dependency))
              .sort((a, b) =>
                a.taskID.localeCompare(b.taskID) ||
                a.dependsOnTaskID.localeCompare(b.dependsOnTaskID) ||
                a.requirement.localeCompare(b.requirement),
              )
            if (JSON.stringify(actualSignature) !== JSON.stringify(expectedSignature))
              return yield* commitFail(
                new SwarmSchema.ConflictError({
                  code: "swarm.graph_changed",
                  reason: "Task graph changed concurrently; retry dependency mutation.",
                }),
              )
            yield* db
              .delete(SwarmTaskDependencyTable)
              .where(eq(SwarmTaskDependencyTable.task_id, input.taskID))
              .run()
              .pipe(Effect.orDie)
            if (payloadDependencies.length > 0)
              yield* db
                .insert(SwarmTaskDependencyTable)
                .values(
                  payloadDependencies.map((dependency) => ({
                    task_id: dependency.taskID,
                    depends_on_task_id: dependency.dependsOnTaskID,
                    requirement: dependency.requirement,
                  })),
                )
                .run()
                .pipe(Effect.orDie)
            yield* db
              .update(SwarmTaskTable)
              .set({
                status: nextStatus,
                ready_at: nextStatus === "ready" ? current.ready_at ?? now : null,
                time_updated: now,
              })
              .where(eq(SwarmTaskTable.id, input.taskID))
              .run()
              .pipe(Effect.orDie)
          }),
      )
      return task
    })

    const dependencies = Effect.fn("Swarm.dependencies")(function* (taskID: SwarmModel.TaskID) {
      const rows = yield* readDb
        .select()
        .from(SwarmTaskDependencyTable)
        .where(eq(SwarmTaskDependencyTable.task_id, taskID))
        .orderBy(asc(SwarmTaskDependencyTable.depends_on_task_id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(hydrateDependency)
    })

    const dependenciesForSwarm = Effect.fn("Swarm.dependenciesForSwarm")(function* (swarmID: SwarmModel.ID) {
      const rows = yield* readDb
        .select({ dependency: SwarmTaskDependencyTable })
        .from(SwarmTaskDependencyTable)
        .innerJoin(SwarmTaskTable, eq(SwarmTaskDependencyTable.task_id, SwarmTaskTable.id))
        .where(eq(SwarmTaskTable.swarm_id, swarmID))
        .orderBy(
          asc(SwarmTaskDependencyTable.task_id),
          asc(SwarmTaskDependencyTable.depends_on_task_id),
        )
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => hydrateDependency(row.dependency))
    })

    const membersForSession = Effect.fn("Swarm.membersForSession")(function* (
      sessionID: typeof SessionTable.$inferSelect.id,
    ) {
      const rows = yield* readDb
        .select()
        .from(SwarmMemberTable)
        .where(eq(SwarmMemberTable.session_id, sessionID))
        .orderBy(asc(SwarmMemberTable.swarm_id), asc(SwarmMemberTable.time_created), asc(SwarmMemberTable.id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(hydrateMember)
    })

    const navigation = Effect.fn("Swarm.navigation")(function* (input?: {
      readonly projectID?: typeof ProjectTable.$inferSelect.id
    }) {
      const conditions = [
        ne(SwarmTable.status, "archived"),
        input?.projectID === undefined ? undefined : eq(SwarmTable.project_id, input.projectID),
      ].filter((item): item is Exclude<typeof item, undefined> => item !== undefined)
      const swarms = yield* readDb
        .select()
        .from(SwarmTable)
        .where(and(...conditions))
        .orderBy(asc(SwarmTable.time_created), asc(SwarmTable.id))
        .all()
        .pipe(Effect.orDie)
      if (swarms.length === 0) return []
      const swarmIDs = swarms.map((swarm) => swarm.id)
      const rows = yield* readDb
        .select({
          member: {
            id: SwarmMemberTable.id,
            swarmID: SwarmMemberTable.swarm_id,
            timeCreated: SwarmMemberTable.time_created,
          },
          session: {
            id: SessionTable.id,
            slug: SessionTable.slug,
            projectID: SessionTable.project_id,
            directory: SessionTable.directory,
            parentID: SessionTable.parent_id,
            title: SessionTable.title,
            version: SessionTable.version,
            timeCreated: SessionTable.time_created,
            timeUpdated: SessionTable.time_updated,
            timeArchived: SessionTable.time_archived,
          },
        })
        .from(SwarmMemberTable)
        .innerJoin(SessionTable, eq(SwarmMemberTable.session_id, SessionTable.id))
        .where(
          and(
            inArray(SwarmMemberTable.swarm_id, swarmIDs),
            isNotNull(SwarmMemberTable.session_id),
          ),
        )
        .orderBy(
          asc(SwarmMemberTable.swarm_id),
          asc(SwarmMemberTable.time_created),
          asc(SwarmMemberTable.id),
        )
        .all()
        .pipe(Effect.orDie)
      const members = new Map<SwarmModel.ID, SwarmModel.NavigationMember[]>()
      for (const row of rows) {
        const bucket = members.get(row.member.swarmID) ?? []
        bucket.push(
          SwarmModel.NavigationMember.make({
            memberID: row.member.id,
            sessionID: row.session.id,
            title: row.session.title,
            slug: row.session.slug,
            projectID: row.session.projectID!,
            directory: row.session.directory,
            ...(row.session.parentID === null ? {} : { parentID: row.session.parentID }),
            version: row.session.version,
            position: bucket.length,
            timeAdded: DateTime.makeUnsafe(row.member.timeCreated),
            time: {
              created: DateTime.makeUnsafe(row.session.timeCreated),
              updated: DateTime.makeUnsafe(row.session.timeUpdated),
              ...(row.session.timeArchived === null
                ? {}
                : { archived: DateTime.makeUnsafe(row.session.timeArchived) }),
            },
          }),
        )
        members.set(row.member.swarmID, bucket)
      }
      const result: SwarmModel.NavigationGroup[] = []
      for (const swarm of swarms) {
        const bound = members.get(swarm.id) ?? []
        if (bound.length === 0) continue
        const coordinatorSessionID =
          swarm.coordinator_member_id === null
            ? undefined
            : bound.find((member) => member.memberID === swarm.coordinator_member_id)?.sessionID
        result.push(
          SwarmModel.NavigationGroup.make({
            swarm: hydrateInfo(swarm),
            ...(coordinatorSessionID === undefined ? {} : { coordinatorSessionID }),
            members: bound,
          }),
        )
      }
      return result
    })

    return Service.of({
      create,
      info,
      get,
      summary,
      summaries,
      list,
      update,
      preflightMemberSession,
      addMember,
      rebindMember,
      setMemberLifecycle,
      configureMember,
      memberSessionTarget,
      unboundManagedMemberTargets,
      readyAssignments,
      processOwnedWork,
      createTask,
      setTaskDependencies,
      dependencies,
      dependenciesForSwarm,
      taskHandoff: handoff.taskHandoff,
      membersForSession,
      navigation,
      ...lease,
      ...messaging,
      ...sharedState,
    ...runtime,
    ...aggregateRecovery,
    ...observability,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node] })
