export * as SwarmContainment from "./containment"

import { Clock, Context, Effect, Layer, Semaphore } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionContainment } from "@opencode-ai/core/session/containment"
import { RUNTIME_OWNER_STALE_AFTER_MS, SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionRecovery } from "@opencode-ai/core/session/recovery"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmRuntimePolicy } from "@opencode-ai/core/swarm/runtime-policy"
import type { Swarm } from "@opencode-ai/schema/swarm"
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm"
import { SwarmMemberTable, SwarmTable, SwarmTaskLeaseTable, SwarmTaskTable } from "@opencode-ai/core/swarm/sql"
import type { SwarmSchema } from "@opencode-ai/core/swarm/schema"

/** Bounded scan window for the project-wide operator overview. */
const OPERATOR_SWARM_SCAN = 64

/**
 * Operator lifecycle closure for Swarms the unattended runtime must never close
 * on its own authority.
 *
 * Two independent durable limbo states end here, and both are deliberately
 * *not* resolved by the level-triggered retirement/deadline loops:
 *
 * 1. `effect-unknown` - a proven-dead owner left an unresolved durable tool
 *    boundary. Automatic recovery correctly refuses to clear the Session
 *    generation, which also leaves the Swarm lease `retiring`, the run
 *    `running`, and the task `working` indefinitely. Containment is a decision
 *    about the outside world (did a surviving OS child mutate the workspace?),
 *    so only an explicit acknowledgement may assert it.
 * 2. abandoned `creating` / idle `active` aggregates, which have no execution
 *    authority left to drain and therefore no loop that would ever revisit them.
 *
 * Honesty rule: acknowledgement seals the transcript so the generation can
 * advance, but it never claims the external effect did not happen. The sealed
 * tool rows stay `error`/`unknown`, the Swarm run settles as `unsettled`,
 * the task is parked in `review_pending`, and the task is never advanced to
 * `completed`. A task whose real outcome is unknown stays reviewable.
 */
export interface UnresolvedEffects {
  readonly swarmID: Swarm.ID
  readonly taskID: Swarm.TaskID
  readonly leaseGeneration: number
  /** Persisted lease rows predate the closed runtime union, so reads stay honest. */
  readonly retireReason?: string
  readonly sessionID: Swarm.TaskRun["sessionID"]
  readonly sessionGeneration: number
  readonly deadOwnerID: SessionExecutionOwner.Snapshot["ownerID"] & {}
  readonly recoveryOwnerID: SessionExecutionOwner.Snapshot["recoveryOwnerID"] & {}
  readonly hazards: SessionRecovery.ExecutionHazards
}

/**
 * A bound managed-worker Session whose execution owner is proven dead while
 * its transcript still holds unresolved tool boundaries. This is the
 * Session-owned analogue of `UnresolvedEffects`: nothing task-fenced owns the
 * generation, so only `acknowledgeSession` may end it.
 */
export interface BoundSessionLimbo {
  readonly memberID: Swarm.MemberID
  readonly memberName: string
  readonly sessionID: Swarm.TaskRun["sessionID"]
  readonly sessionGeneration: number
  readonly deadOwnerID?: RuntimeOwner.ID
  readonly recoveryOwnerID?: RuntimeOwner.ID
  readonly hazards: SessionRecovery.ExecutionHazards
}

export interface ReviewBacklogEntry {
  readonly swarmID: Swarm.ID
  readonly taskID: Swarm.TaskID
  readonly title: string
  readonly status: "review_pending" | "changes_requested"
  readonly leaseGeneration: number
}

export interface OperatorOverview {
  readonly effects: ReadonlyArray<UnresolvedEffects>
  readonly reviewBacklog: ReadonlyArray<ReviewBacklogEntry>
  readonly boundSessions: ReadonlyArray<BoundSessionLimbo>
  readonly truncated: {
    readonly effects: boolean
    readonly reviewBacklog: boolean
    readonly boundSessions: boolean
    readonly swarms: boolean
  }
}

export type AcknowledgeResult =
  /** Effects were sealed and the dead generation's fence was released. */
  | { readonly state: "contained"; readonly taskID: Swarm.TaskID; readonly runID: Swarm.TaskRunID; readonly sealed: number }
  /**
   * Some hazard could not be sealed (for example one only visible in the
   * retained V1 projection). The Session fence is retained; the task is parked
   * for review before any tool hazard is removed.
   */
  | { readonly state: "uncontained"; readonly taskID: Swarm.TaskID; readonly sealed: number; readonly hazards: SessionRecovery.ExecutionHazards }
  /** The lease is no longer retiring at that generation, or the claim was not ours. */
  | { readonly state: "stale" }
  /** The execution owner is alive or unproven; acknowledging would be a lie. */
  | { readonly state: "blocked"; readonly proof?: Exclude<RuntimeOwner.LocalDeathProof, "dead"> }
  /** Another recovery owner holds the claim. */
  | { readonly state: "busy" }
  | { readonly state: "not-found" }
  /** Ambiguous durable authority: never force-close more than one live run. */
  | { readonly state: "ambiguous" }

export interface Interface {
  /**
   * Explicitly abandon one already-claimed dead Session generation. If it owns
   * a Swarm lease, retire and settle its exact running task as unknown before
   * sealing/releasing the Session fence. A Session without a lease is contained
   * directly. This records no claim that an external mutation did not happen.
   */
  readonly abandonSession: (
    token: SessionExecutionOwner.Token | SessionExecutionOwner.RecoveryToken,
  ) => Effect.Effect<boolean>
  /** Operator recovery of a bound Session, including work outside a task lease. */
  readonly acknowledgeSession: (input: {
    readonly swarmID: Swarm.ID
    readonly memberID: Swarm.MemberID
  }) => Effect.Effect<
    | { readonly state: "contained"; readonly sessionID: Swarm.TaskRun["sessionID"]; readonly sealed: number }
    | { readonly state: "idle" | "blocked" | "busy" | "uncontained" | "stale" | "unbound" }
    | { readonly state: "task-owned"; readonly taskID: Swarm.TaskID; readonly leaseGeneration: number },
    SwarmSchema.Error
  >
  /**
   * Durable, bounded discovery of retiring Swarm leases fenced by unresolved
   * execution effects. Level-triggered and idempotent: it only reads durable
   * rows and the Session execution fence.
   */
  readonly unresolved: (input?: {
    readonly limit?: number
    readonly swarmID?: Swarm.ID
    readonly taskID?: Swarm.TaskID
  }) => Effect.Effect<ReadonlyArray<UnresolvedEffects>>
  /**
   * Bounded, project-scoped discovery for the operator repair surface.
   *
   * Read-only: it lists retiring leases fenced by unresolved execution
   * effects, tasks parked for review, and proven-dead bound member Sessions.
   * It never claims recovery ownership and never mutates durable state, so an
   * admin agent can scope the blast radius before any acknowledgement.
   */
  readonly operatorOverview: (input: {
    readonly projectID: typeof SwarmTable.$inferSelect.project_id
    readonly swarmID?: Swarm.ID
    readonly limit?: number
  }) => Effect.Effect<OperatorOverview>
  /**
   * Explicit operator containment acknowledgement for one retiring lease.
   *
   * This is the only path out of `effect-unknown` limbo. It is intentionally not
   * reachable from any unattended drain: it requires a caller that decided the
   * external effects are contained.
   */
  readonly acknowledge: (input: {
    readonly taskID: Swarm.TaskID
    readonly generation: number
    readonly now?: number
  }) => Effect.Effect<AcknowledgeResult>
  /**
   * Level-triggered, idempotent aggregate closure. Closes only provably inert
   * abandoned `creating` aggregates and reports idle `active` ones without
   * closing them.
   */
  readonly reconcile: (input?: { readonly now?: number }) => Effect.Effect<{
    readonly closedCreating: number
    readonly staleActive: number
  }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SwarmContainment") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const swarm = yield* SwarmV2.Service
    const execution = yield* SessionExecutionOwner.Service
    const runtime = yield* RuntimeOwner.Service
    const acknowledgeLock = Semaphore.makeUnsafe(1)
    const aggregateLock = Semaphore.makeUnsafe(1)
    let reportedCreating = new Map<string, string>()
    let reportedIdle = new Map<string, string>()

    const unresolved: Interface["unresolved"] = Effect.fn("SwarmContainment.unresolved")(function* (input) {
      const limit = Math.min(256, Math.max(1, Math.trunc(input?.limit ?? SwarmRuntimePolicy.RETIREMENT_BATCH)))
      const retiring = yield* swarm.retiringTargets({
        limit,
        ...(input?.swarmID === undefined ? {} : { swarmID: input.swarmID }),
        ...(input?.taskID === undefined ? {} : { taskID: input.taskID }),
      })
      const found: UnresolvedEffects[] = []
      for (const target of retiring) {
        // Only a lease with exactly one live run has an unambiguous Session
        // fence. Ambiguous rows are left for the retirement log, not resolved.
        if (target.runs.length !== 1) continue
        const snapshot = yield* execution.snapshot(target.token.sessionID)
        if (snapshot.ownerID === undefined || snapshot.recoveryOwnerID === undefined) continue
        const hazards = yield* SessionRecovery.executionHazards(db, target.token.sessionID)
        if (!hazards.currentTool && !hazards.legacyTool) continue
        found.push({
          swarmID: target.swarmID,
          taskID: target.token.taskID,
          leaseGeneration: target.token.generation,
          ...(target.lease.retireReason === undefined ? {} : { retireReason: target.lease.retireReason }),
          sessionID: target.token.sessionID,
          sessionGeneration: snapshot.generation,
          deadOwnerID: snapshot.ownerID,
          recoveryOwnerID: snapshot.recoveryOwnerID,
          hazards,
        })
      }
      return found
    })

    const acknowledge: Interface["acknowledge"] = Effect.fn("SwarmContainment.acknowledge")(function* (input) {
      return yield* acknowledgeLock.withPermit(
        Effect.gen(function* () {
          const retiring = yield* swarm.retiringTargets({ limit: 1, taskID: input.taskID })
          const target = retiring.find(
            (item) => item.token.taskID === input.taskID && item.token.generation === input.generation,
          )
          if (!target) return { state: "not-found" as const }
          if (target.runs.length !== 1) return { state: "ambiguous" as const }
          const run = target.runs[0]!.run

          const now = input.now ?? (yield* Clock.currentTimeMillis)
          const claim = yield* execution.tryClaimRecovery(target.token.sessionID)
          if (claim.state === "blocked") return { state: "blocked" as const, proof: claim.proof }
          if (claim.state === "busy") return { state: "busy" as const }
          if (claim.state === "idle") return { state: "stale" as const }

          // Terminal unknown outcome, not operational churn. `superseded` would
          // return the task to `ready` and immediately redispatch a mutation
          // whose external effect is still unknown. `contained_unknown` closes
          // the run as the truthful terminal unknown fact and parks the task in
          // `review_pending`, so only a deliberate review decision can retry it.
          // It spends no semantic retry budget and asserts nothing about whether
          // the effect actually occurred.
          const settlement = yield* swarm
            .settleTask({
              token: target.token,
              runID: run.id,
              settlement: {
                type: "contained_unknown",
                detail: `retired after ${target.lease.retireReason ?? "lease_owner_lost"}; external effects contained by explicit operator acknowledgement (outcome unknown)`,
              },
              now,
            })
            .pipe(Effect.exit)
          if (settlement._tag === "Failure") {
            yield* Effect.logDebug("Swarm containment settlement raced durable authority", {
              taskID: input.taskID,
              leaseGeneration: input.generation,
              runID: run.id,
              cause: settlement.cause,
            })
            return { state: "stale" as const }
          }
          // Persist the terminal unknown outcome BEFORE removing tool hazards
          // or releasing the Session fence. Otherwise the unattended retirement
          // owner can observe a quiescent Session in between, supersede this
          // run, and redispatch an operation whose external outcome is unknown.
          // A crash here leaves a review-pending task and a recoverable Session,
          // never a ready task that silently repeats an interrupted mutation.
          const contained = yield* SessionContainment.containAcknowledgedEffects(db, events, execution, claim.token)
          if (contained.state === "stale") return { state: "stale" as const }
          if (contained.state === "uncontained") return {
            state: "uncontained" as const, taskID: input.taskID,
            sealed: contained.sealed, hazards: contained.hazards,
          }
          if (contained.release !== "released") return { state: "stale" as const }
          yield* Effect.logWarning("Swarm operator acknowledged containment of unresolved execution effects", {
            swarmID: target.swarmID,
            taskID: input.taskID,
            leaseGeneration: input.generation,
            runID: run.id,
            sessionID: target.token.sessionID,
            sessionGeneration: contained.token.generation,
            deadOwnerID: contained.token.ownerID,
            recoveryOwnerID: contained.token.recoveryOwnerID,
            sealed: contained.sealed,
          })
          return { state: "contained" as const, taskID: input.taskID, runID: run.id, sealed: contained.sealed }
        }),
      )
    })

    const abandonSession: Interface["abandonSession"] = Effect.fn("SwarmContainment.abandonSession")(function* (token) {
      return yield* acknowledgeLock.withPermit(Effect.gen(function* () {
        const snapshot = yield* execution.snapshot(token.sessionID)
        const recoveryOwnerID = "recoveryOwnerID" in token ? token.recoveryOwnerID : undefined
        if (
          snapshot.ownerID !== token.ownerID ||
          snapshot.generation !== token.generation ||
          snapshot.recoveryOwnerID !== recoveryOwnerID
        ) return false

        // Resolve durable task ownership from the exact Session, not from a
        // caller-supplied member or UI binding. Multiple lease rows are
        // ambiguous authority and must keep the Session fence closed.
        const leases = yield* db
          .select({ lease: SwarmTaskLeaseTable, swarmID: SwarmTaskTable.swarm_id })
          .from(SwarmTaskLeaseTable)
          .innerJoin(SwarmTaskTable, eq(SwarmTaskTable.id, SwarmTaskLeaseTable.task_id))
          .where(eq(SwarmTaskLeaseTable.owner_session_id, token.sessionID))
          .all()
          .pipe(Effect.orDie)
        if (leases.length > 1) return false

        if (leases.length === 0) return true
        if (leases.length === 1) {
          const row = leases[0]!
          const leaseToken = {
            swarmID: row.swarmID as Swarm.ID,
            taskID: row.lease.task_id as Swarm.TaskID,
            generation: row.lease.generation,
            memberID: row.lease.owner_member_id as Swarm.MemberID,
            sessionID: row.lease.owner_session_id as Swarm.TaskRun["sessionID"],
            bindingGeneration: row.lease.owner_binding_generation,
            processOwner: row.lease.lease_owner_process,
          }
          // Admission and lease retirement are separate durable operations. If
          // this generation is still runnable, first revoke redispatch by
          // entering retiring. The exact same lease token fences settlement.
          const retired = yield* swarm.requestTaskRetirement({ token: leaseToken, reason: "recovery" }).pipe(Effect.exit)
          if (retired._tag === "Failure") return false

          const target = (yield* swarm.retiringTargets({ limit: 2, taskID: leaseToken.taskID, swarmID: leaseToken.swarmID }))
            .find((item) => item.token.generation === leaseToken.generation)
          if (!target || target.runs.length > 1)
            return false

          const run = target.runs[0]?.run
          if (run && run.status !== "running" && run.status !== "admitted") return false
          // `contained_unknown` is the non-dispatchable review state. Its
          // detail deliberately says the effect outcome is unknown; it does not
          // assert that the external mutation was undone or absent.
          const settled = yield* swarm.settleTask({
            token: leaseToken,
            ...(run ? { runID: run.id } : {}),
            settlement: run?.status === "running" ? {
              type: "contained_unknown",
              detail: "operator abandoned the interrupted execution; external outcome unknown",
            } : { type: "superseded", detail: "operator recovered Session before task execution began" },
          }).pipe(Effect.exit)
          if (settled._tag === "Failure") return false
        }
        // The caller now seals/release the exact Session token. A crash or a
        // stale token before that point leaves the task parked in review_pending
        // and cannot replay its unknown execution.
        return true
      }))
    })

    const reconcile: Interface["reconcile"] = Effect.fn("SwarmContainment.reconcile")(function* (input) {
      return yield* aggregateLock.withPermit(
        Effect.gen(function* () {
          const now = input?.now ?? (yield* Clock.currentTimeMillis)
          let closedCreating = 0

          const abandoned = yield* swarm
            .abandonedCreating({
              staleBefore: now - SwarmRuntimePolicy.ABANDONED_SWARM_STALE_MS,
              limit: SwarmRuntimePolicy.AGGREGATE_RECOVERY_BATCH,
            })
            .pipe(Effect.orDie)
          const creatingThisPass = new Map<string, string>()
          for (const target of abandoned) {
            // Only an aggregate with nothing materialized can be closed without
            // operator judgement. Anything with a member/task/lease stays
            // visible in `unresolved`-style reporting instead of being discarded.
            if (target.members > 0 || target.tasks > 0 || target.leases > 0) {
              const signature = `${target.members}:${target.tasks}:${target.leases}`
              creatingThisPass.set(target.swarm.id, signature)
              if (reportedCreating.get(target.swarm.id) !== signature)
                yield* Effect.logWarning("Swarm aggregate is stuck in creating but already owns durable work", {
                swarmID: target.swarm.id,
                members: target.members,
                tasks: target.tasks,
                leases: target.leases,
                idleForMs: target.idleForMs,
              })
              continue
            }
            const closed = yield* swarm
              .update({
                id: target.swarm.id,
                expectedRevision: target.swarm.revision,
                status: "failed",
                now,
              })
              .pipe(Effect.exit)
            if (closed._tag === "Success") {
              closedCreating++
              continue
            }
            yield* Effect.logDebug("Swarm abandoned-creating closure raced a concurrent revision", {
              swarmID: target.swarm.id,
              cause: closed.cause,
            })
          }
          reportedCreating = creatingThisPass

          // Fail-closed by construction: an idle Swarm is a legitimate quiet
          // state, so it is surfaced for an operator and never auto-closed.
          const stale = yield* swarm
            .staleActive({
              staleBefore: now - SwarmRuntimePolicy.STALE_ACTIVE_SWARM_MS,
              limit: SwarmRuntimePolicy.AGGREGATE_RECOVERY_BATCH,
            })
            .pipe(Effect.orDie)
          const idleThisPass = new Map(stale.map((item) => [String(item.swarm.id), `${item.openTasks}:${item.leases}`]))
          const newlyStale = stale.filter((item) => reportedIdle.get(item.swarm.id) !== idleThisPass.get(item.swarm.id))
          reportedIdle = idleThisPass
          if (newlyStale.length > 0)
            yield* Effect.logWarning("Swarm active aggregates are idle; operator closure required", {
              count: newlyStale.length,
              swarms: newlyStale.map((item) => ({
                swarmID: item.swarm.id,
                idleForMs: item.idleForMs,
                openTasks: item.openTasks,
                leases: item.leases,
              })),
            })

          return { closedCreating, staleActive: stale.length }
        }),
      )
    })

    const acknowledgeSession: Interface["acknowledgeSession"] = Effect.fn("SwarmContainment.acknowledgeSession")(function* (input) {
      return yield* acknowledgeLock.withPermit(Effect.gen(function* () {
        const target = yield* swarm.memberSessionTarget(input.swarmID, input.memberID)
        const sessionID = target.member.sessionID
        if (!sessionID || target.member.kind !== "managed_worker") return { state: "unbound" as const }
        // A wall-clock timeout or quiet transcript is never a death proof.
        const claim = yield* execution.tryClaimRecovery(sessionID)
        if (claim.state !== "claimed") return { state: claim.state }
        // Task settlement is a separate owner. Never release its Session fence
        // underneath a live lease, including one renewed by a replacement runtime.
        const lease = yield* db.select().from(SwarmTaskLeaseTable)
          .where(eq(SwarmTaskLeaseTable.owner_session_id, sessionID)).get().pipe(Effect.orDie)
        if (lease) {
          yield* swarm.requestTaskRetirement({ token: {
            swarmID: input.swarmID, taskID: lease.task_id, generation: lease.generation,
            memberID: lease.owner_member_id, sessionID: lease.owner_session_id,
            bindingGeneration: lease.owner_binding_generation, processOwner: lease.lease_owner_process,
          }, reason: "recovery" })
          return { state: "task-owned" as const, taskID: lease.task_id, leaseGeneration: lease.generation }
        }
        const contained = yield* SessionContainment.containAcknowledgedEffects(db, events, execution, claim.token)
        if (contained.state !== "contained") return { state: contained.state }
        if (contained.release !== "released") return { state: "stale" as const }
        return { state: "contained" as const, sessionID, sealed: contained.sealed }
      }))
    })

    /**
     * Bounded, project-scoped operator recovery overview.
     *
     * This is the discovery surface for the states only an explicit operator
     * decision can end: retiring leases fenced by unresolved execution effects,
     * tasks parked for review, and bound member Sessions whose execution owner
     * is proven dead while their transcript still holds unresolved tools.
     * Listing performs no mutation and claims no recovery ownership; every
     * listed entry is re-validated by `acknowledge`/`acknowledgeSession` before
     * anything is sealed.
     */
    const operatorOverview: Interface["operatorOverview"] = Effect.fn("SwarmContainment.operatorOverview")(
      function* (input) {
        const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 32)))
        const scope =
          input.swarmID === undefined
            ? eq(SwarmTable.project_id, input.projectID)
            : and(eq(SwarmTable.project_id, input.projectID), eq(SwarmTable.id, input.swarmID))
        const swarmRows = yield* db
          .select({ id: SwarmTable.id })
          .from(SwarmTable)
          .where(scope)
          .orderBy(asc(SwarmTable.id))
          .limit(OPERATOR_SWARM_SCAN + 1)
          .all()
          .pipe(Effect.orDie)
        const swarmsTruncated = swarmRows.length > OPERATOR_SWARM_SCAN

        const effects: UnresolvedEffects[] = []
        let effectsTruncated = false
        for (const row of swarmRows.slice(0, OPERATOR_SWARM_SCAN)) {
          const remaining = limit - effects.length
          if (remaining <= 0) {
            effectsTruncated = true
            break
          }
          const fenced = yield* unresolved({ swarmID: row.id, limit: remaining + 1 })
          if (fenced.length > remaining) {
            effects.push(...fenced.slice(0, remaining))
            effectsTruncated = true
            break
          }
          effects.push(...fenced)
        }

        const backlogRows = yield* db
          .select({
            swarmID: SwarmTaskTable.swarm_id,
            taskID: SwarmTaskTable.id,
            title: SwarmTaskTable.title,
            status: SwarmTaskTable.status,
            generation: SwarmTaskTable.lease_generation,
          })
          .from(SwarmTaskTable)
          .innerJoin(SwarmTable, eq(SwarmTable.id, SwarmTaskTable.swarm_id))
          .where(and(scope, inArray(SwarmTaskTable.status, ["review_pending", "changes_requested"])))
          .orderBy(asc(SwarmTaskTable.time_updated), asc(SwarmTaskTable.id))
          .limit(limit + 1)
          .all()
          .pipe(Effect.orDie)
        const reviewBacklog: ReviewBacklogEntry[] = backlogRows.slice(0, limit).map((row) => ({
          swarmID: row.swarmID,
          taskID: row.taskID,
          title: row.title,
          status: row.status as ReviewBacklogEntry["status"],
          leaseGeneration: row.generation,
        }))

        const boundSessions: BoundSessionLimbo[] = []
        let boundSessionsTruncated = false
        if (input.swarmID !== undefined) {
          // Match SessionExecutionOwner's own staleness gate: death proof is
          // compared against real wall-clock time, not an effect test clock.
          const now = Date.now()
          const provenDead = (ownerID: RuntimeOwner.ID) =>
            Effect.gen(function* () {
              const owner = yield* runtime.snapshot(ownerID)
              if (!owner) return false
              if (now - owner.heartbeatAt < RUNTIME_OWNER_STALE_AFTER_MS) return false
              return (yield* runtime.proveLocalDeath(ownerID)) === "dead"
            })
          // A Session already fenced through a retiring lease is task-owned:
          // containment must resolve that lease first, never the Session fence.
          const taskOwned = new Set(effects.map((entry) => entry.sessionID))
          const memberRows = yield* db
            .select()
            .from(SwarmMemberTable)
            .where(
              and(
                eq(SwarmMemberTable.swarm_id, input.swarmID),
                eq(SwarmMemberTable.kind, "managed_worker"),
                isNotNull(SwarmMemberTable.session_id),
              ),
            )
            .orderBy(asc(SwarmMemberTable.time_created), asc(SwarmMemberTable.id))
            .limit(OPERATOR_SWARM_SCAN + 1)
            .all()
            .pipe(Effect.orDie)
          boundSessionsTruncated = memberRows.length > OPERATOR_SWARM_SCAN
          for (const member of memberRows.slice(0, OPERATOR_SWARM_SCAN)) {
            if (boundSessions.length >= limit) {
              boundSessionsTruncated = true
              break
            }
            const sessionID = member.session_id
            if (!sessionID) continue
            if (taskOwned.has(sessionID)) continue
            const snapshot = yield* execution.snapshot(sessionID)
            if (snapshot.ownerID === undefined) continue
            const hazards = yield* SessionRecovery.executionHazards(db, sessionID)
            if (!hazards.currentTool && !hazards.legacyTool) continue
            if (!(yield* provenDead(snapshot.ownerID))) continue
            // A recovery claim held by another live runtime is not actionable;
            // this process's own claim is reused by `acknowledgeSession`.
            if (snapshot.recoveryOwnerID !== undefined && snapshot.recoveryOwnerID !== runtime.id) {
              if (!(yield* provenDead(snapshot.recoveryOwnerID))) continue
            }
            boundSessions.push({
              memberID: member.id,
              memberName: member.name,
              sessionID,
              sessionGeneration: snapshot.generation,
              ...(snapshot.ownerID === undefined ? {} : { deadOwnerID: snapshot.ownerID }),
              ...(snapshot.recoveryOwnerID === undefined ? {} : { recoveryOwnerID: snapshot.recoveryOwnerID }),
              hazards,
            })
          }
        }

        return {
          effects,
          reviewBacklog,
          boundSessions,
          truncated: {
            effects: effectsTruncated,
            reviewBacklog: backlogRows.length > limit,
            boundSessions: boundSessionsTruncated,
            swarms: swarmsTruncated,
          },
        } satisfies OperatorOverview
      },
    )

    return Service.of({ unresolved, acknowledge, abandonSession, acknowledgeSession, operatorOverview, reconcile })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, RuntimeOwner.node, SessionExecutionOwner.node, SwarmV2.node],
})
