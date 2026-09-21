export * as SwarmRuntimeRetention from "./runtime-retention"

import { Context, Effect, Layer, Semaphore } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { RuntimeOwner } from "@opencode-ai/core/runtime-owner"
import { SwarmV2 } from "@opencode-ai/core/swarm"

export interface Interface {
  readonly ownerID: RuntimeOwner.ID
  /** Ensure the process RuntimeOwner row/heartbeat exists before claiming durable work. */
  readonly ensure: () => Effect.Effect<void>
  /** Reconcile one process-global heartbeat against authoritative Swarm ownership rows. */
  readonly reconcile: () => Effect.Effect<SwarmV2.ProcessOwnedWork>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SwarmRuntimeRetention") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const runtime = yield* RuntimeOwner.Service
    const swarm = yield* SwarmV2.Service
    const lock = Semaphore.makeUnsafe(1)
    let retention: RuntimeOwner.Retention | undefined

    const ensure = Effect.fn("SwarmRuntimeRetention.ensure")(function* () {
      yield* lock.withPermit(
        Effect.gen(function* () {
          retention ??= yield* runtime.retain
        }),
      )
    })

    const reconcile = Effect.fn("SwarmRuntimeRetention.reconcile")(function* () {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const owned = yield* swarm.processOwnedWork(runtime.id)
          const hasWork = owned.taskLeases > 0 || owned.deliveryClaims > 0
          if (hasWork && !retention) retention = yield* runtime.retain
          if (!hasWork && retention) {
            const current = retention
            retention = undefined
            yield* current.release
          }
          return owned
        }),
      )
    })

    yield* Effect.addFinalizer(() =>
      lock.withPermit(
        Effect.gen(function* () {
          if (!retention) return
          const current = retention
          retention = undefined
          yield* current.release
        }),
      ),
    )

    return Service.of({ ownerID: runtime.id, ensure, reconcile })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [RuntimeOwner.node, SwarmV2.node],
})
