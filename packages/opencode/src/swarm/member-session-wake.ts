export * as SwarmMemberSessionWake from "./member-session-wake"

import { Context, Effect, Layer, Ref } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Swarm } from "@opencode-ai/schema/swarm"

type Handler = (swarmID?: Swarm.ID) => Effect.Effect<void>

export interface Interface {
  /**
   * Install the one process-global member-session reconciliation wake target.
   * The returned effect removes only this exact handler.
   */
  readonly install: (handler: Handler) => Effect.Effect<Effect.Effect<void>>
  /**
   * Request one coalesced reconciliation pass. False means the runtime owner is
   * not currently installed; durable state remains authoritative and startup
   * reconciliation will still recover it later.
   */
  readonly request: (swarmID?: Swarm.ID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SwarmMemberSessionWake") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const current = yield* Ref.make<Handler | undefined>(undefined)

    const install: Interface["install"] = Effect.fn("SwarmMemberSessionWake.install")(function* (handler) {
      yield* Ref.set(current, handler)
      return Ref.get(current).pipe(
        Effect.flatMap((active) => (active === handler ? Ref.set(current, undefined) : Effect.void)),
      )
    })

    const request: Interface["request"] = Effect.fn("SwarmMemberSessionWake.request")(function* (swarmID) {
      const handler = yield* Ref.get(current)
      if (!handler) return false
      yield* handler(swarmID)
      return true
    })

    return Service.of({ install, request })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [],
})
