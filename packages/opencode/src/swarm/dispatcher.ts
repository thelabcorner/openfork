export * as SwarmDispatcher from "./dispatcher"

import { Context, Effect, Layer, Ref, Semaphore } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmRuntimePolicy } from "@opencode-ai/core/swarm/runtime-policy"
import { Swarm } from "@opencode-ai/schema/swarm"
import { make as makeCoalescedDrain } from "@/effect/coalesced-drain"
import { SwarmMailExecutor } from "./mail-executor"
import { SwarmTaskExecutor } from "./task-executor"

export interface Interface {
  /** Idempotent startup reconciliation. Durable state, not the wake, owns work. */
  readonly start: () => Effect.Effect<void>
  /** Explicit diagnostic/test wake. Production convergence is event/deadline driven. */
  readonly poke: () => Effect.Effect<void>
  /** 0 or 1: the shared coalesced drain never overlaps process-global scans. */
  readonly activeDrains: () => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SwarmDispatcher") {}

type DispatchJob =
  | { readonly type: "task"; readonly assignment: SwarmV2.ReadyAssignment }
  | { readonly type: "mail"; readonly deliveryID: Swarm.DeliveryID }

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const swarm = yield* SwarmV2.Service
    const tasks = yield* SwarmTaskExecutor.Service
    const mail = yield* SwarmMailExecutor.Service
    const events = yield* EventV2.Service
    const started = yield* Ref.make(false)
    const startLock = Semaphore.makeUnsafe(1)

    const scanOnce = Effect.fn("SwarmDispatcher.scanOnce")(function* () {
      const now = Date.now()
      const [assignments, deliveryIDs] = yield* Effect.all([
        swarm.readyAssignments({ now, limit: SwarmRuntimePolicy.TASK_DISPATCH_BATCH }),
        swarm.claimableDeliveryIDs({ now, limit: SwarmRuntimePolicy.DELIVERY_DISPATCH_BATCH }),
      ])
      const jobs: DispatchJob[] = [
        ...assignments.map((assignment) => ({ type: "task" as const, assignment })),
        ...deliveryIDs.map((deliveryID) => ({ type: "mail" as const, deliveryID })),
      ]
      yield* Effect.forEach(
        jobs,
        (job) =>
          job.type === "task"
            ? tasks.execute(job.assignment).pipe(Effect.asVoid)
            : mail.execute(job.deliveryID).pipe(Effect.asVoid),
        { concurrency: SwarmRuntimePolicy.DISPATCH_CONCURRENCY, discard: true },
      )
    })

    const drain = yield* makeCoalescedDrain({
      name: "SwarmDispatcher",
      drain: scanOnce(),
      onCause: (cause) => Effect.logError("Swarm dispatcher drain failed", { cause }),
    })

    const start: Interface["start"] = Effect.fn("SwarmDispatcher.start")(function* () {
      yield* startLock.withPermit(
        Effect.gen(function* () {
          if (yield* Ref.get(started)) return
          yield* Ref.set(started, true)
          yield* drain.wake()
        }),
      )
    })

    const poke: Interface["poke"] = Effect.fn("SwarmDispatcher.poke")(function* () {
      yield* drain.wake()
    })

    const activeDrains: Interface["activeDrains"] = Effect.fn("SwarmDispatcher.activeDrains")(function* () {
      return yield* drain.active()
    })

    const wake = () => drain.wake().pipe(Effect.ignore)
    const unsubscribers = yield* Effect.all([
      events.listenType(Swarm.Event.Updated, wake),
      events.listenType(Swarm.Event.MemberUpdated, wake),
      events.listenType(Swarm.Event.TaskUpdated, wake),
      events.listenType(Swarm.Event.TaskDependenciesUpdated, wake),
      events.listenType(Swarm.Event.TaskRunUpdated, wake),
      events.listenType(Swarm.Event.MessageCreated, wake),
    ])
    yield* Effect.addFinalizer(() => Effect.forEach(unsubscribers, (unsubscribe) => unsubscribe, { discard: true }))

    yield* Effect.forkScoped(start())
    return Service.of({ start, poke, activeDrains })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SwarmV2.node, SwarmTaskExecutor.node, SwarmMailExecutor.node, EventV2.node],
})
