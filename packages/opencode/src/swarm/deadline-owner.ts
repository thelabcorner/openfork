export * as SwarmDeadlineOwner from "./deadline-owner"

import { Clock, Context, Effect, Layer, Ref, Semaphore } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmRuntimePolicy } from "@opencode-ai/core/swarm/runtime-policy"
import { Swarm } from "@opencode-ai/schema/swarm"
import { make as makeCoalescedDrain } from "@/effect/coalesced-drain"
import { make as makeSingleOwnedTimer } from "@/effect/single-owned-timer"
import { SwarmDispatcher } from "./dispatcher"
import { SwarmRecovery } from "./recovery"
import { SwarmRuntimeRetention } from "./runtime-retention"
import { SwarmTaskRetirement } from "./task-retirement"

export interface Interface {
  readonly start: () => Effect.Effect<void>
  readonly poke: () => Effect.Effect<void>
  readonly activeTimerCount: () => Effect.Effect<number>
  readonly activeDrains: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SwarmDeadlineOwner") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const swarm = yield* SwarmV2.Service
    const events = yield* EventV2.Service
    const retention = yield* SwarmRuntimeRetention.Service
    const dispatcher = yield* SwarmDispatcher.Service
    const retirement = yield* SwarmTaskRetirement.Service
    const recovery = yield* SwarmRecovery.Service
    const timer = yield* makeSingleOwnedTimer("SwarmDeadlineOwner")
    const started = yield* Ref.make(false)
    const probeAt = yield* Ref.make<number | undefined>(undefined)
    const recoveryAt = yield* Ref.make<number | undefined>(undefined)
    const startLock = Semaphore.makeUnsafe(1)
    let wakeDeadline: () => Effect.Effect<void> = () => Effect.void

    const requestRetirement = Effect.fn("SwarmDeadlineOwner.requestRetirement")(function* (
      target: SwarmV2.LeaseRuntimeTarget,
      reason: SwarmV2.RetirementReason,
      now: number,
    ) {
      yield* swarm.requestTaskRetirement({ token: target.token, reason, now }).pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("Swarm deadline retirement raced durable authority", {
            taskID: target.token.taskID,
            leaseGeneration: target.token.generation,
            reason,
            cause,
          }),
        ),
      )
    })

    const armNext = Effect.fn("SwarmDeadlineOwner.armNext")(function* () {
      const now = yield* Clock.currentTimeMillis
      const state = yield* swarm.nextRuntimeDeadline({
        now,
        processOwner: retention.ownerID,
        leaseRenewAheadMs: SwarmRuntimePolicy.TASK_LEASE_RENEW_AHEAD_MS,
      })
      if (state.dispatchDue) yield* dispatcher.poke()

      let probe = yield* Ref.get(probeAt)
      if (!state.hasRetiring) {
        probe = undefined
        yield* Ref.set(probeAt, undefined)
      } else if (probe === undefined) {
        probe = now + SwarmRuntimePolicy.RETIREMENT_PROBE_MS
        yield* Ref.set(probeAt, probe)
      }

      const domainAt = state.at
      const recoveryDeadline = yield* Ref.get(recoveryAt)
      const candidates = [domainAt, probe, recoveryDeadline].filter(
        (value): value is number => value !== undefined,
      )
      const next = candidates.length === 0 ? undefined : Math.min(...candidates)
      if (next === undefined) {
        yield* timer.cancel()
        return
      }

      const probeDue = probe !== undefined && probe <= next
      const domainDue = domainAt !== undefined && domainAt <= next
      const recoveryDue = recoveryDeadline !== undefined && recoveryDeadline <= next
      yield* timer.arm(
        Math.max(0, next - now),
        Effect.gen(function* () {
          if (probeDue) {
            yield* Ref.set(probeAt, next + SwarmRuntimePolicy.RETIREMENT_PROBE_MS)
            yield* retirement.poke()
          }
          if (recoveryDue) yield* Ref.set(recoveryAt, undefined)
          // Reservation expiry and delivery retry/reclaim are level-triggered
          // dispatcher deadlines. For other domain deadlines this extra bounded
          // wake is harmless and avoids encoding a second deadline taxonomy.
          if (domainDue) yield* dispatcher.poke()
          yield* wakeDeadline()
        }),
      )
    })

    const scanOnce = Effect.fn("SwarmDeadlineOwner.scanOnce")(function* () {
      yield* timer.cancel()
      const now = yield* Clock.currentTimeMillis

      // Re-establish the process heartbeat iff durable Swarm work says this
      // process still owns something. This is not authority recovery.
      yield* retention.reconcile()

      const recovered = yield* recovery.reconcile({ now })
      if (recovered.nextProbeAt !== undefined)
        yield* Ref.update(recoveryAt, (current) =>
          current === undefined ? recovered.nextProbeAt : Math.min(current, recovered.nextProbeAt!),
        )
      if (recovered.retiredLeases > 0) yield* retirement.poke()

      const renewals = yield* swarm.leaseRenewalTargets({
        processOwner: retention.ownerID,
        now,
        renewBefore: now + SwarmRuntimePolicy.TASK_LEASE_RENEW_AHEAD_MS,
        limit: SwarmRuntimePolicy.DEADLINE_BATCH,
      })
      yield* Effect.forEach(
        renewals,
        (target) =>
          swarm
            .renewTaskLease({
              token: target.token,
              leaseMs: SwarmRuntimePolicy.TASK_LEASE_MS,
              now,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logDebug("Swarm lease renewal raced durable authority", {
                  taskID: target.token.taskID,
                  leaseGeneration: target.token.generation,
                  cause,
                }),
              ),
            ),
        { concurrency: SwarmRuntimePolicy.DEADLINE_CONCURRENCY, discard: true },
      )

      // Expiry outranks a human-hold deadline. Once expiry moves a lease to
      // retiring, the hold scan no longer sees it.
      const expired = yield* swarm.expiredLeaseTargets({
        now,
        limit: SwarmRuntimePolicy.DEADLINE_BATCH,
      })
      yield* Effect.forEach(
        expired,
        (target) => requestRetirement(target, "lease_expired", now),
        { concurrency: SwarmRuntimePolicy.DEADLINE_CONCURRENCY, discard: true },
      )

      const held = yield* swarm.dueHoldTargets({
        now,
        limit: SwarmRuntimePolicy.DEADLINE_BATCH,
      })
      yield* Effect.forEach(
        held,
        (target) => requestRetirement(target, "human_focus", now),
        { concurrency: SwarmRuntimePolicy.DEADLINE_CONCURRENCY, discard: true },
      )

      const expiredDeliveries = yield* swarm.expireDueDeliveries({
        now,
        limit: SwarmRuntimePolicy.DEADLINE_BATCH,
      })

      if (expired.length > 0 || held.length > 0) yield* retirement.poke()
      if (expiredDeliveries.length > 0) yield* dispatcher.poke()
      yield* retention.reconcile()

      // Bounded scans are level-triggered. A full page means there may be more
      // immediately-due durable rows, so request one fresh authoritative pass.
      if (
        renewals.length === SwarmRuntimePolicy.DEADLINE_BATCH ||
        expired.length === SwarmRuntimePolicy.DEADLINE_BATCH ||
        held.length === SwarmRuntimePolicy.DEADLINE_BATCH ||
        expiredDeliveries.length === SwarmRuntimePolicy.DEADLINE_BATCH
      ) {
        yield* wakeDeadline()
      }
      yield* armNext()
    })

    const drain = yield* makeCoalescedDrain({
      name: "SwarmDeadlineOwner",
      drain: scanOnce(),
      onCause: (cause) => Effect.logError("Swarm deadline reconciliation failed", { cause }),
    })
    wakeDeadline = drain.wake

    const start: Interface["start"] = Effect.fn("SwarmDeadlineOwner.start")(function* () {
      yield* startLock.withPermit(
        Effect.gen(function* () {
          if (yield* Ref.get(started)) return
          yield* Ref.set(started, true)
          yield* drain.wake()
        }),
      )
    })

    const poke: Interface["poke"] = Effect.fn("SwarmDeadlineOwner.poke")(function* () {
      yield* drain.wake()
    })

    const activeTimerCount: Interface["activeTimerCount"] = () => timer.active()
    const activeDrains: Interface["activeDrains"] = () => drain.active()

    const wake = () => drain.wake().pipe(Effect.ignore)
    const unsubscribers = yield* Effect.all([
      events.listenType(Swarm.Event.TaskUpdated, wake),
      events.listenType(Swarm.Event.TaskLeaseUpdated, wake),
      events.listenType(Swarm.Event.MessageCreated, wake),
      events.listenType(Swarm.Event.DeliveryUpdated, wake),
    ])
    yield* Effect.addFinalizer(() => Effect.forEach(unsubscribers, (unsubscribe) => unsubscribe, { discard: true }))

    yield* Effect.forkScoped(start())
    return Service.of({ start, poke, activeTimerCount, activeDrains })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    SwarmV2.node,
    EventV2.node,
    SwarmRuntimeRetention.node,
    SwarmDispatcher.node,
    SwarmTaskRetirement.node,
    SwarmRecovery.node,
  ],
})
