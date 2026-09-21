export * as SwarmTaskRetirement from "./task-retirement"

import { Context, Effect, Layer, Ref, Semaphore } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionRecovery } from "@opencode-ai/core/session/recovery"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmRuntimePolicy } from "@opencode-ai/core/swarm/runtime-policy"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { Swarm } from "@opencode-ai/schema/swarm"
import { make as makeCoalescedDrain } from "@/effect/coalesced-drain"
import { SwarmRuntimeRetention } from "./runtime-retention"

export interface Interface {
  readonly start: () => Effect.Effect<void>
  readonly poke: () => Effect.Effect<void>
  readonly activeDrains: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SwarmTaskRetirement") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const swarm = yield* SwarmV2.Service
    const execution = yield* SessionExecutionOwner.Service
    const retention = yield* SwarmRuntimeRetention.Service
    const started = yield* Ref.make(false)
    const startLock = Semaphore.makeUnsafe(1)

    const settle = Effect.fn("SwarmTaskRetirement.settle")(function* (
      target: SwarmV2.RetirementTarget,
      runID?: Swarm.TaskRunID,
    ) {
      yield* swarm.settleTask({
        token: target.token,
        ...(runID === undefined ? {} : { runID }),
        settlement: {
          type: "superseded",
          detail: target.lease.retireReason
            ? `retired after ${target.lease.retireReason}`
            : "retired at a proven quiescent boundary",
        },
      })
    })

    const reconcileTarget = Effect.fn("SwarmTaskRetirement.reconcileTarget")(function* (
      target: SwarmV2.RetirementTarget,
    ) {
      if (target.runs.length === 0) {
        yield* settle(target)
        return
      }
      if (target.runs.length !== 1) {
        yield* Effect.logError("Swarm retirement found multiple active runs for one lease; leaving authority fenced", {
          taskID: target.token.taskID,
          leaseGeneration: target.token.generation,
          runIDs: target.runs.map((item) => item.run.id),
        })
        return
      }

      const current = target.runs[0]!
      const pending =
        current.run.status === "admitted" &&
        current.input !== undefined &&
        current.input.promotedSeq === undefined
      if (pending) {
        if (current.input!.revokedSeq === undefined) {
          const revoked = yield* SessionInput.revokeSynthetic(db, events, {
            sessionID: target.token.sessionID,
            id: current.input!.id,
            reason: "superseded",
          })
          if (revoked.state === "too-late") {
            // Promotion won the CAS. The running branch below owns safety.
          } else if (
            revoked.state === "revoked" ||
            revoked.state === "already-revoked"
          ) {
            // SwarmSessionProjector normally settles this in the same revocation
            // transaction. Exact settle is a safe idempotent/race fallback.
            yield* settle(target, current.run.id).pipe(Effect.ignore)
            return
          } else {
            yield* Effect.logWarning("Swarm pending retirement could not prove revocation", {
              taskID: target.token.taskID,
              runID: current.run.id,
              state: revoked.state,
            })
          }
        } else {
          yield* settle(target, current.run.id).pipe(Effect.ignore)
          return
        }
      }

      const snapshot = yield* execution.snapshot(target.token.sessionID)
      if (snapshot.ownerID === undefined) {
        yield* settle(target, current.run.id)
        return
      }

      // Interrupt is acceleration only. Do not overwrite an existing operator,
      // pause, shutdown, recovery, or earlier handoff request, and never clear
      // ownership here.
      if (snapshot.interruptReason === undefined) {
        yield* execution.requestInterrupt(target.token.sessionID, "handoff")
      }

      const recovery = yield* SessionRecovery.recoverDeadOwnerIfQuiescent(db, execution, target.token.sessionID)
      if (recovery.state === "recovered" || recovery.state === "idle") {
        yield* settle(target, current.run.id)
        return
      }
      if (recovery.state === "effect-unknown") {
        // Do not seal the unresolved tool rows yet. Until OS containment or an
        // explicit operator acknowledgement exists, those rows are the durable
        // evidence preventing a later recovery process from mistaking the
        // generation for quiescent after this recovery owner itself crashes.
        const newlyClaimed = snapshot.recoveryOwnerID !== recovery.token.recoveryOwnerID
        if (newlyClaimed)
          yield* Effect.logWarning("Swarm retirement recovery is blocked by unresolved execution effects", {
            taskID: target.token.taskID,
            leaseGeneration: target.token.generation,
            sessionID: target.token.sessionID,
            sessionGeneration: recovery.token.generation,
            deadOwnerID: recovery.token.ownerID,
            recoveryOwnerID: recovery.token.recoveryOwnerID,
            hazards: recovery.hazards,
          })
      }
    })

    const scanOnce = Effect.fn("SwarmTaskRetirement.scanOnce")(function* () {
      const required = yield* swarm.retirementRequiredTargets({
        limit: SwarmRuntimePolicy.RETIREMENT_BATCH,
      })
      yield* Effect.forEach(
        required,
        (target) =>
          swarm
            .requestTaskRetirement({ token: target.token, reason: target.reason })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logDebug("Swarm retirement request raced durable authority", {
                  taskID: target.token.taskID,
                  cause,
                }),
              ),
            ),
        { concurrency: SwarmRuntimePolicy.RETIREMENT_CONCURRENCY, discard: true },
      )

      const retiring = yield* swarm.retiringTargets({
        limit: SwarmRuntimePolicy.RETIREMENT_BATCH,
      })
      yield* Effect.forEach(
        retiring,
        (target) =>
          reconcileTarget(target).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Swarm retirement reconciliation raced or failed", {
                taskID: target.token.taskID,
                leaseGeneration: target.token.generation,
                cause,
              }),
            ),
          ),
        { concurrency: SwarmRuntimePolicy.RETIREMENT_CONCURRENCY, discard: true },
      )
      yield* retention.reconcile()
    })

    const drain = yield* makeCoalescedDrain({
      name: "SwarmTaskRetirement",
      drain: scanOnce(),
      onCause: (cause) => Effect.logError("Swarm retirement drain failed", { cause }),
    })

    const start: Interface["start"] = Effect.fn("SwarmTaskRetirement.start")(function* () {
      yield* startLock.withPermit(
        Effect.gen(function* () {
          if (yield* Ref.get(started)) return
          yield* Ref.set(started, true)
          yield* drain.wake()
        }),
      )
    })

    const poke: Interface["poke"] = Effect.fn("SwarmTaskRetirement.poke")(function* () {
      yield* drain.wake()
    })

    const activeDrains: Interface["activeDrains"] = Effect.fn("SwarmTaskRetirement.activeDrains")(function* () {
      return yield* drain.active()
    })

    const wake = () => drain.wake().pipe(Effect.ignore)
    const unsubscribers = yield* Effect.all([
      events.listenType(Swarm.Event.Updated, wake),
      events.listenType(Swarm.Event.MemberUpdated, wake),
      events.listenType(Swarm.Event.TaskLeaseUpdated, wake),
      events.listenType(Swarm.Event.TaskRunUpdated, wake),
      events.listenType(SessionEvent.SyntheticPromoted, wake),
      events.listenType(SessionEvent.SyntheticRevoked, wake),
      events.listenType(SessionStatusEvent.Idle, wake),
    ])
    yield* Effect.addFinalizer(() => Effect.forEach(unsubscribers, (unsubscribe) => unsubscribe, { discard: true }))

    yield* Effect.forkScoped(start())
    return Service.of({ start, poke, activeDrains })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    EventV2.node,
    SwarmV2.node,
    SessionExecutionOwner.node,
    SwarmRuntimeRetention.node,
  ],
})
