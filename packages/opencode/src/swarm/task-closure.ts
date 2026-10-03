export * as SwarmTaskClosure from "./task-closure"

import { Context, Effect, Layer, Ref, Semaphore } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecutionOwner } from "@opencode-ai/core/session/execution-owner"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionRecovery } from "@opencode-ai/core/session/recovery"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmRuntimePolicy } from "@opencode-ai/core/swarm/runtime-policy"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { Swarm } from "@opencode-ai/schema/swarm"
import { make as makeCoalescedDrain } from "@/effect/coalesced-drain"
import { make as makeSingleOwnedTimer } from "@/effect/single-owned-timer"

export interface Interface {
  readonly start: () => Effect.Effect<void>
  readonly poke: () => Effect.Effect<void>
  readonly activeDrains: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SwarmTaskClosure") {}

/**
 * Natural-execution-end closure for Swarm task runs.
 *
 * A normal, un-aborted `session.idle` is host-owned evidence that the managed
 * worker's turn ended. It is deliberately NOT semantic success: if the worker
 * forgot `swarm_member.done` / `fail`, this service moves the still-running
 * task to `review_pending` with an `unsettled` terminal run instead of
 * immediately replaying already-produced work.
 *
 * Safety boundaries:
 * - only a natural `session.idle` makes a Session eligible;
 * - live Session execution ownership remains blocked until release is visible;
 * - dead-owner recovery is NEVER performed here. Process death proves
 *   quiescence, not that useful execution completed; retirement owns retry /
 *   supersession when an owner dies;
 * - unresolved tool effects remain fail-closed;
 * - startup scans and arbitrary pokes cannot manufacture execution completion.
 *
 * Residual crash window: if a process dies after producing useful output but
 * before publishing natural `session.idle`, no durable completion proof exists
 * and retirement may retry the task. Closing that window requires a dedicated
 * producer-owned durable completion fact; transcript prose and dead-owner
 * quiescence are insufficient authority.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const swarm = yield* SwarmV2.Service
    const execution = yield* SessionExecutionOwner.Service
    const timer = yield* makeSingleOwnedTimer("SwarmTaskClosure")
    const started = yield* Ref.make(false)
    const eligibleSessions = yield* Ref.make<Set<SessionV2.ID>>(new Set())
    const startLock = Semaphore.makeUnsafe(1)
    let wakeScan: () => Effect.Effect<void> = () => Effect.void

    type CloseOutcome = "closed" | "blocked" | "fenced" | "raced"

    const removeEligible = Effect.fn("SwarmTaskClosure.removeEligible")(function* (
      sessionIDs: readonly SessionV2.ID[],
    ) {
      if (sessionIDs.length === 0) return
      yield* Ref.update(eligibleSessions, (current) => {
        const next = new Set(current)
        for (const sessionID of sessionIDs) next.delete(sessionID)
        return next
      })
    })

    const close = Effect.fn("SwarmTaskClosure.close")(function* (target: SwarmV2.UnsettledTarget) {
      const snapshot = yield* execution.snapshot(target.token.sessionID)
      if (snapshot.ownerID !== undefined) return "blocked" as const

      // Natural idle says the turn ended, but it never authorizes erasing an
      // unresolved external-effect boundary.
      const hazards = yield* SessionRecovery.executionHazards(db, target.token.sessionID)
      if (hazards.currentTool || hazards.legacyTool) {
        yield* Effect.logWarning("Swarm execution-end closure blocked by unresolved execution effects", {
          taskID: target.token.taskID,
          leaseGeneration: target.token.generation,
          sessionID: target.token.sessionID,
          runID: target.run.id,
          hazards,
        })
        return "fenced" as const
      }

      const settled = yield* swarm
        .settleTask({
          token: target.token,
          runID: target.run.id,
          settlement: {
            type: "unsettled",
            detail: "worker execution ended normally without semantic settlement",
          },
        })
        .pipe(Effect.exit)

      if (settled._tag === "Success") return "closed" as const

      yield* Effect.logDebug("Swarm execution-end closure raced durable authority", {
        taskID: target.token.taskID,
        leaseGeneration: target.token.generation,
        runID: target.run.id,
        cause: settled.cause,
      })
      return "raced" as const
    })

    const armProbe = Effect.fn("SwarmTaskClosure.armProbe")(function* (pending: boolean) {
      if (!pending) {
        yield* timer.cancel()
        return
      }
      yield* timer.arm(
        SwarmRuntimePolicy.EXECUTION_CLOSURE_PROBE_MS,
        Effect.gen(function* () {
          yield* wakeScan()
        }),
      )
    })

    const scanOnce = Effect.fn("SwarmTaskClosure.scanOnce")(function* () {
      yield* timer.cancel()

      const eligible = [...(yield* Ref.get(eligibleSessions))]
      if (eligible.length === 0) return

      const page = eligible.slice(0, SwarmRuntimePolicy.EXECUTION_CLOSURE_BATCH)
      const targets = yield* swarm.unsettledExecutionTargets({
        limit: SwarmRuntimePolicy.EXECUTION_CLOSURE_BATCH,
        sessionIDs: page,
      })

      // Natural idle can race explicit settlement/revocation. If there is no
      // longer an exact running target, consume that eligibility token.
      const represented = new Set(targets.map((target) => target.token.sessionID))
      yield* removeEligible(page.filter((sessionID) => !represented.has(sessionID)))

      const outcomes = yield* Effect.forEach(targets, close, {
        concurrency: SwarmRuntimePolicy.EXECUTION_CLOSURE_CONCURRENCY,
      })

      yield* removeEligible(
        targets
          .filter((_, index) => outcomes[index] === "closed")
          .map((target) => target.token.sessionID),
      )

      yield* Effect.logDebug("Swarm execution-end closure scan completed", {
        eligible: page.length,
        candidates: targets.length,
        closed: outcomes.filter((outcome) => outcome === "closed").length,
        blocked: outcomes.filter((outcome) => outcome === "blocked").length,
        fenced: outcomes.filter((outcome) => outcome === "fenced").length,
        raced: outcomes.filter((outcome) => outcome === "raced").length,
      })

      // A natural idle event can publish just before canonical execution-owner
      // release. Retry only blocked/raced evidence at the bounded probe rate.
      // Fenced candidates require explicit containment/operator work.
      yield* armProbe(
        eligible.length > page.length ||
          outcomes.includes("blocked") ||
          outcomes.includes("raced"),
      )
    })

    const drain = yield* makeCoalescedDrain({
      name: "SwarmTaskClosure",
      drain: scanOnce(),
      onCause: (cause) => Effect.logError("Swarm execution-end closure drain failed", { cause }),
    })
    wakeScan = drain.wake

    const start: Interface["start"] = Effect.fn("SwarmTaskClosure.start")(function* () {
      yield* startLock.withPermit(
        Effect.gen(function* () {
          if (yield* Ref.get(started)) return
          yield* Ref.set(started, true)
          // No startup scan: historical running rows have no natural-idle proof.
        }),
      )
    })

    const poke: Interface["poke"] = Effect.fn("SwarmTaskClosure.poke")(function* () {
      yield* drain.wake()
    })

    const activeDrains: Interface["activeDrains"] = Effect.fn("SwarmTaskClosure.activeDrains")(function* () {
      return yield* drain.active()
    })

    const wake = () => drain.wake().pipe(Effect.ignore)
    const unsubscribers = yield* Effect.all([
      events.listenType(SessionStatusEvent.Idle, (event) =>
        Effect.gen(function* () {
          const sessionID = SessionV2.ID.make(event.data.sessionID)
          if (event.data.reason === "aborted") {
            yield* removeEligible([sessionID])
            return
          }
          yield* Ref.update(eligibleSessions, (current) => new Set(current).add(sessionID))
          yield* wakeScan()
        }),
      ),
      events.listenType(Swarm.Event.TaskRunUpdated, wake),
      events.listenType(Swarm.Event.TaskLeaseUpdated, wake),
      events.listenType(SessionEvent.SyntheticPromoted, wake),
      events.listenType(SessionEvent.SyntheticRevoked, wake),
    ])
    yield* Effect.addFinalizer(() => Effect.forEach(unsubscribers, (unsubscribe) => unsubscribe, { discard: true }))

    yield* Effect.forkScoped(start())
    return Service.of({ start, poke, activeDrains })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SwarmV2.node, SessionExecutionOwner.node],
})
