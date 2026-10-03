export * as SwarmContainment from "./containment"

import { Clock, Context, Effect, Layer, Semaphore } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionContainment } from "@opencode-ai/core/session/containment"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionRecovery } from "@opencode-ai/core/session/recovery"
import type { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmRuntimePolicy } from "@opencode-ai/core/swarm/runtime-policy"
import type { Swarm } from "@opencode-ai/schema/swarm"

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
 * tool rows stay `error`/`unknown`, the Swarm run settles as `superseded`
 * (operational churn, not semantic failure), and the task is never advanced to
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

export type AcknowledgeResult =
  /** Effects were sealed and the dead generation's fence was released. */
  | { readonly state: "contained"; readonly taskID: Swarm.TaskID; readonly runID: Swarm.TaskRunID; readonly sealed: number }
  /**
   * Some hazard could not be sealed (for example one only visible in the
   * retained V1 projection). The fence is retained and nothing is settled.
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
   * Durable, bounded discovery of retiring Swarm leases fenced by unresolved
   * execution effects. Level-triggered and idempotent: it only reads durable
   * rows and the Session execution fence.
   */
  readonly unresolved: (input?: { readonly limit?: number }) => Effect.Effect<ReadonlyArray<UnresolvedEffects>>
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
    const acknowledgeLock = Semaphore.makeUnsafe(1)
    const aggregateLock = Semaphore.makeUnsafe(1)

    const unresolved: Interface["unresolved"] = Effect.fn("SwarmContainment.unresolved")(function* (input) {
      const limit = Math.min(256, Math.max(1, Math.trunc(input?.limit ?? SwarmRuntimePolicy.RETIREMENT_BATCH)))
      const retiring = yield* swarm.retiringTargets({ limit })
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
          const retiring = yield* swarm.retiringTargets({ limit: SwarmRuntimePolicy.RETIREMENT_BATCH })
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

          const contained = yield* SessionContainment.containAcknowledgedEffects(db, events, execution, claim.token)
          if (contained.state === "stale") return { state: "stale" as const }
          if (contained.state === "uncontained") {
            yield* Effect.logWarning("Swarm containment acknowledgement left a hazard unsealed", {
              taskID: input.taskID,
              leaseGeneration: input.generation,
              sessionID: target.token.sessionID,
              sealed: contained.sealed,
              hazards: contained.hazards,
            })
            return {
              state: "uncontained" as const,
              taskID: input.taskID,
              sealed: contained.sealed,
              hazards: contained.hazards,
            }
          }
          if (contained.release !== "released") return { state: "stale" as const }

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
          for (const target of abandoned) {
            // Only an aggregate with nothing materialized can be closed without
            // operator judgement. Anything with a member/task/lease stays
            // visible in `unresolved`-style reporting instead of being discarded.
            if (target.members > 0 || target.tasks > 0 || target.leases > 0) {
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

          // Fail-closed by construction: an idle Swarm is a legitimate quiet
          // state, so it is surfaced for an operator and never auto-closed.
          const stale = yield* swarm
            .staleActive({
              staleBefore: now - SwarmRuntimePolicy.STALE_ACTIVE_SWARM_MS,
              limit: SwarmRuntimePolicy.AGGREGATE_RECOVERY_BATCH,
            })
            .pipe(Effect.orDie)
          if (stale.length > 0)
            yield* Effect.logWarning("Swarm active aggregates are idle; operator closure required", {
              count: stale.length,
              swarms: stale.map((item) => ({
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

    return Service.of({ unresolved, acknowledge, reconcile })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SessionExecutionOwner.node, SwarmV2.node],
})
