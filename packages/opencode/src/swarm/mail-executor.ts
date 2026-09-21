export * as SwarmMailExecutor from "./mail-executor"

import { Cause, Context, Effect, Layer, Option } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmRuntimePolicy } from "@opencode-ai/core/swarm/runtime-policy"
import { Swarm } from "@opencode-ai/schema/swarm"
import { SwarmRuntimeRetention } from "./runtime-retention"
import { SwarmSessionAdmission } from "./session-admission"

export type Result =
  | { readonly state: "admitted"; readonly deliveryID: Swarm.DeliveryID }
  | { readonly state: "expired"; readonly deliveryID: Swarm.DeliveryID }
  | { readonly state: "deferred"; readonly deliveryID: Swarm.DeliveryID; readonly reason: string }
  | { readonly state: "skipped"; readonly deliveryID: Swarm.DeliveryID; readonly reason: string }

export interface Interface {
  readonly execute: (deliveryID: Swarm.DeliveryID) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SwarmMailExecutor") {}

function reasonOf(value: unknown) {
  if (value instanceof Error) return value.message
  if (typeof value === "object" && value !== null && "reason" in value) return String((value as { reason: unknown }).reason)
  return String(value)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const swarm = yield* SwarmV2.Service
    const admission = yield* SwarmSessionAdmission.Service
    const ownership = yield* SwarmRuntimeRetention.Service

    const execute: Interface["execute"] = Effect.fn("SwarmMailExecutor.execute")(function* (deliveryID) {
      yield* ownership.ensure()
      const claimed = yield* swarm
        .claimDelivery({
          deliveryID,
          owner: ownership.ownerID,
          leaseMs: SwarmRuntimePolicy.DELIVERY_CLAIM_MS,
        })
        .pipe(Effect.exit)
      if (claimed._tag === "Failure") {
        yield* ownership.reconcile()
        return { state: "skipped", deliveryID, reason: claimed.cause.toString() }
      }

      const admitted = yield* admission
        .peer({
          delivery: claimed.value.delivery,
          message: claimed.value.message,
          token: claimed.value.token,
        })
        .pipe(Effect.exit)
      if (admitted._tag === "Success") {
        yield* ownership.reconcile()
        return { state: "admitted", deliveryID }
      }

      const error = Option.getOrUndefined(Cause.findErrorOption(admitted.cause))
      if (
        error instanceof SwarmSessionAdmission.AdmissionConflictError &&
        error.code === "swarm.message_expired"
      ) {
        const expired = yield* swarm.expireDelivery({ deliveryID }).pipe(Effect.exit)
        yield* ownership.reconcile()
        if (expired._tag === "Success") return { state: "expired", deliveryID }
      }

      const reason = reasonOf(error ?? admitted.cause)
      yield* swarm
        .releaseDelivery({
          token: claimed.value.token,
          outcome: {
            type: "retry",
            nextAttemptAt: Date.now() + SwarmRuntimePolicy.DELIVERY_RETRY_MS,
            error: reason,
            countAsAttempt: false,
          },
        })
        .pipe(Effect.ignore)
      yield* ownership.reconcile()
      return { state: "deferred", deliveryID, reason }
    })

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SwarmV2.node, SwarmSessionAdmission.node, SwarmRuntimeRetention.node],
})
